// Computer driver after original game's AI: it drives the track's own AI nodes
// (the .fan file: segments across the track with the designers' racing line
// and overtaking line between their two ends).
//
//   steering  pure pursuit on the line — aim at a point a speed-dependent
//             distance ahead and turn the wheels by the angle the car's own
//             geometry needs to arc through it (smooth, no twitching)
//   speed     look down the line, work out how fast each bend can be taken with
//             the tyres' grip (v = sqrt(mu g R)), and brake early enough for
//             the tightest one; throttle is proportional, not on/off
//   racecraft another car close ahead on our line -> drift over to the
//             overtaking line until past it
//   smoothing the line ahead is averaged over a few metres before it is followed: the authored
//             line kinks at nodes and zigzags where nodes disagree, and following it exactly
//             made the cars weave (and hit Toys in the Hood's skate ramp at an angle and flip)
//   avoiding  a ray at bumper height along the way ahead: where the line runs into a prop (the
//             parked BMW's wheel on Toys in the Hood, Toytanic's deck chairs) the car steers to
//             the nearest side that is clear, instead of hitting it every lap
import * as THREE from 'three'
import { surface } from './surfaces'
import type { TrackInfo } from './assets'
import type { Car, Controls } from './car'
import type { Physics } from './physics'
import { standOn } from './race'

const G = 22
const NO_PROGRESS_S = 6 // s without getting 1 m closer to the next node (Toytanic has 80 m gaps)
const STEER_MAX = 0.42 // must match car.ts
const V = (p: number[]) => new THREE.Vector3(p[0], p[1], p[2])

// original game's AI node priorities (track editor): how the designers marked tricky bits
const PRIO = { LONG_ROUTE: 11, SHORTCUT: 10, OFF_THROTTLE: 13, OFF_THROTTLE_PETROL: 14 } as const
const SLOWDOWN: Record<number, number> = { 4: 0.75, 16: 0.85, 17: 0.8, 18: 0.7 } // "slowdown 25/15/20/30 %"

interface Node {
  prio: number
  a: THREE.Vector3
  b: THREE.Vector3
  line: number
  over: number
  next: number[]
  prev: number[]
}

export interface AiOptions {
  physics?: Physics // for looking ahead for obstacles
  pace?: number // grip the driver dares to use (skill), ~0.85..1.05
  route?: number // 0..1 chance of taking an alternative branch
  /** knows the course ("some smarter CPU cars in every batch" — Toys in the Hood's cuts over the
   *  lowered kerbs): at a fork takes the branch measured faster (AiMemory fast), and the one that is
   *  faster with a turbo when it holds one (fastTurbo; the race fires it there, shared/ai.ts) */
  smart?: boolean
  hasTurbo?: () => boolean
  hints?: boolean // obey the track's slowdown / off-throttle marks (default true)
  obstacles?: () => number[][] // things that move, [x, y, z, r] (knock-over packets, bottles): steered round
  seek?: () => THREE.Vector3[] // pickup stars worth a detour (none while a weapon is in hand)
  /** holding the putty bomb: the rival to hand it to (position, velocity, ahead or behind), or null */
  chase?: () => { pos: THREE.Vector3; vel: THREE.Vector3 } | null
  seekLat?: number // m: the furthest a star may lie beside the way to be steered for (default 1.2)
  aggro?: number // 0..1: leaning on rivals alongside, covering the inside from one behind
}

// Branches no CPU car should take on a course (keyed by its TrackInfo, shared by the drivers on it):
// found unclimbable when the course loads (a kerb across the way: Toys in the Hood's "soft
// suspension" routes over 29 cm kerbs), or because a car got stuck soon after taking one.
const badBranches = new WeakMap<TrackInfo, Map<number, number>>() // fork node -> the way (0 / 1) not to take
const STEP = 0.18 // m: a rise this sudden is a wall to a toy car
// Speed memory (per course, shared by its CPU cars): where a car crashed, the speed it may reach
// within CAP_R of that place is capped at 90% of the crash speed — tighter each time, never below
// CAP_MIN (was 9 m/s: Toy World 1's hairpin into the narrow corridor, nodes 9–11, can't be taken
// at 9 and every car hit the corridor's corner there at 8.8–9.6 m/s, start after start) ([x, y, z, m/s, reach m], y = the ground under it). A grip factor did nothing where the crash
// wasn't about the bend (off a ramp into a wall); per node, one crash slowed an 80 m straight
// (Toytanic 1). A crash above the limit means the car couldn't brake in time (light over a ramp's
// crest, Toytanic 1's dead-end corridor): the limit then reaches 3 m further, up to 12 m.
const speedCaps = new WeakMap<TrackInfo, number[][]>()
const CAP_R = 5
const CAP_MIN = 7 // m/s
/** How hard the CPU drivers push (tests set these from AI_GRIP / AI_BRAKE / AI_LEARN, shared/ai.ts):
 *  grip = the share of the tyres' grip used in bends (× pace), brake = m/s² planned for, learn = whether
 *  crashes in a race become speed limits */
export const TUNE = { grip: 1.8, brake: 24, learn: true }
const CRASH_FROM = 8 // m/s: slower knocks aren't learnt from
// (Remembering crash points as obstacles to steer round was tried and dropped: through Supermarket
// 1's U-turns the cars swung wide round them and lapped 20 % slower, for no fewer resets.)
// The racing / overtaking line as the designers drew it, with every point that made a stretch run
// into something (Toytanic 1: from node 81 the line passes a vent's corner 5 cm off — a car is
// 0.6 m wide) moved along its node until the stretches either side are clear. Per course.
const clearedLines = new WeakMap<TrackInfo, { line: number[]; over: number[]; moved: number }>()
const CLEAR_W = [0, -0.15, 0.15, -0.3, 0.3, -0.45, 0.45, -0.6, 0.6] // m either side of the line: the car and a margin (every 15 cm: Museum 2's rope posts are thinner than the old 25 cm gaps)
// a face this steep (normal's y below it, ~41°) is a wall to a line being cleared: a kerb at 45°
// counted as a ramp, and Toys in the Hood 1 reversed sent every car into one at node 211 each lap
const WALL_N = 0.75
const MAX_MOVE = 3.5 // m, from where the designers put it (7 m on Museum 1 took the cars off a walkway)

/** Walls a stretch of line runs into, counted along CLEAR_W rays 12 cm up (under a step a car
 *  can't climb — STEP; Ghost Town 2's boardwalk edge); a ramp or kerb doesn't count. Every wall
 *  along each ray, so getting past one of two counts as better. */
export function wallsOn(ph: Physics, p: THREE.Vector3, q: THREE.Vector3): number {
  const d = q.clone().sub(p)
  const len = d.length()
  if (len < 0.3 || Math.abs(d.y) > len * 0.7) return 0
  d.divideScalar(len)
  const side = new THREE.Vector3(-d.z, 0, d.x).normalize()
  let n = 0
  // 12 cm up, and 25 cm (a car's body): Museum 2's rope posts are 15 cm thin poles standing on a
  // 16 cm dome — a ray at 12 cm runs into the dome and never meets the pole
  for (const w of CLEAR_W) for (const up of [0.12, 0.25]) {
    const a = p.clone().addScaledVector(side, w)
    a.y += up
    let from = a, left = len
    for (let k = 0; k < 6 && left > 0.05; k++) {
      const hit = ph.raycast(from.toArray(), d.toArray(), left)
      if (!hit) break
      if (hit.normal[1] < WALL_N) n++
      from = from.clone().addScaledVector(d, hit.dist + 0.05)
      left -= hit.dist + 0.05
    }
  }
  return n
}

