// Laps, race order and resets from the track's own data:
//   .taz track zones  ordered boxes (ids 0..N-1, some duplicated for forks);
//                     the start line is the N-1 -> 0 crossing
//   .pan pos nodes    the racing line, for "put me back on the track"
import * as THREE from 'three'
import type { TrackInfo, Zone } from './assets'
import type { Physics } from './physics'

function inZone(z: Zone, p: THREE.Vector3): boolean {
  const dx = p.x - z.pos[0], dy = p.y - z.pos[1], dz = p.z - z.pos[2]
  const r = z.rot
  // columns of rot are the zone's axes in world space
  const lx = dx * r[0][0] + dy * r[1][0] + dz * r[2][0]
  const ly = dx * r[0][1] + dy * r[1][1] + dz * r[2][1]
  const lz = dx * r[0][2] + dy * r[1][2] + dz * r[2][2]
  return Math.abs(lx) <= z.half[0] && Math.abs(ly) <= z.half[1] && Math.abs(lz) <= z.half[2]
}

export class LapTracker {
  readonly count: number // zone ids 0..count-1
  private centres: THREE.Vector3[] = []
  last: number // last zone id passed in order
  passes = 0 // zones passed in order since the start
  crossings = 0 // times over the start line (1 = on lap 1)
  lapStart = 0
  lapTimes: number[] = []
  wrongWay = 0

  constructor(private info: TrackInfo) {
    this.count = Math.max(...info.zones.map((z) => z.id)) + 1
    for (let i = 0; i < this.count; i++) {
      const zs = info.zones.filter((z) => z.id === i)
      const c = new THREE.Vector3()
      zs.forEach((z) => c.add(new THREE.Vector3(...z.pos)))
      this.centres.push(c.divideScalar(Math.max(1, zs.length)))
    }
    this.last = this.count - 1
  }

  reset() {
    this.last = this.count - 1
    this.passes = 0
    this.crossings = 0
    this.lapTimes = []
    this.lapStart = 0
  }

  get lap(): number {
    return Math.max(1, this.crossings)
  }

  /** Returns 'lap' when a lap was just completed. */
  update(p: THREE.Vector3, now: number): 'lap' | null {
    let result: 'lap' | null = null
    for (const z of this.info.zones) {
      if (!inZone(z, p)) continue
      // accept the next zone, or one skipped (small gaps between boxes)
      const ahead = (z.id - this.last + this.count) % this.count
      if (ahead === 1 || ahead === 2) {
        this.last = z.id
        this.passes += ahead
        if (z.id === 0 || (ahead === 2 && z.id === 1)) {
          this.crossings++
          // lap 1 is timed from GO (the grid sits just behind the line)
          if (this.crossings > 1) {
            this.lapTimes.push(now - this.lapStart)
            this.lapStart = now
            result = 'lap'
          }
        }
        break
      }
    }
    return result
  }

  /** Race order key: zones passed + how far towards the next one. */
  progress(p: THREE.Vector3): number {
    const a = this.centres[this.last]
    const b = this.centres[(this.last + 1) % this.count]
    const seg = a.distanceTo(b) || 1
    const f = Math.max(0, Math.min(0.99, 1 - p.distanceTo(b) / seg))
    return this.passes + f
  }

  completedLaps(): number {
    return Math.max(0, this.crossings - 1)
  }
}

// original game's start grids (original executable, 3 tables of 12 cars: forward, side in cm from STARTPOS; the
// level picks one with STARTGRID / STARTGRIDREV). 0: pairs 2.56 m apart (pole to the right of the
// start point, the 2nd car on it 40 cm back), a pair every 3 m; 1: the same with the pole on the
// left; 2: rows of three (the frontend's). Ours used two columns 1.1 m apart, 1.5 m rows.
const GRID3 = [[300, 256], [270, -256], [240, -44], [100, 212], [70, -300], [40, 44], [-100, 300], [-130, -212],
  [-160, 0], [-300, 256], [-330, -256], [-360, 0]]
