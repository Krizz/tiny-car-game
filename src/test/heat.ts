// Heatmap data: a whole CPU race on a course — positions (10 Hz), crashes, resets and a height map → JSON.
//   docker run --rm -v ./src:/src -w /src oven/bun:1.3.0 bun test/heat.ts <course> [seconds] > x.json
//   then convert/heatmap.py (README: CPU lines)
const fake = { now: 0 }
Object.defineProperty(performance, 'now', { value: () => fake.now })
const { AiWorld } = await import('../shared/ai')
const course = process.argv[2]
const S = Number(process.argv[3] ?? 300)
const finished = new Set<number>()
const world: any = await AiWorld.create({ message: () => {}, state: () => {}, finish: (id: number) => finished.add(id) } as any, course)
const keys = ['rc', 'tc5', 'candy', 'sugo', 'tc1', 'amw']
for (let i = 0; i < 6; i++) await world.addAi(200 + i, keys[i], i)
if (world.timer) clearInterval(world.timer)
world.timer = 1; world.last = 0
world.setPhase('grid'); for (let t = 0; t < 4; t += 1 / 60) { fake.now += 1000 / 60; world.step(fake.now) }
world.setPhase('race')
const pts: number[] = [], crashes: number[] = [], resets: number[] = []
const lastV = new Map<number, number>(), lastRes = new Map<number, number>()
let step = 0
for (let t = 0; t < S && finished.size < 6; t += 1 / 60) {
  fake.now += 1000 / 60; world.step(fake.now); step++
  for (const d of world.drivers.values()) {
    if (finished.has(d.id)) continue
    const p = d.car.position, v = Math.hypot(d.car.velocity.x, d.car.velocity.z)
    if (step % 6 === 0) pts.push(+p.x.toFixed(1), +p.z.toFixed(1))
    const was = lastV.get(d.id) ?? v
    if (was > 6 && was - v > 5) crashes.push(+p.x.toFixed(1), +p.z.toFixed(1))
    lastV.set(d.id, v)
    if (d.resets !== (lastRes.get(d.id) ?? 0)) { resets.push(+p.x.toFixed(1), +p.z.toFixed(1)); lastRes.set(d.id, d.resets) }
  }
}
// bounding box of the AI nodes, and a height map over it (0.5 m)
let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9
for (const n of world.info.ai) for (const q of [n.a, n.b]) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]) }
x0 = Math.floor(x0 - 12); x1 = Math.ceil(x1 + 12); z0 = Math.floor(z0 - 12); z1 = Math.ceil(z1 + 12)
const R = 0.5, hm: number[] = []
let top = -1e9
for (const n of world.info.ai) top = Math.max(top, n.a[1], n.b[1])
for (let z = z0; z < z1; z += R) for (let x = x0; x < x1; x += R) {
  const h = world.physics.raycast([x, top + 4, z], [0, -1, 0], top + 80)
  hm.push(h ? Math.round(h.point[1] * 10) / 10 : -999)
}
console.log(JSON.stringify({ course, box: [x0, x1, z0, z1], res: R, hm, pts, crashes, resets, finished: finished.size, laps: S }))
process.exit(0)
