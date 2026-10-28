// A whole CPU race on a course, faster than real time: the server's own AiWorld (6 CPU cars,
// weapons from the stars, the same drivers the lobby runs) on a fake clock.
//   bun test/race.ts [course prefix ...]     (default: every course)
// Per course: cars finished (of 6), best lap, the slowest finisher's time, resets per car.
const fake = { now: 0 }
Object.defineProperty(performance, 'now', { value: () => fake.now })

const { AiWorld } = await import('../shared/ai')
const { COURSES } = await import('../shared/course')
const { AMMO, WEAPONS, LAPS } = await import('../shared/protocol')
const { drawWeapon } = await import('../shared/draw')
// CPUBEST=1: each CPU car's best lap goes into data/laps/cpu-best.json (the bar a player's lap must beat
// to be kept, shared/laps.ts) — stop the server's lobby from writing it meanwhile (it reads it at start)
const { LapRecorder } = await import('../shared/laps')
const recorder = process.env.CPUBEST ? new LapRecorder() : null

const CARS = process.env.CARS?.split(',') ?? ['rc', 'phat', 'cougar', 'dino', 'mite', 'volken', 'candy', 'beatall', 'toyeca', 'amw', 'adeon', 'sugo', 'mouse', 'r5', 'tc5', 'tc1', 'tc3']
const MAX_S = Number(process.env.MAX_S ?? 480) // the lobby's own limit is 8 min
const want = process.argv.slice(2)
// EXACT=1: only the course named (toylite alone, not toylite:r and the rest too)
const list = COURSES.filter((c) => !want.length || want.some((w) => c === w || (!process.env.EXACT && (c.startsWith(w + ':') || (w.endsWith(':') && c.startsWith(w))))))