/** Sudden steps in the floor along a stretch of line (the CLEAR_W strip, every 30 cm along): a rise
 *  or drop of BUMP over 15 cm across, or of 2 × BUMP over 30 cm along — kerbs and the cone feet of
 *  posts the wall rays slide through (Museum 2's rope posts: the 12 cm rays went into the 40 cm
 *  base and never met the post; every car hit it, every lap). Banked bends and ramps are far less
 *  sudden; a gap the line jumps is no step, an edge beside it is. One count per place along. */
const BUMP = 0.18
// (A "hump" test — a strip sample 8 cm above the chord across it, for the 16 cm domes under Museum
// 2's rope posts — was tried and dropped: it moved ~140 line points elsewhere and the 41 courses it
// alone touched had 20 % more resets. Museum 2's line is hand-set round the domes instead.)
export function bumpsOn(ph: Physics, p: THREE.Vector3, q: THREE.Vector3): number {
  const d = q.clone().sub(p)
  const len = Math.hypot(d.x, d.z)
  if (len < 0.3) return 0
  const side = new THREE.Vector3(-d.z / len, 0, d.x / len)
  const ws = [...CLEAR_W].sort((x, y) => x - y)
  let n = 0
  let prev: (number | null)[] | null = null
  for (let s = 0; s <= len; s += 0.3) {
    const c = p.clone().addScaledVector(d, s / len)
    const hs = ws.map((w) => {
      const o = c.clone().addScaledVector(side, w)
      const h = ph.raycast([o.x, c.y + 0.6, o.z], [0, -1, 0], 1.6)
      return h ? h.point[1] : null
    })
    // no floor under the line itself: a jump's gap, not a step. No floor beside it while there is
    // under it: a ledge (Toytanic reversed, nodes 72–74: the line ran 0.7 m from a 15 m drop)
    const mid = hs[ws.indexOf(0)]
    if (mid === null) { prev = null; continue }
    let step = hs.some((h) => h === null)
    for (let i = 1; i < hs.length && !step; i++) {
      const a0 = hs[i - 1], a1 = hs[i]
      if (a0 !== null && a1 !== null && Math.abs(a1 - a0) > BUMP) step = true
    }
    if (prev) for (let i = 0; i < hs.length && !step; i++) {
      const a0 = prev[i], a1 = hs[i]
      if (a0 !== null && a1 !== null && Math.abs(a1 - a0) > 2 * BUMP) step = true
    }
    if (step) n++
    prev = hs
  }
  return n
}

/** What the CPU cars have learnt about a course (test/train.ts writes it, the server loads it).
 *  `line`: hand-set racing-line points [node, x, z] where the designers' line doesn't suit our cars
 *  (Toy World 1: the exit of the first hairpin hugged the corridor's corner, and every car came out
 *  1.5 m wide of it into that corner). Kept as they are by training. */
export interface AiMemory {
  caps?: number[][]; avoid: [number, number][]; line?: [number, number, number][]
  /** forks whose alternative branch is faster (test/forkspeed.ts: ≥ 0.25 s on the fork-to-rejoin stretch for
   *  each car tried) — and those where it is only with a turbo fired there. Smart drivers use them */
  fast?: number[]; fastTurbo?: number[]
  /** [fork, way, m/s]: that way is a jump that needs this speed at the fork (Botanical Garden's gap after
   *  node 166: made from ~25 m/s, short below). A car that won't have it there takes the other way */
  jumps?: [number, number, number][]
  /** nodes whose designers' hints (slow down, lift off) don't hold for our cars: a player's lap went
   *  through them flat out (Museum 2 RM: 30% slower on 112 of the lap's nodes; test/fromlap.py) */
  nohint?: number[]
}
const lineFixes = new WeakMap<TrackInfo, [number, number, number][]>()
const fastForks = new WeakMap<TrackInfo, { fast: Set<number>; turbo: Set<number> }>()
const jumpForks = new WeakMap<TrackInfo, Map<number, [number, number]>>() // fork -> [way, m/s needed]
const noHints = new WeakMap<TrackInfo, Set<number>>()

export function saveMemory(info: TrackInfo): AiMemory {
  return {
    caps: (speedCaps.get(info) ?? []).map((p) => p.map((c) => Math.round(c * 100) / 100)),
    avoid: [...(badBranches.get(info) ?? [])],
    ...(lineFixes.get(info)?.length ? { line: lineFixes.get(info) } : {}),
    fast: [...(fastForks.get(info)?.fast ?? [])], fastTurbo: [...(fastForks.get(info)?.turbo ?? [])],
    ...(noHints.get(info)?.size ? { nohint: [...noHints.get(info)!] } : {}),
    ...(jumpForks.get(info)?.size ? { jumps: [...jumpForks.get(info)!].map(([i, [w, v]]) => [i, w, v] as [number, number, number]) } : {}),
  }
}

/** Before the first driver on a course is made (or it starts from the fork check alone). */
export function loadMemory(info: TrackInfo, m: AiMemory) {
  speedCaps.set(info, m.caps ?? [])
  badBranches.set(info, new Map(m.avoid))
  lineFixes.set(info, m.line ?? [])
  fastForks.set(info, { fast: new Set(m.fast ?? []), turbo: new Set(m.fastTurbo ?? []) })
  jumpForks.set(info, new Map((m.jumps ?? []).map(([i, w, v]) => [i, [w, v]])))
  noHints.set(info, new Set(m.nohint ?? []))
}

export class AiDriver {
  node = -1
  private bad: Map<number, number>
  private caps: number[][]
  private nearCaps: number[][] = []
  private bestGap = Infinity // closest the car has come to the next node
  private aheadNodes: number[] = []
  private lastSpeed = 0
  private movers: number[][] = [] // [x, y, z, r]: loose objects nearby, this step
  private recent: number[][] = [] // [x, y, z, speed, clock] every 0.25 s for 8 s, on the ground
  private recentAt = 0
  dbg: number[] = []
  /** what set the speed limit this tick (tests): top, grip, lock, cap, crest, brake-ahead…, off, hint */
  limit = ''
  private tookAlt: { i: number; pick: number; t: number }[] = []
  private clock = 0
  private nodes: Node[]
  private branch = new Map<number, number>() // node -> chosen next index, per lap
  private jumps: Map<number, [number, number]>
  private nohint: Set<number>
  private jumpSet = new Set<number>() // jump forks decided at the fork itself this lap
  private here = new THREE.Vector3()
  private vtop = 30
  private blend = 0 // 0 racing line .. 1 overtaking line
  private stuck = 0
  private reverse = 0
  private throttle = 0
  private sameNode = 0 // s spent without reaching the next node
  // how much of the assumed grip this car really has: drops while the front tyres slide in a
  // bend (understeer — the R6 Turbo ploughed into the same wall every lap), creeps back up
  private grip = 1
  private steerOut = 0
  private lastNode = -1
  private lastRescue: { at: THREE.Vector3; t: number; n: number } | null = null
  private avoid = 0 // m sideways off the line, to get round something in the way (eased towards...)
  private avoidWant = 0 // ...where the last look ahead found the way clear
  private probeIn = 0
  /** -1..1, set by the race (shared/ai.ts): + far behind the leader (takes shortcuts and other branches more
   *  often), − leading well clear (a little safer in bends). Keeps the field together without touching the physics */
  risk = 0
  private branchAt = new Map<number, number>()
  private straightLen: number[] | null = null
  private waitForRival = false
  private chaseSpeed = 0
  private lean = 0 // m to the right: shouldering a rival alongside / covering one behind
  private leanWant = 0
  private leanFor = 0
  private overtakeFor = 0
  private turned = 0 // rad the car has turned since it last reached a node (orbit detection)
  private facingAway = 0 // s pointing well away from the way while slow (scraping along a wall)
  private lastYaw: number | null = null
  bend = 0 // how tight the line is just ahead (0 straight .. ~1 hairpin) — for weapon timing

