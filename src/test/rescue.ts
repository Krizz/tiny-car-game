// Every rescue point (one per .pan node) must leave a car upright and on the floor.
//   env TRACK=toy2 bun test/rescue.ts [car]
import * as THREE from 'three'
import { Physics } from '../src/physics'
import { Car } from '../src/car'
import type { CarInfo, TrackInfo, LoadedCar } from '../src/assets'
import { rescuePoint } from '../src/race'

const ROOT = new URL('../public/', import.meta.url).pathname
const TRACK = process.env.TRACK ?? 'toy2'
const physics = await Physics.load(ROOT + 'box3d.wasm')
const info: TrackInfo = await Bun.file(ROOT + `game/${TRACK}/track.json`).json()
const col = await Bun.file(ROOT + `game/${TRACK}/collision.bin`).arrayBuffer()
const nt = info.collision.triangles
physics.addMesh(new Float32Array(col, 0, nt * 9), new Float32Array(col, nt * 36, nt), 0.5)
const key = process.argv[2] ?? 'volken'
const ci: CarInfo = await Bun.file(ROOT + `game/cars/${key}/car.json`).json()
const loaded: LoadedCar = { info: ci, body: new THREE.Mesh(), wheels: ci.wheels.map(() => new THREE.Mesh()) }
const car = new Car(physics, loaded, new THREE.Vector3(0, 50, 0), 0)
let bad = 0
info.pan.nodes.forEach((n, i) => {
  const r = rescuePoint(info, physics, new THREE.Vector3(...n.pos))
  car.place(r.pos, r.yaw)
  for (let k = 0; k < 240; k++) {
    car.drive({ throttle: 0, steer: 0, handbrake: false }, 1 / 120)
    physics.step(1 / 120, 2)
  }
  car.readState()
  const moved = car.position.distanceTo(r.pos)
  if (car.upAxis.y < 0.7 || moved > 1.5 || car.grounded < 3) {
    bad++
    console.log(`node ${i} at ${n.pos.map((v) => v.toFixed(1))}: placed ${r.pos.toArray().map((v) => v.toFixed(1))} -> up ${car.upAxis.y.toFixed(2)} moved ${moved.toFixed(1)} m grounded ${car.grounded}`)
  }
})
console.log(`${TRACK} ${key}: ${bad} bad of ${info.pan.nodes.length} rescue points`)
