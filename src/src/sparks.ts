// Car particles, after original game's sparks and dust: a shower of sparks where a car takes a hard
// knock (a wall, another car, landing on its roof), and dust behind the wheels on dusty floors
// (surfaces.ts dust type: gravel, sand, grass, dirt, a little smoke on paving). Works for every
// car on the track from its velocity and the floor under it, so it needs nothing from the network.
import * as THREE from 'three'
import type { Car } from './car'
import { SPR, type Fx } from './fx'
import type { Physics } from './physics'
import { surface } from './surfaces'

const KNOCK = 4 // m/s of velocity change in a frame that throws sparks
// per dust type: puffs per second at speed, colour, size
const DUST: Record<number, { rate: number; color: number; size: number }> = {
  1: { rate: 14, color: 0x8c8578, size: 0.35 }, // gravel
  2: { rate: 12, color: 0xd8c08a, size: 0.4 }, // sand
  3: { rate: 14, color: 0x7d9a45, size: 0.3 }, // grass
  4: { rate: 12, color: 0x8a6a48, size: 0.4 }, // dirt
  5: { rate: 4, color: 0x9a9a9a, size: 0.35 }, // road (paving)
}

export class CarParticles {
  private last = new WeakMap<Car, THREE.Vector3>()
  private dust = new WeakMap<Car, number>()
  private down = [0, -1, 0]

  constructor(private fx: Fx, private physics: Physics) {}

  update(cars: Car[], dt: number) {
    for (const car of cars) {
      const v = car.velocity
      const prev = this.last.get(car)
      if (prev && dt > 0 && dt < 0.05) {
        const dv = v.clone().sub(prev)
        if (dv.length() > KNOCK) this.sparks(car, dv)
      }
      this.last.set(car, (prev ?? new THREE.Vector3()).copy(v))
      this.kickDust(car, dt)
    }
  }

  private sparks(car: Car, dv: THREE.Vector3) {
    const n = Math.min(14, Math.round(dv.length() * 1.5))
    const away = dv.clone().normalize()
    // the knock pushed the car away from what it hit: the sparks fly from that side
    const at = car.position.clone().addScaledVector(away, -0.25)
    for (let i = 0; i < n; i++) {
      const vel = away.clone().multiplyScalar(2 + Math.random() * 3)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(5))
        .addScaledVector(car.velocity, 0.5)
      this.fx.sprite(SPR.spark, at, { size: 0.12, sizeEnd: 0.04, life: 0.25 + Math.random() * 0.25, color: 0xffb040, vel, gravity: 18 })
    }
  }

  private kickDust(car: Car, dt: number) {
    const speed = car.velocity.length()
    if (speed < 2.5 || !car.root.visible) return
    const hit = this.physics.raycast(car.position.toArray(), this.down, 0.8)
    const d = hit ? DUST[surface(hit.material).dust] : undefined
    if (!d || !hit) return
    let acc = (this.dust.get(car) ?? 0) + dt * d.rate * Math.min(1, speed / 12)
    const back = car.velocity.clone().normalize()
    while (acc >= 1) {
      acc -= 1
      const side = (Math.random() - 0.5) * 0.5
      const at = new THREE.Vector3(...hit.point).addScaledVector(back, -0.3)
      at.x += side * back.z
      at.z -= side * back.x
      at.y += 0.05
      // the white puff added on (the FX pages are drawn on black): normal blending drew dark blots
      this.fx.sprite(SPR.cloud, at, {
        size: d.size, sizeEnd: d.size * 3, life: 0.8 + Math.random() * 0.4, alpha: 0.3, color: d.color, spin: 1,
        vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.6 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8).addScaledVector(car.velocity, 0.15),
      })
    }
    this.dust.set(car, acc)
  }
}
