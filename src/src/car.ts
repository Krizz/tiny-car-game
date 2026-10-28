// Raycast vehicle on a Box3D convex hull, tuned from the car's own
// Parameters.txt (converted to metres by convert.py).
//
// Each fixed step, before the world steps:
//   suspension  one ray per wheel along the body's down axis; spring + damper
//               from SPRING n {Stiffness, Damping}, travel from WHEEL n {MaxPos}
//   tyres       per-wheel impulses at the contact point: lateral slip killed up
//               to the friction circle (static/kinetic friction × load),
//               engine drive on powered wheels, brakes, rolling drag
//   aero        original game's DownForceMod (more load = more grip at speed)
// Box3D integrates the body and resolves hull contacts (walls, other cars).
import { Aerial } from './aerial'
import * as THREE from 'three'
import type { CarInfo, LoadedCar } from './assets'
import { GRAVITY, Physics } from './physics'
import { bumpAt, surface } from './surfaces'

export interface Controls {
  throttle: number // -1 brake/reverse .. 1 accelerate
  steer: number // -1 right .. 1 left
  handbrake: boolean
}

const STEER_MAX = 0.42 // rad at |SteerRatio| = 0.5 and standstill
const BRAKE_DECEL = 26 // m/s² (all wheels together)
const ROLL_DRAG = 1.2 // m/s² coasting
// angular damping in the air (Box3D, 1/s): original game cars fly off a lip fairly level (ResMod); at 1.2 the
// pitch picked up as the front wheels left a shelf kept turning them nose-first into the floor
// (RC Bandit flipped twice a lap on Toy World 1, Toyeca/others on Toy World 2)
const AIR_ANG = 3

const DROOP = 0.6 // wheels hang this much (× MaxPos) below rest before leaving the ground
const ROLL_INFLUENCE = 0.75 // lift tyre forces towards the CoM: original game cars lean but rarely trip over in a flat corner
// ...and more for a tall, narrow car (the R6's CoM is 29 cm over its pivots, 18 cm half track): the
// tyre force's lever under the CoM stays at most ROLL_ARM × half track, so it takes ~3 g to trip any car
const ROLL_ARM = 0.35

const v3 = () => new THREE.Vector3()

// Suspension visuals (original game draws these from the car's own models): an axle
// runs from its body mount out to the wheel's pivot (WHEEL Offset1); a spring
// from its body mount down onto that axle; a pin stands on the pivot and turns
// with the steering. Axles/springs are stretched to the distance they span.
interface Link {
  kind: 'axle' | 'spring' | 'pin'
  wheel: number
  holder: THREE.Group
  mesh: THREE.Mesh
  from: THREE.Vector3 // body frame
  length: number
}
const AXIS = { axle: new THREE.Vector3(0, 0, -1), spring: new THREE.Vector3(0, -1, 0) }

interface WheelRuntime {
  rest: THREE.Vector3 // wheel centre at rest, body frame
  contact: boolean
  compression: number // m, + = compressed
  pos: number // current wheel centre offset along -up from rest (visual)
  spin: number
  steer: number
  skid: number // 0..1 how much the tyre slides (sound/marks)
  load: number
  surface: number // floor material under it (surfaces.ts)
  oil: number // performance.now() until which this tyre has lost its traction (it went through oil)
  oilMark: number // ... and until which it leaves an oily track
}

export class Car {
  readonly id: number
  readonly info: CarInfo
  readonly root = new THREE.Group()
  readonly bodyMesh: THREE.Mesh
  readonly wheelMeshes: (THREE.Object3D | null)[] = []
  readonly wheels: WheelRuntime[]
  private rollInfluence = ROLL_INFLUENCE
  private links: Link[] = []
  private aerial: Aerial | null = null
  steer = 0
  grounded = 0
  speed = 0 // forward m/s
  readonly velocity = new THREE.Vector3() // world m/s (last readState)
  vtop: number
  accel: number
  upsideTime = 0
  slideYaw = 0
  slide = 0 // past the finish: which way the car is thrown into its slide (±1, 0 = not yet)
  // weapon effects on this car (performance.now() ms until which they last)
  zappedUntil = 0 // electro: motor dead, steering weak
  iceLag = 1 // × the floor's slide lag (surfaces.ts `lag`): CPU drivers get less — they can't feel a slide
  hitAt = -1e9 // when a weapon last threw it about (the CPU driver doesn't learn from those crashes)
  turboUntil = 0 // turbo battery: more power, higher top speed
  now = 0 // set by the game each frame
  netFlags = 0 // a remote car's state flags (see protocol)