  constructor(private info: TrackInfo, private opts: AiOptions = {}) {
    this.nodes = (info.ai ?? []).map((n) => ({ prio: n.prio, a: V(n.a), b: V(n.b), line: n.line, over: n.over, next: n.next, prev: n.prev }))
    if (opts.physics && !process.env.NOCLEAR) {
      let cl = clearedLines.get(info)
      if (!cl) clearedLines.set(info, (cl = this.clearLines(opts.physics)))
      this.nodes.forEach((n, i) => { n.line = cl.line[i]; n.over = cl.over[i] })
    }
    // hand-set line points: where along its node the point (x, z) lies
    for (const [i, x, z] of lineFixes.get(info) ?? []) {
      const n = this.nodes[i]
      if (!n) continue
      const ab = n.b.clone().sub(n.a).setY(0)
      const f = new THREE.Vector3(x - n.a.x, 0, z - n.a.z).dot(ab) / ab.lengthSq()
      n.line = Math.max(0, Math.min(1, f))
    }
    let bad = badBranches.get(info)
    if (!bad) {
      badBranches.set(info, (bad = new Map()))
      if (opts.physics) this.checkBranches(opts.physics, bad)
    }
    this.bad = bad
    this.jumps = jumpForks.get(info) ?? new Map()
    this.nohint = noHints.get(info) ?? new Set()
    let cm = speedCaps.get(info)
    if (!cm) speedCaps.set(info, (cm = []))
    this.caps = cm
  }

  /** The learnt speed limit at p (see speedCaps). */
  private capAt(p: THREE.Vector3): number {
    let v = 99
    for (const c of this.nearCaps) {
      if (c[5] === 0) continue // a reset's, not confirmed yet
      if ((c[0] - p.x) ** 2 + (c[2] - p.z) ** 2 < (c[4] ?? CAP_R) ** 2 && Math.abs(c[1] - p.y) < 3) v = Math.min(v, c[3])
    }
    return v
  }

  /** Move line points off props (see clearedLines). */
  private clearLines(ph: Physics) {
    const ns = this.nodes
    const pt = (i: number, f: number) => ns[i].a.clone().lerp(ns[i].b, Math.max(0.06, Math.min(0.94, f)))
    const blocked = (p: THREE.Vector3, q: THREE.Vector3) => wallsOn(ph, p, q) + bumpsOn(ph, p, q)
    let moved = 0
    const fix = (key: 'line' | 'over') => {
      const f = ns.map((n) => n[key])
      const cost = (i: number, fi: number) => {
        const p = pt(i, fi)
        let c = 0
        for (const j of ns[i].next) if (j !== undefined && ns[j]) c += blocked(p, pt(j, f[j]))
        for (const j of ns[i].prev) if (j !== undefined && ns[j]) c += blocked(pt(j, f[j]), p)
        return c
      }
      for (let pass = 0; pass < 6; pass++) {
        let changed = false
        ns.forEach((_, i) => {
          const c0 = cost(i, f[i])
          if (c0 === 0) return
          // the nearest place along the node (both ways, 2 % steps, at most MAX_MOVE) that blocks
          // fewer rays, with floor at the same height under it. Partly clear is a step: two points
          // may have to move together (Ghost Town 2's line runs over 52 cm railway sleepers)
          const p0 = pt(i, f[i])
          const len = ns[i].a.distanceTo(ns[i].b)
          let best = f[i], bc = c0
          for (let s = 0.02; s * len <= MAX_MOVE && bc > 0; s += 0.02) {
            for (const fi of [f[i] - s, f[i] + s]) {
              if (fi < 0.06 || fi > 0.94 || bc === 0) continue
              if (Math.abs(fi - ns[i][key]) * len > MAX_MOVE) continue
              const q = pt(i, fi)
              const down = ph.raycast([q.x, q.y + 1, q.z], [0, -1, 0], 2)
              if (!down || Math.abs(down.point[1] - p0.y) > 0.4) continue
              const c = cost(i, fi)
              if (c < bc) { bc = c; best = fi }
            }
          }
          if (best !== f[i]) {
            if (process.env.CLEARLOG) console.log(`clear ${key} node ${i}: ${f[i].toFixed(2)} -> ${best.toFixed(2)} (rays ${c0} -> ${bc}) at ${pt(i, f[i]).toArray().map((v) => v.toFixed(1))} -> ${pt(i, best).toArray().map((v) => v.toFixed(1))}`)
            f[i] = best; changed = true; moved++
          }
        })
        if (!changed) break
      }
      return f
    }
    const line = fix('line'), over = fix('over')
    return { line, over, moved }
  }

  /** At each fork, the way whose first stretches climb a step a car can't (see STEP) — if only one does. */
  private checkBranches(ph: Physics, bad: Map<number, number>) {
    const climbs = (i: number, first: number) => {
      let from = i, to: number | undefined = first
      for (let k = 0; k < 4 && to !== undefined; k++) {
        const a = this.at(from, 0), b = this.at(to, 0)
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        let last: number | null = null
        for (let d = 0; d <= len; d += 0.3) {
          const q = a.clone().lerp(b, len ? d / len : 0)
          const hit = ph.raycast([q.x, q.y + 2, q.z], [0, -1, 0], 4)
          const y = hit ? hit.point[1] : null
          if (y !== null && last !== null && y - last > STEP) return true
          if (y !== null) last = y
        }
        from = to
        to = this.nodes[to].next[0]
      }
      return false
    }
    // ...or whose first stretch runs into a wall the line couldn't be moved off (Ghost Town 1 R's
    // node 68: one way off the boardwalk is a wall; cars stuck there before reaching the fork, so
    // "stuck after taking it" never caught it)
    const walled = (i: number, j: number) => wallsOn(ph, this.at(i, 0), this.at(j, 0)) >= 3
    this.nodes.forEach((n, i) => {
      if (n.next.length < 2) return
      const c0 = climbs(i, n.next[0]) || walled(i, n.next[0]), c1 = climbs(i, n.next[1]) || walled(i, n.next[1])
      if (c0 !== c1) bad.set(i, c0 ? 0 : 1)
    })
  }

  /** Narrow places on the course (a gate ≤ 3.5 m and under half the course's usual width: Toy World 1's
   *  piano, 2.1 m, and the shelf-top walk; Museum 1's plinths) — where a dropped oil slick, ball bearings
   *  or fake star can't be driven round (shared/ai.ts think) */
  private narrowSet: Set<number> | null = null
  private narrowNodes(): Set<number> {
    if (!this.narrowSet) {
      const w = this.nodes.map((n) => n.a.distanceTo(n.b))
      const med = [...w].sort((x, y) => x - y)[Math.floor(w.length / 2)] ?? 0
      this.narrowSet = new Set(w.flatMap((x, i) => (x <= Math.min(3.5, med * 0.5) ? [i] : [])))
    }
    return this.narrowSet
  }
  /** m of nearly straight course ahead (the line turns < 25° in it) — for the turbo (shared/ai.ts think). */
  straightAhead(): number {
    if (this.node < 0) return 0
    if (!this.straightLen) {
      const n = this.nodes.length, out = new Array<number>(n).fill(0)
      for (let i = 0; i < n; i++) {
        let d = 0, turned = 0, j = i
        let dir = this.at(this.nextOf(j), 0).sub(this.at(j, 0)).setY(0).normalize()
        for (let k = 0; k < 40 && turned < 0.44 && d < 200; k++) {
          const nj = this.nextOf(j)
          const seg = this.at(nj, 0).sub(this.at(j, 0)).setY(0)
          const len = seg.length()
          if (len > 0.01) {
            const nd = seg.divideScalar(len)
            turned += Math.acos(Math.max(-1, Math.min(1, nd.dot(dir))))
            dir = nd
          }
          if (turned < 0.44) d += len
          j = nj
        }
        out[i] = d
      }
      this.straightLen = out
    }
    return this.straightLen[this.node]
  }
  /** The course's longer straights: the length 80% of its node-straights are shorter than. */
  longStraight(): number {
    this.straightAhead()
    const s = [...(this.straightLen ?? [0])].sort((a, b) => a - b)
    return s[Math.floor(s.length * 0.8)] ?? 0
  }

