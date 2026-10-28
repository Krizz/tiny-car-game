// The car's aerial (Parameters.txt AERIAL): a whip of SECTIONS copies of cars/misc/Aerial.m with
// the AerialT.m tip on top, standing on the body at Offset along Direction. Drawing only: the tip
// is a damped spring pushed by the body's acceleration (it leans back as the car pulls away,
// forward under braking, sideways in a turn, and wobbles over bumps); the whip bends as a curve
// from its root to the tip. Each car's Stiffness / Damping set how stiff and how lively it is.
import * as THREE from 'three'

export interface AerialInfo {
  offset: number[]
  dir: number[]
  length: number // per section
  stiffness: number
  damping: number
  sec: number // mesh index of the section model
  top: number // mesh index of the tip (-1 = none)
}

const SECTIONS = 3
const MODEL_LEN = 0.01 // Aerial.m is 1 unit (1 cm) long: scaled along y to each section's length
const LEAN = 0.008 // how far the tip swings per m/s² of acceleration, × the whip's length (hard braking ≈ 25°)
const UP = new THREE.Vector3(0, 1, 0)
// Aerial.m takes its colour from a corner of the car's texture page, which only some cars paint
// (the rest showed body colour): always black, and the tip in its own vertex colours (grey + red)
const WHIP = new THREE.MeshBasicMaterial({ color: 0x141414 })
const TIP = new THREE.MeshBasicMaterial({ vertexColors: true })
WHIP.userData.shared = TIP.userData.shared = true // every car's: not tinted per car (carlight.ts)

export class Aerial {
  readonly group = new THREE.Group()
  private secs: THREE.Object3D[] = []
  private tip: THREE.Object3D | null = null
  private base: THREE.Vector3
  private dir: THREE.Vector3
  private total: number
  private k: number
  private c: number
  // tip displacement (body frame, across the whip) and its rate
  private d = new THREE.Vector3()
  private dv = new THREE.Vector3()
  private lastVel: THREE.Vector3 | null = null
  private acc = new THREE.Vector3()
  private last = 0

  constructor(info: AerialInfo, part: (i: number) => THREE.Mesh | null) {
    this.base = new THREE.Vector3(...info.offset)
    this.dir = new THREE.Vector3(...info.dir).normalize()
    this.total = info.length * SECTIONS
    // original game's 2000 / 5.5 -> ~4 Hz, lightly damped: a whip that keeps swaying a moment
    this.k = info.stiffness * 0.3
    this.c = info.damping * 0.8
    for (let i = 0; i < SECTIONS; i++) {
      const m = part(info.sec)
      if (!m) continue
      m.material = WHIP
      const h = new THREE.Group()
      h.add(m)
      this.group.add(h)
      this.secs.push(h)
    }
    const t = info.top >= 0 ? part(info.top) : null
    if (t) {
      t.material = TIP
      this.tip = new THREE.Group()
      this.tip.add(t)
      this.group.add(this.tip)
    }
  }

  /** Step the whip by the body's world velocity (this frame) and pose the sections. */
  update(vel: THREE.Vector3, q: THREE.Quaternion) {
    const now = performance.now()
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000)
    this.last = now
    if (dt > 0 && this.lastVel) {
      // body-frame acceleration, smoothed a little (frame times and physics steps don't line up)
      const a = vel.clone().sub(this.lastVel).divideScalar(dt).applyQuaternion(q.clone().invert())
      this.acc.lerp(a, Math.min(1, dt * 25))
      // only the part across the whip moves the tip
      const across = this.acc.clone().addScaledVector(this.dir, -this.acc.dot(this.dir))
      const steps = Math.ceil(dt / (1 / 240))
      const h = dt / steps
      for (let s = 0; s < steps; s++) {
        // inertia: the tip lags behind the body's acceleration
        const f = across.clone().multiplyScalar(-LEAN * this.total * this.k)
          .addScaledVector(this.d, -this.k).addScaledVector(this.dv, -this.c)
        this.dv.addScaledVector(f, h)
        this.d.addScaledVector(this.dv, h)
      }
      this.d.addScaledVector(this.dir, -this.d.dot(this.dir))
      const max = this.total * 0.45
      if (this.d.length() > max) this.d.setLength(max)
    }
    this.lastVel = vel.clone()
    this.pose()
  }

  /** A point up the whip (0 = its foot, 1 = the tip), in world space — the putty bomb's spark. */
  worldPoint(t: number): THREE.Vector3 {
    return this.group.localToWorld(this.point(Math.max(0, Math.min(1, t))))
  }

  private point(t: number): THREE.Vector3 {
    // straight up the whip, bent towards the tip's displacement (more near the top)
    return this.base.clone().addScaledVector(this.dir, this.total * t).addScaledVector(this.d, t * t)
  }

  private pose() {
    const n = this.secs.length
    for (let i = 0; i < n; i++) {
      const a = this.point(i / n), b = this.point((i + 1) / n)
      const seg = b.clone().sub(a)
      const len = seg.length()
      const h = this.secs[i]
      h.position.copy(a)
      if (len > 1e-6) h.quaternion.setFromUnitVectors(UP, seg.divideScalar(len))
      h.scale.set(1, len / MODEL_LEN, 1)
    }
    if (this.tip) {
      const a = this.point((n - 1) / n), b = this.point(1)
      this.tip.position.copy(b)
      const seg = b.sub(a)
      if (seg.lengthSq() > 1e-12) this.tip.quaternion.setFromUnitVectors(UP, seg.normalize())
    }
  }
}