  // scratch
  private q = new THREE.Quaternion()
  private pos = v3()
  private com = v3()
  private up = v3()
  private fwd = v3()
  private right = v3()

  constructor(
    readonly physics: Physics,
    loaded: LoadedCar,
    position: THREE.Vector3,
    yaw: number,
    readonly remote = false,
  ) {
    const info = (this.info = loaded.info)
    this.bodyMesh = loaded.body
    this.root.add(this.bodyMesh)
    this.wheels = info.wheels.map((w, i) => {
      const m = loaded.wheels[i]
      const holder = new THREE.Group()
      if (m) holder.add(m)
      this.root.add(holder)
      this.wheelMeshes.push(m ? holder : null)
      return {
        rest: new THREE.Vector3(w.offset1[0] + w.offset2[0], w.offset1[1] + w.offset2[1], w.offset1[2] + w.offset2[2]),
        contact: false, compression: 0, pos: 0, spin: 0, steer: 0, skid: 0, load: 0, surface: 0, oil: 0, oilMark: 0,
      }
    })
    const link = (kind: Link['kind'], wheel: number, l: { mesh: number; offset: number[]; length: number } | undefined) => {
      if (!l || l.mesh < 0 || !loaded.part || !info.wheels[wheel]?.present) return
      const mesh = loaded.part(l.mesh)
      if (!mesh) return
      const holder = new THREE.Group()
      holder.add(mesh)
      this.root.add(holder)
      this.links.push({ kind, wheel, holder, mesh, from: new THREE.Vector3(...l.offset), length: Math.abs(l.length) })
    }
    if (info.aerial && loaded.part) {
      this.aerial = new Aerial(info.aerial, loaded.part)
      this.root.add(this.aerial.group)
    }
    for (let i = 0; i < 4; i++) {
      link('axle', i, info.axles?.[i])
      link('spring', i, info.springs?.[i])
      link('pin', i, info.pins?.[i])
    }
    this.vtop = Math.max(5, info.topEnd / 100)
    this.accel = Math.max(8, info.acc * 3.2)
    {
      const ws = info.wheels.filter((w) => w.present)
      if (ws.length) {
        const ground = Math.min(...ws.map((w) => w.offset1[1] + w.offset2[1] - w.radius))
        const halfTrack = Math.min(...ws.map((w) => Math.abs(w.offset1[0] + w.offset2[0])))
        const h = info.com[1] - ground
        if (h > 0 && halfTrack > 0) this.rollInfluence = Math.max(ROLL_INFLUENCE, Math.min(0.95, 1 - ROLL_ARM * halfTrack / h))
      }
    }

    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    const hull = info.hull.length >= 4 ? info.hull : boxHull()
    // tyre spheres at the top of each wheel's travel: they block walls at the
    // sides, and only reach the floor when the suspension bottoms out
    const tyres = info.wheels.filter((w) => w.present).map((w) => [
      w.offset1[0] + w.offset2[0], w.offset1[1] + w.offset2[1] + w.maxPos, w.offset1[2] + w.offset2[2], w.radius * 0.92,
    ])
    this.id = physics.createCar(hull, info.body.mass, info.com, info.body.inertia,
      [position.x, position.y, position.z], [q.x, q.y, q.z, q.w], 0.25, remote, tyres)
    physics.setDamping(this.id, 0.05, 0.6)
    this.readState()
  }

  destroy() {
    this.physics.destroyCar(this.id)
    this.root.removeFromParent()
  }

  readState() {
    const s = this.physics.state(this.id)
    this.pos.set(s.pos[0], s.pos[1], s.pos[2])
    this.q.set(s.quat[0], s.quat[1], s.quat[2], s.quat[3])
    this.com.set(s.com[0], s.com[1], s.com[2])
    this.up.set(0, 1, 0).applyQuaternion(this.q)
    this.fwd.set(0, 0, -1).applyQuaternion(this.q)
    this.right.set(1, 0, 0).applyQuaternion(this.q)
    this.velocity.set(s.vel[0], s.vel[1], s.vel[2])
    this.speed = s.vel[0] * this.fwd.x + s.vel[1] * this.fwd.y + s.vel[2] * this.fwd.z
    return s
  }

