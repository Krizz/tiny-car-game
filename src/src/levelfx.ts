// The level objects that are mostly effects, after the original executable (README "Level
// objects, 2026-10-13"): Museum 1/2's security lasers (cut by a car: sparks and the alarm for 5 s),
// spark generators (Toy World 1's smoke, Museum 2's sparks), the sky's clouds and sun, Ghost Town's
// flags, the garden's dolphin fountain, lawn sprinklers (a car on the hose shuts its sprinkler off),
// Toys in the Hood 1's thrown basketballs (drawn here; thrown and synced in shared/), the practice
// stars (lobby only). The effects are each browser's own.
import * as THREE from 'three'
import { loadTexture } from './assets'
import { SPR, type Fx, type Rect } from './fx'
import type { Physics } from './physics'
import { LevelLoop, play, playLevel } from './sound'
import { Glow } from './glow'
import { T, type LevelObject, type ObjectBodies, type ObjectsInfo } from '../shared/objects'

interface Box { pos: number[]; rot: number[][]; half: number[]; id: number }
type Car = { position: THREE.Vector3 }

const v3 = (a: ArrayLike<number>) => new THREE.Vector3(a[0], a[1], a[2])
/** a column of a 3x3 (the object's axis in the world) */
const axis = (o: { rot: number[][] }, i: number) => new THREE.Vector3(o.rot[0][i], o.rot[1][i], o.rot[2][i])
function inBox(b: { pos: number[]; rot: number[][]; half: number[] }, p: THREE.Vector3, pad = 0) {
  const d = [p.x - b.pos[0], p.y - b.pos[1], p.z - b.pos[2]]
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[0] * b.rot[0][a] + d[1] * b.rot[1][a] + d[2] * b.rot[2][a]) > b.half[a] + pad) return false
  }
  return true
}

// spark kinds (exe's SPARK_ list, by number): what our FX pages draw them with
const SPARK_KIND: Record<number, { r: Rect; size: number; end: number; life: number; g: number; col: number }> = {
  0: { r: SPR.spark, size: 0.12, end: 0.04, life: 0.5, g: 9, col: 0xffc060 },
  1: { r: SPR.spark, size: 0.16, end: 0.05, life: 0.7, g: 9, col: 0xffa040 },
  10: { r: SPR.smoke, size: 0.5, end: 1.6, life: 1.6, g: -0.6, col: 0x9a9a9a },
}

interface Laser { o: LevelObject; from: THREE.Vector3; dir: THREE.Vector3; len: number; beam: THREE.Mesh; glow: THREE.Mesh; alarmUntil: number; nextSpark: number }
interface Sprinkler { o: LevelObject; head: THREE.Object3D | null; angle: number; phase: number; pressure: number; squash: number; lastTick: number }

export class LevelFx {
  private lasers: Laser[] = []
  private hum: LevelLoop | null = null
  private gens: { o: LevelObject; dir: THREE.Vector3; acc: number }[] = []
  private clouds: THREE.Group | null = null
  private flags: { o: LevelObject; mesh: THREE.Mesh; base: Float32Array; along: THREE.Vector3; normal: THREE.Vector3 }[] = []
  private dolphins: LevelObject[] = []
  readonly sprinklers: Sprinkler[] = []
  private hoses: (Box & { o: LevelObject })[] = []
  private ballMeshes = new Map<number, THREE.Object3D>()
  private stars: { o: LevelObject; root: THREE.Object3D; got: boolean; glow: Glow }[] = []
  private raceStar: { o: LevelObject; root: THREE.Object3D; got: boolean; glow: Glow } | null = null
  private mirrored: boolean
  private eye = new THREE.Vector3()
  onStar: (found: number, of: number) => void = () => {}
  /** our car touched the race's star (the server fires the Global Pulse) */
  onRaceStar: (at: THREE.Vector3) => void = () => {}

  constructor(private info: ObjectsInfo & { throws?: Box[] }, private scene: THREE.Scene, private fx: Fx, private physics: Physics, private bodies: ObjectBodies | null, private model: (name: string) => THREE.Mesh | undefined, course: { base: string }, private farPlane: number) {
    this.mirrored = !!info.objectsMirror
    for (const o of info.objects ?? []) {
      switch (o.type) {
        case T.LASER: this.addLaser(o); break
        case T.SPARKGEN: this.gens.push({ o, dir: axis(o, 2).negate(), acc: 0 }); break
        case T.CLOUDS: this.addClouds(o); break
        case T.FLAG: this.addFlag(o, course.base); break
        case T.DOLPHIN: this.dolphins.push(o); break
        case T.HOSE: this.hoses.push({ o, pos: o.pos, rot: o.rot, half: [3.9, 0.6, 0.9], id: o.p[0] }); break
      }
    }
    if (this.lasers.length) this.hum = new LevelLoop('muse/laserhum')
  }

