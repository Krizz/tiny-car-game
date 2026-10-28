// Thin wrapper over the Box3D wasm shim (../wasm/shim.c). All numbers cross
// the boundary through HEAPF32: re-read it on every call, memory growth can
// swap the buffer underneath us.
import createBox3d from './box3d.js'

export const GRAVITY = 22 // original game's 2200 units/s² at 1 unit = 1 cm

export interface CarState {
  pos: [number, number, number]
  quat: [number, number, number, number]
  vel: [number, number, number]
  ang: [number, number, number]
  com: [number, number, number]
}

export interface RayHit {
  dist: number
  point: [number, number, number]
  normal: [number, number, number]
  material: number
}

export class Physics {
  private m: any
  private scratchPtr = 0
  /** the course is mirrored: conveyor floors run the other way along x (surfaces.ts) */
  mirrored = false
  /** the level's force fields (shared/fields.ts): every Car applies them in drive() */
  fields: import('../shared/fields').ForceFields | null = null
  private outPtr = 0

  static async load(wasmUrl = '/box3d.wasm'): Promise<Physics> {
    const m = await createBox3d({ locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p) })
    const p = new Physics()
    p.m = m
    p.scratchPtr = m._w_scratch() >> 2
    p.outPtr = m._w_out() >> 2
    m._w_init(0, -GRAVITY, 0)
    return p
  }

  private get heap(): Float32Array {
    return this.m.HEAPF32
  }

  private out(n: number): number[] {
    const h = this.heap
    return Array.from(h.subarray(this.outPtr, this.outPtr + n))
  }

  /** Triangles [x,y,z]*3 per tri, optional surface id per tri. Chunked (shim limit). */
  addMesh(tris: Float32Array, materials: Float32Array | null, friction = 0.6): void {
    const CHUNK = 40000
    const total = tris.length / 9
    for (let at = 0; at < total; at += CHUNK) {
      const n = Math.min(CHUNK, total - at)
      const h = this.heap
      h.set(tris.subarray(at * 9, (at + n) * 9), this.scratchPtr)
      if (materials) h.set(materials.subarray(at, at + n), this.scratchPtr + n * 9)
      this.m._w_add_mesh(n, friction, materials ? 1 : 0)
    }
  }

  step(dt: number, subSteps: number): void {
    this.m._w_step(dt, subSteps)
  }

  raycast(o: ArrayLike<number>, d: ArrayLike<number>, len: number): RayHit | null {
    this.m._w_raycast(o[0], o[1], o[2], d[0], d[1], d[2], len)
    const r = this.out(8)
    if (r[0] < 0) return null
    return { dist: r[0], point: [r[1], r[2], r[3]], normal: [r[4], r[5], r[6]], material: r[7] }
  }

  createCar(
    hull: number[][],
    mass: number,
    com: number[],
    inertia: number[],
    pos: number[],
    quat: number[],
    friction = 0.3,
    remote = false,
    tyres: number[][] = [], // [x, y, z, radius] body frame
  ): number {
    const h = this.heap
    hull.forEach((p, i) => h.set(p, this.scratchPtr + i * 3))
    tyres.forEach((t, i) => h.set(t, this.scratchPtr + hull.length * 3 + i * 4))
    return this.m._car_create(
      hull.length, mass, com[0], com[1], com[2], inertia[0], inertia[1], inertia[2],
      pos[0], pos[1], pos[2], quat[0], quat[1], quat[2], quat[3], friction, remote ? 1 : 0, tyres.length,
    )
  }

  /** A dynamic sphere (weapon ball); shares the car slots, so state/setVelocity/destroyCar work. */
  createBall(radius: number, mass: number, pos: ArrayLike<number>, vel: ArrayLike<number>, friction = 0.4, restitution = 0.3): number {
    return this.m._ball_create(radius, mass, pos[0], pos[1], pos[2], vel[0], vel[1], vel[2], friction, restitution)
  }

  /** A kinematic body of boxes ([cx, cy, cz, hx, hy, hz] body frame) that counts as track; move it with setPose/setVelocity. */
  createKinematic(boxes: number[][], pos: ArrayLike<number>, quat: ArrayLike<number>, friction = 0.5): number {
    const h = this.heap
    boxes.forEach((b, i) => h.set(b, this.scratchPtr + i * 6))
    return this.m._kin_create(boxes.length, pos[0], pos[1], pos[2], quat[0], quat[1], quat[2], quat[3], friction)
  }

  destroyCar(id: number): void {
    this.m._car_destroy(id)
  }

  impulseAt(id: number, i: ArrayLike<number>, p: ArrayLike<number>): void {
    this.m._car_impulse_at(id, i[0], i[1], i[2], p[0], p[1], p[2])
  }

  angularImpulse(id: number, i: ArrayLike<number>): void {
    this.m._car_angular_impulse(id, i[0], i[1], i[2])
  }

  pointVelocity(id: number, p: ArrayLike<number>): [number, number, number] {
    this.m._car_point_velocity(id, p[0], p[1], p[2])
    const r = this.out(3)
    return [r[0], r[1], r[2]]
  }

  state(id: number): CarState {
    this.m._car_state(id)
    const r = this.out(16)
    return {
      pos: [r[0], r[1], r[2]],
      quat: [r[3], r[4], r[5], r[6]],
      vel: [r[7], r[8], r[9]],
      ang: [r[10], r[11], r[12]],
      com: [r[13], r[14], r[15]],
    }
  }

  /** World inverse inertia, row-major 3x3. */
  invInertia(id: number): number[] {
    this.m._car_inv_inertia(id)
    return this.out(9)
  }

  setPose(id: number, p: ArrayLike<number>, q: ArrayLike<number>): void {
    this.m._car_set_pose(id, p[0], p[1], p[2], q[0], q[1], q[2], q[3])
  }

  setVelocity(id: number, v: ArrayLike<number>, w: ArrayLike<number>): void {
    this.m._car_set_velocity(id, v[0], v[1], v[2], w[0], w[1], w[2])
  }

  setDamping(id: number, linear: number, angular: number): void {
    this.m._car_set_damping(id, linear, angular)
  }
}