  /** In a narrow place now (the node the car is on, or the next). */
  inNarrow(): boolean {
    if (this.node < 0) return false
    const n = this.narrowNodes()
    return n.has(this.node) || n.has(this.nextOf(this.node))
  }
  /** A narrow place within `metres` ahead along the course. */
  narrowAhead(metres: number): boolean {
    if (this.node < 0) return false
    const n = this.narrowNodes()
    let d = 0
    for (let i = this.node, k = 0; d < metres && k < 60; k++) {
      const j = this.nextOf(i)
      if (n.has(j)) return true
      d += this.at(i, 0).distanceTo(this.at(j, 0))
      i = j
    }
    return false
  }

  /** Smart, holding a turbo, a fork ahead whose alternative is faster with one: fire it there. */
  turboFork = -1
  /** a turbo-worthy fork (AiMemory fastTurbo) within `metres` ahead */
  turboForkAhead(metres: number): boolean {
    const ff = fastForks.get(this.info)
    if (!this.opts.smart || !ff?.turbo.size || this.node < 0) return false
    let d = 0
    for (let i = this.node, k = 0; d < metres && k < 80; k++) {
      if (ff.turbo.has(i)) return true
      const j = this.nextOf(i)
      d += this.at(i, 0).distanceTo(this.at(j, 0))
      i = j
    }
    return false
  }
  /** at the turbo fork now (on it or its next node) */
  atTurboFork(): boolean {
    return this.turboFork >= 0 && (this.node === this.turboFork || this.nextOf(this.turboFork) === this.node)
  }

  private nextOf(i: number): number {
    const n = this.nodes[i]
    if (n.next.length < 2) return n.next[0] ?? i
    let pick = this.branch.get(i)
    // a jump: only with the speed for it at the fork ("slow cars should not take the jump").
    // Settled when the car reaches the fork; before that, the speed it will have gained by then
    // (~4.5 m/s² at 20+ m/s, Flag 20 → 24.7 m/s over 22 m). Ahead of the learnt `bad` ways: one car
    // falling short mustn't stop the fast ones jumping
    const jump = this.jumps.get(i)
    if (jump) {
      if (this.jumpSet.has(i) && pick !== undefined) return n.next[pick] ?? n.next[0]
      const d = this.node === i ? 0 : Math.hypot(this.here.x - this.at(i, 0).x, this.here.z - this.at(i, 0).z)
      const v = Math.min(this.vtop, Math.sqrt(this.lastSpeed ** 2 + 2 * 4.5 * d))
      pick = v >= jump[1] ? jump[0] : 1 - jump[0]
      this.branch.set(i, pick)
      this.branchAt.set(i, this.clock)
      if (this.node === i) this.jumpSet.add(i)
      return n.next[pick] ?? n.next[0]
    }
    // (chosen again each lap: how bold the car is changes with its place, `risk`)
    if (pick !== undefined && this.clock - (this.branchAt.get(i) ?? 0) > 20) pick = undefined
    if (pick === undefined && this.bad.has(i)) pick = 1 - this.bad.get(i)!
    if (pick === undefined) {
      // shortcuts are taken, long routes only now and then — shortcuts and other branches more often
      // by a car far back, less by a leader well clear
      const alt = this.nodes[n.next[1]]?.prio
      const r = this.risk
      let p = alt === PRIO.SHORTCUT ? Math.min(1, 0.8 + 0.2 * r) : alt === PRIO.LONG_ROUTE ? 0.12 * (1 - Math.max(0, r))
        : Math.max(0.1, Math.min(0.7, (this.opts.route ?? 0.3) + 0.4 * r))
      // a driver who knows the course: the branch measured faster, nearly always; with a turbo in hand,
      // the one that is faster with it (and fires it there); otherwise the main one (a shorter way isn't
      // a faster one: going by length, smart cars lapped 1% slower on Toys in the Hood)
      if (this.opts.smart && alt !== PRIO.SHORTCUT) {
        const ff = fastForks.get(this.info)
        if (ff?.fast.has(i)) p = 0.95
        else if (ff?.turbo.has(i) && this.opts.hasTurbo?.()) {
          p = 0.95
          this.turboFork = i
        } else p = 0.05
      }
      pick = Math.random() < p ? 1 : 0
      this.branch.set(i, pick)
      this.branchAt.set(i, this.clock)
    }
    return n.next[pick] ?? n.next[0]
  }

  /** Point on the driven line at node i (blend between racing and overtaking line). */
  private at(i: number, blend: number): THREE.Vector3 {
    const n = this.nodes[i]
    const f = n.line + (n.over - n.line) * blend
    return n.a.clone().lerp(n.b, Math.max(0.06, Math.min(0.94, f)))
  }

