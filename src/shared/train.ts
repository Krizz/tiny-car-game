// The Toy World 2 train: a steam engine that runs along its rails across the race track (about
// 40 m after the start line), from a tunnel on one side to the tunnel on the other, and starts
// again out of sight. The level data only says where it stands and which way it faces; the run
// itself was the game's own code, so the stretch of rails (`run`, from convert.py), its speed and
// how often it comes are ours.
//
// Its position is a function of the server clock alone, so every browser and the server's AI
// world have it in the same place without sending anything. In the physics it is a kinematic body
// (wasm kin_create): it shoves cars out of its way and nothing moves it.
import type { MeshMeta } from '../src/assets'
import type { Physics } from '../src/physics'

export interface TrainInfo {
  pos: number[] // on the floor, where the level puts it
  fwd: number[] // the way it faces and runs
  run: [number, number] // from / to along fwd, metres from pos
  models: { body: MeshMeta; big: MeshMeta; small: MeshMeta }
  mirror?: boolean // mirrored course: the model is drawn flipped
}

export const TRAIN_SPEED = 5 // m/s
export const TRAIN_PERIOD = 24_000 // ms from one departure to the next

/** Wheels (model frame: front +z, floor y 0): which model, centre z, radius. Both sides. */
export const TRAIN_WHEELS = [
  { model: 'small' as const, z: 2.25, r: 0.94 },
  { model: 'small' as const, z: 0.2, r: 0.94 },
  { model: 'big' as const, z: -2.9, r: 1.36 },
]
export const TRAIN_WHEEL_X = 1.0
/** Where the steam comes out (model frame). */
export const TRAIN_CHIMNEY = [0, 5.5, 2.0]

// collision: chassis and wheels, the cab, the boiler ([cx, cy, cz, hx, hy, hz], model frame)
const BOXES = [
  [0, 1.3, 0, 1.12, 1.3, 4.73],
  [0, 3.78, -3.19, 0.87, 1.18, 1.55],
  [0, 3.37, 0.55, 0.6, 0.77, 2.19],
]

export interface TrainPose {
  pos: [number, number, number]
  s: number // distance along the run since this departure (wheel turn)
  moving: boolean
  departed: number // server time of this departure
}

export function trainPose(t: TrainInfo, serverMs: number): TrainPose {
  const departed = Math.floor(serverMs / TRAIN_PERIOD) * TRAIN_PERIOD
  const len = t.run[1] - t.run[0]
  const s = Math.min(len, ((serverMs - departed) / 1000) * TRAIN_SPEED)
  const d = t.run[0] + s
  return {
    pos: [t.pos[0] + t.fwd[0] * d, t.pos[1], t.pos[2] + t.fwd[2] * d],
    s,
    moving: s < len,
    departed,
  }
}

export function trainYaw(t: TrainInfo): number {
  return Math.atan2(t.fwd[0], t.fwd[2])
}

/** The train in a physics world; call step() before every physics step with that step's time. */
export class TrainBody {
  readonly id: number
  private q: number[]

  constructor(private t: TrainInfo, private physics: Physics, serverMs: number) {
    const y = trainYaw(t)
    this.q = [0, Math.sin(y / 2), 0, Math.cos(y / 2)]
    this.id = physics.createKinematic(BOXES, trainPose(t, serverMs).pos, this.q)
  }

  step(serverMs: number) {
    const p = trainPose(this.t, serverMs)
    const v = p.moving ? TRAIN_SPEED : 0
    this.physics.setPose(this.id, p.pos, this.q)
    this.physics.setVelocity(this.id, [this.t.fwd[0] * v, 0, this.t.fwd[2] * v], [0, 0, 0])
  }
}
