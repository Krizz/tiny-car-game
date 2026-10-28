// Headless driving test: the real Physics + Car code under Bun, no browser.
//   bun test/sim.ts [car] [script]
// Prints a trace of the car's state while a scripted driver holds inputs.
import * as THREE from 'three'
import { Physics } from '../src/physics'
import { Car, stopping, type Controls } from '../src/car'
import type { CarInfo, TrackInfo, LoadedCar } from '../src/assets'
import { Autopilot } from '../src/autopilot'
import { AiDriver } from '../src/aidriver'
import { LapTracker, TrackMeter, rescuePoint } from '../src/race'
import { Piano } from '../src/piano'
import { courseFiles, mirrorCollision, mirrorInfo, parseCourse } from '../shared/course'

const ROOT = new URL('../public/', import.meta.url).pathname
const carKey = process.argv[2] ?? 'rc'
const script = process.argv[3] ?? 'straight'

const physics = await Physics.load(ROOT + 'box3d.wasm')
const TRACK = process.env.TRACK ?? 'toy2' // a course id: level, level:r, level:m, level:rm
const course = parseCourse(TRACK)!
const cf = courseFiles(course)
const info: TrackInfo = await Bun.file(ROOT + cf.base.slice(1) + cf.info).json()
if (course.mirror) mirrorInfo(info)
const col = await Bun.file(ROOT + cf.base.slice(1) + (info.colBin ?? 'collision.bin')).arrayBuffer()
const nt = info.collision.triangles
if (course.mirror) mirrorCollision(new Float32Array(col, 0, nt * 9))
if (process.env.FLAT) {
  // a flat 400 m plane at the start height (isolates the car from the track)
  const y = info.start.pos[1] - 0.2, h = 200, x0 = info.start.pos[0], z0 = info.start.pos[2]
  physics.addMesh(new Float32Array([x0 - h, y, z0 - h, x0 - h, y, z0 + h, x0 + h, y, z0 + h, x0 - h, y, z0 - h, x0 + h, y, z0 + h, x0 + h, y, z0 - h]), null, 0.5)
} else physics.addMesh(new Float32Array(col, 0, nt * 9), new Float32Array(col, nt * 36, nt), 0.5)

const carInfo: CarInfo = await Bun.file(ROOT + `game/cars/${carKey}/car.json`).json()
const loaded: LoadedCar = { info: carInfo, body: new THREE.Mesh(), wheels: carInfo.wheels.map(() => new THREE.Mesh()) }
const s = info.start
const yaw = -s.rot * Math.PI * 2
const car = new Car(physics, loaded, new THREE.Vector3(s.pos[0], s.pos[1] + 0.25, s.pos[2]), yaw)
if (process.env.START) {
  const [x, y, z, a] = process.env.START.split(',').map(Number)
  car.place(new THREE.Vector3(x, y, z), a)
}

