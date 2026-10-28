// Train the CPU drivers on courses: six CPU cars race (no weapons, so every crash is a driving
// mistake) for MAX_S seconds of fake time; what they learn — corners to take slower, forks to
// leave alone (src/aidriver.ts corner memory / bad branches) — is written to
// public/game/<level>/ai-<course>.json, which the server's AiWorld loads.
//   bun test/train.ts [course prefix ...]     (default: every course)
const fake = { now: 0 }
Object.defineProperty(performance, 'now', { value: () => fake.now })

const { AiWorld } = await import('../shared/ai')
const { COURSES, parseCourse, courseFiles } = await import('../shared/course')
const { saveMemory } = await import('../src/aidriver')

const ROOT = new URL('../public/', import.meta.url).pathname
const CARS = ['rc', 'phat', 'cougar', 'dino', 'mite', 'volken', 'candy', 'beatall', 'toyeca', 'amw', 'adeon', 'sugo', 'mouse']
const SECONDS = Number(process.env.MAX_S ?? 600)
const want = process.argv.slice(2)
const list = COURSES.filter((c) => !want.length || want.some((w) => c === w || (!process.env.EXACT && (c.startsWith(w + ':') || (w.endsWith(':') && c.startsWith(w))))))

for (const course of list) {
  const hooks = { message: () => {}, state: () => {}, finish: () => {} }
  const world = await AiWorld.create(hooks, course)
  const keys = [...CARS].sort(() => Math.random() - 0.5).slice(0, 6)
  for (let i = 0; i < 6; i++) await world.addAi(300 + i, keys[i], i)
  const w = world as any
  if (w.timer) clearInterval(w.timer)
  w.timer = 1
  w.last = fake.now
  world.setPhase('grid')
  for (let t = 0; t < 4; t += 1 / 60) { fake.now += 1000 / 60; w.step(fake.now) }
  world.setPhase('race')
  for (let t = 0; t < SECONDS; t += 1 / 60) {
    fake.now += 1000 / 60
    w.step(fake.now)
    for (const d of w.drivers.values()) d.finished = false // keep going past the flag
  }
  const mem = saveMemory(w.info)
  const c = parseCourse(course)!
  await Bun.write(ROOT + courseFiles(c).base.slice(1) + `ai-${course.replace(':', '-')}.json`, JSON.stringify(mem))
  const resets = [...w.drivers.values()].map((d: any) => d.resets)
  console.log(`${course.padEnd(14)} caps ${mem.caps?.filter((c) => c[5] !== 0).length ?? 0} (slowest ${Math.min(99, ...(mem.caps ?? []).map((x) => x[3])).toFixed(1)} m/s)  forks avoided ${mem.avoid.length}  resets in training ${resets.join(' ')}`)
  w.dispose()
}