  /** Squared distance (height ×3) from p to node i's stretch of line (i -> its next). */
  private segDist(i: number, p: THREE.Vector3): number {
    const a = this.at(i, 0), b = this.at(this.nextOf(i), 0)
    const seg = b.clone().sub(a)
    const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(seg) / Math.max(1e-6, seg.lengthSq())))
    const q = a.addScaledVector(seg, t)
    return (q.x - p.x) ** 2 + ((q.y - p.y) * 3) ** 2 + (q.z - p.z) ** 2
  }

  private locate(p: THREE.Vector3, fwd?: THREE.Vector3) {
    const ns = this.nodes
    // lost: far from the stretch we're on, or on another level (fell off a shelf into a pit — the
    // pit has its own way out in the AI data, e.g. Toy World 1's node 125). Measured to the whole
    // stretch: to its first node, a car halfway down a 25 m stretch counted as lost
    if (this.node < 0 || this.segDist(this.node, p) > 15 * 15) {
      // the nearest stretch pointing our way: where a road is driven both ways (Toys in the Hood
      // 1's out-and-back street) the nearest one can be the other direction, and the car turned
      // round and circled there for good
      let best = 0, bd = Infinity
      ns.forEach((_, i) => {
        let d = this.segDist(i, p)
        if (fwd) {
          const dir = this.at(this.nextOf(i), 0).sub(this.at(i, 0)).setY(0).normalize()
          if (dir.dot(fwd) < -0.2) d += 40 * 40
        }
        if (d < bd) { bd = d; best = i }
      })
      this.node = best
    }
    // move on while we're past the segment's end — or right at it: in a hairpin a car that
    // can't turn tightly enough never gets "past" the apex node, and circled round it for good
    for (let k = 0; k < 6; k++) {
      const a = this.at(this.node, 0), b = this.at(this.nextOf(this.node), 0)
      const seg = b.clone().sub(a)
      if (p.clone().sub(a).dot(seg) > seg.lengthSq() || Math.hypot(p.x - b.x, p.z - b.z) < 2) {
        if (this.node === 0) { this.branch.clear(); this.jumpSet.clear() } // a new lap: choose branches afresh
        if (this.nodes[this.node].next.length > 1) this.tookAlt.push({ i: this.node, pick: this.branch.get(this.node) ?? 0, t: this.clock })
        this.node = this.nextOf(this.node)
      } else break
    }
  }

  /** Walk `dist` metres down the line from the car's spot; returns the points every `step`. */
  private ahead(p: THREE.Vector3, dist: number, step: number, blend: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = []
    this.aheadNodes = []
    let i = this.node
    let from = p.clone()
    let to = this.at(this.nextOf(i), blend)
    // start from the projection of the car on the current segment
    const a = this.at(i, blend)
    const seg = to.clone().sub(a)
    const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(seg) / Math.max(1e-6, seg.lengthSq())))
    from = a.clone().addScaledVector(seg, t)
    let left = 0
    let guard = 0
    while (out.length * step < dist && guard++ < 400) {
      const d = from.distanceTo(to)
      if (left + d >= step) {
        from = from.clone().lerp(to, (step - left) / d)
        out.push(from.clone())
        this.aheadNodes.push(i)
        left = 0
        continue
      }
      left += d
      from = to
      i = this.nextOf(i)
      to = this.at(this.nextOf(i), blend)
    }
    return out
  }

  /**
   * Where to put this car back: on its own route (where it is in the race), not just the
   * nearest bit of track — where two roads cross, the nearest one can be the other road
   * (Toy World 2's jump over the lower road: a car that fell short was rescued onto the road
   * underneath, which doesn't lead where its route goes, again and again). The racing-line
   * point a little past the next node first — so a car that failed a jump or a climb isn't
   * set down to fail it again — then the ones before, wherever a car can stand level.
   */
  rescueSpot(physics: Physics): { pos: THREE.Vector3; yaw: number } | null {
    if (this.node < 0) return null
    // a reset is a mistake too, often one with no crash in it (sliding off a ramp's edge on Ghost
    // Town 1 R, then upside down below): the last place it was going fast, a second or more
    // before, gets a speed limit like a crash's
    const back = [...this.recent].reverse().find((h) => this.clock - h[4] > 1 && h[3] > 10)
    // — once it has happened there twice (c[5] = 0 until then): a reset can be another car's doing,
    // and one-off limits all over Toys in the Hood 1 RM's long straights cost 10 s a lap
    if (back && TUNE.learn) {
      const cap = this.caps.find((c) => (c[0] - back[0]) ** 2 + (c[2] - back[2]) ** 2 < 2.5 * 2.5 && Math.abs(c[1] - back[1]) < 3)
      const vcap = Math.max(9, back[3] * 0.85)
      if (!cap) this.caps.push([back[0], back[1], back[2], vcap, CAP_R, 0])
      else {
        cap[3] = Math.min(cap[3], vcap)
        cap[5] = 1
      }
    }
    this.recent = []
    // stuck or flipped soon after taking a branch: no CPU car takes that branch again
    for (const b of this.tookAlt) if (this.clock - b.t < 12 && !this.bad.has(b.i)) {
      this.bad.set(b.i, b.pick)
      this.branch.set(b.i, 1 - b.pick)
    }
    // ...or on the way into the one it chose, before getting past the fork
    const fork = this.nodes[this.node]
    const pick = this.branch.get(this.node)
    if (fork.next.length > 1 && pick !== undefined && !this.bad.has(this.node)) {
      this.bad.set(this.node, pick)
      this.branch.set(this.node, 1 - pick)
    }
    this.tookAlt = []
    // the next nodes first: a CPU car put back behind its trouble drove into it again — trying the
    // spot 2 m behind first (as people get, R) took a suite from 311 to 302 of 312 finishers, with
    // reset loops of 24 and 39 (2026-10-12)
    // put back at the same place again and again (an AMW on Toys in the Hood 2, 49 times at node
    // 219, pinned to a wall at a tight bend): each repeat within 20 s starts one node further on
    const here = this.at(this.node, 0)
    const again = this.lastRescue && this.clock - this.lastRescue.t < 20 && this.lastRescue.at.distanceTo(here) < 15
    this.lastRescue = { at: here, t: this.clock, n: again ? this.lastRescue!.n + 1 : 0 }
    let first = this.nextOf(this.node)
    for (let k = 0; k < Math.min(6, this.lastRescue.n); k++) first = this.nextOf(first)
    const order: number[] = []
    for (let k = 0, i = first; k < 2; k++, i = this.nextOf(i)) order.push(i)
    for (let k = 0, i = this.node; k < 4 && i !== undefined; k++, i = this.nodes[i].prev[0]) order.push(i)
    let fallback: { pos: THREE.Vector3; yaw: number } | null = null
    for (const i of order) {
      const a = this.at(i, 0), b = this.at(this.nextOf(i), 0)
      const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z))
      // a little way into the segment, so it isn't put right on a node at a lip
      const spot = standOn(physics, a.clone().lerp(b, 0.3), yaw)
      if (spot?.good) {
        this.node = i
        this.sameNode = 0
        return spot
      }
      fallback ??= spot
    }
    return fallback
  }

  /**
   * Something solid on the way ahead? A ray at bumper height from the car to the line ~1 s ahead
   * (and to the steering target); if it hits a wall-like face short of the point, try points
   * beside the line, nearest first, and keep to the first clear one until the line is clear again.
   */
  private dodge(car: Car, pts: THREE.Vector3[], speed: number, dt: number) {
    const ph = this.opts.physics
    if (!ph) return
    if ((this.probeIn -= dt) > 0) return
    this.probeIn = 1 / 30
    const reach = Math.max(4, Math.min(24, speed * 0.9))
    const k = Math.min(pts.length - 2, Math.max(0, Math.round(reach / 1.5) - 1))
    if (k < 1) return
    const nose = car.position.clone().addScaledVector(car.forward, 0.3)
    nose.y += 0.12
    // sideways at each point of the way ahead
    const sides = pts.map((q, j) => {
      const nx = pts[Math.min(pts.length - 1, j + 1)], pv = pts[Math.max(0, j - 1)]
      const dir = nx.clone().sub(pv).setY(0).normalize()
      return new THREE.Vector3(-dir.z, 0, dir.x)
    })
    // along the way ahead in ~3 m pieces (a straight ray to a point far ahead cut past the post
    // the car, following the bend, then hit), across the car's width (a thin post slips
    // between rays further apart)
    const near = this.movers.filter((s) => (s[0] - nose.x) ** 2 + (s[2] - nose.z) ** 2 < (reach + 3) ** 2)
    const clear = (o: number) => {
      let from = nose
      for (let j = 1; j <= k; j += 2) {
        const to = pts[j].clone().addScaledVector(sides[j], o)
        // a loose object within the car's width of the way
        for (const s of near) {
          if (Math.abs(s[1] - to.y) > 1.5) continue
          const ax = from.x, az = from.z, bx = to.x - ax, bz = to.z - az
          const t = Math.max(0, Math.min(1, ((s[0] - ax) * bx + (s[2] - az) * bz) / Math.max(1e-6, bx * bx + bz * bz)))
          if ((ax + bx * t - s[0]) ** 2 + (az + bz * t - s[2]) ** 2 < s[3] ** 2) return false
        }
        // a sidestep must keep floor under it (not off a walkway's edge: Museum 1's cars fell off)
        if (o !== 0) {
          const down = ph.raycast([to.x, to.y + 1, to.z], [0, -1, 0], 2.5)
          if (!down || down.point[1] < to.y - 1) return false
        }
        to.y += 0.12
        // the car and a margin: wheels stick out past the hull, and following a point ahead cuts
        // a bend a little — a sign on the inside of a corner (Museum 1) was seen 2.5 m off
        for (const w of [0, -0.2, 0.2, -0.4, 0.4, -0.6, 0.6]) {
          const a = from.clone().addScaledVector(sides[j], w)
          const d = to.clone().addScaledVector(sides[j], w).sub(a)
          const len = d.length()
          if (len < 0.2) continue
          const dn = d.divideScalar(len)
          const hit = ph.raycast(a.toArray(), dn.toArray(), len)
          if (!hit || hit.normal[1] >= 0.82) continue // floor, a ramp, a kerb: no obstacle
          if (hit.normal[1] < 0.55) return false // a wall
          // steep but not a wall: a ramp across the road, or the sloped foot of something narrow
          // (the road-works posts' pyramid bases flipped cars) — a ramp is there beside it too
          for (const sd of [-0.6, 0.6]) {
            const b2 = a.clone().addScaledVector(sides[j], sd)
            const h2 = ph.raycast(b2.toArray(), dn.toArray(), len)
            if (!h2 || h2.dist > hit.dist + 0.5) return false
          }
        }
        from = to
      }
      return true
    }
    // a pickup star just off the way ahead and nothing in hand: through it (CPU cars only had
    // what they happened to run over)
    const seek = this.seekOffset(pts, sides, reach)
    if (seek !== null && Math.abs(seek - this.avoidWant) < 3.5 && clear(seek)) {
      this.avoidWant = seek
      return
    }
    if (clear(this.avoidWant)) {
      // back onto the line once it is clear itself
      if (this.avoidWant !== 0 && clear(0)) this.avoidWant = 0
      return
    }
    for (const o of [0.8, -0.8, 1.6, -1.6, 2.4, -2.4, 3.2, -3.2]) {
      if (clear(this.avoidWant + o)) {
        this.avoidWant = Math.max(-4, Math.min(4, this.avoidWant + o))
        return
      }
    }
  }

  /** Sideways offset from the way ahead to the nearest wanted pickup within reach, or null. */
  private seekOffset(pts: THREE.Vector3[], sides: THREE.Vector3[], reach: number): number | null {
    const want = this.opts.seek?.()
    // only a small sidestep, and not in a bend: swerving up to 2.5 m for stars, bends and all, cost a
    // third more resets over the 52 courses (2026-10-14)
    if (!want?.length || this.bend > 0.2) return null
    const maxLat = this.opts.seekLat ?? 1.2
    let best: number | null = null, bestJ = 1e9
    const last = Math.min(pts.length - 1, Math.round((reach + 6) / 1.5))
    for (const s of want) {
      for (let j = 2; j <= last && j < bestJ; j++) {
        const q = pts[j]
        if (Math.abs(s.y - q.y) > 1.5) continue
        const dx = s.x - q.x, dz = s.z - q.z
        if (dx * dx + dz * dz > 2.6 * 2.6) continue
        const lat = dx * sides[j].x + dz * sides[j].z
        if (Math.abs(lat) <= maxLat) { best = lat; bestJ = j }
        break
      }
    }
    return best
  }

  private kinK = 0
  private kin(car: Car): number {
    if (!this.kinK) {
      const ws = car.info.wheels.filter((w) => w.present !== false)
      const k = ws.reduce((a, w) => a + w.kineticFriction, 0) / Math.max(1, ws.length)
      this.kinK = Math.max(0.8, Math.min(1.1, k / 1.45))
    }
    return this.kinK
  }

  drive(car: Car, dt: number, others: Car[] = []): Controls & { reset: boolean } {
    if (!this.nodes.length) return { throttle: 0, steer: 0, handbrake: false, reset: false }
    this.clock += dt
    const p = car.position
    this.here.copy(p)
    this.vtop = car.vtop
    // a crash (lost > 5 m/s along the ground in one step, no other car to blame): remember the
    // corner. Speed across the ground only: landing from a drop isn't a crash
    const v = Math.hypot(car.velocity.x, car.velocity.z)
    // (only real ones, from CRASH_FROM: a nudge while recovering slowly had capped corners at 4 m/s
    // and the trained cars lapped 50 % slower). In the air too: off Toytanic's deck ramp into a lifebelt
    // (not when a weapon threw it: a rocket's blast on a straight had capped the straight)
    const thrown = car.now - car.hitAt < 2500 || car.now < car.zappedUntil
    if (TUNE.learn && !thrown && this.lastSpeed > CRASH_FROM && this.lastSpeed - v > 5 && this.node >= 0 && !others.some((o) => o.position.distanceToSquared(p) < 4)) {
      const ph = this.opts.physics
      const down = ph?.raycast([p.x, p.y + 0.3, p.z], [0, -1, 0], 6)
      const gy = down ? down.point[1] : p.y
      const cap = this.caps.find((c) => (c[0] - p.x) ** 2 + (c[2] - p.z) ** 2 < 2.5 * 2.5 && Math.abs(c[1] - gy) < 3)
      const vcap = Math.max(CAP_MIN, this.lastSpeed * 0.9)
      if (!cap) this.caps.push([p.x, gy, p.z, vcap, CAP_R, 1])
      else if (this.lastSpeed > cap[3] + 1 && cap[5] !== 0) cap[4] = Math.min(12, (cap[4] ?? CAP_R) + 3)
      else {
        cap[3] = Math.min(cap[3], vcap)
        cap[5] = 1
      }
    }
    if (this.lastSpeed > 10 && this.lastSpeed - v > 5 && car.grounded > 0 && this.node >= 0 && !others.some((o) => o.position.distanceToSquared(p) < 4)) {
      // just off onto a side route (a pickup ledge, a shortcut) and into the wall: not worth it
      for (const b of this.tookAlt) if (b.pick === 1 && this.clock - b.t < 8 && !this.bad.has(b.i)) this.bad.set(b.i, 1)
    }
    this.lastSpeed = v
    if (this.clock - this.recentAt >= 0.25) {
      this.recentAt = this.clock
      if (car.grounded >= 2) this.recent.push([p.x, p.y, p.z, v, this.clock])
      while (this.recent.length && this.clock - this.recent[0][4] > 8) this.recent.shift()
    }
    // what's in the way that the rays can't see: loose objects (Supermarket 1's cereal packets lie
    // across an aisle once knocked). Not stalled cars: on the grid every car is one, and steering
    // round each other there sent whole fields of CPU cars round in circles (Supermarket 1 RM)
    this.movers = []
    for (const o of this.opts.obstacles?.() ?? []) {
      if ((o[0] - p.x) ** 2 + (o[2] - p.z) ** 2 < 30 * 30) this.movers.push(o)
    }
    this.locate(p, car.forward.clone().setY(0).normalize())
    const speed = Math.abs(car.speed)
    this.nearCaps = this.caps.filter((c) => (c[0] - p.x) ** 2 + (c[2] - p.z) ** 2 < 70 * 70)
    const fwd = car.forward.clone()
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quaternion)

    // racecraft: someone close ahead on our line -> take the overtaking line
    // (held a while once started: flicking between the lines made the cars weave)
    for (const o of others) {
      const d = o.position.clone().sub(p)
      const along = d.dot(fwd), side = Math.abs(d.dot(right))
      if (along > 0.3 && along < 4 + speed * 0.25 && side < 0.9) this.overtakeFor = 1.5
    }
    this.overtakeFor -= dt
    // aggression: shoulder a rival running alongside (rubbing is racing), and cover the side a car
    // close behind is trying to come past on — on the straights only, not in a bend
    const aggro = this.opts.aggro ?? 0
    if (aggro > 0 && speed > 6 && this.bend < 0.3) {
      for (const o of others) {
        const d = o.position.clone().sub(p)
        if (Math.abs(d.y) > 1) continue
        const along = d.dot(fwd), side = d.dot(right)
        if (Math.abs(along) < 1.1 && Math.abs(side) > 0.5 && Math.abs(side) < 2) {
          this.leanWant = Math.sign(side) * 0.45 * aggro
          this.leanFor = 0.5
        } else if (along < -0.8 && along > -6 && Math.abs(side) > 0.3 && Math.abs(side) < 2 && o.speed > speed - 1) {
          this.leanWant = Math.sign(side) * 0.6 * aggro
          this.leanFor = 0.6
        }
      }
    }
    if ((this.leanFor -= dt) <= 0) this.leanWant = 0
    this.lean += Math.max(-dt * 1.5, Math.min(dt * 1.5, this.leanWant - this.lean))
    this.blend += ((this.overtakeFor > 0 ? 1 : 0) - this.blend) * Math.min(1, dt * 0.8)

    // --- steering: pure pursuit
    const look = Math.max(1.4, Math.min(7, 1.0 + speed * 0.22)) // short: a long look cuts inside corners into barrier ends
    const raw = this.ahead(p, Math.max(look, 45), 1.5, this.blend)
    const pts = smooth(raw)
    const ti = Math.max(0, Math.round(look / 1.5) - 1)
    const target = (pts[ti] ?? this.at(this.nextOf(this.node), this.blend)).clone()
    this.dodge(car, pts, speed, dt)
    // glide sideways (a step of the target made the steering jerk)
    this.avoid += Math.max(-dt * 4, Math.min(dt * 4, this.avoidWant - this.avoid))
    if (Math.abs(this.avoid) > 0.01 && pts.length > ti + 1) {
      const dir = pts[ti + 1].clone().sub(pts[ti]).setY(0).normalize()
      target.add(new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(this.avoid))
    }
    if (Math.abs(this.lean) > 0.01) target.addScaledVector(right, this.lean)
    // the putty bomb in hand ("chase the nearest rival and ram it to hand the bomb over"): steer
    // at a rival ahead (where it will be in a quarter second); one close behind — wait for it
    // — and across into its path, so it can't just go round (CPU cars take the overtaking line)
    this.waitForRival = false
    this.chaseSpeed = 0
    const prey = this.opts.chase?.()
    if (prey) {
      const lead = prey.pos.clone().addScaledVector(prey.vel, 0.25)
      const to = lead.clone().sub(p)
      const ahead = to.dot(fwd)
      if (ahead > 0.3 && to.length() < 35 && Math.abs(to.dot(right)) < ahead * 1.5 + 1) {
        target.copy(lead)
        this.chaseSpeed = prey.vel.length() + 4 // close in on it
      } else if (ahead < -0.3 && to.length() < 25) {
        this.waitForRival = true
        target.addScaledVector(right, Math.max(-2, Math.min(2, prey.pos.clone().sub(p).dot(right))))
      }
    }
    const d = target.clone().sub(p)
    const lateral = -d.dot(right) // + = target to the left
    const forward = d.dot(fwd)
    const alpha = Math.atan2(lateral, Math.max(0.05, forward))
    const ld = Math.max(0.5, Math.hypot(lateral, forward))
    const ws = car.info.wheels
    const wheelbase = Math.abs((ws[0]?.offset1[2] ?? -0.4) - (ws[2]?.offset1[2] ?? 0.4)) || 0.8
    const delta = Math.atan(2 * wheelbase * Math.sin(alpha) / ld) // the wheel angle that arcs through the target
    const ratio = Math.abs(ws.find((w) => w.turnable)?.steerRatio ?? 0.5) / 0.5
    // car.ts takes lock away at speed; ask for that much more
    const atSpeed = 1 / (1 + (speed / car.vtop) * car.info.steerMod * 2.5)
    let steer = Math.max(-1, Math.min(1, delta / (STEER_MAX * ratio * atSpeed)))
    if (forward < 0) steer = lateral >= 0 ? 1 : -1 // target behind: full lock round
    // pointing well off the way to go (out of a spin, past a hairpin): slow right down to turn
    // round tightly — at speed the car circled round the target (Toys in the Hood's cul-de-sac)
    const off = Math.abs(alpha)

    // --- speed: the tightest bend ahead sets how fast we may go now
    const front = car.wheels.filter((_, i) => car.info.wheels[i].turnable && car.wheels[i].contact)
    const plough = front.length > 0 && front.every((w) => w.skid > 0.8) && Math.abs(this.steerOut) > 0.6 && speed > 5
    this.grip = Math.max(0.7, Math.min(1, this.grip + (plough ? -0.25 : 0.004) * dt))
    // ~92% of what a car really holds on a flat floor (rc: 1.74 × 22 m/s² at full lock). Scaling it
    // by each car's tyre friction (1.3 F1 … 1.9 Toyeca) was tried 2026-10-12: lap times didn't move
    // ...scaled by what this car's tyres keep once sliding (KineticFriction; the RC Bandit's 1.45 = 1):
    // the Evil Weasel (1.15) took every bend at the others' speed and made 48 of 76 resets in solo laps
    // (a leader well clear eases off a little; a car far back does NOT push harder — tried 2026-10-14: in
    // two-car races it crashed more and fell further back, 125 → 169 m mean gap)
    const mu = TUNE.grip * (this.opts.pace ?? 1) * (1 + 0.06 * Math.min(0, this.risk)) * this.grip * this.kin(car)
    const brake = TUNE.brake * (this.opts.pace ?? 1) * (1 + 0.04 * Math.min(0, this.risk)) // the cars brake ~26 m/s² on the flat
    let allowed = car.vtop
    this.limit = 'top'
    let tight = 0
    // curvature over a 6 m span: the authored line has small wiggles that would read as bends
    // ...and no faster than this car can still steer round it: car.ts takes lock away with speed
    // (SteerMod), and a car that can't turn tightly enough ploughs on into the wall (the R6 did,
    // every lap). Lock needed for radius r (with a margin): atan(wheelbase / (0.8 r)).
    const k = car.info.steerMod * 2.5
    const maxLock = STEER_MAX * ratio
    // (bends from the line as authored, not the smoothed one followed: smoothing rounds a sharp
    // corner off, and the cars then came in too fast and went straight on into the wall)
    // the ground under the next 30 m of the line (the line's own heights are straight between
    // nodes and miss a ramp's crest)
    // ...and the floor's own grip there (ice: Supermarket 2's freezer), beyond 33 m as the last seen
    const floorGrip: number[] = []
    const ground = raw.map((q, i) => {
      if (i * 1.5 > 33 || !this.opts.physics) {
        floorGrip.push(floorGrip.length ? floorGrip[floorGrip.length - 1] : 1)
        return q.y
      }
      const h = this.opts.physics.raycast([q.x, q.y + 1.2, q.z], [0, -1, 0], 3)
      // (a floor where a slide lingers — ice — counts for less: the car drifts wide of the line there)
      const sf = h ? surface(h.material) : null
      floorGrip.push(sf ? sf.friction * (sf.lag > 0 ? 1 - 0.55 * car.iceLag : 1) : 1)
      return h ? h.point[1] : q.y
    })
    let gripRun = Math.min(floorGrip[0] ?? 1, floorGrip[1] ?? 1)
    for (let k2 = 2; k2 < raw.length - 2; k2++) {
      const r = radius(raw[k2 - 2], raw[k2], raw[k2 + 2])
      const need = Math.atan(wheelbase / (0.8 * r))
      const vs = k > 0 ? (car.vtop / k) * Math.max(0.05, maxLock / need - 1) : car.vtop
      const vg = Math.sqrt(mu * Math.min(1, floorGrip[k2]) * G * r), vcap = this.capAt(raw[k2])
      let vc = Math.min(vg, vs, vcap)
      let why = vc === vcap ? 'cap' : vc === vs ? 'lock' : 'grip'
      // over a crest the car goes light, and light in a bend it spins out and off the side (Ghost
      // Town 1 R: up a ramp turning, off its edge into a pocket below). A crest in a bend: no faster
      // than the tyres stay down (v² = g R, R the crest's radius). A straight jump stays a jump
      if (k2 * 1.5 < 30 && r < 25) {
        const d1 = Math.hypot(raw[k2].x - raw[k2 - 2].x, raw[k2].z - raw[k2 - 2].z)
        const d2 = Math.hypot(raw[k2 + 2].x - raw[k2].x, raw[k2 + 2].z - raw[k2].z)
        const crest = Math.atan2(ground[k2] - ground[k2 - 2], d1) - Math.atan2(ground[k2 + 2] - ground[k2], d2)
        if (crest > 0.08 && d1 + d2 > 0.5) {
          const vk = Math.max(7, Math.sqrt(G * ((d1 + d2) / 2) / crest))
          if (vk < vc) { vc = vk; why = 'crest' }
        }
      }
      const s = k2 * 1.5
      // braking is only as good as the floor (ice): the worst grip from here to the bend
      gripRun = Math.min(gripRun, floorGrip[k2])
      const va = Math.sqrt(vc * vc + 2 * brake * Math.min(1, gripRun) * s)
      if (va < allowed) { allowed = va; this.limit = why }
      if (s < 12) tight = Math.max(tight, Math.min(1, 1.5 / r))
    }
    if (off > 0.45 && Math.max(3, car.vtop * (1 - (off - 0.45) / 1.2)) < allowed) { allowed = Math.max(3, car.vtop * (1 - (off - 0.45) / 1.2)); this.limit = 'off' }
    if (this.capAt(p) < allowed) { allowed = this.capAt(p); this.limit = 'cap' }
    // something on the line ahead (a sign at a corner, Museum 1): steer round it slower
    this.bend = tight
    // the designers' hints on the next few nodes
    let offThrottle = false
    for (let k = 0, i = this.node; k < 3; k++, i = this.nextOf(i)) {
      const pr = this.nodes[i].prio
      if (this.opts.hints === false) break
      if (this.nohint.has(i)) continue
      if (SLOWDOWN[pr] && car.vtop * SLOWDOWN[pr] < allowed) { allowed = car.vtop * SLOWDOWN[pr]; this.limit = 'hint' }
      if (k < 2 && (pr === PRIO.OFF_THROTTLE || pr === PRIO.OFF_THROTTLE_PETROL)) offThrottle = true
    }
    if (this.waitForRival) allowed = Math.min(allowed, 3)
    // closing on a rival ahead on a straight: as fast as needed to catch it, the car's top speed at most
    if (this.chaseSpeed > allowed && this.bend < 0.2) allowed = Math.min(car.vtop, this.chaseSpeed)
    // full power below the allowed speed, coast just over it, brake (in proportion) above that;
    // the low-pass below keeps it from slamming between the two
    const over = speed - allowed
    // (braking was proportional and soft: 1-2 m/s over the limit braked weakly and the car came
    // into a hairpin 3 m/s too fast — Museum 1. Now full brake by ~1.4 m/s over)
    let want = over < -0.3 ? 1 : over < 0.3 ? 0.15 : Math.max(-1, -(over - 0.3) * 0.9)
    // rolling backwards (bounced off something, or the back-out just ended): forward throttle
    // brakes it. "Braking" with reverse throttle there was more reverse power — a car backed
    // 15 m down Toytanic's deck at 11 m/s after hitting a vent
    if (car.speed < -0.5) want = 1
    // lift before a jump — at speed; slow or recovering, it still needs the power
    if (offThrottle && speed > car.vtop * 0.45) want = Math.min(want, 0)
    this.throttle += (want - this.throttle) * Math.min(1, dt * 8)
    this.dbg = [allowed, want, tight]
    let throttle = this.throttle

    // --- unstick: back out with the wheel the other way, give up after a while
    // stuck: not moving, or rolling backwards while trying to go forwards
    this.stuck = (speed < 0.7 || car.speed < -0.3) && this.reverse <= 0 && throttle > 0.3 ? this.stuck + dt : 0
    let reset = false
    // no progress along the track for a while (wedged on an obstacle, shuffling back and forth
    // beside it): put it back on the track, as original game does with a stranded CPU car
    // orbiting: turned most of a full circle without reaching the next node — the target is
    // inside the turning circle. Back out with the wheel the other way (a three-point turn)
    const yaw = Math.atan2(car.forward.x, car.forward.z)
    if (this.lastYaw !== null) {
      let dy = yaw - this.lastYaw
      dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
      this.turned += dy
    }
    this.lastYaw = yaw
    if (Math.abs(this.turned) > Math.PI * 1.7 && this.reverse <= 0) {
      this.turned = 0
      this.reverse = 0.9
    }
    const gap = Math.hypot(...this.at(this.nextOf(this.node), 0).sub(p).toArray())
    if (this.node !== this.lastNode) {
      this.lastNode = this.node
      this.sameNode = 0
      this.turned = 0
      this.bestGap = gap
    } else if (gap < this.bestGap - 1) {
      this.bestGap = gap
      this.sameNode = 0
    } else if ((this.sameNode += dt) > NO_PROGRESS_S) {
      this.sameNode = 0
      this.stuck = 0
      this.reverse = 0
      return { throttle: 0, steer: 0, handbrake: false, reset: true }
    }
    if (this.stuck > 1.4) {
      this.stuck = 0
      this.reverse = 1.1
    }
    // pointing well away from the way and slow: nose against a wall, scraping along it at a few
    // m/s at full lock (Ghost Town 2's mine corner — 6 s until the no-progress reset). Back out
    this.facingAway = off > 1.2 && speed < 6 && this.reverse <= 0 ? this.facingAway + dt : 0
    if (this.facingAway > 1.0) {
      this.facingAway = 0
      this.reverse = 0.9
    }
    if (this.reverse > 0) {
      this.reverse -= dt
      // back out, not away: full reverse for 1.1 s took the AMW to 10 m/s backwards, across the
      // aisle and into a reset (Supermarket 1's U-turns)
      throttle = car.speed < -3 ? 0 : -0.8
      steer = -steer
      if (this.reverse <= 0 && speed < 0.5 && Math.random() < 0.35) reset = true
    }
    this.steerOut = steer
    return { throttle, steer, handbrake: false, reset }
  }
}