function gridOffset(type: number, k: number): [number, number] {
  if (type === 2) {
    const [f, s] = GRID3[k % 12]
    return [f - 600 * Math.floor(k / 12), s]
  }
  // types 0/1 run on past 12 cars the same way (we allow 16)
  return [-300 * Math.floor(k / 2) - 40 * (k % 2), k % 2 ? 0 : type === 1 ? -256 : 256]
}

/**
 * Grid slot i (original game's grid for the level), dropped onto the floor. A spot with no level floor
 * under it moves everyone after it one place back. The floor can be several metres under
 * STARTPOS (Botanical Garden, Ghost Town, Toytanic): it is looked for up to 12 m down — at 3 m
 * every spot there "failed" and the whole field was stacked on one point in the air.
 */
export function gridSlot(info: TrackInfo, physics: Physics, i: number): { pos: THREE.Vector3; yaw: number } {
  const yaw = -info.start.rot * Math.PI * 2
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
  const side = info.start.side ?? 1 // -1 on a mirrored course
  const type = info.start.grid ?? 0
  const base = new THREE.Vector3(...info.start.pos)
  const floorAt = (p: THREE.Vector3) => physics.raycast([p.x, p.y + 1, p.z], [0, -1, 0], 12)
  const baseFloor = floorAt(base)?.point[1] ?? base.y
  // level enough, and at about the height of the last spot taken (a grid can run up a ramp behind
  // the line — Toytanic 1 — but must not drop to a floor under the track)
  let lastFloor = baseFloor
  const usable = (p: THREE.Vector3) => {
    const hit = floorAt(p.clone().setY(lastFloor))
    return hit && hit.normal[1] > 0.8 && Math.abs(hit.point[1] - lastFloor) < 1.5 ? hit : null
  }
  const spine = trackBehind(info, base, fwd)
  // slot i = the i-th usable spot of the grid in order (an unusable one moves everyone after it back).
  // The original's grid is straight and 12 cars long (16.5 m); with 16 cars, or where the road bends
  // close behind the line, a spot off the straight is placed as far back along the track instead
  for (let k = 0, found = 0; k < i + 40; k++) {
    const [f, s] = gridOffset(type, k)
    let p = base.clone().addScaledVector(fwd, f / 100).addScaledVector(right, (side * s) / 100)
    let h = usable(p)
    let dir = fwd
    if (!h && f < 0) {
      const at = spine(-f / 100)
      dir = at.dir
      p = at.pos.addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x), (side * s) / 100)
      h = usable(p)
    }
    if (!h) continue
    lastFloor = h.point[1]
    if (found++ === i) return { pos: new THREE.Vector3(h.point[0], h.point[1] + 0.22, h.point[2]), yaw: Math.atan2(-dir.x, -dir.z) }
  }
  return { pos: base.setY(baseFloor + 0.25), yaw }
}

/**
 * The track behind the start line as a path: the AI line's node chain walked backwards (prev
 * links) from the node at the start, shifted so it passes through STARTPOS. Returns the point
 * `d` metres back and the race direction there (level).
 */
