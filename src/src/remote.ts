// Another player's car: a real Box3D body (so our car can hit it) pulled
// towards where that player's car is NOW.
//
// Every state packet carries the time it was taken (server clock). We predict
// it forward by its age (position by velocity, rotation by angular velocity),
// so the car is drawn where it really is rather than ~latency in the past —
// what makes a hit on your screen line up with a hit on theirs. A new packet
// that disagrees with the prediction is not snapped to: the body is pulled
// there over ~80 ms.
//
// When our car hits it, the body is let go for a moment (soft pull) so the
// knock is visible, then eased back as the owner's own (bumped) state arrives.
import * as THREE from 'three'
import { Car } from './car'
import type { LoadedCar } from './assets'
import type { Physics } from './physics'
import type { EngineSound } from './sound'

const MAX_PREDICT = 0.35 // s: beyond this a packet is late, stop extrapolating
const SNAP = 4 // m: further off than this, teleport instead of pulling
const PULL = 12 // 1/s position error correction
const TURN = 14 // 1/s rotation error correction
const CONTACT_MS = 350 // after a hit, how long the body is left to react
const SOFT = 0.06 // per step blend towards the target while in contact
const MAX_ACCEL = 40 // m/s², a sanity cap on the speed change used for prediction

interface Sample {
  t: number // server ms
  p: THREE.Vector3
  q: THREE.Quaternion
  v: THREE.Vector3
  w: THREE.Vector3
  steer: number
  a: number // m/s², change of speed along the way it's going (braking < 0), from the last two packets
}

const tmpQ = new THREE.Quaternion()
const tmpV = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

export class RemoteCar {
  car: Car
  private last: Sample | null = null
  progress = 0
  flags = 0
  lastHeard = 0 // performance.now() of the last packet
  engine: EngineSound | null = null
  contactUntil = 0
  nearLocal = false
  private setV = new THREE.Vector3()
  private tp = new THREE.Vector3()
  private tq = new THREE.Quaternion()
  private tv = new THREE.Vector3()

  constructor(physics: Physics, loaded: LoadedCar, readonly id: number, readonly carKey: string) {
    this.car = new Car(physics, loaded, new THREE.Vector3(0, -500 - id * 3, 0), 0, true)
  }

  push(time: number, f: Float32Array, now: number) {
    if (this.last && time <= this.last.t) return // out of order
    const s: Sample = {
      t: time,
      p: new THREE.Vector3(f[0], f[1], f[2]),
      q: new THREE.Quaternion(f[3], f[4], f[5], f[6]).normalize(),
      v: new THREE.Vector3(f[7], f[8], f[9]),
      w: new THREE.Vector3(f[10], f[11], f[12]),
      steer: f[13],
      a: 0,
    }
    // speed change since the previous packet: the arc below handles turning; this adds braking and
    // accelerating, so a CPU car lifting for a bend isn't seen to overshoot and get pulled back
    const prev = this.last
    if (prev) {
      const gap = (time - prev.t) / 1000
      if (gap > 0.01 && gap < 0.15) {
        const hv = (v: THREE.Vector3) => Math.hypot(v.x, v.z)
        const a = Math.max(-MAX_ACCEL, Math.min(MAX_ACCEL, (hv(s.v) - hv(prev.v)) / gap))
        s.a = prev.a + (a - prev.a) * 0.6
      }
    }
    this.progress = f[14]
    this.flags = f[15]
    this.car.netFlags = f[15]
    const first = !this.last
    this.last = s
    this.lastHeard = now
    if (first) this.teleport(s.p, s.q, s.v, s.w)
  }

  private teleport(p: THREE.Vector3, q: THREE.Quaternion, v: THREE.Vector3, w: THREE.Vector3) {
    const ph = this.car.physics
    ph.setPose(this.car.id, p.toArray(), [q.x, q.y, q.z, q.w])
    ph.setVelocity(this.car.id, v.toArray(), w.toArray())
    this.setV.copy(v)
  }