  get position(): THREE.Vector3 { return this.pos }
  get quaternion(): THREE.Quaternion { return this.q }
  get forward(): THREE.Vector3 { return this.fwd }
  get upAxis(): THREE.Vector3 { return this.up }

  /** Inverse effective mass of the body for an impulse along d at world point p. */
  private invMass(p: THREE.Vector3, d: THREE.Vector3, invI: number[]): number {
    const r = v3().subVectors(p, this.com)
    const rxd = v3().crossVectors(r, d)
    const ix = invI[0] * rxd.x + invI[1] * rxd.y + invI[2] * rxd.z
    const iy = invI[3] * rxd.x + invI[4] * rxd.y + invI[5] * rxd.z
    const iz = invI[6] * rxd.x + invI[7] * rxd.y + invI[8] * rxd.z
    return 1 / this.info.body.mass + rxd.x * ix + rxd.y * iy + rxd.z * iz
  }

  /** Apply suspension + tyre impulses for one fixed step. */
  drive(c: Controls, dt: number) {
    const info = this.info
    const ph = this.physics
    const s = this.readState()
    const mass = info.body.mass
    const invI = ph.invInertia(this.id)
    const speedAbs = Math.hypot(s.vel[0], s.vel[1], s.vel[2])

    const zapped = this.now < this.zappedUntil
    const turbo = this.now < this.turboUntil
    if (zapped) c = { throttle: Math.min(0, c.throttle) * 0.3, steer: c.steer * 0.5, handbrake: c.handbrake }
    const vtop = this.vtop * (turbo ? 1.35 : 1)
    const accel = this.accel * (turbo ? 1.8 : 1)
    // steering: approach the input at SteerRate, less lock at speed (SteerMod)
    const target = c.steer / (1 + (Math.abs(this.speed) / this.vtop) * info.steerMod * 2.5)
    const rate = info.steerRate * dt * 1.6
    this.steer += Math.max(-rate, Math.min(rate, target - this.steer))

    const nPowered = info.wheels.filter((w) => w.present && w.powered).length || 1
    let grounded = 0
    const origin = v3(), dir = v3(), wheelFwd = v3(), side = v3(), n = v3(), cp = v3(), ap = v3()
    const ray = this.wheels.map((w, i) => {
      const wi = info.wheels[i]
      if (!wi.present) return null
      origin.copy(w.rest).addScaledVector(new THREE.Vector3(0, 1, 0), wi.maxPos).applyQuaternion(this.q).add(this.pos)
      dir.copy(this.up).negate()
      const len = wi.radius + wi.maxPos * (2 + DROOP)
      return ph.raycast(origin.toArray(), dir.toArray(), len)
    })

    // downforce: more load (and grip) with speed
    // wheels that will touch: each takes its share of the slip correction
    // (all of them cancelling the whole slip overshoots: ±v every step)
    const touching = ray.filter((h, i) => h && info.wheels[i].maxPos - (h.dist - info.wheels[i].radius) >= -info.wheels[i].maxPos * DROOP).length || 1
    const down = (mass * GRAVITY * 0.25 * info.downForceMod * Math.min(1.5, (speedAbs / this.vtop) ** 2))

    const pending: number[][] = []
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]
      const wi = info.wheels[i]
      const spr = info.springs[i]
      const hit = ray[i]
      w.contact = false
      w.skid = 0
      w.load = 0
      const steerAngle = wi.turnable ? this.steer * STEER_MAX * Math.abs(wi.steerRatio) / 0.5 : 0
      w.steer = steerAngle
      if (!hit) {
        w.pos += (wi.maxPos * DROOP - w.pos) * Math.min(1, dt * 12)
        w.spin += (c.throttle * 20 * (wi.powered ? 1 : 0)) * dt
        continue
      }
      const sf = surface(hit.material)
      w.surface = hit.material
      const d = hit.dist - wi.radius // top of travel -> wheel centre
      const x = wi.maxPos - d + bumpAt(sf, hit.point[0], hit.point[2]) // compression (+ washboard floors)
      // drawn where the tyre meets the ground (past full travel the tyre sphere holds the body)
      w.pos = Math.max(-wi.maxPos * 1.8, Math.min(wi.maxPos * DROOP, -x))
      if (x < -wi.maxPos * DROOP) continue
      w.contact = true
      grounded++
      n.set(hit.normal[0], hit.normal[1], hit.normal[2])
      cp.set(hit.point[0], hit.point[1], hit.point[2])
      const vp = ph.pointVelocity(this.id, cp.toArray())
      const vn = vp[0] * n.x + vp[1] * n.y + vp[2] * n.z

