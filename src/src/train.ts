// Drawing and sound for the Toy World 2 train (where it is and how it moves: shared/train.ts).
// The engine with its six wheels turning, steam from the chimney while it is out in the open, the
// chuffing loop, and the whistle as it comes out of the tunnel.
import * as THREE from 'three'
import { loadLevelModels } from './assets'
import { SPR, type Fx } from './fx'
import type { Physics } from './physics'
import { LoopSound, play } from './sound'
import { TRAIN_CHIMNEY, TRAIN_SPEED, TRAIN_WHEELS, TRAIN_WHEEL_X, trainPose, trainYaw, type TrainInfo } from '../shared/train'

const WHISTLE_AT = 3 // m into the run: the engine's nose is at the tunnel mouth
const PUFF_EVERY = 0.22 // s between puffs at full speed
const UP = new THREE.Vector3(0, 1, 0)

export class TrainView {
  readonly root = new THREE.Group()
  private wheels: { obj: THREE.Object3D; r: number }[] = []
  private chuff = new LoopSound('train')
  private whistled = -1
  private puff = 0

  constructor(private t: TrainInfo, course: string, scene: THREE.Scene, private fx: Fx, private physics: Physics) {
    this.root.rotation.y = trainYaw(t)
    this.root.visible = false
    scene.add(this.root)
    loadLevelModels(course, 'train.bin', t.models).then((m) => {
      const inner = new THREE.Group()
      if (t.mirror) inner.scale.x = -1 // three.js flips the winding back by itself
      inner.add(m.body())
      for (const w of TRAIN_WHEELS) {
        for (const side of [-1, 1]) {
          const hub = new THREE.Group()
          hub.position.set(side * TRAIN_WHEEL_X, w.r, w.z)
          hub.add(m[w.model]())
          inner.add(hub)
          this.wheels.push({ obj: hub, r: w.r })
        }
      }
      this.root.add(inner)
      this.root.visible = true
    }).catch((e) => console.warn('train:', e))
  }

  update(serverMs: number, dt: number, listener: THREE.Vector3) {
    const p = trainPose(this.t, serverMs)
    this.root.position.set(...p.pos)
    for (const w of this.wheels) w.obj.rotation.x = p.s / w.r
    const dist = this.root.position.distanceTo(listener)
    const fall = 1 / (1 + Math.max(0, dist - 6) * 0.08)
    this.chuff.volume(p.moving ? 0.5 * fall : 0)
    if (!p.moving) return
    if (p.s >= WHISTLE_AT && this.whistled !== p.departed) {
      this.whistled = p.departed
      play('whistle', 0.8 * fall)
    }
    // steam, only out in the open (inside a tunnel it would show through the roof)
    this.puff -= dt
    if (this.puff > 0) return
    this.puff = PUFF_EVERY * (0.8 + Math.random() * 0.4)
    const at = new THREE.Vector3(...TRAIN_CHIMNEY)
    if (this.t.mirror) at.x = -at.x
    at.applyAxisAngle(UP, this.root.rotation.y).add(this.root.position)
    if (this.physics.raycast(at.toArray(), [0, 1, 0], 5)) return
    // a puff keeps a little of the engine's speed and is left behind as it drives on
    const vel = new THREE.Vector3(...this.t.fwd).multiplyScalar(TRAIN_SPEED * 0.2)
    this.fx.sprite(SPR.smoke, at, {
      size: 1.4, sizeEnd: 4.5, life: 2, alpha: 0.45, spin: 0.6, // additive: white steam, as in the game
      vel: vel.add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 2.5, (Math.random() - 0.5) * 0.6)),
    })
  }
}