/** The line ahead, averaged over ±3 m (twice), the first point kept where it is. */
function smooth(pts: THREE.Vector3[]): THREE.Vector3[] {
  let cur = pts
  for (let pass = 0; pass < 2; pass++) {
    cur = cur.map((q, k) => {
      if (k === 0) return q
      const lo = Math.max(0, k - 2), hi = Math.min(cur.length - 1, k + 2)
      const m = new THREE.Vector3()
      for (let j = lo; j <= hi; j++) m.add(cur[j])
      return m.divideScalar(hi - lo + 1)
    })
  }
  return cur
}

/**
 * Radius of the circle through three points (large for a straight), seen from above: a crest or
 * a drop is not a bend (in 3D the drop after Toy World 1's kicker read as a hairpin, and the AI
 * braked on the ramp, stalled and fell into the pit beside it).
 */
function radius(a3: THREE.Vector3, b3: THREE.Vector3, c3: THREE.Vector3): number {
  const a = new THREE.Vector3(a3.x, 0, a3.z), b = new THREE.Vector3(b3.x, 0, b3.z), c = new THREE.Vector3(c3.x, 0, c3.z)
  const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a)
  const area2 = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length()
  if (area2 < 1e-6) return 1e4
  return (ab * bc * ca) / (2 * area2)
}