      // spring + damper (+ bump stop past full travel)
      const k = spr ? spr.stiffness : 300
      const cdamp = spr ? spr.damping : 6
      let F = k * Math.max(0, x) - cdamp * vn
      if (x > wi.maxPos) F += k * 8 * (x - wi.maxPos)
      F = Math.max(0, F)
      const upDot = Math.max(0, n.dot(this.up))
      pending.push([n.x * F * dt, n.y * F * dt, n.z * F * dt, cp.x, cp.y, cp.z])
      w.compression = x
      w.load = F * upDot + down / 4

      // tyre frame on the contact plane
      wheelFwd.copy(this.fwd).applyAxisAngle(this.up, steerAngle)
      wheelFwd.addScaledVector(n, -wheelFwd.dot(n)).normalize()
      side.crossVectors(wheelFwd, n).normalize()
      // a conveyor floor: the tyre grips the moving belt, so slip is measured against it
      const vr = [vp[0], vp[1], vp[2]]
      if (sf.move) {
        const mx = this.physics.mirrored ? -sf.move[0] : sf.move[0], my = sf.move[1], mz = sf.move[2]
        const mn = mx * n.x + my * n.y + mz * n.z
        vr[0] -= mx - n.x * mn
        vr[1] -= my - n.y * mn
        vr[2] -= mz - n.z * mn
      }
      const vlong = vr[0] * wheelFwd.x + vr[1] * wheelFwd.y + vr[2] * wheelFwd.z
      const vlat = vr[0] * side.x + vr[1] * side.y + vr[2] * side.z
      w.spin += (vlong / wi.radius) * dt

      // apply point: contact lifted towards the CoM height (less roll-over)
      ap.copy(cp).lerp(this.com, this.rollInfluence)
      // lateral: cancel the slip (shared across the grounded wheels)
      const mLat = 1 / this.invMass(ap, side, invI)
      // (on ice only part of it each step: the slide dies away over sf.lag seconds)
      let jLat = (-vlat * mLat * (sf.lag > 0 ? Math.min(0.9, dt / (sf.lag * this.iceLag)) : 0.9)) / touching
      // longitudinal
      let jLong = 0
      const mLong = 1 / this.invMass(ap, wheelFwd, invI)
      const movingFwd = this.speed > 0.5, movingBack = this.speed < -0.5
      const braking = (c.throttle < 0 && movingFwd) || (c.throttle > 0 && movingBack)
      if (braking) {
        const want = -vlong * mLong
        const cap = (BRAKE_DECEL * mass / 4) * dt * Math.abs(c.throttle)
        jLong = Math.max(-cap, Math.min(cap, want))
      } else if (wi.powered && c.throttle !== 0 && !(c.handbrake && i >= 2)) {
        const top = c.throttle > 0 ? vtop : vtop * 0.45
        const along = Math.abs(this.speed)
        const f = Math.max(0, 1 - along / top)
        jLong = Math.sign(c.throttle) * Math.abs(c.throttle) * accel * (mass / nPowered) * f * dt
      } else {
        const want = -vlong * mLong
        const cap = (ROLL_DRAG * mass / 4) * dt
        jLong = Math.max(-cap, Math.min(cap, want))
      }
      if (c.handbrake && i >= 2) {
        const want = -vlong * mLong
        const cap = (BRAKE_DECEL * 0.6 * mass / 4) * dt
        jLong = Math.max(-cap, Math.min(cap, want))
      }