function trackBehind(info: TrackInfo, base: THREE.Vector3, fwd: THREE.Vector3) {
  const ai = info.ai ?? []
  const mid = (i: number) => new THREE.Vector3(...ai[i].a).lerp(new THREE.Vector3(...ai[i].b), 0.5)
  const pts: THREE.Vector3[] = [base.clone()]
  if (ai.length) {
    // the nearest node pointing the race's way that is not ahead of the line
    let s = -1, bd = Infinity
    ai.forEach((n, i) => {
      const m = mid(i)
      const nx = n.next[0] ?? i
      const dir = mid(nx).sub(m).setY(0)
      if (dir.dot(fwd) <= 0) return
      const to = m.clone().sub(base)
      if (to.dot(fwd) > 0.5) return
      const d = to.lengthSq()
      if (d < bd) { bd = d; s = i }
    })
    if (s >= 0) {
      const shift = base.clone().sub(mid(s)).setY(0)
      // only the part across the race direction: the path then starts level with the line
      shift.addScaledVector(fwd, -shift.dot(fwd))
      for (let k = 0, i = s; k < 40; k++) {
        pts.push(mid(i).add(shift))
        const pv = ai[i].prev[0]
        if (pv === undefined || pv === s) break
        i = pv
      }
    }
  }
  return (d: number) => {
    let left = d
    for (let j = 0; j + 1 < pts.length; j++) {
      const seg = pts[j + 1].clone().sub(pts[j])
      const len = seg.length()
      if (len < 1e-3) continue
      if (left <= len) {
        const dir = seg.clone().setY(0).normalize().negate()
        return { pos: pts[j].clone().addScaledVector(seg, left / len), dir: dir.lengthSq() > 0 ? dir : fwd.clone() }
      }
      left -= len
    }
    return { pos: base.clone().addScaledVector(fwd, -d), dir: fwd.clone() }
  }
}

/**
 * Where to put a car back on the track: the nearest racing-line node whose floor is
 * a good place to stand — level enough, with floor under all four corners of a car
 * (not on a shelf's lip or a ramp's edge, where a rescued car used to roll off and
 * flip again at once, in a loop). Raised a little and facing along the line.
 */
/**
 * Back on the track: the nearest level spot on the AI line. `behind`: never one ahead of `p` along
 * the race (a reset could gain a few metres or hop a corner) — players' resets and the CPU cars'.
 */
