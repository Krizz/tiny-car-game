// How far an untargeted firework gets: one CPU car laps a course and fires every 5 s (nobody to
// home on); per shot, the distance from launch to where it went off and how long it flew.
//   bun test/rocket.ts [course] [shots]
const fake = { now: 0 }
Object.defineProperty(performance, 'now', { value: () => fake.now })
const { AiWorld } = await import('../shared/ai')
const course = process.argv[2] ?? 'toylite'
const shots = Number(process.argv[3] ?? 12)
const world = await AiWorld.create({ message: () => {}, state: () => {}, finish: () => {} }, course)
await world.addAi(200, 'rc', 0)
const w = world as any
if (w.timer) clearInterval(w.timer)
w.timer = 1
w.last = fake.now
const step = (s: number) => { for (let t = 0; t < s; t += 1 / 60) { fake.now += 1000 / 60; w.step(fake.now) } }
world.setPhase('grid'); step(4); world.setPhase('race')
const res: number[][] = []
for (let i = 0; i < shots; i++) {
  step(5)
  const d = w.drivers.get(200)
  d.nextThink = Infinity // the AI's own weapon logic stays out of it
  world.give(200, 'firework', 1)
  const n0 = w.weapons.projectiles.length
  w.weapons.fire(200)
  const p = w.weapons.projectiles[n0]
  if (!p) continue
  const from = p.pos.clone(), v0 = p.vel.length()
  let last = p.pos.clone(), age = 0
  while (w.weapons.projectiles.includes(p)) { last = p.pos.clone(); age = p.age; step(1 / 60) }
  res.push([from.distanceTo(last), age, v0, last.y - from.y])
  d.nextThink = 0
}
for (const r of res) console.log(`flew ${r[0].toFixed(1)} m in ${r[1].toFixed(2)} s (launched at ${r[2].toFixed(1)} m/s, ended ${r[3].toFixed(1)} m ${r[3] >= 0 ? 'up' : 'down'})`)
const avg = res.reduce((s, r) => s + r[0], 0) / res.length
console.log(`${course}: ${res.length} shots, average ${avg.toFixed(1)} m, ${res.filter((r) => r[1] >= 3.1).length} ran their full time`)
