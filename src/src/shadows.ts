// Car shadows, as in original game: a soft top-down shape of each car (gfx/Shadow.bmp, one cell per
// car; box and cell from the game's own table, convert.py SHADOWS) laid on the floor under the
// car and taken off the floor's colour (subtractive). It follows the floor's slope, and fades as
// the car gets higher above it.
import * as THREE from 'three'
import type { Car } from './car'
import type { Physics } from './physics'

const STRENGTH = 0.55
const FADE_FROM = 0.3 // m above the floor: full shadow below this
const FADE_TO = 3 // ... gone above this
const LIFT = 0.015

let tex: THREE.Texture | null = null
function shadowTexture() {
  if (!tex) {
    tex = new THREE.TextureLoader().load('/game/fx/shadow.png')
    tex.flipY = false
    tex.colorSpace = THREE.NoColorSpace
  }
  return tex
}

export class Shadows {
  private list = new Map<Car, THREE.Mesh>()
  private down = [0, -1, 0]
  private m = new THREE.Matrix4()
  private x = new THREE.Vector3()
  private z = new THREE.Vector3()
  private n = new THREE.Vector3()

  constructor(private scene: THREE.Scene, private physics: Physics) {}

  private make(car: Car): THREE.Mesh | null {
    const s = car.info.shadow
    if (!s) return null
    const [l, r, f, b] = s.box
    const [u, v, w, h] = s.uv
    // car frame: x right, -z forward (original game's front is +z)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([l, 0, -f, r, 0, -f, l, 0, -b, r, 0, -b], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([u, v, u + w, v, u, v + h, u + w, v + h], 2))
    g.setIndex([0, 2, 1, 1, 2, 3])
    const mat = new THREE.MeshBasicMaterial({
      map: shadowTexture(), transparent: true, depthWrite: false, opacity: STRENGTH,
      blending: THREE.SubtractiveBlending, premultipliedAlpha: true,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, fog: false,
    })
    const mesh = new THREE.Mesh(g, mat)
    mesh.matrixAutoUpdate = false
    mesh.frustumCulled = false
    mesh.renderOrder = 1
    this.scene.add(mesh)
    return mesh
  }

  /** Once a frame with every car on the track; cars no longer listed lose their shadow. */
  update(cars: Car[]) {
    for (const [car, mesh] of this.list) {
      if (!cars.includes(car)) {
        mesh.removeFromParent()
        mesh.geometry.dispose()
        this.list.delete(car)
      }
    }
    for (const car of cars) {
      let mesh = this.list.get(car)
      if (mesh === undefined) {
        const made = this.make(car)
        if (!made) continue
        this.list.set(car, (mesh = made))
      }
      const hit = this.physics.raycast(car.position.toArray(), this.down, FADE_TO + 0.5)
      const height = hit ? hit.dist : Infinity
      const k = 1 - Math.min(1, Math.max(0, (height - FADE_FROM) / (FADE_TO - FADE_FROM)))
      mesh.visible = !!hit && k > 0 && car.root.visible
      if (!mesh.visible || !hit) continue
      ;(mesh.material as THREE.MeshBasicMaterial).opacity = STRENGTH * k
      // the car's heading laid onto the floor's plane
      this.n.set(hit.normal[0], hit.normal[1], hit.normal[2])
      this.z.set(0, 0, 1).applyQuaternion(car.quaternion)
      this.z.addScaledVector(this.n, -this.z.dot(this.n)).normalize()
      this.x.crossVectors(this.n, this.z).normalize()
      this.m.makeBasis(this.x, this.n, this.z)
      this.m.setPosition(hit.point[0] + this.n.x * LIFT, hit.point[1] + this.n.y * LIFT, hit.point[2] + this.n.z * LIFT)
      mesh.matrix.copy(this.m)
      mesh.matrixWorldNeedsUpdate = true
    }
  }
}
