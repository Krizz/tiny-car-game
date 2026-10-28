// Loose level objects the same for everyone ("fix all loose objects"): the
// server's world for the course (shared/ai.ts) is the one that counts for traffic cones, bottles,
// packets, ABC blocks, beach balls, tumbleweeds, sprinkler bases, trolleys and thrown basketballs
// — every car is in it (the CPU cars, and the people's where their browsers say). It sends their
// state while they move (and a few at rest each tick, so a late joiner gets them all within a
// second). Each browser keeps its own physics copy, so a car hitting one sees it react at once, and
// pulls it towards the server's state predicted to the present, as it does other players' cars.
//
// Packet: u8 0xFF, u8 count, 6 spare, f64 server ms; then per object u16 net id (its index in the
// level's object list; thrown balls 10000+), u16 spare, f32 pos[3] quat[4] vel[3] ang[3].
import * as THREE from 'three'
import type { Physics } from '../src/physics'
import type { ObjectBodies } from './objects'

export const OBJ_MARK = 0xff
const HEAD = 16
const ENTRY = 56
const MAX = 20 // entries a packet (~1.1 kB)
const SEND_HZ = 30
const REST_PER_TICK = 2 // objects at rest sent each tick anyway (the refresh)
const MAX_PREDICT = 0.3 // s
const SNAP = 2.5 // m: further off, teleport
const PULL = 10 // 1/s
const TURN = 10 // 1/s
const SOFT = 0.15 // a car of ours close by: the local knock shows, the server's eases in
const STALE_MS = 1500

interface Sample { t: number; p: THREE.Vector3; q: THREE.Quaternion; v: THREE.Vector3; w: THREE.Vector3 }

const moving = (s: { vel: number[]; ang: number[] }) =>
  s.vel[0] ** 2 + s.vel[1] ** 2 + s.vel[2] ** 2 > 0.05 ** 2 || s.ang[0] ** 2 + s.ang[1] ** 2 + s.ang[2] ** 2 > 0.1 ** 2

export class ObjectNet {
  // server
  private acc = 0
  private wasMoving = new Set<number>()
  private sweep = 0
  // browser
  private samples = new Map<number, Sample>()
  lastHeard = 0 // performance.now() of the last packet

  constructor(private bodies: ObjectBodies, private physics: Physics) {}

  /** Server, every tick: the packets to send now (none between the 30 Hz sends). */
  packets(serverMs: number, dt: number): Uint8Array[] {
    this.acc += dt
    if (this.acc < 1 / SEND_HZ - 0.004) return []
    this.acc = Math.min(1 / SEND_HZ, this.acc - 1 / SEND_HZ)
    const ids = [...this.bodies.net.keys()]
    const send: number[] = []
    for (const nid of ids) {
      const st = this.physics.state(this.bodies.net.get(nid)!)
      const m = moving(st)
      if (m || this.wasMoving.has(nid)) send.push(nid) // and once more when it has stopped
      if (m) this.wasMoving.add(nid)
      else this.wasMoving.delete(nid)
    }
    for (let k = 0; k < REST_PER_TICK && ids.length; k++) {
      const nid = ids[this.sweep++ % ids.length]
      if (!send.includes(nid)) send.push(nid)
    }
    const out: Uint8Array[] = []
    for (let i = 0; i < send.length; i += MAX) {
      const part = send.slice(i, i + MAX)
      const buf = new ArrayBuffer(HEAD + part.length * ENTRY)
      const dv = new DataView(buf)
      dv.setUint8(0, OBJ_MARK)
      dv.setUint8(1, part.length)
      dv.setFloat64(8, serverMs, true)
      part.forEach((nid, k) => {
        const o = HEAD + k * ENTRY
        const st = this.physics.state(this.bodies.net.get(nid)!)
        dv.setUint16(o, nid, true)
        const f = new Float32Array(buf, o + 4, 13)
        f.set(st.pos, 0)
        f.set(st.quat, 3)
        f.set(st.vel, 7)
        f.set(st.ang, 10)
      })
      out.push(new Uint8Array(buf))
    }
    return out
  }

  /** Browser: a packet from the server (already known to start with OBJ_MARK). */
  receive(buf: ArrayBuffer) {
    const dv = new DataView(buf)
    const n = dv.getUint8(1)
    if (buf.byteLength < HEAD + n * ENTRY) return
    const t = dv.getFloat64(8, true)
    this.lastHeard = performance.now()
    this.bodies.synced = true
    for (let k = 0; k < n; k++) {
      const o = HEAD + k * ENTRY
      const nid = dv.getUint16(o, true)
      const f = new Float32Array(buf.slice(o + 4, o + 4 + 52))
      const old = this.samples.get(nid)
      if (old && old.t >= t) continue // out of order
      if (!this.bodies.net.has(nid) && nid >= 10000) this.bodies.spawnBall(nid, [f[0], f[1], f[2]], [f[7], f[8], f[9]])
      this.samples.set(nid, {
        t, p: new THREE.Vector3(f[0], f[1], f[2]), q: new THREE.Quaternion(f[3], f[4], f[5], f[6]),
        v: new THREE.Vector3(f[7], f[8], f[9]), w: new THREE.Vector3(f[10], f[11], f[12]),
      })
    }
  }

  /** Browser, before every physics step: pull each object towards the server's state now. `near`:
   *  where our own car is (the knocks it gives show at once). */
  pull(serverMs: number, near: THREE.Vector3 | null) {
    if (performance.now() - this.lastHeard > 3000) {
      this.bodies.synced = false // the server went quiet (offline, reconnecting): ours again
      return
    }
    for (const [nid, s] of this.samples) {
      const id = this.bodies.net.get(nid)
      const age = (serverMs - s.t) / 1000
      if (id === undefined || age * 1000 > STALE_MS) {
        if (age * 1000 > STALE_MS) this.samples.delete(nid)
        continue
      }
      const st = this.physics.state(id)
      const atRest = s.v.lengthSq() < 0.05 ** 2 && s.w.lengthSq() < 0.1 ** 2
      const tp = s.p.clone().addScaledVector(s.v, Math.min(MAX_PREDICT, Math.max(0, age)))
      const err = tp.clone().sub(new THREE.Vector3(st.pos[0], st.pos[1], st.pos[2]))
      if (atRest && err.lengthSq() < 0.03 ** 2 && !moving(st)) continue
      if (err.length() > SNAP) {
        this.physics.setPose(id, tp.toArray(), s.q.toArray())
        this.physics.setVelocity(id, s.v.toArray(), s.w.toArray())
        continue
      }
      const v = s.v.clone().addScaledVector(err, PULL)
      const q = new THREE.Quaternion(st.quat[0], st.quat[1], st.quat[2], st.quat[3])
      const dq = s.q.clone().multiply(q.invert())
      if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w)
      const ang = 2 * Math.acos(Math.min(1, dq.w))
      const w = s.w.clone()
      const axis = new THREE.Vector3(dq.x, dq.y, dq.z)
      if (axis.lengthSq() > 1e-10) w.addScaledVector(axis.normalize(), ang * TURN)
      if (near && near.distanceToSquared(new THREE.Vector3(st.pos[0], st.pos[1], st.pos[2])) < 3 * 3) {
        v.lerpVectors(new THREE.Vector3(...st.vel), v, SOFT)
        w.lerpVectors(new THREE.Vector3(...st.ang), w, SOFT)
      }
      this.physics.setVelocity(id, v.toArray(), w.toArray())
    }
  }
}
