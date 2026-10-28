// Skidmarks, as in original game: dark tyre streaks left on the floor wherever a car
// slides sideways (cornering hard, the handbrake, the spin after the finish).
// Only on floors that take them (surfaces.ts: not wood, carpet, grass, dirt...), and like the
// game the mark's colour is taken off the floor (subtractive), so dirt marks come out brown.
// Works the same for our car and remote/AI ones: it reads only the body's
// sideways speed and finds the floor under each wheel with a ray, so it needs
// nothing from the network. One ring buffer of quads; the oldest are reused.
import * as THREE from 'three'
import type { Car } from './car'
import type { Physics } from './physics'
import { surface } from './surfaces'

const MAX = 4000 // quads in the ring
const MIN_STEP = 0.12 // m between strip points
const SLIP_FROM = 1.6 // m/s sideways before a mark shows
const SLIP_FULL = 5 // ... and at full strength
const ALPHA = 0.6
const OIL_COLOUR: [number, number, number] = [150, 140, 130] // taken off the floor: near black
const OIL_FADE_MS = 2000 // an oily track fades over its last 2 s
const LIFT = 0.012 // above the floor

interface Trail { p: THREE.Vector3; l: THREE.Vector3; r: THREE.Vector3; a: number }
const STRENGTH = 1.8 // × the material's skid colour / 255

function treadTexture(): THREE.Texture {
  // across the tyre: soft edges, a few darker tread lines
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 4
  const g = c.getContext('2d')!
  const img = g.createImageData(32, 4)
  for (let x = 0; x < 32; x++) {
    const u = (x + 0.5) / 32
    const edge = Math.min(1, Math.min(u, 1 - u) / 0.22)
    const tread = 0.75 + 0.25 * Math.cos(u * Math.PI * 10)
    for (let y = 0; y < 4; y++) {
      const i = (y * 32 + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = Math.round(255 * edge * tread)
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  return t
}

export class SkidMarks {
  private pos = new Float32Array(MAX * 4 * 3)
  private col = new Float32Array(MAX * 4 * 4)
  private geo = new THREE.BufferGeometry()
  head = 0
  private dirty = false
  private trails = new WeakMap<Car, (Trail | null)[]>()
  private v = new THREE.Vector3()
  private n = new THREE.Vector3()
  private side = new THREE.Vector3()
  private right = new THREE.Vector3()
  private up = new THREE.Vector3()
  private colour: [number, number, number] = [112, 112, 112]

  constructor(scene: THREE.Scene, private physics: Physics) {
    const uv = new Float32Array(MAX * 4 * 2)
    const idx = new Uint32Array(MAX * 6)
    for (let i = 0; i < MAX; i++) {
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8)
      const b = i * 4
      idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], i * 6)
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1))
    const mat = new THREE.MeshBasicMaterial({
      map: treadTexture(), vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.SubtractiveBlending, premultipliedAlpha: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true,
    })
    const mesh = new THREE.Mesh(this.geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 1
    scene.add(mesh)
  }

  /** Call once a frame after the cars' poses are read, with every car on the track. */
  update(cars: Car[]) {
    for (const car of cars) this.car(car)
    if (this.dirty) {
      ;(this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
      ;(this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true
      this.dirty = false
    }
  }

  /** Forget where a car's marks were (it was teleported / reset). */
  cut(car: Car) {
    this.trails.delete(car)
  }

  private car(car: Car) {
    let trails = this.trails.get(car)
    if (!trails) this.trails.set(car, (trails = car.wheels.map(() => null)))
    this.right.set(1, 0, 0).applyQuaternion(car.quaternion)
    this.up.copy(car.upAxis)
    const slip = Math.abs(car.velocity.dot(this.right))
    const k = Math.min(1, Math.max(0, (slip - SLIP_FROM) / (SLIP_FULL - SLIP_FROM)))
    const now = performance.now()
    // a remote car's oily tyres come as a flag (32): all of them, while it is set
    const remoteOil = car.netFlags & 32 ? 0.8 : 0
    for (let i = 0; i < car.wheels.length; i++) {
      const wi = car.info.wheels[i]
      // oily tyres leave a dark track as they roll, sliding or not, fading out
      const oilK = Math.max(remoteOil, Math.min(1, (car.wheels[i].oilMark - now) / OIL_FADE_MS))
      if (!wi.present || (k <= 0 && oilK <= 0)) {
        trails[i] = null
        continue
      }
      const w = car.wheels[i]
      // the tyre's centre in the world, then straight down along the car to the floor
      this.v.set(w.rest.x, w.rest.y - w.pos + 0.05, w.rest.z).applyQuaternion(car.quaternion).add(car.position)
      const hit = this.physics.raycast(this.v.toArray(), this.up.clone().negate().toArray(), wi.radius + 0.12)
      if (!hit) {
        trails[i] = null
        continue
      }
      const sf = surface(hit.material)
      if (!sf.skid && oilK <= 0) {
        trails[i] = null
        continue
      }
      this.colour = oilK > k ? OIL_COLOUR : sf.skidColor
      this.n.set(hit.normal[0], hit.normal[1], hit.normal[2])
      const g = new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]).addScaledVector(this.n, LIFT)
      const a = Math.max(k, oilK) * ALPHA
      const t = trails[i]
      if (!t) {
        trails[i] = this.edges(g, g.clone().sub(car.velocity), wi.skidWidth, a)
        continue
      }
      const d = g.distanceTo(t.p)
      if (d > 1.5) {
        trails[i] = this.edges(g, g.clone().sub(car.velocity), wi.skidWidth, a)
        continue
      }
      if (d < MIN_STEP) continue
      const next = this.edges(g, t.p, wi.skidWidth, a)
      this.quad(t.l, t.r, t.a, next.l, next.r, a)
      trails[i] = next
    }
  }

  /** The strip's two edges at g, across the direction it came from. */
  private edges(g: THREE.Vector3, from: THREE.Vector3, width: number, a: number): Trail {
    this.side.subVectors(g, from).cross(this.n)
    if (this.side.lengthSq() < 1e-8) this.side.copy(this.right)
    this.side.normalize().multiplyScalar(Math.max(0.04, width) / 2)
    return { p: g, l: g.clone().sub(this.side), r: g.clone().add(this.side), a }
  }

  private quad(l0: THREE.Vector3, r0: THREE.Vector3, a0: number, l1: THREE.Vector3, r1: THREE.Vector3, a1: number) {
    const i = this.head
    this.head = (this.head + 1) % MAX
    this.pos.set([l0.x, l0.y, l0.z, r0.x, r0.y, r0.z, l1.x, l1.y, l1.z, r1.x, r1.y, r1.z], i * 12)
    const [r, g, b] = this.colour.map((v) => Math.min(1, (v / 255) * STRENGTH))
    this.col.set([r, g, b, a0, r, g, b, a0, r, g, b, a1, r, g, b, a1], i * 16)
    this.dirty = true
  }
}
