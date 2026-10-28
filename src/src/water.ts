// Water, after original executable's three water objects:
// - "Water" (type 6, Toy World 1's pond): models/water.m with levels/toylite/water.bmp, translucent
//   (the game's colour 0xc0808080), each vertex bobbing ±5 cm at its own random speed.
// - "Water Ripples" (type 69, Botanical Garden's stream): models/gardenwater1-4 drawn with a texture
//   the game simulates — a 2D height field rippling out from drops (it keeps two 256x256
//   fields). Here: one 128x128 field tiled every RIPPLE_M over the world, rain-like drops falling at
//   random plus a ring wherever a car drives through.
// - "Water Box" (type 68, the Toytanic pool): a box (half size in cm) that plays the splash when a car
//   drops in and shows the world through water while the camera is inside. The water's
//   pull on the cars is the level's force fields (shared/fields.ts).
import * as THREE from 'three'
import { T, type LevelObject, type ObjectsInfo } from '../shared/objects'

const BOB_M = 0.05
const WATER_TILE_M = 4 // water.png repeats every 4 m
const RIPPLE_N = 128
const RIPPLE_M = 12 // the ripple field repeats every 12 m
const RIPPLE_HZ = 45
const RIPPLE_DAMP = 0.982
const UNDER_FOG = new THREE.Color(0x1d5a6e)

interface Surface { mesh: THREE.Mesh; kind: number; base?: Float32Array; speed?: Float32Array; phase?: Float32Array; uvDone: boolean }
export interface Box { min: number[]; max: number[] }

export class Waters {
  readonly boxes: Box[] = []
  private fogBoxes: Box[] = []
  private surfaces: Surface[] = []
  private field = new Float32Array(RIPPLE_N * RIPPLE_N)
  private prev = new Float32Array(RIPPLE_N * RIPPLE_N)
  private pixels = new Uint8Array(RIPPLE_N * RIPPLE_N * 4)
  private rippleTex = new THREE.DataTexture(this.pixels, RIPPLE_N, RIPPLE_N, THREE.RGBAFormat)
  private acc = 0
  private waterTex: THREE.Texture | null = null
  private fog: { color: THREE.Color; near: number; far: number } | null = null
  private mist: { near: number; far: number } | null = null

  constructor(info: ObjectsInfo, private scene: THREE.Scene) {
    for (const o of info.objects ?? []) {
      if (o.type !== T.WATERBOX && o.type !== T.FOGBOX) continue
      const h = o.p.slice(0, 3).map((v) => v / 100)
      ;(o.type === T.WATERBOX ? this.boxes : this.fogBoxes).push({ min: o.pos.map((v, i) => v - h[i]), max: o.pos.map((v, i) => v + h[i]) })
    }
    this.rippleTex.wrapS = this.rippleTex.wrapT = THREE.RepeatWrapping
    this.rippleTex.magFilter = this.rippleTex.minFilter = THREE.LinearFilter
    this.rippleTex.colorSpace = THREE.NoColorSpace
    this.paint()
  }

