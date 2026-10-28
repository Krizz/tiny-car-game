// Chase camera like original game's default: behind and above the car, following
// its heading with lag, pulled in when a wall would come between.
import * as THREE from 'three'
import type { Car } from './car'
import type { Physics } from './physics'

const BACK = 2.0
const HIGH = 0.72
const LOOK_UP = 0.18

export class ChaseCam {
  private heading = new THREE.Vector3(0, 0, -1)
  private pos = new THREE.Vector3()
  private look = new THREE.Vector3()
  private dist = BACK

  constructor(private cam: THREE.PerspectiveCamera, private physics: Physics) {}

  private desiredHeading(car: Car): THREE.Vector3 {
    const f = car.forward.clone()
    f.y = 0
    if (f.lengthSq() < 1e-4) f.copy(this.heading)
    return f.normalize()
  }

  snap(car: Car) {
    this.heading.copy(this.desiredHeading(car))
    this.place(car, 1)
  }

  update(car: Car, dt: number) {
    // follow the heading; when reversing fast, keep looking forward
    const target = this.desiredHeading(car)
    this.heading.lerp(target, 1 - Math.exp(-dt * 5)).normalize()
    this.place(car, 1 - Math.exp(-dt * 12))
  }

  private place(car: Car, k: number) {
    const p = car.root.position
    const anchor = p.clone().add(new THREE.Vector3(0, 0.25, 0))
    const want = p.clone().addScaledVector(this.heading, -BACK).add(new THREE.Vector3(0, HIGH, 0))
    // keep the camera out of walls
    const d = want.clone().sub(anchor)
    const len = d.length()
    d.normalize()
    const hit = this.physics.raycast(anchor.toArray(), d.toArray(), len)
    const allowed = hit ? Math.max(0.3, hit.dist - 0.15) : len
    this.dist += (allowed - this.dist) * (allowed < this.dist ? 1 : 0.08)
    want.copy(anchor).addScaledVector(d, this.dist)
    this.pos.lerp(want, k)
    if (k === 1) this.pos.copy(want)
    this.look.copy(p).add(new THREE.Vector3(0, LOOK_UP, 0))
    this.cam.position.copy(this.pos)
    this.cam.lookAt(this.look)
  }
}

// The grid's fly-in ("the camera flies towards the racers and then turns just before GO,
// like in the game" — the original's moves aren't in its data; this follows that description):
// one smooth curve from high up in front of the grid, looking back at the cars, down towards ours
// and round it (to the side with more room) onto ChaseCam's own pose at GO, so nothing jumps.
// Smooth ("without jankiness"): a single centripetal Catmull-Rom curve fixed at the grid's
// start (not two eased moves — the camera stopped dead between the fly-in and the turn), travelled
// at an even speed with ease in/out only at its ends, the car's heading read once (it wobbled as
// the car settled), and walls pulling it in gradually instead of from one frame to the next.
const CLEAR_N = 64
const ease = (x: number) => x * x * x * (x * (x * 6 - 15) + 10) // smootherstep: still at both ends

export class StartCam {
  private curve: THREE.CatmullRomCurve3 | null = null
  private lookFrom = new THREE.Vector3()
  private lookTo = new THREE.Vector3()
  // share of the way out from the car the walls allow, along the curve (CLEAR_N samples, smoothed)
  private clear: number[] = []

  constructor(private cam: THREE.PerspectiveCamera, private physics: Physics) {}

