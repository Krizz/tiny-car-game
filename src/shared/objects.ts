// Level objects that move (.fob, convert.py level_objects): where each one is at a given server
// time (so every browser and the server's AI world agree without messages), and the physics of
// the ones cars can touch. Drawing is src/objects.ts.
//
// The .fob gives each object four numbers; their meaning comes from the game's object editor
// (original executable's labels), the units are our reading of them:
//   plane    [speed °/s, radius cm, bank °, direction]  circles its spot, banked
//   copter   [x, y, z range (cm/5), height offset]      drifts about its spot, hovering
//   planet   [which, orbits which, orbit °/s, spin °/s] Museum 2's planetarium
//   horse, balloon, radar, boat: no numbers — rocks / bobs / turns
//   slider   [which way]  Supermarket 2's sliding doors: 4 m out and back every 3 s (original executable)
//   tumbleweed           a light ball the wind rolls about (each world its own, not synced)
//   strobe, lantern, ship light, water, ripples, rain, lightning, water box: drawn only (src/)
import type { LoadedCar, MeshMeta } from '../src/assets'
import type { Physics } from '../src/physics'
import { Car, type Controls } from '../src/car'
import * as THREE from 'three'

export interface LevelObject {
  type: number
  pos: number[]
  rot: number[][] // 3x3, columns = the object's axes in the world
  p: number[]
  models: string[]
}

export interface ObjectsInfo {
  throws?: { pos: number[]; rot: number[][]; half: number[]; id: number }[]
  objects?: LevelObject[]
  objectModels?: Record<string, MeshMeta>
  objectsMirror?: boolean
}

export const T = {
  BALL: 1, PLANET: 2, PLANE: 3, COPTER: 4, DRAGON: 5, WATER: 6, BOAT: 8, RADAR: 10, BALLOON: 11, HORSE: 12,
  STROBE: 14, TUMBLEWEED: 52, LANTERN: 54, SLIDER: 56, BOTTLE: 57, CONE: 59, RAIN: 63, LIGHTNING: 64,
  SHIPLIGHT: 65, PACKET: 66, ABC: 67, WATERBOX: 68, RIPPLES: 69,
  BARREL: 0, TROLLEY: 7, SPARKGEN: 16, LASER: 33, CLOUDS: 38, SPRINKLER: 40, HOSE: 41, THROWER: 42,
  STREAM: 47, STAR: 50, FLAG: 70, DOLPHIN: 71, FOGBOX: 73,
} as const

/**
 * Things cars knock over: a convex shape (body frame, m — the model's extent: our y is up, the
 * model's origin where the level put it) and a mass. Light against a car (~1-2 kg), so they fly.
 */
export const KNOCK: Record<number, { hull: number[][]; mass: number }> = {
  [T.ABC]: { hull: box(-0.3, 0.3, -0.3, 0.3, -0.3, 0.3), mass: 0.25 },
  [T.BOTTLE]: { hull: box(-0.2, 0.2, -0.41, 0.89, -0.2, 0.2), mass: 0.15 },
  [T.PACKET]: { hull: box(-0.34, 0.36, -0.68, 0.7, -0.36, 0.34), mass: 0.3 },
  // a pyramid: wide foot, point on top
  [T.CONE]: { hull: [[-0.6, -0.18, -0.52], [0.6, -0.18, -0.52], [-0.6, -0.18, 0.52], [0.6, -0.18, 0.52], [0, 1.47, 0]], mass: 0.2 },
  // a lawn sprinkler's base (spbase.m; original executable makes it a physics object too): knocked about, and
  // its head (drawn 38 cm above it) goes with it
  [T.SPRINKLER]: { hull: box(-0.42, 0.46, -0.53, 0.47, -0.4, 0.21), mass: 0.4 },
}

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[][] {
  const out: number[][] = []
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push([x, y, z])
  return out
}

/**
 * A sliding door's way out from where the level puts it (m, world): original executable runs it
 * out along its own x axis and back on a 3 s triangle wave, 4 m at the far end — one door of the
 * pair one way (first parameter 0), the other the other way. On the server clock, so every world
 * agrees. Mirrored courses flip it with the rest.
 */