let bad = 0
for (const course of list) {
  const finished = new Map<number, { time: number; best: number | null }>()
  const rockets = { locked: 0, loose: 0 }
  const haz = { oily: 0, fakes: 0, turbos: 0, turboS: 0, turboCrash: 0, turboReset: 0 } // s of CPU cars with a tyre in oil, fake stars set off
  const pending: any[] = []
  const drawn = [[0, 0], [0, 0], [0, 0], [0, 0]] // [turbos, others] for last, 2nd/3rd to last, the rest
  let world: InstanceType<typeof AiWorld>
  const hooks = {
    message: (id: number, m: any) => {
      if (m.t === 'pick' && process.env.NOWEAPONS) return
      if (m.t === 'pick') {
        // the server's draw by place (DRAW=old: without the turbo boost at the back, DRAW=flat: any weapon
        // alike); WEAPON=turbo: every star a turbo
        const w = (process.env.WEAPON as any) ?? (process.env.DRAW === 'flat' ? WEAPONS[Math.floor(Math.random() * WEAPONS.length)] : drawWeapon(m.place, m.of, process.env.DRAW === 'old' ? [] : undefined))
        const back = m.of - m.place
        drawn[back < 3 && m.place > 1 ? back : 3][w === 'turbo' ? 0 : 1]++
        if (w !== 'puttyBomb') world.give(id, w, AMMO[w])
      } else if (m.t === 'det') {
        // handed back on the next tick, as over the network (now: inside the loop that checks fake stars)
        haz.fakes++
        pending.push({ ...m, t: 'det', id })
      } else if (m.t === 'fire') {
        if (m.w === 'turbo') haz.turbos++
        if (m.w === 'firework' || m.w === 'fireworkPack') rockets[(m.d?.[6] ?? 0) > 0 ? 'locked' : 'loose']++
        if (process.env.DROPS && (m.w === 'oilSlick' || m.w === 'ballBearing' || m.w === 'clone')) {
          const d = (world as any).drivers.get(id)
          console.log(`    drop ${m.w} at ${d.car.position.toArray().map((v: number) => v.toFixed(0))} narrow ${d.pilot.inNarrow()} held ${((performance.now() - d.heldSince) / 1000).toFixed(1)} s`)
        }
        world.onServerMsg({ ...m, t: 'fire', id })
      }
    },
    state: () => {},
    finish: (id: number, time: number, best: number | null) => {
      finished.set(id, { time, best })
      if (recorder && best !== null) recorder.cpuLap(course, (world as any).drivers.get(id).key, best)
    },
  }
  world = await AiWorld.create(hooks, course)
  const N = Number(process.env.N ?? 6) // cars in the race
  const keys = [...CARS].sort(() => Math.random() - 0.5).slice(0, N)
  for (let i = 0; i < N; i++) await world.addAi(200 + i, keys[i], i)
  const w = world as any
  if (w.timer) clearInterval(w.timer)
  w.timer = 1 // never let it start its own real-time loop
  // crashes: a car losing more than 5 m/s within one 1/60 s tick (a wall, a post, a car, a flip)
  let raceT0 = 0
  const lastV = new Map<number, number>()
  const lastRes = new Map<number, number>()
  const crashes = new Map<number, number>()
  const crashAt: number[][] = []
  const step = (s: number) => {
    for (let t = 0; t < s; t += 1 / 60) {
      fake.now += 1000 / 60
      for (const m of pending.splice(0)) world.onServerMsg(m)
      w.step(fake.now)
      if (w.phase !== 'race') continue
      for (const d of w.drivers.values()) {
        if (d.finished) continue
        if (d.car.wheels.some((wh: any) => wh.oil > fake.now)) haz.oily += 1 / 60
        if (d.car.turboUntil > fake.now) haz.turboS += 1 / 60
        // a reset on turbo or within 3 s of it
        if (d.resets > (lastRes.get(d.id) ?? 0) && fake.now - d.car.turboUntil < 3000) haz.turboReset++
        lastRes.set(d.id, d.resets)
        const v = Math.hypot(d.car.velocity.x, d.car.velocity.z) // landings aren't crashes
        const was = lastV.get(d.id) ?? v
        if (was - v > 5) {
          crashes.set(d.id, (crashes.get(d.id) ?? 0) + 1)
          if (d.car.turboUntil > fake.now) haz.turboCrash++
          crashAt.push([d.car.position.x, d.car.position.y, d.car.position.z])
          // EARLY=15: every crash in the race's first 15 s, with the car and its AI node
          if (process.env.EARLY && raceT0 && fake.now - raceT0 < Number(process.env.EARLY) * 1000) {
            console.log(`    early ${((fake.now - raceT0) / 1000).toFixed(1)} s ${d.key} at ${d.car.position.toArray().map((x: number) => x.toFixed(1))} node ${(d.pilot as any).node} ${was.toFixed(1)}→${v.toFixed(1)} m/s`)
          }
        }
        lastV.set(d.id, v)
      }
    }
  }
  w.last = fake.now
  world.setPhase('grid')
  step(4)
  world.setPhase('race')
  const t0 = fake.now
  raceT0 = t0
  while (finished.size < N && fake.now - t0 < MAX_S * 1000) step(5)
  const drivers = [...w.drivers.values()]
  const resets = drivers.map((d: any) => d.resets)
  const bests = [...finished.values()].map((f) => f.best).filter((b): b is number => !!b)
  const slowest = Math.max(0, ...[...finished.values()].map((f) => f.time))
  const crash = drivers.map((d: any) => crashes.get(d.id) ?? 0)
  const ok = finished.size === N && Math.max(...resets) <= 6
  if (!ok) bad++
  console.log(`${ok ? 'ok ' : 'BAD'} ${course.padEnd(14)} finished ${finished.size}/${N}  best ${bests.length ? (Math.min(...bests) / 1000).toFixed(1) : '-'} s  ` +
    `last home ${(slowest / 1000).toFixed(0)} s  resets ${resets.join(' ')}  crashes ${crash.join(' ')}  (${LAPS} laps)` +
    `  hit-resets ${w.resetLog.filter((r: any) => r.why.endsWith('+hit')).length}` + (process.env.KEYS ? `  cars ${drivers.map((d: any) => d.key).join(' ')}` : ''))
  // cars that never finished: where they are and what they think
  if (finished.size < N) console.log(`    world phase ${w.phase}, raceStart ${w.raceStart}, now ${fake.now}, acc ${w.acc}, last ${w.last}`)
  for (const d of drivers as any[]) {
    if (finished.has(d.id)) continue
    const pl = d.pilot
    console.log(`    DNF ${d.key} at ${d.car.position.toArray().map((v: number) => v.toFixed(1))} v=${d.car.speed.toFixed(1)} up=${d.car.upAxis.y.toFixed(2)} node=${pl.node} lap=${d.lap.lap} last zone=${d.lap.last} passes=${d.lap.passes} crossings=${d.lap.crossings} resets=${d.resets} heldSince=${d.heldSince}`)
  }
  console.log(`    first home ${(Math.min(...[...finished.values()].map((f) => f.time)) / 1000).toFixed(0)} s; rockets fired: ${rockets.locked} locked, ${rockets.loose} loose; in oil ${haz.oily.toFixed(1)} s, fake stars set off ${haz.fakes}; turbos fired ${haz.turbos}, ${haz.turboS.toFixed(0)} s on turbo, ${haz.turboCrash} crashes on turbo, ${haz.turboReset} resets on/just after turbo; drawn (turbo/other) last ${drawn[0].join('/')} 2nd ${drawn[1].join('/')} 3rd ${drawn[2].join('/')} rest ${drawn[3].join('/')}`)
  if (process.env.WHERE) {
    // hotspots: resets grouped by 5 m cell
    const cells = new Map<string, { n: number; why: Record<string, number>; node: number; pos: number[] }>()
    for (const r of w.resetLog) {
      const k = `${Math.round(r.pos[0] / 5) * 5},${Math.round(r.pos[2] / 5) * 5}`
      const c = cells.get(k) ?? { n: 0, why: {}, node: r.node, pos: r.pos }
      c.n++
      c.why[r.why] = (c.why[r.why] ?? 0) + 1
      cells.set(k, c)
    }
    for (const [k, c] of [...cells].sort((a, b) => b[1].n - a[1].n).slice(0, 6))
      console.log(`    ${String(c.n).padStart(3)} at ${k} (y ${c.pos[1].toFixed(1)}) node ${c.node} ${JSON.stringify(c.why)}`)
    const cc = new Map<string, number>()
    for (const p of crashAt) {
      const k = `${Math.round(p[0] / 5) * 5},${Math.round(p[2] / 5) * 5} (y ${p[1].toFixed(0)})`
      cc.set(k, (cc.get(k) ?? 0) + 1)
    }
    console.log('    crashes at: ' + [...cc].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${n}× ${k}`).join(' · '))
  }
  w.dispose()
}
console.log(`${list.length - bad}/${list.length} courses ok`)
