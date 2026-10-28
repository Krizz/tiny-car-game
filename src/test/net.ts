// Two players, two separate physics worlds (as in two browsers), joined by a
// simulated network with latency + jitter. Measures how far each player's
// view of the other is from the truth, and what a crash looks like on both sides.
//   bun test/net.ts [oneWayMs=40] [jitterMs=10] [scenario=chase|ram]
// LOSS=<%> drops packets; NET=tcp (default, what a WebSocket does: a lost packet is resent and
// everything behind it waits — head-of-line blocking) or NET=udp (lost = gone, later ones not held up).
import * as THREE from 'three'
import { GRAVITY, Physics } from '../src/physics'
import { Car, type Controls } from '../src/car'
import { RemoteCar } from '../src/remote'
import { Autopilot } from '../src/autopilot'
import { rescuePoint } from '../src/race'
import type { CarInfo, LoadedCar, TrackInfo } from '../src/assets'
import { packCars, unpackCars } from '../shared/protocol'

const ROOT = new URL('../public/', import.meta.url).pathname
const ONE_WAY = Number(process.argv[2] ?? 40)
const JITTER = Number(process.argv[3] ?? 10)
const SCENARIO = process.argv[4] ?? 'chase'
const DT = 1 / 120
const SEND_DT = 1 / Number(process.env.SEND_HZ ?? 30) // the browsers' STATE_HZ

const info: TrackInfo = await Bun.file(ROOT + 'game/toy2/track.json').json()
const col = await Bun.file(ROOT + 'game/toy2/collision.bin').arrayBuffer()
const nt = info.collision.triangles
const loadCar = async (key: string): Promise<LoadedCar> => {
  const ci: CarInfo = await Bun.file(ROOT + `game/cars/${key}/car.json`).json()
  return { info: ci, body: new THREE.Mesh(), wheels: ci.wheels.map(() => new THREE.Mesh()) }
}

class Client {
  physics!: Physics
  me!: Car
  remote!: RemoteCar
  pilot = new Autopilot(info)
  inbox: { at: number; t: number; f: Float32Array }[] = []
  static async make(key: string, otherKey: string, pos: THREE.Vector3, yaw: number) {
    const c = new Client()
    c.physics = await Physics.load(ROOT + 'box3d.wasm')
    c.physics.addMesh(new Float32Array(col, 0, nt * 9), new Float32Array(col, nt * 36, nt), 0.5)
    c.me = new Car(c.physics, await loadCar(key), pos, yaw)
    c.remote = new RemoteCar(c.physics, await loadCar(otherKey), 2, otherKey)
    return c
  }
  pack(): Float32Array {
    const s = this.physics.state(this.me.id)
    const f = new Float32Array([...s.pos, ...s.quat, ...s.vel, ...s.ang, this.me.steer, 0, 0])
    if (process.env.PACK === '0') return f
    // through the wire format (shared/protocol.ts), as the real thing goes
    let out = f
    unpackCars(packCars(0, [{ id: 0, f }]), (_, __, g) => (out = g))
    return out
  }
}

const start = rescuePoint(info, (await Physics.load(ROOT + 'box3d.wasm')), new THREE.Vector3(...info.start.pos))
const fwd = new THREE.Vector3(-Math.sin(start.yaw), 0, -Math.cos(start.yaw))
const right = new THREE.Vector3(Math.cos(start.yaw), 0, -Math.sin(start.yaw))
// chase: B a little ahead and to the side, both bots. ram: B parked 12 m ahead, A drives into it.
const posA = start.pos.clone().addScaledVector(right, SCENARIO === 'ram' ? 0 : -0.5)
const posB = start.pos.clone().addScaledVector(fwd, SCENARIO === 'ram' ? -12 : 3).addScaledVector(right, SCENARIO === 'ram' ? 0 : 0.5)
// ram: B sits ahead of A on the straight (fwd is down the track; A starts behind it)
if (SCENARIO === 'ram') posB.copy(start.pos).addScaledVector(fwd, 12)
const A = await Client.make('rc', 'phat', posA, start.yaw)
const B = await Client.make('phat', 'rc', posB, start.yaw)

