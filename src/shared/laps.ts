// Player laps for the CPU drivers to learn from ("store the players' paths …
// only laps that are better than the current CPU best time").
//
// The lobby feeds every person's state packets in (the 30 Hz stream it relays anyway); a trace is
// kept at ~10 Hz. When the browser reports a lap, the lap's stretch of the trace is stored if it is
//   - a flying lap (lap 2 on: lap 1 starts from the grid),
//   - clean: no turbo, zap, oil, weapon blast, put-back or flip in it (state flags 4/8/32/64/128),
//     no jump in position (a reset by an older page) and no hole in the stream over 0.5 s,
//   - faster than the best CPU lap on that course in a car of the same class (`cpu-best.json`, kept
//     from the CPU cars' race results; no CPU time for the class yet = nothing stored).
// Per course, the 10 fastest such laps per class are kept: data/laps/<course>.json
//   { course, laps: [{ car, cls, ms, cpuMs, at, n, pts: [[t ms, x, y, z cm, speed cm/s, steer %], …] }] }
// (positions in the course's own frame: a mirrored course's laps are mirrored like its world).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

// original game's class per car (Rating in its Parameters.txt): 0 Rookie, 1 Amateur, 2 Advanced, 3 Semi-Pro, 4 Pro
export const RATING: Record<string, number> = {
  rc: 0, phat: 0, mite: 0, volken: 0, beatall: 0, moss: 0, mud: 0, tc6: 0,
  dino: 1, candy: 1, mouse: 1, gencar: 1, q: 1, tc4: 1,
  flag: 2, r5: 2, sgt: 2, tc2: 2, tc5: 2,
  adeon: 3, fone: 3, rotor: 3, tc1: 3, tc3: 3,
  cougar: 4, toyeca: 4, amw: 4, sugo: 4, panga: 4, ufo: 4,
}

const DIR = process.env.LAPS_DIR ?? new URL('../data/laps/', import.meta.url).pathname
const KEEP = 10 // laps per course and class
const EVERY_MS = 100 // trace sampling
const TRACE_MS = 6 * 60_000 // trace kept per player (longer than any lap)
const DIRTY = 4 | 8 | 32 | 64 | 128 // zapped, turbo, oiled, thrown, put back

type Pt = [number, number, number, number, number, number, number] // server ms, x, y, z, speed, steer, flags

interface Lap { car: string; cls: number; ms: number; cpuMs: number; at: string; n: number; pts: number[][] }

const fileOf = (course: string) => DIR + course.replace(/:/g, '-') + '.json'

function readJson<T>(f: string, fallback: T): T {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return fallback }
}
function writeJson(f: string, v: unknown) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(f + '.tmp', JSON.stringify(v))
  renameSync(f + '.tmp', f)
}

export class LapRecorder {
  private traces = new Map<number, Pt[]>()
  private last = new Map<number, Pt>() // the last raw sample (jumps / holes are checked at full rate)
  private broken = new Map<number, number>() // player -> server ms of the last jump or hole
  private cpuBest: Record<string, Record<string, { ms: number; car: string; at: string }>> = readJson(DIR + 'cpu-best.json', {})

  /** A person's state packet: server-clock time, the 16 floats (shared/protocol.ts). */
  state(id: number, time: number, f: Float32Array) {
    const flags = f[15] | 0
    const p: Pt = [time, f[0], f[1], f[2], Math.hypot(f[7], f[8], f[9]), f[13], flags]
    const prev = this.last.get(id)
    this.last.set(id, p)
    if (!(flags & 2) || flags & 1) { this.traces.delete(id); return } // not racing / finished
    if (prev) {
      const dt = time - prev[0]
      if (dt <= 0) return // late (unordered channel): the trace is ordered
      const jump = Math.hypot(p[1] - prev[1], p[2] - prev[2], p[3] - prev[3])
      if (dt > 500 || jump > Math.max(3, 0.05 * dt)) this.broken.set(id, time) // 50 m/s
    }
    const tr = this.traces.get(id) ?? []
    if (!tr.length || time - tr[tr.length - 1][0] >= EVERY_MS || flags & DIRTY) tr.push(p)
    while (tr.length && time - tr[0][0] > TRACE_MS) tr.shift()
    this.traces.set(id, tr)
  }

  /** A person reported lap `n` done in `ms`. Stores it if it qualifies; returns why not (for the log). */
  lap(id: number, course: string, car: string, n: number, ms: number): string {
    const tr = this.traces.get(id)
    if (n < 2) return 'first lap'
    if (!tr?.length || !(ms > 3000)) return 'no trace'
    const end = tr[tr.length - 1][0], start = end - ms
    if (tr[0][0] > start + 300) return 'trace too short'
    const pts = tr.filter((p) => p[0] >= start - EVERY_MS && p[0] <= end)
    const dirty = pts.reduce((a, p) => a | (p[6] & DIRTY), 0)
    if (dirty) return 'not clean: ' + Object.entries({ 4: 'zapped', 8: 'turbo', 32: 'oil', 64: 'weapon hit', 128: 'put back' }).filter(([b]) => dirty & +b).map(([, n]) => n).join(', ')
    if ((this.broken.get(id) ?? 0) >= start) return 'jump or hole'
    const cls = RATING[car] ?? 0
    const cpu = this.cpuBest[course]?.[cls]
    if (!cpu) return 'no CPU time for the class'
    if (ms >= cpu.ms) return `slower than the CPU (${(cpu.ms / 1000).toFixed(2)} s)`
    const f = fileOf(course)
    const data = readJson<{ course: string; laps: Lap[] }>(f, { course, laps: [] })
    const t0 = pts[0][0]
    const lap: Lap = {
      car, cls, ms: Math.round(ms), cpuMs: cpu.ms, at: new Date().toISOString(), n,
      pts: pts.map((p) => [Math.round(p[0] - t0), Math.round(p[1] * 100), Math.round(p[2] * 100), Math.round(p[3] * 100), Math.round(p[4] * 100), Math.round(p[5] * 100)]),
    }
    data.laps.push(lap)
    const drop = new Set(data.laps.filter((l) => l.cls === cls).sort((a, b) => a.ms - b.ms).slice(KEEP))
    if (drop.has(lap)) return `not in the best ${KEEP}`
    data.laps = data.laps.filter((l) => !drop.has(l))
    writeJson(f, data)
    return 'stored'
  }

  /** A CPU car's lap (lap 1 included: never faster than its flying laps; laps with a turbo too — a higher bar). */
  cpuLap(course: string, car: string, ms: number) {
    if (!(ms > 3000)) return
    const cls = RATING[car] ?? 0
    const c = (this.cpuBest[course] ??= {})
    if (c[cls] && c[cls].ms <= ms) return
    c[cls] = { ms: Math.round(ms), car, at: new Date().toISOString() }
    writeJson(DIR + 'cpu-best.json', this.cpuBest)
  }

  forget(id: number) {
    this.traces.delete(id)
    this.last.delete(id)
    this.broken.delete(id)
  }
}