export const SLIDER_PERIOD = 3000
export const SLIDER_TRAVEL = 4
export function sliderOffset(o: LevelObject, ms: number, mirrored: boolean): number[] {
  const k = (((ms % SLIDER_PERIOD) + SLIDER_PERIOD) % SLIDER_PERIOD) / (SLIDER_PERIOD / 2)
  const f = k < 1 ? k : 2 - k
  const d = (o.p[0] ? 1 : -1) * (mirrored ? -1 : 1) * f * SLIDER_TRAVEL
  return [o.rot[0][0] * d, o.rot[1][0] * d, o.rot[2][0] * d]
}
// slider.m: 4.64 m wide, 8.5 m tall about its origin, 26 cm thick behind it
const SLIDER_BOX = [0, 0, 0.13, 2.32, 4.25, 0.13]

/** Tumbleweeds: tumble_weed.m is 1.6 m across; original executable gives it a 70 cm collision sphere. */
export const WEED_R = 0.7
const WEED_MASS = 0.25
const WEED_WIND = 2.6 // m/s the breeze pushes them at
const WEED_ROAM = 40 // m from home before one is put back
const WEED_STUCK_S = 25

const IDLE: Controls = { throttle: 0, steer: 0, handbrake: false }

export const HORSE_ROCK = 0.16 // rad
export const HORSE_PERIOD = 1.9 // s

/** A rocking horse's tilt (rad, about its own x axis) at a time; each horse keeps its own beat. */
export function horseTilt(o: LevelObject, ms: number) {
  const phase = (o.pos[0] * 0.37 + o.pos[2] * 0.11) % (Math.PI * 2)
  return HORSE_ROCK * Math.sin((ms / 1000) * ((Math.PI * 2) / HORSE_PERIOD) + phase)
}

/**
 * The bodies cars meet: rocking horses (kinematic boxes, rocked every step) and the beach ball
 * (a light, bouncy dynamic sphere). The server's world is the one that counts for everything loose
 * (shared/objnet.ts); browsers pull their copies towards it.
 */
export class ObjectBodies {
  private horses: { o: LevelObject; id: number }[] = []
  private sliders: { o: LevelObject; id: number; q: number[] }[] = []
  readonly weeds: { o: LevelObject; id: number; still: number }[] = []
  private mirrored: boolean
  private wind: number[]
  readonly balls: { o: LevelObject; id: number }[] = []
  readonly loose = new Map<LevelObject, number>() // knockable things -> body
  /** every body the server keeps the same for everyone (shared/objnet.ts): net id -> body. Net id =
   *  the object's index in the level's list; thrown basketballs 10000 + n */
  readonly net = new Map<number, number>()
  /** the server's states are coming in: its tumbleweed breeze and throws, not ours */
  synced = false
  readonly trolleys: { o: LevelObject; car: Car }[] = []
  readonly thrown = new Map<number, { id: number; until: number; from?: LevelObject }>()
  private throwAt = new Map<number, number>()
  private nextThrow = 10000

  /** Where the knockable things are now, for CPU drivers to steer round: [x, y, z, r] — r = half
   *  the thing's longest side + half a car (the look-ahead's rays only see the static track). */
  obstacles(): number[][] {
    const out: number[][] = []
    for (const [o, id] of this.loose) {
      const k = KNOCK[o.type]
      const ext = Math.max(...[0, 1, 2].map((a) => Math.max(...k.hull.map((p) => p[a])) - Math.min(...k.hull.map((p) => p[a]))))
      const p = this.physics.state(id).pos
      out.push([p[0], p[1], p[2], ext / 2 + 0.3])
    }
    // the trolleys (cars/trolley: about 1 m long)
    for (const t of this.trolleys) out.push([t.car.position.x, t.car.position.y, t.car.position.z, 0.9])
    return out
  }

