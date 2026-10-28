// Force fields (the levels' .fld, convert.py force_fields), applied to every driven car each step —
// the player's in the browser, the CPU cars on the server. As original executable applies them:
// - type 0, a box (pos, axes = rot's columns, half sizes): an impulse along `dir` of
//   (mag − damp × speed along dir) × dt, not scaled by the car's mass (the exe's "mode 1"): so
//   it moves light cars more. mag is in cm/s² like the game's gravity (2200), the speed in cm/s.
//   The pond and the Toytanic pool: up 2250–2450 against gravity (cars of 1.2–2.5 kg sink slowly,
//   bobbing less); Toys in the Hood 2's stream: tilted, so it also carries cars along it.
// - type 1, a box: a turn of the car's up axis towards `dir`, (mag × (1 − damp × ω along the axis))
//   × dt as angular impulse in the game's kg·cm²/s (÷ 1e4 here): rights a car in the water.
// - type 4: a type 0 over the whole world (the Ghost Towns: 100 up, gravity 4.5% lower).
import type { Physics } from '../src/physics'

export interface ForceField {
  type: number
  pos: number[]
  rot: number[][] // 3x3, columns = the box's axes in the world
  half: number[]
  dir: number[]
  mag: number
  damp: number
}

function inside(f: ForceField, p: ArrayLike<number>): boolean {
  const d = [p[0] - f.pos[0], p[1] - f.pos[1], p[2] - f.pos[2]]
  for (let a = 0; a < 3; a++) {
    const along = d[0] * f.rot[0][a] + d[1] * f.rot[1][a] + d[2] * f.rot[2][a]
    if (Math.abs(along) > f.half[a]) return false
  }
  return true
}

export class ForceFields {
  constructor(readonly list: ForceField[]) {}

  /** The fields a point is in (for water effects and tests). */
  at(p: ArrayLike<number>): ForceField[] {
    return this.list.filter((f) => f.type === 4 || inside(f, p))
  }

  /** One step's push on a body: its centre `pos`, velocity, angular velocity, up axis (world). */
  apply(ph: Physics, id: number, pos: ArrayLike<number>, vel: ArrayLike<number>, ang: ArrayLike<number>, up: { x: number; y: number; z: number }, com: number[], dt: number) {
    for (const f of this.list) {
      if (f.type !== 4 && !inside(f, pos)) continue
      const d = f.dir
      if (f.type === 0 || f.type === 4) {
        const along = (vel[0] * d[0] + vel[1] * d[1] + vel[2] * d[2]) * 100 // cm/s
        const j = ((f.mag - f.damp * along) / 100) * dt // kg·m/s (the game's impulse, not × mass)
        ph.impulseAt(id, [d[0] * j, d[1] * j, d[2] * j], com)
      } else if (f.type === 1) {
        // axis = up × dir: turning about it brings up towards dir
        const ax = [up.y * d[2] - up.z * d[1], up.z * d[0] - up.x * d[2], up.x * d[1] - up.y * d[0]]
        const spin = ax[0] * ang[0] + ax[1] * ang[1] + ax[2] * ang[2]
        const k = (f.mag * (1 - f.damp * spin) * dt) / 1e4
        ph.angularImpulse(id, [ax[0] * k, ax[1] * k, ax[2] * k])
      }
    }
  }
}
