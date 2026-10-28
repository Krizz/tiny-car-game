// The level's direction signs (.tri type 2): while the car we follow is inside a sign's box, its
// arrow shows at the top of the screen, and stays a moment after the car leaves it.
//
// One way only where the route goes through a box twice ("Ghost Town 2 R M
// directions seem very wrong" — out along a street and back through the same gate, the U-turn arrow
// came up again driving away from the U-turn). The boxes are thin gates, but which way through is
// "theirs" isn't in the data (right ones were crossed either way about equally), so it is worked
// out per box at load: of the racing line's crossings of it, the direction whose turn afterwards
// matches the arrow. Measured on all 26 forward/reversed courses before: 375 right, 20 wrong.
import type * as THREE from 'three'
import type { TrackInfo } from './assets'

const HOLD_MS = 1200
const AHEAD_M = 60 // how far on the line "the turn after it" is measured

interface Box { pos: number[]; rot: number[][]; half: number[]; sign: number }

export class Signs {
  private shown: number | null = null
  private until = 0
  // per sign: its gate's thin axis (world) and the way through it the sign is for (0 = either way)
  private gate: { axis: number[]; way: number }[]

  constructor(private info: TrackInfo) {
    this.gate = (info.signs ?? []).map((b) => this.whichWay(b as Box))
  }

  private inside(b: Box, x: number, y: number, z: number) {
    const dx = x - b.pos[0], dy = y - b.pos[1], dz = z - b.pos[2]
    const r = b.rot
    const lx = dx * r[0][0] + dy * r[1][0] + dz * r[2][0]
    const ly = dx * r[0][1] + dy * r[1][1] + dz * r[2][1]
    const lz = dx * r[0][2] + dy * r[1][2] + dz * r[2][2]
    return Math.abs(lx) <= b.half[0] && Math.abs(ly) <= b.half[1] + 0.5 && Math.abs(lz) <= b.half[2]
  }

  private whichWay(b: Box): { axis: number[]; way: number } {
    const t = b.half[0] < b.half[2] ? 0 : 2 // the gate's thin side: the way cars go through
    const axis = [b.rot[0][t], b.rot[1][t], b.rot[2][t]]
    const ai = this.info.ai ?? []
    if (!ai.length) return { axis, way: 0 }
    const pt = (i: number) => ai[i].a.map((v, j) => v + (ai[i].b[j] - v) * ai[i].line)
    // the racing line's crossings of the box: per direction through it, the turn that follows
    const turns = new Map<number, number[]>()
    for (let i = 0; i < ai.length; i++) {
      for (const k of ai[i].next) {
        const a = pt(i), c = pt(k)
        let hit = false
        for (let s = 0; s <= 8 && !hit; s++) hit = this.inside(b, a[0] + (c[0] - a[0]) * s / 8, a[1] + (c[1] - a[1]) * s / 8, a[2] + (c[2] - a[2]) * s / 8)
        if (!hit) continue
        const along = (c[0] - a[0]) * axis[0] + (c[1] - a[1]) * axis[1] + (c[2] - a[2]) * axis[2]
        if (Math.abs(along) < 1e-3) continue
        const way = Math.sign(along)
        const list = turns.get(way) ?? []
        list.push(this.turnAfter(k, pt))
        turns.set(way, list)
      }
    }
    if (turns.size < 2 || b.sign > 8) return { axis, way: 0 } // through it one way only (or danger/fork/cross)
    // the direction whose turn fits the arrow: left (0-3) / right (4-7) the most that way, straight
    // on (8) the least turning
    const fit = (deg: number) => (b.sign === 8 ? -Math.abs(deg) : b.sign < 4 ? deg : -deg)
    let best = 0, bestFit = -Infinity
    for (const [way, list] of turns) {
      const f = Math.max(...list.map(fit))
      if (f > bestFit) { bestFit = f; best = way }
    }
    return { axis, way: best }
  }

  /** Signed turn (degrees, + = left) of the line over AHEAD_M from node k. */
  private turnAfter(k: number, pt: (i: number) => number[]): number {
    const ai = this.info.ai!
    let prev = pt(k), i = k, dist = 0, turn = 0, dir: number[] | null = null
    while (dist < AHEAD_M) {
      i = ai[i].next[0] ?? i
      const q = pt(i)
      const d = [q[0] - prev[0], q[2] - prev[2]]
      const len = Math.hypot(d[0], d[1])
      if (len < 1e-3) break
      if (dir) turn += Math.atan2(dir[1] * d[0] - dir[0] * d[1], dir[0] * d[0] + dir[1] * d[1])
      dir = d
      dist += len
      prev = q
    }
    return (turn * 180) / Math.PI
  }

  private at(p: THREE.Vector3, heading?: THREE.Vector3): number | null {
    const list = this.info.signs ?? []
    for (let n = 0; n < list.length; n++) {
      const b = list[n] as Box
      if (!this.inside(b, p.x, p.y, p.z)) continue
      const g = this.gate[n]
      if (g.way && heading && (heading.x * g.axis[0] + heading.y * g.axis[1] + heading.z * g.axis[2]) * g.way < 0) continue
      return b.sign
    }
    return null
  }

  /** The arrow to show now (null = none) for a car at p going `heading` (its forward). */
  update(p: THREE.Vector3 | null, now: number, heading?: THREE.Vector3): number | null {
    const k = p ? this.at(p, heading) : null
    if (k !== null) {
      this.shown = k
      this.until = now + HOLD_MS
    } else if (now > this.until) this.shown = null
    return this.shown
  }
}
