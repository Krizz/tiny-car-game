// Reflective floors, as in original game: the level's .rim rectangles (Toy World's polished boards, the
// supermarket and museum tiles...) show the cars upside down beneath them, fading as a car gets
// higher off the floor (the .inf's MIRRORS strength and distance).
//
// Done with the stencil buffer, after the normal render: invisible quads over the mirror floors mark
// the pixels where that floor is what you see (stencil 1; a car or wall in front hides it), then each
// car is drawn again flipped about the floor's plane, translucent, only into those pixels. The
// world itself is not reflected (nor was it in the game).
import * as THREE from 'three'
import type { TrackInfo } from './assets'
import type { Physics } from './physics'

const LIFT = 0.003

interface Saved { transparent: boolean; opacity: number; alphaTest: number; stencilWrite: boolean; stencilFunc: THREE.StencilFunc; stencilRef: number; depthWrite: boolean }

export class Mirrors {
  private planes: { y: number; x: number[]; z: number[] }[]
  private strength: number
  private fade: number
  private m = new THREE.Matrix4()
  private flip = new THREE.Matrix4()
  private p = new THREE.Vector3()

  private cam = new THREE.Vector3()
  // reflections are drawn outside the scene (no fog) and translucent: other shader variants than
  // the normal pass, compiled the first time a car reached a mirror floor — a stutter on entering
  // the museum's tiles. Compiled in the background as soon as an object is shown instead.
  private fogless = new THREE.Scene()
  private warmed = new WeakSet<THREE.Object3D>()

  constructor(info: TrackInfo, scene: THREE.Scene, private physics: Physics) {
    const mi = info.mirrors
    this.planes = mi?.planes ?? []
    this.strength = mi?.strength ?? 0
    this.fade = mi?.fade || 2.56
    if (!this.planes.length || this.strength <= 0) return
    const pos: number[] = []
    for (const p of this.planes) {
      const y = p.y + LIFT
      const [x0, x1] = p.x, [z0, z1] = p.z
      pos.push(x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const mark = new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    })
    const quads = new THREE.Mesh(g, mark)
    quads.renderOrder = 100
    quads.frustumCulled = false
    scene.add(quads)
  }

  private planeUnder(p: THREE.Vector3) {
    let best: { y: number } | null = null
    for (const q of this.planes) {
      if (p.x < q.x[0] || p.x > q.x[1] || p.z < q.z[0] || p.z > q.z[1] || p.y < q.y - 0.3) continue
      if (!best || q.y > best.y) best = q
    }
    return best
  }

  private warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera, o: THREE.Object3D) {
    this.warmed.add(o)
    const mats: THREE.Material[] = []
    o.traverse((c) => {
      const mm = (c as THREE.Mesh).material
      if (mm) for (const mat of Array.isArray(mm) ? mm : [mm]) if (!mat.transparent) mats.push(mat)
    })
    for (const mat of mats) mat.transparent = true // as render() draws them (no OPAQUE define)
    renderer.compileAsync(o, camera, this.fogless).catch(() => {})
    for (const mat of mats) mat.transparent = false
  }

  /** Call right after renderer.render(scene, camera), with the objects that show in mirrors. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, objects: THREE.Object3D[]) {
    if (!this.planes.length || this.strength <= 0) return
    for (const o of objects) if (o.visible && !this.warmed.has(o)) this.warm(renderer, camera, o)
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    let cleared = false
    for (const o of objects) {
      if (!o.visible) continue
      o.getWorldPosition(this.p)
      const plane = this.planeUnder(this.p)
      if (!plane) continue
      // reflections are drawn with the depth cleared, so nothing between hides them: only what
      // the camera can see itself (blocks in the next room showed in this room's floor)
      camera.getWorldPosition(this.cam)
      const to = this.p.clone().add(new THREE.Vector3(0, 0.3, 0)).sub(this.cam)
      const dist = to.length()
      if (dist > 60) continue
      const hit = this.physics.raycast(this.cam.toArray(), to.divideScalar(dist).toArray(), dist)
      if (hit && hit.dist < dist - 0.8) continue
      const k = this.strength * Math.max(0, Math.min(1, 1 - (this.p.y - plane.y) / this.fade))
      if (k < 0.02) continue
      if (!cleared) {
        renderer.clearDepth() // the reflections sit under the floor: only the stencil decides
        cleared = true
      }
      // y -> 2h - y about the floor's plane
      this.flip.makeScale(1, -1, 1).setPosition(0, 2 * plane.y, 0)
      const auto = o.matrixAutoUpdate
      o.updateMatrix()
      const saved = o.matrix.clone()
      o.matrix.copy(this.m.multiplyMatrices(this.flip, saved))
      o.matrixAutoUpdate = false
      o.matrixWorldNeedsUpdate = true
      const mats = new Map<THREE.Material, Saved>()
      o.traverse((c) => {
        const mm = (c as THREE.Mesh).material
        if (!mm) return
        for (const mat of Array.isArray(mm) ? mm : [mm]) {
          if (mats.has(mat)) continue
          mats.set(mat, {
            transparent: mat.transparent, opacity: mat.opacity, alphaTest: mat.alphaTest, stencilWrite: mat.stencilWrite,
            stencilFunc: mat.stencilFunc, stencilRef: mat.stencilRef, depthWrite: mat.depthWrite,
          })
          mat.transparent = true
          mat.opacity *= k
          // the colour key's cut-off scales with it: at the museum's 0.3 every pixel of a car's
          // paint fell under alphaTest 0.5 and only the (untextured) aerial was left in the floor
          mat.alphaTest *= k
          mat.stencilWrite = true
          mat.stencilFunc = THREE.EqualStencilFunc
          mat.stencilRef = 1
        }
      })
      renderer.render(o, camera)
      for (const [mat, s] of mats) Object.assign(mat, s)
      o.matrix.copy(saved)
      o.matrixAutoUpdate = auto
      o.matrixWorldNeedsUpdate = true
      o.updateMatrixWorld(true)
    }
    renderer.autoClear = autoClear
  }
}