export function rescuePoint(info: TrackInfo, physics: Physics, p: THREE.Vector3, behind = false): { pos: THREE.Vector3; yaw: number } {
  const nodes = info.pan.nodes
  if (behind) {
    // where the car is along the line (nearest point of the nearest stretches between nodes),
    // BACK_OFF metres back: the nearest node behind was up to 26 m back on a long straight
    const BACK_OFF = 2
    const near: { a: number[]; dir: THREE.Vector3; len: number; t: number; d: number }[] = []
    for (const n of nodes) {
      for (const k of n.next) {
        const m = nodes[k]
        if (!m) continue
        const dir = new THREE.Vector3(m.pos[0] - n.pos[0], m.pos[1] - n.pos[1], m.pos[2] - n.pos[2])
        const len = dir.length()
        if (len < 0.01) continue
        dir.divideScalar(len)
        const t = Math.max(0, Math.min(len, (p.x - n.pos[0]) * dir.x + (p.y - n.pos[1]) * dir.y + (p.z - n.pos[2]) * dir.z))
        const q = [n.pos[0] + dir.x * t, n.pos[1] + dir.y * t, n.pos[2] + dir.z * t]
        near.push({ a: n.pos, dir, len, t, d: (q[0] - p.x) ** 2 + ((q[1] - p.y) * 2) ** 2 + (q[2] - p.z) ** 2 })
      }
    }
    near.sort((x, y) => x.d - y.d)
    // ...and with nothing right in front: on Toytanic 1 that put a car nose to a post it had hit
    for (const s of near.slice(0, 4)) {
      for (const back of [BACK_OFF, BACK_OFF * 2, BACK_OFF * 3]) {
        const t = Math.max(0, s.t - back)
        const at = new THREE.Vector3(s.a[0] + s.dir.x * t, s.a[1] + s.dir.y * t, s.a[2] + s.dir.z * t)
        const spot = standOn(physics, at, Math.atan2(-s.dir.x, -s.dir.z))
        if (!spot?.good) continue
        const flat = Math.hypot(s.dir.x, s.dir.z) || 1
        if (!physics.raycast([spot.pos.x, spot.pos.y, spot.pos.z], [s.dir.x / flat, 0, s.dir.z / flat], 1.5)) return spot
      }
    }
  }
  const order = nodes
    .map((n, i) => ({ i, d: (n.pos[0] - p.x) ** 2 + ((n.pos[1] - p.y) * 2) ** 2 + (n.pos[2] - p.z) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
  let first: { pos: THREE.Vector3; yaw: number } | null = null
  let firstBack: { pos: THREE.Vector3; yaw: number } | null = null
  for (const { i } of order) {
    const spot = standAt(info, physics, i)
    if (!spot) continue
    first ??= spot
    // ahead = the spot is past p in the direction the car will face there
    const back = !behind || (p.x - spot.pos.x) * -Math.sin(spot.yaw) + (p.z - spot.pos.z) * -Math.cos(spot.yaw) >= -0.5
    if (!back) continue
    if (spot.good) return spot
    firstBack ??= spot
  }
  return firstBack ?? first ?? standAt(info, physics, order[0].i, true)!
}

function standAt(info: TrackInfo, physics: Physics, i: number, any = false): { pos: THREE.Vector3; yaw: number; good: boolean } | null {
  const n = info.pan.nodes[i]
  const next = info.pan.nodes[n.next[0] ?? i] ?? n
  const dir = new THREE.Vector3(next.pos[0] - n.pos[0], 0, next.pos[2] - n.pos[2])
  // the .pan line runs against the race direction on some tracks: match the zones
  return standOn(physics, new THREE.Vector3(...n.pos), Math.atan2(-dir.x, -dir.z), any)
}

/**
 * A car-sized spot on the floor at (about) `at`, facing `yaw`: `good` when it is level and
 * there is floor at the same height under all four corners. null if there's no floor there.
 */
export function standOn(physics: Physics, at: THREE.Vector3, yaw: number, any = false): { pos: THREE.Vector3; yaw: number; good: boolean } | null {
  const pos = at.clone()
  const hit = physics.raycast([pos.x, pos.y + 1.5, pos.z], [0, -1, 0], 6)
  if (!hit) {
    if (!any) return null
    pos.y += 0.3
    return { pos, yaw, good: false }
  }
  pos.set(hit.point[0], hit.point[1] + 0.3, hit.point[2])
  let good = hit.normal[1] > 0.93
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
  for (const [a, b] of [[0.6, 0.35], [0.6, -0.35], [-0.6, 0.35], [-0.6, -0.35]]) {
    if (!good) break
    const c = pos.clone().addScaledVector(fwd, a).addScaledVector(right, b)
    const h = physics.raycast([c.x, c.y + 0.5, c.z], [0, -1, 0], 1.2)
    good = !!h && Math.abs(h.point[1] - hit.point[1]) < 0.12 && h.normal[1] > 0.85
  }
  return { pos, yaw, good }
}

/**
 * Metres travelled along the race, from the track's AI nodes (each knows its
 * distance to the finish). Continuous across laps — 1 lap = `length` — so the
 * difference between two cars is the gap between them in metres (the HUD's
 * "12 m ahead"), and it orders the race more finely than the zones.
 */
export class TrackMeter {
  readonly length: number
  private pts: THREE.Vector3[]
  private along: number[] // metres from the finish, 0 .. length
  private next: number[][]
  private prev: number[][]
  private node = -1
  value = 0
  private started = false

  constructor(info: TrackInfo) {
    const ai = info.ai ?? []
    this.pts = ai.map((n) => new THREE.Vector3(...n.a).lerp(new THREE.Vector3(...n.b), 0.5))
    const dist = ai.map((n) => n.dist)
    this.next = ai.map((n, i) => (n.next.length ? n.next : [i]))
    this.prev = ai.map((n) => n.prev)
    // Metres to the finish from each node, measured along the line itself (shortest way on, over
    // every branch) — not the .fan's own figures: on Toytanic 1 R two branches cross the finish and
    // one's figures are ~190 m out, so a 6 m link "covered" 190 m. The finish is crossed on the links
    // where the .fan's distance-to-go jumps up (from ~0 to ~a lap).
    const maxD = Math.max(0, ...dist)
    const hop = (i: number, k: number) => this.pts[i].distanceTo(this.pts[k])
    // ...and only by the start line: the .fan has false jumps mid-lap too (Ghost Town 1: 146 m from
    // the finish, 92 m from the line; Toytanic 1 R 180 / 143 m). A real crossing leaves a node 0–28 m
    // from the finish by the data, within 30 m of the start; the false ones 60–180 m and 43–143 m
    const jump = (i: number, k: number) => dist[k] - dist[i] > maxD * 0.5
    const startAt = new THREE.Vector3(...info.start.pos)
    const real = (i: number, k: number) => dist[i] <= 40 && this.pts[i].clone().lerp(this.pts[k], 0.5).distanceTo(startAt) <= 60
    const jumps: [number, number][] = []
    ai.forEach((_, i) => { for (const k of this.next[i]) if (jump(i, k)) jumps.push([i, k]) })
    let finish = jumps.filter(([i, k]) => real(i, k))
    if (!finish.length && jumps.length) finish = [jumps.reduce((x, y) => (dist[y[0]] < dist[x[0]] ? y : x))]
    const wraps = (i: number, k: number) => finish.some(([a, b]) => a === i && b === k)
    const togo = ai.map(() => Infinity)
    const targets: number[] = []
    ai.forEach((_, i) => { for (const k of this.next[i]) if (wraps(i, k)) { togo[i] = Math.min(togo[i], hop(i, k)); targets.push(k) } })
    if (targets.length) {
      for (let pass = 0, changed = true; changed && pass < ai.length + 2; pass++) {
        changed = false
        ai.forEach((_, i) => {
          for (const k of this.next[i]) {
            if (wraps(i, k) || togo[k] === Infinity) continue
            const v = hop(i, k) + togo[k]
            if (v < togo[i] - 1e-6) { togo[i] = v; changed = true }
          }
        })
      }
      // a lap: from just past the finish all the way round to it again
      const laps = targets.map((k) => togo[k]).filter((v) => v < Infinity)
      this.length = (laps.length ? Math.min(...laps) : maxD) || 1
      this.along = togo.map((g) => (g === Infinity ? 0 : ((((this.length - g) % this.length) + this.length) % this.length)))
    } else {
      // no finish crossing found in the data: the .fan's own figures
      let far = 0
      dist.forEach((d, i) => { if (d > dist[far]) far = i })
      const start = this.prev[far]?.[0] ?? 0
      this.length = (dist[far] ?? 0) + (this.pts[far] && this.pts[start] ? hop(far, start) : 0) || 1
      this.along = dist.map((d) => (((this.length - d) % this.length) + this.length) % this.length)
    }
  }

  reset() {
    this.node = -1
    this.started = false
    this.value = 0
  }

  // Robust (2026-10-12: "confused who is 1st when spectating, Toytanic a lot"): the old one
  // followed only a node's first branch, re-found a lost car by the nearest node (another deck on
  // Toytanic) and wrapped the lap only at node 0 — Toytanic's .fan wraps between two other nodes,
  // and across that link it read anything from 0 to a whole lap. Up to 3500 jumps of > 5 m a race.
  // Now: the nearest stretch among every branch a few nodes either way, a lost car re-found where
  // the reading carries on, and the reading unwrapped against the last one wherever the lap wraps.

  /** Metres from the finish at the point t (0..1) of stretch i -> k (across a wrap: the short way). */
  private at(i: number, k: number, t: number): number {
    const L = this.length, a = this.along[i]
    let b = this.along[k]
    if (b < a - L / 2) b += L
    else if (b > a + L / 2) b -= L
    return a + (b - a) * t
  }

  private nearest(p: THREE.Vector3, nodes: Iterable<number>) {
    let best = { i: -1, k: -1, t: 0, d: Infinity }
    for (const i of nodes) {
      const a = this.pts[i]
      for (const k of this.next[i]) {
        const b = this.pts[k]
        const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * sx + (p.y - a.y) * sy + (p.z - a.z) * sz) / Math.max(1e-6, sx * sx + sy * sy + sz * sz)))
        // height counts three times over: decks above each other
        const d = (a.x + sx * t - p.x) ** 2 + ((a.y + sy * t - p.y) * 3) ** 2 + (a.z + sz * t - p.z) ** 2
        if (d < best.d) best = { i, k, t, d }
      }
    }
    return best
  }

  update(p: THREE.Vector3): number {
    if (!this.pts.length) return 0
    const L = this.length
    let best = { i: -1, k: -1, t: 0, d: Infinity }
    if (this.node >= 0) {
      // the stretches within a few nodes either way, every branch
      const near = new Set<number>([this.node])
      let ring = [this.node]
      for (let h = 0; h < 4; h++) {
        const nx: number[] = []
        for (const n of ring) for (const m of [...this.next[n], ...this.prev[n]]) if (!near.has(m)) { near.add(m); nx.push(m) }
        ring = nx
      }
      best = this.nearest(p, near)
      // stay on the stretch it was on unless another is clearly nearer: where two run close
      // (Museum 2) the reading flicked 37 m and back for a tick
      const here = this.nearest(p, [this.node])
      if (here.d <= best.d + 1) best = here
    }
    if (best.d > 15 * 15) {
      // lost (rescued, fell, joined): every stretch; of those about as near as the nearest, the one
      // where the reading carries on (not the deck above or below)
      const all: { i: number; k: number; t: number; d: number }[] = []
      for (let i = 0; i < this.pts.length; i++) all.push(this.nearest(p, [i]))
      const min = Math.min(...all.map((c) => c.d))
      const close = all.filter((c) => c.d <= Math.max(min * 2.5, min + 25))
      const last = ((this.value % L) + L) % L
      const gap = (c: { i: number; k: number; t: number }) => {
        const g = Math.abs((((this.at(c.i, c.k, c.t) - last) % L) + L) % L)
        return Math.min(g, L - g)
      }
      best = this.started ? close.reduce((x, y) => (gap(y) < gap(x) ? y : x)) : all.reduce((x, y) => (y.d < x.d ? y : x))
    }
    this.node = best.i
    const along = ((this.at(best.i, best.k, best.t) % L) + L) % L
    // the lap count from continuity: whichever whole lap puts this nearest the last reading
    this.value = this.started ? along + L * Math.round((this.value - along) / L) : along
    this.started = true
    return this.value
  }
}