let t = 0
let sendAcc = 0
const errs: number[] = []
const lines: string[] = []
const jitter = () => ONE_WAY + (Math.random() * 2 - 1) * JITTER
const LOSS = Number(process.env.LOSS ?? 0) / 100
const NET = process.env.NET ?? 'tcp'
// When a packet sent at `ms` reaches the other side, or null if it never does.
// TCP: a loss is noticed by fast retransmit (3 later packets → duplicate ACKs, ~100 ms at 30 Hz,
// + the ACKs' trip back) or Linux's 200 ms minimum RTO, whichever is first; the resend can be
// lost too (then the RTO doubles); and nothing is handed over before the packet ahead of it.
const lastIn = new Map<object, number>()
function arrival(dir: object, ms: number): number | null {
  let at = ms, rto = Math.max(200, 4 * ONE_WAY)
  let first = true
  while (Math.random() < LOSS) {
    if (NET === 'udp') return null
    at += first ? Math.min(3 * SEND_DT * 1000 + 2 * ONE_WAY, rto) : rto
    if (!first) rto *= 2
    first = false
  }
  at += jitter()
  if (NET === 'tcp') at = Math.max(at, lastIn.get(dir) ?? 0)
  lastIn.set(dir, at)
  return at
}
const AtoB = {}, BtoA = {}
// error in the packets' timestamps (server timer / clock-offset noise), ms
const STAMP = Number(process.env.STAMP ?? 0)
const stampErr = () => (Math.random() * 2 - 1) * STAMP
// smoothness as drawn at 60 fps: |p2 - 2 p1 + p0| (horizontal, cm) for the own car and for the
// other player's car as this browser draws it — 0 for steady motion, a stutter shows as cm
const jerk = { own: [] as number[], remote: [] as number[] }
const jumps: number[] = []
const hist = { own: [] as THREE.Vector3[], remote: [] as THREE.Vector3[] }
function sample(kind: 'own' | 'remote', p: THREE.Vector3) {
  const h = hist[kind]
  h.push(new THREE.Vector3(p.x, 0, p.z))
  if (h.length > 3) h.shift()
  if (h.length === 3) {
    const e = h[2].clone().addScaledVector(h[1], -2).add(h[0]).length() * 100
    if (e < 50) jerk[kind].push(e)
    if (kind === 'remote') jumps.push(e)
  }
}
let bHitAt = -1, aDv = 0, bDvInB = 0, lastVA = new THREE.Vector3(), lastVB = new THREE.Vector3()
const T = SCENARIO === 'ram' ? 4 : Number(process.env.DUR ?? 30)