  /** The car's pose at server time `now` (ms), predicted from the last packet. */
  private predict(now: number): boolean {
    const s = this.last
    if (!s) return false
    const age = (now - s.t) / 1000
    const dt = Math.max(0, Math.min(MAX_PREDICT, age))
    // a turning car's velocity turns with it: advance along the arc (midpoint rule)
    const turn = s.w.y * dt
    const vx = s.v.x * Math.cos(turn / 2) + s.v.z * Math.sin(turn / 2)
    const vz = -s.v.x * Math.sin(turn / 2) + s.v.z * Math.cos(turn / 2)
    // + ½ a t² along the way it's going (braking ends at a standstill, it doesn't reverse)
    const hs = Math.hypot(vx, vz)
    let ext = 0
    if (s.a && hs > 0.5) {
      ext = 0.5 * s.a * dt * dt
      if (s.a < 0 && hs + s.a * dt < 0) ext = hs * hs / (-2 * s.a) - hs * dt // stopped within dt
    }
    const kx = hs > 0.5 ? vx / hs : 0, kz = hs > 0.5 ? vz / hs : 0
    this.tp.set(s.p.x + vx * dt + kx * ext, s.p.y + s.v.y * dt, s.p.z + vz * dt + kz * ext)
    const wl = s.w.length()
    this.tq.copy(s.q)
    if (wl > 1e-4) this.tq.premultiply(tmpQ.setFromAxisAngle(tmpV.copy(s.w).divideScalar(wl), wl * dt))
    // a packet that is late is a car that may have stopped: don't keep it flying off
    this.tv.copy(s.v).applyAxisAngle(UP, turn).multiplyScalar(age > MAX_PREDICT ? 0 : 1)
    if (s.a && hs > 0.5 && age <= MAX_PREDICT) {
      const k = Math.max(0, hs + s.a * dt) / hs // speed now vs at the packet, along the way it goes
      this.tv.x *= k
      this.tv.z *= k
    }
    return true
  }

  /** Before each physics step: steer the body towards the predicted pose. */
  step(serverNow: number, now: number) {
    if (!this.predict(serverNow)) return
    const s = this.last!
    const ph = this.car.physics
    const st = this.car.readState()
    const err = this.tp.clone().sub(tmpV.set(st.pos[0], st.pos[1], st.pos[2]))
    if (err.length() > SNAP) return this.teleport(this.tp, this.tq, this.tv, s.w)
    const v = this.tv.clone().addScaledVector(err, PULL)
    // rotation error as an angular velocity
    const q = new THREE.Quaternion(st.quat[0], st.quat[1], st.quat[2], st.quat[3])
    const dq = this.tq.clone().multiply(q.invert())
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w)
    const ang = 2 * Math.acos(Math.min(1, dq.w))
    const w = s.w.clone()
    const axis = new THREE.Vector3(dq.x, dq.y, dq.z)
    if (axis.lengthSq() > 1e-10) w.addScaledVector(axis.normalize(), ang * TURN)
    if (now < this.contactUntil) {
      // just hit: let the knock show, drift back gently
      v.lerpVectors(new THREE.Vector3(...st.vel), v, SOFT)
      w.lerpVectors(new THREE.Vector3(...st.ang), w, SOFT)
    }
    ph.setVelocity(this.car.id, v.toArray(), w.toArray())
    this.setV.copy(v)

    // visuals: front wheels steer, all wheels roll
    this.car.steer = s.steer
    const speed = s.v.dot(this.car.forward)
    this.car.wheels.forEach((wh, i) => {
      const wi = this.car.info.wheels[i]
      wh.steer = wi.turnable ? s.steer * 0.42 * Math.abs(wi.steerRatio) / 0.5 : 0
      wh.spin += (speed / Math.max(0.05, wi.radius)) * (1 / 120)
      wh.pos *= 0.9
    })
  }

  /** After the physics step: did our car knock the body off what we asked? */
  afterStep(now: number, dt: number, gravity: number) {
    if (!this.nearLocal || !this.last) return // the track pushing it stays firm
    const st = this.car.physics.state(this.car.id)
    const dx = st.vel[0] - this.setV.x, dy = st.vel[1] - this.setV.y + gravity * dt, dz = st.vel[2] - this.setV.z
    if (dx * dx + dy * dy + dz * dz > 0.8 * 0.8) this.contactUntil = now + CONTACT_MS
  }

  destroy() {
    this.car.destroy()
  }
}