  /** The drawn surface for a water / ripples object, from the model the level gives it. */
  surface(o: LevelObject, model: THREE.Mesh): THREE.Mesh {
    const geo = model.geometry.clone()
    const s: Surface = { mesh: new THREE.Mesh(geo), kind: o.type, uvDone: false }
    if (o.type === T.WATER || o.type === T.STREAM) {
      const src = (Array.isArray(model.material) ? model.material : [model.material])
        .map((m) => (m as THREE.MeshBasicMaterial).map).find((m) => m) ?? null
      if (src) {
        this.waterTex = src.clone()
        this.waterTex.wrapS = this.waterTex.wrapT = THREE.RepeatWrapping
        this.waterTex.needsUpdate = true
      }
      s.mesh.material = o.type === T.STREAM
        // a stream is drawn additive in dark grey (0x404040, flags 0x106): a shimmer of
        // light over the stream bed, not a surface you can't see through
        ? new THREE.MeshBasicMaterial({ map: this.waterTex, color: new THREE.Color(0.4, 0.42, 0.45), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
        : new THREE.MeshBasicMaterial({ map: this.waterTex, color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide })
      const pos = geo.getAttribute('position') as THREE.BufferAttribute
      s.base = Float32Array.from(pos.array as Float32Array)
      // speed and phase from the vertex's place, so the faces sharing a corner move together (the
      // model's triangles are separate: a phase by vertex index tore the surface into cracks)
      s.speed = new Float32Array(pos.count)
      s.phase = new Float32Array(pos.count)
      for (let i = 0; i < pos.count; i++) {
        const x = Math.round(pos.getX(i) * 100) / 100, z = Math.round(pos.getZ(i) * 100) / 100
        s.speed[i] = 1 + (Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1)
        s.phase[i] = (Math.abs(Math.sin(x * 39.346 + z * 11.135) * 24634.6345) % 1) * Math.PI * 2
      }
    } else {
      s.mesh.material = new THREE.MeshBasicMaterial({ map: this.rippleTex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    }
    geo.clearGroups()
    s.mesh.renderOrder = 2
    this.surfaces.push(s)
    return s.mesh
  }

  /** A ring in the ripples at a world spot (a car driving through, 0..1 strength). */
  drop(x: number, z: number, strength = 1, r = 2) {
    const N = RIPPLE_N
    const cx = Math.floor(((x / RIPPLE_M) % 1 + 1) % 1 * N), cz = Math.floor(((z / RIPPLE_M) % 1 + 1) % 1 * N)
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r * r) continue
      const i = ((cz + dz + N) % N) * N + ((cx + dx + N) % N)
      this.field[i] -= 1.6 * strength
    }
  }

  /** Is a world point under the water of a box (the pool)? */
  inBox(p: { x: number; y: number; z: number }): Box | null {
    for (const b of this.boxes) {
      if (p.x > b.min[0] && p.x < b.max[0] && p.y > b.min[1] && p.y < b.max[1] && p.z > b.min[2] && p.z < b.max[2]) return b
    }
    return null
  }

  /** Is a world point over / in a ripple patch (for cars stirring it)? */
  onRipples(p: THREE.Vector3): boolean {
    for (const s of this.surfaces) {
      if (s.kind !== T.RIPPLES) continue
      const box = s.mesh.geometry.boundingBox ?? (s.mesh.geometry.computeBoundingBox(), s.mesh.geometry.boundingBox!)
      const local = s.mesh.worldToLocal(p.clone())
      if (local.x > box.min.x && local.x < box.max.x && local.z > box.min.z && local.z < box.max.z && Math.abs(local.y - box.max.y) < 1.2) return true
    }
    return false
  }

  update(ms: number, dt: number) {
    const t = ms / 1000
    for (const s of this.surfaces) {
      if (!s.uvDone) this.worldUv(s)
      if ((s.kind === T.WATER || s.kind === T.STREAM) && s.base && s.speed) {
        const pos = s.mesh.geometry.getAttribute('position') as THREE.BufferAttribute
        // streams wave 2 cm, the pond 5
        const bob = s.kind === T.STREAM ? 0.02 : BOB_M
        for (let i = 0; i < pos.count; i++) pos.setY(i, s.base[i * 3 + 1] + Math.sin(t * s.speed[i] * 2 + s.phase![i]) * bob)
        pos.needsUpdate = true
      }
    }
    if (this.waterTex) this.waterTex.offset.set((t * 0.015) % 1, (t * 0.01) % 1)
    if (!this.surfaces.some((s) => s.kind === T.RIPPLES)) return
    this.acc += dt
    let steps = 0
    while (this.acc > 1 / RIPPLE_HZ && steps < 3) {
      this.acc -= 1 / RIPPLE_HZ
      steps++
      if (Math.random() < 0.5) this.drop(Math.random() * RIPPLE_M, Math.random() * RIPPLE_M, 0.25 + Math.random() * 0.35, 1)
      this.stepField()
    }
    if (steps) this.paint()
    if (this.acc > 1) this.acc = 0
  }

  /** Underwater look while the camera is in a water box: the fog closes in, blue-green; in a fog box
   *  (Ghost Town 2) it closes in in the level's own colour. */
  camera(p: THREE.Vector3) {
    const fog = this.scene.fog as THREE.Fog | null
    if (!fog) return
    const misty = this.fogBoxes.some((b) => p.x > b.min[0] && p.x < b.max[0] && p.y > b.min[1] && p.y < b.max[1] && p.z > b.min[2] && p.z < b.max[2])
    if (misty !== !!this.mist) {
      if (misty) {
        this.mist = { near: fog.near, far: fog.far }
        fog.near = 2
        fog.far = 35
      } else {
        fog.near = this.mist!.near
        fog.far = this.mist!.far
        this.mist = null
      }
    }
    const under = !!this.inBox(p)
    if (under && !this.fog) {
      this.fog = { color: fog.color.clone(), near: fog.near, far: fog.far }
      fog.color.copy(UNDER_FOG)
      fog.near = 0.5
      fog.far = 22
    } else if (!under && this.fog) {
      fog.color.copy(this.fog.color)
      fog.near = this.fog.near
      fog.far = this.fog.far
      this.fog = null
    }
  }

  private worldUv(s: Surface) {
    s.mesh.updateWorldMatrix(true, false)
    const geo = s.mesh.geometry
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const uv = new Float32Array(pos.count * 2)
    const v = new THREE.Vector3()
    const tile = s.kind === T.RIPPLES ? RIPPLE_M : WATER_TILE_M
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(s.mesh.matrixWorld)
      uv[i * 2] = v.x / tile
      uv[i * 2 + 1] = v.z / tile
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    s.uvDone = true
  }

  private stepField() {
    const N = RIPPLE_N, a = this.field, b = this.prev
    for (let z = 0; z < N; z++) {
      const zu = ((z + N - 1) % N) * N, zd = ((z + 1) % N) * N, zr = z * N
      for (let x = 0; x < N; x++) {
        const xl = (x + N - 1) % N, xr = (x + 1) % N
        const i = zr + x
        b[i] = ((a[zr + xl] + a[zr + xr] + a[zu + x] + a[zd + x]) / 2 - b[i]) * RIPPLE_DAMP
      }
    }
    this.field = b
    this.prev = a
  }

  /** Height field -> colour: deep green-blue water lit by its slopes, brighter crests. */
  private paint() {
    const N = RIPPLE_N, h = this.field, px = this.pixels
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x
        const sx = h[z * N + (x + 1) % N] - h[z * N + (x + N - 1) % N]
        const sz = h[((z + 1) % N) * N + x] - h[((z + N - 1) % N) * N + x]
        const light = Math.max(-1, Math.min(1, (sx * 0.7 + sz * 0.5) * 0.9))
        const j = i * 4
        px[j] = Math.max(0, Math.min(255, 70 + light * 110))
        px[j + 1] = Math.max(0, Math.min(255, 125 + light * 110))
        px[j + 2] = Math.max(0, Math.min(255, 140 + light * 100))
        px[j + 3] = Math.max(0, Math.min(255, 150 + Math.abs(light) * 90))
      }
    }
    this.rippleTex.needsUpdate = true
  }
}