      // friction circle
      let mu = wi.staticFriction * sf.friction
      if (c.handbrake && i >= 2) mu *= 0.35
      // oil slick, per tyre as the game's readme has it: "each tire that is driven through this pool
      // of oil temporarily loses traction"
      const oily = this.now < w.oil
      if (oily) mu *= 0.18
      const limit = mu * w.load * dt
      const mag = Math.hypot(jLat, jLong)
      if (mag > limit && mag > 0) {
        const kin = (c.handbrake && i >= 2 ? 0.35 : 1) * (oily ? 0.15 : 1) * wi.kineticFriction * sf.friction * sf.slip * w.load * dt
        const sc = kin / mag
        jLat *= sc
        jLong *= sc
        w.skid = Math.min(1, (mag - limit) / (limit + 1e-6))
      }
      pending.push([
        side.x * jLat + wheelFwd.x * jLong,
        side.y * jLat + wheelFwd.y * jLong,
        side.z * jLat + wheelFwd.z * jLong,
        ap.x, ap.y, ap.z,
      ])
    }
    // all wheels measured the same body state; apply together (applying as we
    // go made the first wheel's push skew every later wheel: a steady yaw)
    for (const j of pending) ph.impulseAt(this.id, [j[0], j[1], j[2]], [j[3], j[4], j[5]])
    this.grounded = grounded

    // downforce pushes the body into the road
    if (grounded > 0 && down > 0) {
      ph.impulseAt(this.id, [-this.up.x * down * dt, -this.up.y * down * dt, -this.up.z * down * dt], this.com.toArray())
    }
    // the level's force fields: the water in the pond, the pool, Hood 2's stream (shared/fields.ts)
    ph.fields?.apply(ph, this.id, s.pos, s.vel, s.ang, this.up, this.com.toArray(), dt)
    // in the air original game cars keep spinning less wildly (ResMod)
    ph.setDamping(this.id, grounded ? 0.08 : 0.02, grounded ? 0.6 : AIR_ANG)

    // upside down and stuck -> flip back on the wheels after a moment
    // ...or lying on its side, propped on something (past ~60°: it can't drive away from that) —
    // a car leaning on the edge of the Hood's wooden ramp stayed there for good
    if ((this.up.y < 0.2 || (this.up.y < 0.5 && grounded < 2)) && speedAbs < 1.5) this.upsideTime += dt
    else this.upsideTime = 0
  }

  /** A weapon blast at `at`: push away + up, with a random tumble. Falls off to 0 at `radius`. */
  blast(at: THREE.Vector3, radius: number, push: number, lift: number, spin: number) {
    const d = this.pos.clone().sub(at)
    const dist = d.length()
    if (dist > radius) return 0
    this.hitAt = this.now
    const k = 1 - dist / radius * 0.6
    d.y = 0
    if (d.lengthSq() < 1e-6) d.set(Math.random() - 0.5, 0, Math.random() - 0.5)
    d.normalize()
    const m = this.info.body.mass
    const imp = [d.x * push * k * m, lift * k * m, d.z * push * k * m]
    // a little below the centre of mass: cars flip over, as in the original
    const p = this.com.clone().addScaledVector(this.up, -0.05).addScaledVector(d, -0.05)
    this.physics.impulseAt(this.id, imp, p.toArray())
    const r = () => (Math.random() * 2 - 1) * spin * k * m * 0.1
    this.physics.angularImpulse(this.id, [r(), r(), r()])
    return k
  }

  /** Teleport upright at p, facing yaw, at rest. */
  place(p: THREE.Vector3, yaw: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    this.physics.setPose(this.id, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w])
    this.physics.setVelocity(this.id, [0, 0, 0], [0, 0, 0])
    this.steer = 0
    this.upsideTime = 0
    this.slide = 0
    this.readState()
  }

  /** Copy physics pose to the meshes (with an optional interpolation pose). */
  sync(p?: THREE.Vector3, q?: THREE.Quaternion) {
    this.root.position.copy(p ?? this.pos)
    this.root.quaternion.copy(q ?? this.q)
    this.aerial?.update(this.velocity, this.root.quaternion)
    for (let i = 0; i < this.wheels.length; i++) {
      const h = this.wheelMeshes[i]
      if (!h) continue
      const w = this.wheels[i]
      // wheel models are built around the pivot (Offset1): the tyre already sits
      // Offset2 outboard of their origin and the hub stub reaches in to the axle
      h.position.copy(this.pivot(i))
      h.rotation.set(-w.spin, w.steer, 0, 'YXZ')
    }
    for (const l of this.links) {
      const pivot = this.pivot(l.wheel)
      if (l.kind === 'pin') {
        // a kingpin through the hub: centred on the pivot, not standing on it
        if (!l.mesh.geometry.boundingBox) l.mesh.geometry.computeBoundingBox()
        const bb = l.mesh.geometry.boundingBox!
        l.mesh.position.y = -(bb.min.y + bb.max.y) / 2
        l.holder.position.copy(pivot).add(l.from)
        l.holder.rotation.set(0, this.wheels[l.wheel].steer, 0)
        continue
      }
      let to = pivot
      if (l.kind === 'spring') {
        // land on the axle (the point of it nearest the spring's mount), else the pivot
        const axle = this.links.find((a) => a.kind === 'axle' && a.wheel === l.wheel)
        if (axle) {
          const seg = pivot.clone().sub(axle.from)
          const k = Math.max(0, Math.min(1, l.from.clone().sub(axle.from).dot(seg) / Math.max(1e-6, seg.lengthSq())))
          to = axle.from.clone().addScaledVector(seg, k)
        }
      }
      const d = to.clone().sub(l.from)
      const len = d.length()
      l.holder.position.copy(l.from)
      if (len > 1e-5) l.holder.quaternion.setFromUnitVectors(AXIS[l.kind], d.divideScalar(len))
      const s = l.length > 1e-4 ? len / l.length : 1
      if (l.kind === 'axle') l.mesh.scale.set(1, 1, s)
      else l.mesh.scale.set(1, s, 1)
    }
  }

  /** A point up the aerial (0 foot .. 1 tip) in world space, or null for a car without one. */
  aerialPoint(t: number): THREE.Vector3 | null {
    return this.aerial ? this.aerial.worldPoint(t) : null
  }

  private puttyMats: THREE.MeshBasicMaterial[] | null = null
  /** Covered in putty (carrying the putty bomb): the body goes black, as in original game. */
  putty(on: boolean) {
    if (!on && !this.puttyMats) return
    if (!this.puttyMats) {
      // own copies: the same car model's materials are shared with every other copy of it
      const mats = (Array.isArray(this.bodyMesh.material) ? this.bodyMesh.material : [this.bodyMesh.material]) as THREE.MeshBasicMaterial[]
      this.puttyMats = mats.map((m) => m.clone())
      this.bodyMesh.material = Array.isArray(this.bodyMesh.material) ? this.puttyMats : this.puttyMats[0]
    }
    // black while it's on (carlight.ts leaves these alone then; off, it lights them again)
    for (const m of this.puttyMats) {
      m.userData.putty = on
      if (on) m.color.setHex(0x1c1c1c)
    }
  }

  /** The wheel's pivot (WHEEL Offset1) in the body frame, moved by the suspension. */
  private pivot(i: number): THREE.Vector3 {
    const o = this.info.wheels[i].offset1
    return new THREE.Vector3(o[0], o[1] - this.wheels[i].pos, o[2])
  }
}