  constructor(private info: ObjectsInfo, private physics: Physics) {
    this.mirrored = !!info.objectsMirror
    // one breeze a level, from its first tumbleweed's place (any way will do, as long as it's fixed)
    const w0 = info.objects?.find((o) => o.type === T.TUMBLEWEED)
    const a = w0 ? (w0.pos[0] * 0.13 + w0.pos[2] * 0.07) % (Math.PI * 2) : 0
    this.wind = [Math.cos(a), 0, Math.sin(a)]
    for (const o of info.objects ?? []) {
      if (o.type === T.SLIDER) {
        const q = rotQuat(o.rot)
        const id = physics.createKinematic([SLIDER_BOX], o.pos, q)
        if (id >= 0) this.sliders.push({ o, id, q })
        continue
      }
      if (o.type === T.TUMBLEWEED) {
        const id = physics.createBall(WEED_R, WEED_MASS, [o.pos[0], o.pos[1] + 0.1, o.pos[2]], [0, 0, 0], 0.6, 0.45)
        if (id >= 0) {
          physics.setDamping(id, 0.15, 0.3)
          this.weeds.push({ o, id, still: 0 })
          this.net.set(info.objects!.indexOf(o), id)
        }
        continue
      }
      if (o.type === T.HORSE) {
        // Horse.m: 0.56 wide, 1.98 tall, rockers 2.3 m long
        const id = physics.createKinematic([[0, 0.99, 0.08, 0.28, 0.99, 1.16]], o.pos, this.quat(o, 0))
        this.horses.push({ o, id })
      } else if (o.type === T.BALL) {
        const id = physics.createBall(1.0, 0.6, [o.pos[0], o.pos[1] + 1.05, o.pos[2]], [0, 0, 0], 0.5, 0.75)
        physics.setDamping(id, 0.4, 0.6)
        this.balls.push({ o, id })
        this.net.set(info.objects!.indexOf(o), id)
      } else if (KNOCK[o.type]) {
        const k = KNOCK[o.type]
        const ext = [0, 1, 2].map((a) => Math.max(...k.hull.map((p) => p[a])) - Math.min(...k.hull.map((p) => p[a])))
        const inertia = [k.mass * (ext[1] ** 2 + ext[2] ** 2) / 12, k.mass * (ext[0] ** 2 + ext[2] ** 2) / 12, k.mass * (ext[0] ** 2 + ext[1] ** 2) / 12]
        const com = [0, 1, 2].map((a) => k.hull.reduce((s, p) => s + p[a], 0) / k.hull.length)
        const id = physics.createCar(k.hull, k.mass, com, inertia, o.pos, rotQuat(o.rot), 0.5)
        if (id >= 0) {
          physics.setDamping(id, 0.3, 0.5)
          this.loose.set(o, id)
          this.net.set(info.objects!.indexOf(o), id)
        }
      }
    }
  }

  /** Supermarket 1 and 2's shopping trolleys: cars/trolley with nobody driving (the original makes them
   *  cars too). `load` fetches the car (browser or server). */
  async addTrolleys(load: (key: string) => Promise<LoadedCar>) {
    for (const o of this.info.objects ?? []) {
      if (o.type !== T.TROLLEY) continue
      const car = new Car(this.physics, await load('trolley'), new THREE.Vector3(o.pos[0], o.pos[1] + 0.3, o.pos[2]), Math.atan2(o.rot[0][2], o.rot[2][2]))
      this.trolleys.push({ o, car })
      this.net.set(this.info.objects!.indexOf(o), car.id)
    }
  }

  /** A basketball (Toys in the Hood 1's throwers): models/basketball.m, 0.5 m, light and bouncy. */
  spawnBall(nid: number, pos: number[], vel: number[], from?: LevelObject) {
    const id = this.physics.createBall(0.5, 0.6, pos, vel, 0.5, 0.75)
    if (id < 0) return
    this.physics.setDamping(id, 0.1, 0.3)
    this.thrown.set(nid, { id, until: performance.now() + 15000, from })
    this.net.set(nid, id)
  }

  /** Throw-trigger boxes (.tri type 6): a car entering one has the thrower with its ID throw a
   *  basketball (the 2nd number names the object: 43), at its 3rd number / 10 m/s. Not while the
   *  server's states come in (it throws them for everyone). */
  throwCheck(cars: { x: number; y: number; z: number }[], now: number) {
    if (this.synced) return
    for (const b of this.info.throws ?? []) {
      if ((this.throwAt.get(b.id) ?? 0) > now - 4000) continue
      const hit = cars.some((c) => {
        const d = [c.x - b.pos[0], c.y - b.pos[1], c.z - b.pos[2]]
        for (let a = 0; a < 3; a++) if (Math.abs(d[0] * b.rot[0][a] + d[1] * b.rot[1][a] + d[2] * b.rot[2][a]) > b.half[a]) return false
        return true
      })
      if (!hit) continue
      this.throwAt.set(b.id, now)
      for (const o of this.info.objects ?? []) {
        if (o.type !== T.THROWER || o.p[0] !== b.id || o.p[1] !== 43) continue
        const dir = [-o.rot[0][2], -o.rot[1][2] + 0.35, -o.rot[2][2]]
        const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
        const sp = o.p[2] / 10
        this.spawnBall(this.nextThrow, o.pos, dir.map((v) => (v / l) * sp), o)
        this.nextThrow = this.nextThrow >= 65000 ? 10000 : this.nextThrow + 1
      }
    }
  }