  /** A sprinkler's head (made by ObjectViews), turning on its base. */
  addSprinkler(o: LevelObject, head: THREE.Object3D | null) {
    this.sprinklers.push({ o, head, angle: Math.random() * Math.PI * 2, phase: 0, pressure: 1, squash: 1, lastTick: 0 })
  }

  /** A star. original executable: parameter 0 = 1 is a practice star (Practice mode: here the
   *  lobby), 0 the race's Global Pulse star (races with pickups; one a level, gone once touched). */
  addStar(o: LevelObject, root: THREE.Object3D) {
    const glow = new Glow(0xffd860)
    this.scene.add(glow.root)
    if (o.p[0]) this.stars.push({ o, root, got: false, glow })
    else this.raceStar = { o, root, got: false, glow }
  }

  /** The race's star went (someone touched it). */
  takeRaceStar() {
    if (this.raceStar) this.raceStar.got = true
  }

  // ------------------------------------------------------------ lasers
  private addLaser(o: LevelObject) {
    const from = v3(o.pos), dir = axis(o, 2).negate()
    const hit = this.physics.raycast(from.toArray(), dir.toArray(), 200)
    const len = hit ? hit.dist : 200
    const mk = (r: number, op: number) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 6, 1, true).translate(0, 0.5, 0),
        new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      m.position.copy(from)
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      m.scale.set(1, len, 1)
      m.frustumCulled = false
      this.scene.add(m)
      return m
    }
    this.lasers.push({ o, from, dir, len, beam: mk(0.012 * Math.max(1, o.p[0]), 0.9), glow: mk(0.05, 0.22), alarmUntil: 0, nextSpark: 0 })
  }

  private updateLasers(now: number, cars: Car[]) {
    let nearest = Infinity
    for (const l of this.lasers) {
      // a car across the beam cuts it there (original executable tests the cars along it when its 3rd number is set)
      let cut = l.len
      if (l.o.p[2]) {
        for (const c of cars) {
          const rel = c.position.clone().sub(l.from)
          const along = rel.dot(l.dir)
          if (along <= 0 || along >= cut) continue
          if (rel.addScaledVector(l.dir, -along).length() < 0.45) cut = along
        }
      }
      const flicker = 0.75 + Math.random() * 0.25 * Math.min(1, l.o.p[1] / 3)
      for (const m of [l.beam, l.glow]) {
        m.scale.y = cut
        ;(m.material as THREE.MeshBasicMaterial).opacity = (m === l.beam ? 0.9 : 0.22) * flicker
      }
      const mid = l.from.clone().addScaledVector(l.dir, cut / 2)
      nearest = Math.min(nearest, mid.distanceTo(this.eye))
      if (cut < l.len) {
        const at = l.from.clone().addScaledVector(l.dir, cut)
        if (now > l.nextSpark) {
          l.nextSpark = now + 40
          this.fx.sprite(SPR.spark, at, { size: 0.14, sizeEnd: 0.04, life: 0.4, vel: l.dir.clone().multiplyScalar(-1).add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2)), gravity: 9, color: 0xffd080 })
        }
        if (now > l.alarmUntil) {
          // the hum turns into the alarm for 5 s
          l.alarmUntil = now + 5000
          playLevel('muse/alarm2', Math.min(1, 1.6 / (1 + Math.max(0, at.distanceTo(this.eye) - 10) * 0.08)))
        }
      }
    }
    this.hum?.volume(Math.max(0, 1 - nearest / 18) * 0.6)
  }

  // ------------------------------------------------------------ clouds + sun
  private addClouds(o: LevelObject) {
    const g = new THREE.Group()
    loadTexture('/game/fx/clouds.png').then((tex) => {
      const cell = (c: number) => {
        const t = tex.clone()
        t.needsUpdate = true
        t.repeat.set(0.5, 0.5)
        t.offset.set((c % 2) * 0.5, Math.floor(c / 2) * 0.5)
        return t
      }
      const R = 1
      const mk = (c: number, az: number, el: number, size: number, additive: boolean) => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: cell(c), transparent: true, depthWrite: false, fog: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: additive ? 1 : 0.9 }))
        s.position.set(Math.sin(az) * Math.cos(el) * R, Math.sin(el) * R, Math.cos(az) * Math.cos(el) * R)
        s.scale.setScalar(size)
        s.renderOrder = -1
        g.add(s)
      }
      // the sun where the object looks, then 63 clouds about the sky (two of the page's cloud cells)
      const look = axis(o, 2).negate()
      mk(3, Math.atan2(look.x, look.z), 0.42, 0.32, true)
      for (let i = 1; i < 64; i++) mk(Math.random() < 0.5 ? 0 : 1, Math.random() * Math.PI * 2, 0.06 + Math.random() * 0.5, 0.11 + Math.random() * 0.08, false)
    })
    g.scale.setScalar(this.farPlane * 0.8)
    this.scene.add(g)
    this.clouds = g
  }

  // ------------------------------------------------------------ flags: 10 x 7 cloth
  private addFlag(o: LevelObject & { tex?: string; uv?: number[] }, base: string) {
    const NX = 10, NY = 7, STEP = 0.45
    const along = axis(o, 0).multiplyScalar(this.mirrored ? -1 : 1), down = axis(o, 1).negate()
    const normal = along.clone().cross(down).normalize()
    const pos = new Float32Array(NX * NY * 3), uv = new Float32Array(NX * NY * 2)
    const [u0, v0, uw, vh] = o.uv ?? [0, 0, 73, 49]
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const k = j * NX + i
      const p = v3(o.pos).addScaledVector(along, i * STEP).addScaledVector(down, j * STEP)
      pos.set([p.x, p.y, p.z], k * 3)
      uv.set([(u0 + (i / (NX - 1)) * uw) / 256, (v0 + (j / (NY - 1)) * vh) / 256], k * 2)
    }
    const idx: number[] = []
    for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i
      idx.push(a, a + NX, a + 1, a + 1, a + NX, a + NX + 1)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geo.setIndex(idx)
    const mat = new THREE.MeshBasicMaterial({ color: 0xc8c8c8, side: THREE.DoubleSide })
    if (o.tex) loadTexture(base + o.tex).then((t) => { mat.map = t; mat.needsUpdate = true })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    this.scene.add(mesh)
    this.flags.push({ o, mesh, base: pos.slice(), along, normal })
  }

  private updateFlags(t: number) {
    for (const f of this.flags) {
      const pos = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute
      const amp = 0.025 * Math.max(1, f.o.p[0]) // "Garyness" (3, 10)
      for (let k = 0; k < pos.count; k++) {
        const i = k % 10, j = Math.floor(k / 10)
        const w = (i / 9) * amp * (Math.sin(t * 5.2 - i * 0.9 + j * 0.35) + 0.4 * Math.sin(t * 8.3 - i * 1.7))
        pos.setXYZ(k, f.base[k * 3] + f.normal.x * w, f.base[k * 3 + 1] + f.normal.y * w, f.base[k * 3 + 2] + f.normal.z * w)
      }
      pos.needsUpdate = true
    }
  }

  // ------------------------------------------------------------ sprinklers + hoses
  private updateSprinklers(now: number, dt: number, cars: Car[]) {
    // a car on a hose stops the water of the sprinkler with its ID
    for (const h of this.hoses) {
      if (cars.some((c) => inBox(h, c.position))) for (const s of this.sprinklers) if (s.o.p[0] === h.id) s.squash = 0
    }
    for (const s of this.sprinklers) {
      s.squash += dt
      s.pressure = s.squash < 0.2 ? Math.max(0, s.pressure - dt * 0.5) : Math.min(1, s.pressure + dt * 0.5)
      // turns slowly round, ticking
      s.angle -= dt * 0.2 * s.pressure * Math.PI * 2
      s.phase += dt * 14.285 * (1.5 - s.pressure) * 2
      const wob = Math.sin(s.phase) * 0.04 * s.pressure * Math.PI * 2
      if (s.head) s.head.rotation.y = s.angle + wob
      if (!s.head || s.pressure < 0.05 || now - s.lastTick < 400) continue
      s.lastTick = now
      const world = s.head.getWorldPosition(new THREE.Vector3())
      const d = world.distanceTo(this.eye)
      if (d < 30) playLevel('hood/sprink', Math.min(1, 1.2 / (1 + d * 0.1)) * s.pressure)
      if (d > 80) continue
      const q = s.head.getWorldQuaternion(new THREE.Quaternion())
      const from = new THREE.Vector3(0, -0.08, 0.24).applyQuaternion(q).add(world)
      for (let i = 0; i < 6; i++) {
        const k = (0.2 + Math.random() * 0.8) * s.pressure
        const vel = new THREE.Vector3(0, 13 * k * 0.45, 20 * k * 0.45).applyQuaternion(q)
        this.fx.sprite(SPR.drop, from, { size: 0.2, sizeEnd: 0.1, life: 1.2, vel, gravity: 9.8, color: 0xd8f0ff })
      }
    }
  }

  // ------------------------------------------------------------ thrown basketballs
  // (thrown in shared/objects.ts throwCheck — by the server for everyone, or here when offline)
  private updateThrown() {
    const thrown = this.bodies?.thrown
    if (!thrown) return
    for (const [nid, b] of thrown) {
      let m = this.ballMeshes.get(nid)
      if (!m) {
        m = this.model('basketball') ?? new THREE.Object3D()
        this.scene.add(m)
        this.ballMeshes.set(nid, m)
        const st = this.physics.state(b.id)
        const d = v3(st.pos).distanceTo(this.eye)
        playLevel('hood/basketball', Math.min(1, 1.2 / (1 + d * 0.08)))
      }
      const st = this.physics.state(b.id)
      m.position.set(st.pos[0], st.pos[1], st.pos[2])
      m.quaternion.set(st.quat[0], st.quat[1], st.quat[2], st.quat[3])
    }
    for (const [nid, m] of this.ballMeshes) {
      if (thrown.has(nid)) continue
      this.scene.remove(m)
      this.ballMeshes.delete(nid)
    }
  }

  // ------------------------------------------------------------ stars: the lobby's practice
  private updateStars(t: number, lobby: boolean, cars: Car[]) {
    for (const s of this.stars) {
      s.root.visible = lobby && !s.got
      s.root.rotation.y = t * 2
      s.glow.set(v3(s.o.pos), 1.4, s.root.visible ? 0.55 + 0.15 * Math.sin(t * 5) : 0, this.eye)
      if (!s.root.visible || !cars[0]) continue
      if (cars[0].position.distanceTo(v3(s.o.pos)) < 1.3) {
        s.got = true
        play('pickup', 0.9)
        this.fx.sprite(SPR.flare, v3(s.o.pos), { size: 0.8, sizeEnd: 2.4, life: 0.4, color: 0xffe080 })
        this.onStar(this.stars.filter((x) => x.got).length, this.stars.length)
      }
    }
    if (!lobby) for (const s of this.stars) s.got = false
    const r = this.raceStar
    if (!r) return
    if (lobby) r.got = false // ready for the next race
    r.root.visible = !lobby && !r.got
    r.root.rotation.y = t * 2
    r.glow.set(v3(r.o.pos), 1.6, r.root.visible ? 0.65 + 0.2 * Math.sin(t * 5) : 0, this.eye)
    if (r.root.visible && cars[0] && cars[0].position.distanceTo(v3(r.o.pos)) < 1.3) {
      r.got = true // at once here; the server decides who was first
      this.fx.sprite(SPR.flare, v3(r.o.pos), { size: 1, sizeEnd: 3, life: 0.5, color: 0xffe080 })
      this.onRaceStar(v3(r.o.pos))
    }
  }

  /** Each frame: server-clock ms, s, the camera, the cars on the track (the local one first), lobby or not. */
  update(ms: number, dt: number, eye: THREE.Vector3, cars: Car[], lobby: boolean) {
    const now = performance.now(), t = ms / 1000
    this.eye.copy(eye)
    if (this.lasers.length) this.updateLasers(now, cars)
    for (const g of this.gens) {
      const k = SPARK_KIND[g.o.p[0]] ?? SPARK_KIND[0]
      const every = 5 / Math.max(1, g.o.p[3])
      g.acc += dt
      if (v3(g.o.pos).distanceTo(eye) > 90) { g.acc = 0; continue }
      for (let n = 0; g.acc >= every && n < 8; n++) {
        g.acc -= every
        const speed = (g.o.p[1] + (Math.random() * 2 - 1) * g.o.p[2]) / 10
        const vel = g.dir.clone().multiplyScalar(speed).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6))
        this.fx.sprite(k.r, v3(g.o.pos), { size: k.size, sizeEnd: k.end, life: k.life, vel, gravity: k.g, color: k.col })
      }
      if (g.acc > every * 8) g.acc = 0
    }
    if (this.clouds) {
      this.clouds.position.copy(eye)
      this.clouds.rotation.y = t * 0.004
    }
    if (this.flags.length) this.updateFlags(t)
    for (const o of this.dolphins) {
      if (v3(o.pos).distanceTo(eye) > 80) continue
      for (let i = 0; i < 2; i++) {
        const k = 1.2 + Math.random() * 0.8
        const a = (Math.random() - 0.5) * 0.07
        const local = new THREE.Vector3(Math.sin(a) * 3, 5, Math.cos(a) * 3).multiplyScalar(k * 0.5)
        const vel = local.applyMatrix3(new THREE.Matrix3().set(o.rot[0][0], o.rot[0][1], o.rot[0][2], o.rot[1][0], o.rot[1][1], o.rot[1][2], o.rot[2][0], o.rot[2][1], o.rot[2][2]))
        this.fx.sprite(SPR.drop, v3(o.pos), { size: 0.22, sizeEnd: 0.12, life: 1.1, vel, gravity: 9.8, color: 0xd8f0ff })
      }
    }
    if (this.sprinklers.length) this.updateSprinklers(now, dt, cars)
    this.updateThrown()
    if (this.stars.length || this.raceStar) this.updateStars(t, lobby, cars)
  }
}
