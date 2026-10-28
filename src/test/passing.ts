// Do CPU cars that are faster than the car ahead go round it, or run into it / sit behind it?
// 4 CPU cars + a slower "player" (an AiDriver that ignores others, 85% throttle, lower pace — to the
// CPU drivers it is just another Car, as a RemoteCar is), weapons off. Every time one car catches
// another (closing, gap along the track < 8 m) is an encounter, ended by:
//   pass     got ahead (gap < -2 m) without touching it
//   pass+hit got ahead, touching on the way
//   hit      touched it (bodies overlapping: |side| < 0.48 m, |along| < 0.95 m) and did not get by in 20 s
//   stuck    followed within 4 m for 8 s+ without getting by
//   dropped  fell back (gap > 14 m) — not a test of passing
// Also: how far sideways the catching car is when it draws level (|side| at along ≈ 0).
//   docker run ... bun test/passing.ts [course ...]     BLIND=1: CPU cars don't see the others (baseline)
const fake = { now: 0 }
Object.defineProperty(performance, 'now', { value: () => fake.now })
const { AiWorld } = await import('../shared/ai')
const { COURSES } = await import('../shared/course')
const THREE = await import('three')

const want = process.argv.slice(2)
const list = want.length ? COURSES.filter((c) => want.includes(c)) : COURSES.filter((c) => !c.includes(':'))
const CARS = ['rc', 'phat', 'cougar', 'dino', 'mite', 'volken', 'candy', 'beatall', 'toyeca', 'amw', 'adeon', 'sugo', 'mouse', 'r5', 'tc5', 'tc1', 'tc3']
const BLIND = process.env.BLIND === '1'
const PLAYER = 299
const MAX_S = Number(process.env.MAX_S ?? 240)

type Enc = { a: number; b: number; t0: number; hit: boolean; close: number; side: number | null }
const tot: Record<string, Record<string, number>> = { cpu: {}, player: {} }
const sides: Record<string, number[]> = { cpu: [], player: [] }
const add = (k: string, r: string) => (tot[k][r] = (tot[k][r] ?? 0) + 1)

for (const course of list) {
  const hooks = { message: () => {}, state: () => {}, finish: () => {} }
  const world = await AiWorld.create(hooks as any, course)
  const w = world as any
  const keys = [...CARS].sort(() => Math.random() - 0.5)
  for (let i = 0; i < 4; i++) await world.addAi(200 + i, keys[i], i + 1)
  await world.addAi(PLAYER, keys[4], 0) // the "player" starts on pole: everyone has to get past it
  const pl = w.drivers.get(PLAYER)
  pl.pilot.opts.pace = 0.8
  pl.pilot.opts.aggro = 0
  pl.pilot.opts.seek = () => []
  pl.pilot.opts.smart = false
  for (const d of w.drivers.values()) {
    const drive = d.pilot.drive.bind(d.pilot)
    d.pilot.drive = (car: any, dt: number, others: any[]) => {
      if (d.id === PLAYER) { const c = drive(car, dt, []); c.throttle = Math.min(c.throttle, 0.85); return c }
      return drive(car, dt, BLIND ? [] : others)
    }
  }
  w.weapons.give = () => {} // no weapons: driving only
  if (w.timer) clearInterval(w.timer)
  w.timer = 1
  w.last = fake.now
  const open = new Map<string, Enc>()
  const res: Record<string, number> = {}
  const ds = () => [...w.drivers.values()] as any[]
  const tick = () => {
    fake.now += 1000 / 60
    w.step(fake.now)
    if (w.phase !== 'race') return
    const t = fake.now / 1000
    for (const A of ds()) for (const B of ds()) {
      if (A === B || A.id === PLAYER || A.finished || B.finished) continue
      const k = A.id + '>' + B.id
      const gap = B.meter.value - A.meter.value
      const pa = A.car.position, pb = B.car.position
      const d = pb.clone().sub(pa)
      const fwd = A.car.forward.clone().setY(0).normalize()
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x)
      const along = d.dot(fwd), side = d.dot(right)
      let e = open.get(k)
      const closing = A.car.velocity.length() > B.car.velocity.length() + 0.5
      if (!e) {
        if (gap > 0.5 && gap < 8 && closing && Math.abs(d.y) < 1.5) open.set(k, (e = { a: A.id, b: B.id, t0: t, hit: false, close: 0, side: null }))
        else continue
      }
      if (Math.abs(d.y) < 1 && Math.abs(along) < 0.95 && Math.abs(side) < 0.48) e.hit = true // bodies overlap (hull ~0.38 x 1 m, wheels out to ~0.5)
      if (e.side === null && Math.abs(along) < 0.3 && Math.abs(d.y) < 1.5) e.side = Math.abs(side)
      if (gap > 0 && gap < 4) e.close += 1 / 60
      let r: string | null = null
      if (gap < -2) r = e.hit ? 'pass+hit' : 'pass'
      else if (gap > 14) r = 'dropped'
      else if (e.close > 8) r = 'stuck'
      else if (t - e.t0 > 20) r = e.hit ? 'hit' : 'stuck'
      if (r) {
        const kind = B.id === PLAYER ? 'player' : 'cpu'
        add(kind, r); res[(kind === 'player' ? 'P:' : '') + r] = (res[(kind === 'player' ? 'P:' : '') + r] ?? 0) + 1
        if (r.startsWith('pass') && e.side !== null) sides[kind].push(e.side)
        open.delete(k)
      }
    }
  }
  world.setPhase('grid')
  for (let i = 0; i < 240; i++) tick()
  world.setPhase('race')
  const t0 = fake.now
  while (ds().some((d) => !d.finished) && fake.now - t0 < MAX_S * 1000) tick()
  console.log(`${course.padEnd(12)} ${JSON.stringify(res)}`)
  w.dispose()
}
const pct = (o: Record<string, number>) => {
  const n = Object.entries(o).filter(([k]) => k !== 'dropped').reduce((s, [, v]) => s + v, 0)
  return Object.entries(o).map(([k, v]) => `${k} ${v}` + (k === 'dropped' ? '' : ` (${((v / n) * 100).toFixed(0)}%)`)).join(', ')
}
const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1].toFixed(2) : '-')
console.log(`${BLIND ? 'BLIND' : 'AWARE'} CPU catching CPU:    ${pct(tot.cpu)}   side gap when level, median ${med(sides.cpu)} m`)
console.log(`${BLIND ? 'BLIND' : 'AWARE'} CPU catching player: ${pct(tot.player)}   side gap when level, median ${med(sides.player)} m`)
