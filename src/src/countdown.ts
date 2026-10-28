// original game's start countdown: the game's own 3D numbers (models/go3, go2, go1, gogo — red, yellow
// rims, coloured per vertex) in front of the camera, drawn over the scene with their own camera.
// The original's exact moves aren't in the data: each one pops in with a quarter spin, GO flies at
// the camera and fades.
import * as THREE from 'three'

export type CountKey = '3' | '2' | '1' | 'go'
const MODEL: Record<CountKey, string> = { '3': 'go3', '2': 'go2', '1': 'go1', go: 'gogo' }
const HEIGHT = 1.75 // m tall, 6 m in front of a 40° camera: ~40% of the screen, as in the game
const DIST = 6
const MAX_W = 3.6 // m: GO! is wide — at the digits' height it spanned three quarters of the screen
const LIFT = 0.65 // above the middle of the screen: over the cars, as in the game
const POP = 0.28 // s to pop in
const GO_LIFE = 0.9 // s GO stays (flying at the camera, fading)

export class Countdown {
  private scene = new THREE.Scene()
  private cam = new THREE.PerspectiveCamera(40, 1, 0.1, 50)
  private models = new Map<CountKey, THREE.Object3D>()
  private key: CountKey | null = null
  private since = 0

  constructor(make: (name: string) => THREE.Object3D | null) {
    for (const k of Object.keys(MODEL) as CountKey[]) {
      const m = make(MODEL[k])
      if (!m) continue
      // own unlit materials: the vertex colours as they are (no fog, no ×1.6 level light), and fadeable
      m.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, fog: false })
      })
      // centred on its middle, HEIGHT tall
      const box = new THREE.Box3().setFromObject(m)
      const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3())
      const s = Math.min(HEIGHT / Math.max(0.001, size.y), MAX_W / Math.max(0.001, size.x))
      m.scale.setScalar(s)
      m.position.copy(mid).multiplyScalar(-s)
      const holder = new THREE.Group()
      holder.add(m)
      holder.visible = false
      this.scene.add(holder)
      this.models.set(k, holder)
    }
  }

  /** What to show now (null = nothing); a new key starts its animation. */
  show(key: CountKey | null) {
    if (key === this.key) return
    this.key = key
    this.since = performance.now()
    for (const [k, m] of this.models) m.visible = k === key
  }

  /** After the scene (and mirrors) are drawn. */
  render(renderer: THREE.WebGLRenderer) {
    if (!this.key) return
    const m = this.models.get(this.key)
    if (!m) return
    const t = (performance.now() - this.since) / 1000
    if (this.key === 'go' && t > GO_LIFE) return this.show(null)
    // pop: overshoot to 1.12 and settle, a quarter turn about the vertical unwinding
    const p = Math.min(1, t / POP)
    const ease = 1 - (1 - p) ** 3
    let scale = p < 1 ? ease * 1.12 : 1 + 0.12 * Math.max(0, 1 - (t - POP) / 0.15)
    let z = -DIST, alpha = 1
    m.rotation.y = (1 - ease) * Math.PI * 0.5
    if (this.key === 'go' && t > POP) {
      const f = (t - POP) / (GO_LIFE - POP) // flies at the camera and fades
      z = -DIST + f * f * (DIST - 1.5)
      scale *= 1 + f * 0.6
      alpha = 1 - f * f
    }
    m.position.set(0, LIFT * (-z / DIST), z)
    m.scale.setScalar(scale)
    m.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined
      if (mat) mat.opacity = alpha
    })
    const size = renderer.getSize(new THREE.Vector2())
    this.cam.aspect = size.x / Math.max(1, size.y)
    this.cam.updateProjectionMatrix()
    const auto = renderer.autoClear
    renderer.autoClear = false
    renderer.clearDepth()
    renderer.render(this.scene, this.cam)
    renderer.autoClear = auto
  }

  /** For compiling its shader at load. */
  get root(): THREE.Object3D {
    return this.scene
  }
}
