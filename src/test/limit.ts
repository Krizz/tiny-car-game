// One CPU car alone on a course with its trained memory: lap times, resets, and how the
// lap's time splits by what limited the speed (temporary analysis tool).
//   TRACK=toylite PACE=1 NOCAPS=1 NOHINTS=1 bun test/limit.ts mouse 3
import * as THREE from 'three'
import { Physics } from '../src/physics'
import { Car } from '../src/car'
import type { CarInfo, TrackInfo, LoadedCar } from '../src/assets'
import { AiDriver, loadMemory } from '../src/aidriver'
import { LapTracker, rescuePoint } from '../src/race'
import { courseFiles, mirrorCollision, mirrorInfo, parseCourse } from '../shared/course'
import { ForceFields } from '../shared/fields'

const ROOT = new URL('../public/', import.meta.url).pathname
const carKey = process.argv[2] ?? 'mouse'
const LAPS = Number(process.argv[3] ?? 3)
const physics = await Physics.load(ROOT + 'box3d.wasm')
const course = parseCourse(process.env.TRACK ?? 'toylite')!
const cf = courseFiles(course)
const info: TrackInfo = await Bun.file(ROOT + cf.base.slice(1) + cf.info).json()
if (course.mirror) mirrorInfo(info)
const col = await Bun.file(ROOT + cf.base.slice(1) + (info.colBin ?? 'collision.bin')).arrayBuffer()
const nt = info.collision.triangles
const tris = new Float32Array(col, 0, nt * 9)
if (course.mirror) mirrorCollision(tris)
physics.mirrored = !!course.mirror
physics.fields = (info as any).fields?.length ? new ForceFields((info as any).fields) : null
physics.addMesh(tris, new Float32Array(col, nt * 36, nt), 0.5)
const mem = Bun.file(process.env.MEM ?? ROOT + cf.base.slice(1) + `ai-${course.id.replace(':', '-')}.json`) // MEM=file: another memory
if (await mem.exists()) {
  const m = await mem.json()
  if (process.env.NOCAPS) m.caps = []
  loadMemory(info, m)
}
const carInfo: CarInfo = await Bun.file(ROOT + `game/cars/${carKey}/car.json`).json()
const loaded: LoadedCar = { info: carInfo, body: new THREE.Mesh(), wheels: carInfo.wheels.map(() => new THREE.Mesh()) }
const s = info.start
const car = new Car(physics, loaded, new THREE.Vector3(s.pos[0], s.pos[1] + 0.25, s.pos[2]), -s.rot * Math.PI * 2)
car.iceLag = Number(process.env.AI_ICELAG ?? 0.15) // as the server's CPU cars (shared/ai.ts)
const pilot = new AiDriver(info, { pace: Number(process.env.PACE ?? 1), hints: !process.env.NOHINTS, physics, smart: process.env.SMART === '1' })
const laps = new LapTracker(info)
const DT = 1 / 120
const by: Record<string, number> = {}
let resets = 0, flat = 0, t = 0, lapStart = 0, lastV = 0
const where: string[] = [], crashAt: string[] = []
const lapTimes: number[] = []
const TRACE: unknown[][] | null = process.env.TRACE ? [] : null // TRACE=file.json: [lap, t, x, y, z, speed, limit, node] every 0.1 s
const WATCH = process.env.WATCH?.split(",").map(Number) // x0,z0,x1,z1: print the car every 0.1 s inside this box
while (laps.completedLaps() < LAPS && t < 200 * LAPS) {
  const c = pilot.drive(car, DT)
  if (c.reset || car.upsideTime > 1.8 || car.position.y < -30) {
    resets++
    where.push(`${car.position.x.toFixed(0)},${car.position.z.toFixed(0)}:${c.reset ? 'stuck' : car.upsideTime > 1.8 ? 'flip' : 'fell'}:n${(pilot as any).node}`)
    const r = pilot.rescueSpot(physics) ?? rescuePoint(info, physics, car.position)
    car.place(r.pos, r.yaw)
  }
  car.drive(c, DT)
  physics.step(DT, 2)
  car.readState()
  { const v = Math.hypot(car.velocity.x, car.velocity.z); if (lastV > 8 && lastV - v > 5) crashAt.push(`${car.position.x.toFixed(0)},${car.position.z.toFixed(0)}`); lastV = v }
  if (laps.completedLaps() >= 1) {
    // first lap is the standing start: count laps 2..
    by[pilot.limit] = (by[pilot.limit] ?? 0) + DT
    if (c.throttle > 0.95) flat += DT
  }
  if (WATCH && Math.round(t * 120) % 12 === 0 && car.position.x >= WATCH[0] && car.position.z >= WATCH[1] && car.position.x <= WATCH[2] && car.position.z <= WATCH[3])
    console.log(`  t=${t.toFixed(1)} lap ${laps.completedLaps() + 1} pos=${car.position.toArray().map((v) => v.toFixed(1))} v=${car.speed.toFixed(1)} thr=${c.throttle.toFixed(2)} limit=${pilot.limit} node=${(pilot as any).node}`)
  if (TRACE && Math.round(t * 120) % 12 === 0) TRACE.push([laps.completedLaps() + 1, +t.toFixed(2), ...car.position.toArray().map((v) => +v.toFixed(2)), +car.speed.toFixed(2), pilot.limit, (pilot as any).node])
  if (laps.update(car.position, t * 1000) === 'lap') lapTimes.push(laps.lapTimes.at(-1)! / 1000)
  t += DT
}
const counted = Object.values(by).reduce((a, b) => a + b, 0)
const pct = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / counted).toFixed(0)}%`).join(' ')
console.log(`${course.id} ${carKey} pace ${process.env.PACE ?? 1}${process.env.NOCAPS ? ' nocaps' : ''}${process.env.NOHINTS ? ' nohints' : ''}: laps ${lapTimes.map((x) => x.toFixed(1)).join(' ')} resets ${resets} | full throttle ${(100 * flat / counted).toFixed(0)}% | limit ${pct}`)
console.log(`  resets at ${where.join(' ') || '-'} | crashes ${crashAt.length}: ${crashAt.slice(0, 12).join(' ')}`)
if (TRACE) await Bun.write(process.env.TRACE!, JSON.stringify({ laps: lapTimes, trace: TRACE }))