for (let i = 0; i < T / DT; i++) {
  t = i * DT
  const ms = t * 1000
  // deliver packets that have arrived
  for (const [me, other] of [[A, B], [B, A]] as const) {
    while (me.inbox.length && me.inbox[0].at <= ms) {
      const p = me.inbox.shift()!
      me.remote.push(p.t, p.f, ms)
    }
    void other
  }
  const ctlA: Controls = A.pilot.drive(A.me, DT)
  const ctlB: Controls = SCENARIO === 'ram' ? { throttle: 0, steer: 0, handbrake: false } : B.pilot.drive(B.me, DT)
  for (const [c, ctl] of [[A, ctlA], [B, ctlB]] as const) {
    c.remote.step(ms, ms)
    c.me.drive(ctl, DT)
    c.physics.step(DT, 2)
    c.remote.nearLocal = c.remote.car.position.distanceToSquared(c.me.position) < 2.5 * 2.5
    c.remote.afterStep(ms, DT, GRAVITY)
    c.me.readState()
    c.remote.car.readState()
    for (const car of [c.me]) if (car.upsideTime > 1.8) { const r = rescuePoint(info, c.physics, car.position); car.place(r.pos, r.yaw) }
  }
  // send
  sendAcc += DT
  if (sendAcc >= SEND_DT) {
    sendAcc = 0
    const atB = arrival(AtoB, ms), atA = arrival(BtoA, ms)
    if (atB !== null) B.inbox.push({ at: atB, t: ms + DT * 1000 + stampErr(), f: A.pack() }) // the state is after this step
    if (atA !== null) A.inbox.push({ at: atA, t: ms + DT * 1000 + stampErr(), f: B.pack() })
    B.inbox.sort((x, y) => x.at - y.at)
    A.inbox.sort((x, y) => x.at - y.at)
  }
  if (t > 1 && i % 2 === 0) {
    sample('own', A.me.position)
    sample('remote', B.remote.car.position)
  }
  // error: B's view of A vs A's truth (and vice versa)
  if (t > 1) {
    errs.push(B.remote.car.position.distanceTo(A.me.position))
    errs.push(A.remote.car.position.distanceTo(B.me.position))
  }
  // crash bookkeeping
  const vA = new THREE.Vector3(...A.physics.state(A.me.id).vel)
  const vB = new THREE.Vector3(...B.physics.state(B.me.id).vel)
  const dA = vA.distanceTo(lastVA), dB = vB.distanceTo(lastVB)
  if (dA > aDv && t > 0.3) aDv = dA
  if (dB > 0.5 && bHitAt < 0 && t > 0.3) bHitAt = t
  if (dB > bDvInB && t > 0.3) bDvInB = dB
  lastVA.copy(vA); lastVB.copy(vB)
  if (SCENARIO === 'ram' && i % 12 === 0)
    lines.push(`t=${t.toFixed(2)} A: x=${A.me.position.x.toFixed(2)} v=${A.me.speed.toFixed(1)}  B(true): x=${B.me.position.x.toFixed(2)} v=${vB.length().toFixed(2)}  A sees B at x=${A.remote.car.position.x.toFixed(2)}  B sees A at x=${B.remote.car.position.x.toFixed(2)}`)
}
errs.sort((a, b) => a - b)
const q = (f: number) => (errs[Math.floor(errs.length * f)] * 100).toFixed(0)
if (SCENARIO === 'ram') console.log(lines.join('\n'))
console.log(`[${NET} loss ${(LOSS * 100).toFixed(1)}%] ` + `${SCENARIO} one-way ${ONE_WAY}±${JITTER} ms: view error median ${q(0.5)} cm, 90% ${q(0.9)} cm, 99% ${q(0.99)} cm, max ${q(0.999)} cm`)
if (SCENARIO === 'ram') console.log(`B (parked) first moved in its own world at t=${bHitAt.toFixed(2)} s; biggest kick to A ${aDv.toFixed(2)} m/s per step, to B ${bDvInB.toFixed(2)} m/s per step`)
for (const k of ['own', 'remote'] as const) {
  const j = jerk[k]
  const mean = j.reduce((a, b) => a + b, 0) / Math.max(1, j.length)
  console.log(`smoothness ${k}: mean ${mean.toFixed(2)} cm, >2 cm ${(100 * j.filter((e) => e > 2).length / j.length).toFixed(1)}%, >5 cm ${(100 * j.filter((e) => e > 5).length / j.length).toFixed(1)}%`)
}
{
  jumps.sort((a, b) => a - b)
  const min = T / 60
  const n = (cm: number) => (jumps.filter((e) => e > cm && e < 300).length / min).toFixed(1)
  console.log(`remote car jumps (drawn at 60 fps): p99 ${jumps[Math.floor(jumps.length * 0.99)].toFixed(1)} cm, max ${jumps.filter((e) => e < 300).pop()!.toFixed(0)} cm; per minute >5 cm ${n(5)}, >15 cm ${n(15)}, >40 cm ${n(40)}`)
}