const scripts: Record<string, (t: number) => Controls> = {
  straight: (t) => ({ throttle: t > 0.5 ? 1 : 0, steer: 0, handbrake: false }),
  turn: (t) => ({ throttle: t > 0.5 ? 1 : 0, steer: t > 2 ? 1 : 0, handbrake: false }),
  slalom: (t) => ({ throttle: t > 0.5 ? 1 : 0, steer: t > 1.5 ? Math.sign(Math.sin((t - 1.5) * 3)) : 0, handbrake: false }),
  wall: (t) => ({ throttle: 1, steer: t < 1.2 ? 0.35 : 0.15, handbrake: false }),
  brake: (t) => ({ throttle: t < 2 ? 1 : -1, steer: 0, handbrake: false }),
  handbrake: (t) => ({ throttle: t > 0.5 ? 1 : 0, steer: t > 1.8 ? 1 : 0, handbrake: t > 1.8 && t < 2.4 }),
}
const pilot = process.env.OLD ? new Autopilot(info) : new AiDriver(info, { pace: Number(process.env.PACE ?? 1), hints: !process.env.NOHINTS, physics })
const laps = new LapTracker(info)
const meter = new TrackMeter(info)
const notes: number[] = []
const piano = new Piano(info, (_n, _v, rate) => notes.push(Math.round(60 + 12 * Math.log2(rate ?? 1))))
let resets = 0
let worstWall = 0, worstFloor = 0
let steerFlips = 0, lastSteerSign = 0, steerTravel = 0, lastSteer = 0, thrFlips = 0, lastThr = 0
let tNow = 0
// TRACE=file.json: the bot's path every 0.1 s ([x, z, speed, steer, throttle]) and its resets, for
// test/plot.py (a top-down picture of the AI line and where the car really went)
const trace: number[][] = []
const resetAt: number[][] = []
const crashAt: number[][] = []
let lastSpeed = 0
scripts.bot = () => {
  const c = pilot.drive(car, DT)
  if (c.reset || car.upsideTime > 1.8 || car.position.y < -30) {
    resets++
    resetAt.push([car.position.x, car.position.z])
    console.log(`RESET at t=${(tNow).toFixed(1)} pos=${car.position.toArray().map((v) => v.toFixed(1))} up=${car.upAxis.y.toFixed(2)} v=${car.speed.toFixed(1)} zone=${laps.last} why=${c.reset ? 'stuck' : car.upsideTime > 1.8 ? 'flipped' : 'fell'}`)
    const r = (pilot instanceof AiDriver ? pilot.rescueSpot(physics) : null) ?? rescuePoint(info, physics, car.position)
    car.place(r.pos, r.yaw)
  }
  return c
}
// drive the bot until FINISH_AT s, then the after-the-line slide (trace yaw/speed)
let finYaw: number | null = null
scripts.finish = (t) => {
  if (t < Number(process.env.FINISH_AT ?? 12)) return scripts.bot(t)
  const yawNow = Math.atan2(-car.forward.x, -car.forward.z)
  if (finYaw === null) { finYaw = yawNow; console.log(`FINISH v=${car.speed.toFixed(1)}`) }
  if (Math.round(t * 120) % 24 === 0) console.log(`t=${t.toFixed(1)} v=${car.speed.toFixed(1)} turned=${((yawNow - finYaw) * 180 / Math.PI).toFixed(0)} up=${car.upAxis.y.toFixed(2)} skid=${Math.max(...car.wheels.map((w) => w.skid)).toFixed(2)}`)
  return stopping(car)
}
const drive = scripts[script]
const DT = 1 / 120
const T = Number(process.argv[4] ?? 5)
const start = car.position.clone()
for (let i = 0; i <= T / DT; i++) {
  const t = i * DT
  tNow = t
  const ctl = drive(t)
  if (Math.sign(ctl.steer) !== lastSteerSign && Math.abs(ctl.steer) > 0.05) { steerFlips++; lastSteerSign = Math.sign(ctl.steer) }
  steerTravel += Math.abs(car.steer - lastSteer); lastSteer = car.steer
  if (Math.abs(ctl.throttle - lastThr) > 0.9) thrFlips++
  lastThr = ctl.throttle
  car.drive(ctl, DT)
  physics.step(DT, 2)
  // how far does any tyre (where it is drawn) reach into a wall / the floor?
  car.readState()
  car.info.wheels.forEach((wi, k) => {
    const w = car.wheels[k]
    const c = new THREE.Vector3(wi.offset1[0] + wi.offset2[0], wi.offset1[1] - w.pos, wi.offset1[2] + wi.offset2[2]).applyQuaternion(car.quaternion).add(car.position)
    for (const dir of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.7, 0, 0.7], [-0.7, 0, 0.7], [0.7, 0, -0.7], [-0.7, 0, -0.7]]) {
      const h = physics.raycast([c.x, c.y, c.z], dir, wi.radius)
      if (h && Math.abs(h.normal[1]) < 0.5) worstWall = Math.max(worstWall, wi.radius * 0.8 - h.dist)
    }
    const fl = physics.raycast([c.x, c.y + 0.5, c.z], [0, -1, 0], 0.5 + wi.radius)
    if (fl) {
      const pen = (fl.point[1] + wi.radius * Math.hypot(1, Math.tan(Math.acos(Math.min(1, fl.normal[1]))))) - c.y
      if (pen > worstFloor && process.env.WALLCHECK) console.log(`floor pen ${(pen * 100).toFixed(1)} cm wheel ${k} t=${tNow.toFixed(2)} up=${car.upAxis.y.toFixed(2)} ny=${fl.normal[1].toFixed(2)} contact=${w.contact} comp=${(w.compression * 100).toFixed(1)} g=${car.grounded}`)
      worstFloor = Math.max(worstFloor, pen)
    }
  })
  {
    const v = Math.hypot(car.velocity.x, car.velocity.z)
    if (lastSpeed - v > 5) {
      crashAt.push([+car.position.x.toFixed(2), +car.position.z.toFixed(2)])
      if (process.env.CRASHLOG) console.log(`CRASH t=${t.toFixed(1)} pos=${car.position.toArray().map((q) => q.toFixed(1))} from ${lastSpeed.toFixed(1)} to ${v.toFixed(1)} node=${(pilot as any).node} avoid=${((pilot as any).avoid ?? 0).toFixed(1)}`)
    }
    lastSpeed = v
  }
  if (i % 12 === 0) trace.push([+car.position.x.toFixed(2), +car.position.z.toFixed(2), +car.speed.toFixed(1), +ctl.steer.toFixed(2), +ctl.throttle.toFixed(2)])
  meter.update(car.position)
  piano.update([{ id: 1, car }], car.position)
  if (script === 'bot' && laps.update(car.position, t * 1000) === 'lap')
    console.log(`LAP ${laps.completedLaps()} ${(laps.lapTimes.at(-1)! / 1000).toFixed(2)} s (resets so far ${resets}) meter ${meter.value.toFixed(0)} m of ${meter.length.toFixed(0)}/lap`)
  if (i % (script === 'bot' ? Number(process.env.EVERY ?? 600) : 30) === 0) {
    const st = physics.state(car.id)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quaternion)
    const vlat = st.vel[0] * right.x + st.vel[1] * right.y + st.vel[2] * right.z
    const p = car.position
    console.log(
      `t=${t.toFixed(2)} pos=${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} v=${car.speed.toFixed(2)} ` +
      `vlat=${vlat.toFixed(2)} yawRate=${st.ang[1].toFixed(2)} up=${car.upAxis.y.toFixed(2)} g=${car.grounded} ` +
      `dbg=${((pilot as any).dbg ?? []).map((x: number) => x.toFixed(1)).join('/')} node=${(pilot as any).node} avoid=${((pilot as any).avoid ?? 0).toFixed(1)} comp=${car.wheels.map((w) => (w.compression * 100).toFixed(1)).join('/')} skid=${car.wheels.map((w) => w.skid.toFixed(1)).join('/')}`,
    )
  }
}
if (script === 'bot') console.log(`smoothness: steer sign flips ${(steerFlips / T).toFixed(1)}/s, steer travel ${(steerTravel / T).toFixed(2)}/s, throttle slams ${(thrFlips / T).toFixed(1)}/s`)
if (script === 'bot') console.log('zones passed', laps.passes, 'last', laps.last, 'resets', resets, 'crashes', crashAt.length)
if (script === 'wall' || process.env.WALLCHECK) console.log(`deepest wheel in a wall: ${(worstWall * 100).toFixed(1)} cm, floor: ${(worstFloor * 100).toFixed(1)} cm`)
if (notes.length) console.log(`piano: ${notes.length} notes, e.g. ${notes.slice(0, 24).join(' ')}`)
console.log('moved', car.position.distanceTo(start).toFixed(1), 'm')
if (process.env.TRACE) await Bun.write(process.env.TRACE, JSON.stringify({ ai: info.ai, trace, resets: resetAt, crashes: crashAt }))