  /** At the start of the grid, right after ChaseCam.snap(car): the camera holds the pose to end on. */
  begin(car: Car) {
    const p = car.root.position.clone()
    const f = car.forward.clone().setY(0)
    if (f.lengthSq() < 1e-4) f.set(0, 0, -1)
    f.normalize()
    // turn round on the side with more room
    const right = new THREE.Vector3(-f.z, 0, f.x)
    const aside = (sgn: number) => this.physics.raycast([p.x, p.y + 0.4, p.z], right.clone().multiplyScalar(sgn).toArray(), 4)?.dist ?? 4
    const s = right.multiplyScalar(aside(1) >= aside(-1) ? 1 : -1)
    const at = (fwd: number, side: number, up: number) => p.clone().addScaledVector(f, fwd).addScaledVector(s, side).add(new THREE.Vector3(0, up, 0))
    const anchor = p.clone().add(new THREE.Vector3(0, 0.25, 0))
    // the way out from the car to q the walls allow (0..1)
    const room = (q: THREE.Vector3) => {
      const d = q.clone().sub(anchor), len = d.length()
      const hit = this.physics.raycast(anchor.toArray(), d.normalize().toArray(), len)
      return hit ? Math.max(0.1, hit.dist - 0.4) / len : 1
    }
    // the waypoints are moved in from the walls before the curve is made, so it stays one smooth
    // curve: squeezing the camera in afterwards, frame by frame, made it hang near the car and then
    // shoot out where a wall stopped being in the way (Toys in the Hood 2, Toytanic 1)
    let keys = [
      at(26, 0, 7), // high in front of the grid, looking back at the field
      at(12, 0, 3.2),
      at(5.5, 0.6, 1.5), // coming down in front of the car
      at(2.6, 2.6, 1.05), // round its front corner
      at(-0.6, 2.7, 0.85), // beside it
    ]
    const end = this.cam.position.clone() // ChaseCam's pose
    const pull = (q: THREE.Vector3, k: number) => q.sub(anchor).multiplyScalar(k).add(anchor)
    for (const q of keys) pull(q, room(q))
    // a waypoint pulled in past the next one goes (a doubled-back curve)
    keys = keys.filter((q, n) => n === keys.length - 1 || q.distanceTo(anchor) > keys[n + 1].distanceTo(anchor) + 1)
    const make = () => new THREE.CatmullRomCurve3([...keys, end], false, 'centripetal')
    this.curve = make()
    // stretches between waypoints that still cut a corner: the nearest waypoint in a little more
    for (let pass = 0; pass < 4; pass++) {
      let worst = 1, at2 = 0
      for (let n = 0; n <= 48; n++) {
        const k = room(this.curve.getPointAt(n / 48))
        if (k < worst) { worst = k; at2 = n / 48 }
      }
      if (worst > 0.97) break
      const n = Math.min(keys.length - 1, Math.round(at2 * keys.length))
      pull(keys[n], Math.max(0.5, worst))
      this.curve = make()
    }
    this.lookFrom.copy(p).add(new THREE.Vector3(0, 0.3, 0))
    this.lookTo.copy(p).add(new THREE.Vector3(0, LOOK_UP, 0))
    // what is still in the way after that (rare), worked out once and smoothed hard
    const raw: number[] = []
    for (let n = 0; n <= CLEAR_N; n++) raw.push(Math.min(1, room(this.curve.getPointAt(n / CLEAR_N)) + 0.03))
    const W = 10
    const low = raw.map((_, n) => Math.min(...raw.slice(Math.max(0, n - W), n + W + 1)))
    this.clear = low.map((_, n) => {
      const a = low.slice(Math.max(0, n - W), n + W + 1)
      return a.reduce((x, y) => x + y, 0) / a.length
    })
    this.clear[CLEAR_N] = 1 // ends on ChaseCam's own pose, which is already clear
  }

  /** u = 0 .. 1 through the grid. */
  update(car: Car, u: number) {
    if (!this.curve) return
    const e = ease(Math.max(0, Math.min(1, u)))
    const want = this.curve.getPointAt(e) // by arc length: an even speed along the curve
    const look = this.lookFrom.clone().lerp(this.lookTo, e)
    // pulled in towards the car where the walls say (the smoothed table from begin())
    const x = e * CLEAR_N, i = Math.min(CLEAR_N - 1, Math.floor(x))
    const k = this.clear[i] + (this.clear[i + 1] - this.clear[i]) * (x - i)
    const anchor = car.root.position.clone().add(new THREE.Vector3(0, 0.25, 0))
    this.cam.position.copy(anchor).lerp(want, Math.min(1, k))
    this.cam.lookAt(look)
  }
}