/**
 * After the finish line, as in original game: off the throttle, handbrake on and the
 * wheel thrown to one side, so the car slides round to a stop instead of
 * braking in a straight line; then it holds still.
 */
export function stopping(car: Car): Controls {
  const v = car.speed
  const yaw = Math.atan2(-car.forward.x, -car.forward.z)
  if (!car.slide) {
    // a coin flip: following the wheel sent every car the same way (they all cross the line out of the same bend)
    car.slide = Math.random() < 0.5 ? -1 : 1
    car.slideYaw = yaw
  }
  // how far it has swung round since the line (0..π)
  const turned = Math.abs(Math.atan2(Math.sin(yaw - car.slideYaw), Math.cos(yaw - car.slideYaw)))
  if (turned < SLIDE_TURN && Math.abs(v) > 3) return { throttle: 0, steer: car.slide * 0.5, handbrake: true }
  // swung far enough (or slow): grip again and brake it to a standstill
  return { throttle: v > 0.3 ? -1 : v < -0.3 ? 1 : 0, steer: 0, handbrake: Math.abs(v) < 2 }
}
const SLIDE_TURN = 1.2 // rad, ~70°: let go of the handbrake there — the swing carries it on to ~150–270°

function boxHull(): number[][] {
  const out: number[][] = []
  for (const x of [-0.2, 0.2]) for (const y of [-0.05, 0.1]) for (const z of [-0.45, 0.45]) out.push([x, y, z])
  return out
}