  private quat(o: LevelObject, tilt: number): number[] {
    // the object's yaw (from its look axis) then the tilt about its x
    const yaw = Math.atan2(o.rot[0][2], o.rot[2][2])
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cx = Math.cos(tilt / 2), sx = Math.sin(tilt / 2)
    return [cy * sx, sy * cx, -sy * sx, cy * cx]
  }

  /** Before every physics step, with the step's server time. */
  step(ms: number) {
    const dt = 1 / 120
    for (const t of this.trolleys) t.car.drive(IDLE, dt)
    const now = performance.now()
    for (const [nid, b] of this.thrown) {
      if (now < b.until) continue
      this.physics.destroyCar(b.id)
      this.thrown.delete(nid)
      this.net.delete(nid)
    }
    for (const s of this.sliders) {
      const a = sliderOffset(s.o, ms, this.mirrored), b = sliderOffset(s.o, ms + 1000 * dt, this.mirrored)
      this.physics.setPose(s.id, [s.o.pos[0] + a[0], s.o.pos[1] + a[1], s.o.pos[2] + a[2]], s.q)
      this.physics.setVelocity(s.id, [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt, (b[2] - a[2]) / dt], [0, 0, 0])
    }
    // the breeze: eases each tumbleweed's ground speed towards the wind's (gusting), with a hop now
    // and then; one that has strayed, fallen off the world or sat against a wall goes back home
    const gust = 0.6 + 0.4 * Math.sin(ms / 2300) * Math.sin(ms / 5100)
    for (const w of this.synced ? [] : this.weeds) {
      const st = this.physics.state(w.id)
      const v = st.vel
      const want = [this.wind[0] * WEED_WIND * gust, this.wind[2] * WEED_WIND * gust]
      const k = Math.min(1, dt * 0.9)
      const nv = [v[0] + (want[0] - v[0]) * k, v[1], v[2] + (want[1] - v[2]) * k]
      if (Math.abs(v[1]) < 0.05 && Math.random() < dt * 0.35) nv[1] += 1.5 + Math.random() * 1.5
      this.physics.setVelocity(w.id, nv, st.ang)
      const p = st.pos, h = w.o.pos
      w.still = Math.hypot(v[0], v[2]) < 0.3 ? w.still + dt : 0
      const far = Math.hypot(p[0] - h[0], p[2] - h[2]) > WEED_ROAM || p[1] < h[1] - 15
      if (far || w.still > WEED_STUCK_S) {
        this.physics.setPose(w.id, [h[0], h[1] + 0.1, h[2]], [0, 0, 0, 1])
        this.physics.setVelocity(w.id, [0, 0, 0], [0, 0, 0])
        w.still = 0
      }
    }
    for (const h of this.horses) {
      const a = horseTilt(h.o, ms), b = horseTilt(h.o, ms + 1000 / 120)
      this.physics.setPose(h.id, h.o.pos, this.quat(h.o, a))
      const w = (b - a) * 120
      const yaw = Math.atan2(h.o.rot[0][2], h.o.rot[2][2])
      this.physics.setVelocity(h.id, [0, 0, 0], [Math.cos(yaw) * w, 0, -Math.sin(yaw) * w])
    }
  }
}

/** A 3x3 (columns = axes) as a quaternion [x, y, z, w]. */
export function rotQuat(r: number[][]): number[] {
  const m00 = r[0][0], m11 = r[1][1], m22 = r[2][2]
  const tr = m00 + m11 + m22
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    return [(r[2][1] - r[1][2]) / s, (r[0][2] - r[2][0]) / s, (r[1][0] - r[0][1]) / s, s / 4]
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    return [s / 4, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s, (r[2][1] - r[1][2]) / s]
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    return [(r[0][1] + r[1][0]) / s, s / 4, (r[1][2] + r[2][1]) / s, (r[0][2] - r[2][0]) / s]
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2
  return [(r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, s / 4, (r[1][0] - r[0][1]) / s]
}