/**
 * Split times, as in original game: the level's split checkpoints (.tri type 1, 2–5 boxes, in order) time
 * each lap; passing one shows that lap's time there against the best lap's (green ahead, red behind).
 */
export class SplitTimes {
  private boxes: { pos: number[]; rot: number[][]; half: number[]; id: number }[]
  private lap: (number | null)[] = []
  private best: (number | null)[] | null = null

  constructor(info: TrackInfo) {
    this.boxes = (info as any).splits ?? []
  }

  reset() {
    this.lap = []
    this.best = null
  }

  /** The split passed now (its number from 1, the lap time there, the gap to the best lap's), or null. */
  update(p: THREE.Vector3, lapMs: number): { n: number; time: number; diff: number | null } | null {
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.lap[i] != null) continue
      const b = this.boxes[i]
      const d = [p.x - b.pos[0], p.y - b.pos[1], p.z - b.pos[2]]
      let inside = true
      for (let a = 0; a < 3 && inside; a++) inside = Math.abs(d[0] * b.rot[0][a] + d[1] * b.rot[1][a] + d[2] * b.rot[2][a]) <= b.half[a] + 0.3
      if (!inside) continue
      this.lap[i] = lapMs
      const was = this.best?.[i]
      // numbered in the order passed (a reversed course may use the forward run's boxes)
      return { n: this.lap.filter((x) => x != null).length, time: lapMs, diff: was != null ? lapMs - was : null }
    }
    return null
  }

  /** A lap is over; `best` = it was the best yet (its splits become the ones to beat). */
  lapDone(best: boolean) {
    if (best && this.lap.some((x) => x != null)) this.best = this.lap.slice()
    this.lap = []
  }
}
