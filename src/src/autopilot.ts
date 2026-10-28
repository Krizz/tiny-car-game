// A simple driver along the .pan racing line — for tests (?bot=1) and a
// starting point for AI cars later. Toy World 2's line crosses itself, so the
// driver only ever moves forward along the node chain (never re-locks onto
// whichever node happens to be nearest).
import * as THREE from 'three'
import type { TrackInfo } from './assets'
import type { Car, Controls } from './car'

const V = (p: number[]) => new THREE.Vector3(p[0], p[1], p[2])

export class Autopilot {
  node = -1
  private stuck = 0
  private reverse = 0

  private t = Math.random() * 100

  /**
   * pace: corner-speed scale (AI skill), line: how far (m) it wanders off the
   * racing line, slowly, so a pack of AI doesn't drive in single file.
   */
  constructor(private info: TrackInfo, private opts: { pace?: number; line?: number } = {}) {}

  /** How sharp the line bends ahead (rad) — AI uses it to time turbo etc. */
  bend = 0

  private nearest(p: THREE.Vector3, from = -1, window = 0): number {
    const nodes = this.info.pan.nodes
    let best = 0, bd = Infinity
    const consider = (i: number) => {
      const n = nodes[i].pos
      const d = (n[0] - p.x) ** 2 + ((n[1] - p.y) * 3) ** 2 + (n[2] - p.z) ** 2
      if (d < bd) { bd = d; best = i }
    }
    if (from >= 0) {
      let i = from
      for (let k = 0; k < window; k++) {
        consider(i)
        i = nodes[i].next[0] ?? i
      }
    } else nodes.forEach((_, i) => consider(i))
    return best
  }

  /** Point `dist` metres down the line from node i (starting at p). */
  private along(p: THREE.Vector3, i: number, dist: number): { point: THREE.Vector3; node: number } {
    const nodes = this.info.pan.nodes
    let from = p.clone()
    while (true) {
      const t = V(nodes[i].pos)
      const d = from.distanceTo(t)
      if (d >= dist) return { point: from.lerp(t, dist / d), node: i }
      dist -= d
      from = t
      const n = nodes[i].next[0]
      if (n === undefined) return { point: t, node: i }
      i = n
    }
  }

  drive(car: Car, dt: number): Controls & { reset: boolean } {
    const nodes = this.info.pan.nodes
    const p = car.position
    if (this.node < 0) this.node = this.nearest(p)
    // re-find the place on the line, looking only a little behind and ahead
    let back = this.node
    for (let k = 0; k < 3; k++) back = nodes[back].prev[0] ?? back
    this.node = this.nearest(p, back, 12)
    if (p.distanceTo(V(nodes[this.node].pos)) > 25) this.node = this.nearest(p)
    // aim at the next node we haven't passed
    const cur = nodes[this.node], nx = nodes[cur.next[0] ?? this.node]
    let aimNode = this.node
    if (p.clone().sub(V(cur.pos)).dot(V(nx.pos).sub(V(cur.pos))) > 0) aimNode = cur.next[0] ?? this.node

    const speed = Math.abs(car.speed)
    const near = this.along(p, aimNode, Math.max(2.5, speed * 0.35))
    const far = this.along(p, aimNode, Math.max(8, speed * 1.1))
    const heading = car.forward.clone().setY(0).normalize()
    const angTo = (q: THREE.Vector3) => {
      const to = q.clone().sub(p).setY(0)
      return Math.atan2(heading.x * to.z - heading.z * to.x, heading.x * to.x + heading.z * to.z) // + = to the right
    }
    this.t += dt
    const line = this.opts.line ?? 0
    if (line) {
      // drift across the racing line: offset sideways (relative to the line's direction)
      const dir = far.point.clone().sub(near.point).setY(0).normalize()
      const side = new THREE.Vector3(-dir.z, 0, dir.x)
      const off = Math.sin(this.t * 0.37) * line
      near.point.addScaledVector(side, off)
      far.point.addScaledVector(side, off)
    }
    const a = angTo(near.point)
    const bend = Math.abs(angTo(far.point))
    this.bend = bend
    // corner speed: tighter bend ahead -> slower
    const vmax = (6 + 22 * Math.max(0, 1 - bend / 1.1)) * (this.opts.pace ?? 1)
    let throttle = speed > vmax + 1.5 ? -1 : speed > vmax ? 0 : 1
    let steer = Math.max(-1, Math.min(1, -a * 2.5))

    // unstick: reverse out for a moment, then try again
    this.stuck = speed < 0.8 && this.reverse <= 0 ? this.stuck + dt : 0
    if (this.stuck > 1.2) {
      this.reverse = 1.0
      this.stuck = 0
    }
    let reset = false
    if (this.reverse > 0) {
      this.reverse -= dt
      throttle = -1
      steer = -steer
      if (this.reverse <= 0 && speed < 0.5) reset = Math.random() < 0.3
    }
    return { throttle, steer, handbrake: false, reset }
  }
}
