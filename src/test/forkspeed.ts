// Which branch at a fork is faster for a CPU car: solo laps with every fork on its main branch
// (or the alternative where the main one is ruled out), then with one fork switched. Prints one JSON line.
//   TRACK=nhood1 bun test/forkspeed.ts <car> <fork node | -1 for the baseline> [laps]
// convert/ step: test/forkspeed.py collects the lines into ai-<course>.json `fast` (AiDriver smart).
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
const fork = Number(process.argv[3] ?? -1)
// TURBO=1: a turbo fired as the car reaches the fork (gaps that need one: Botanical Garden's)
const TURBO = process.env.TURBO === '1'
let lastBoost = -1e9
const LAPS = Number(process.argv[4] ?? 3)
const physics = await Physics.load(ROOT + 'box3d.wasm')
const course = parseCourse(process.env.TRACK ?? 'nhood1')!
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
const mem = Bun.file(ROOT + cf.base.slice(1) + `ai-${course.id.replace(':', '-')}.json`)
if (await mem.exists()) loadMemory(info, await mem.json())
const carInfo: CarInfo = await Bun.file(ROOT + `game/cars/${carKey}/car.json`).json()
const loaded: LoadedCar = { info: carInfo, body: new THREE.Mesh(), wheels: carInfo.wheels.map(() => new THREE.Mesh()) }
const s = info.start
const car = new Car(physics, loaded, new THREE.Vector3(s.pos[0], s.pos[1] + 0.25, s.pos[2]), -s.rot * Math.PI * 2)
car.iceLag = 0.15
const pilot = new AiDriver(info, { pace: 1, physics }) as any
// every fork on its main branch (its alternative where the main one is ruled out); `fork` switched
const forks: number[] = info.ai!.map((n, i) => (n.next.length > 1 ? i : -1)).filter((i) => i >= 0)
const force = () => {
  for (const f of forks) {
    const bad = pilot.bad.get(f)
    let pick = bad === 0 ? 1 : 0
    if (f === fork && process.env.FLIP !== '0') pick = 1 - pick // FLIP=0: the main branch, turbo at the fork
    pilot.branch.set(f, pick)
    pilot.branchAt.set(f, 1e12) // never chosen again
  }
}
force()
// the stretch from the fork to where its branches rejoin: timed every lap (whole laps were too noisy,
// ~1 s a lap between identical runs), and whether the car really went down the alternative
const ai = info.ai!
let rejoin = -1, altFirst = -1
if (fork >= 0) {
  const main = new Set<number>()
  for (let k = 0, c = ai[fork].next[0]; k < 200; k++, c = ai[c].next[0]) main.add(c)
  altFirst = ai[fork].next[1]
  for (let k = 0, c = altFirst; k < 200; k++, c = ai[c].next[0]) if (main.has(c)) { rejoin = c; break }
}
const sections: number[] = []
let tIn = -1, sawAlt = false, altLaps = 0
const linePt = (i: number) => { const n = ai[i]; return [0, 1, 2].map((k) => n.a[k] + (n.b[k] - n.a[k]) * n.line) }
const laps = new LapTracker(info)
const DT = 1 / 120
let resets = 0, t = 0
const lapTimes: number[] = []
while (laps.completedLaps() < LAPS && t < 200 * LAPS) {
  force() // every tick: the driver clears its branch choices at the start of each lap
  const c = pilot.drive(car, DT)
  if (c.reset || car.upsideTime > 1.8 || car.position.y < -30) {
    resets++
    const r = pilot.rescueSpot(physics) ?? rescuePoint(info, physics, car.position)
    car.place(r.pos, r.yaw)
    force() // (rescueSpot can rule a branch out)
  }
  car.now = t * 1000
  if (TURBO && fork >= 0 && pilot.node === fork && t * 1000 - lastBoost > 8000) {
    car.turboUntil = car.now + 4000 // as weapons.ts
    lastBoost = t * 1000
  }
  car.drive(c, DT)
  physics.step(DT, 2)
  car.readState()
  if (laps.update(car.position, t * 1000) === 'lap') lapTimes.push(laps.lapTimes.at(-1)! / 1000)
  if (fork >= 0 && rejoin >= 0) {
    // by position (the current node can skip a few in one step): within 4 m of the fork's line point
    // starts the stretch, within 4 m of the rejoin point ends it
    const near = (i: number, r: number) => { const q = linePt(i); return Math.hypot(car.position.x - q[0], car.position.z - q[2]) < r && Math.abs(car.position.y - q[1]) < 3 }
    if (tIn < 0 && near(fork, 4)) { tIn = t; sawAlt = false }
    if (tIn >= 0 && (pilot.node === altFirst || near(altFirst, 3))) sawAlt = true
    if (tIn >= 0 && t - tIn > 0.3 && near(rejoin, 4)) {
      if (t - tIn < 120) sections.push(t - tIn)
      if (sawAlt) altLaps++
      tIn = -1
    }
  }
  t += DT
}
console.log(JSON.stringify({ course: course.id, car: carKey, fork, turbo: TURBO, flip: process.env.FLIP !== '0', sections, altLaps, rejoin, laps: lapTimes, resets, done: lapTimes.length >= LAPS }))
