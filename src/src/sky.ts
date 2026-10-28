// The level's skybox (Toys in the Hood 1, both Toytanics: levels\<name>\sky_*.bmp, as original executable loads
// them): a cube round the camera, drawn first, no fog, no depth. original game's axes: ft = forward (+z,
// ours -z), rt = right (+x), tp = up. Mirrored courses draw it flipped like the rest of the level.
import * as THREE from 'three'

export type SkyFaces = Record<'ft' | 'bk' | 'lt' | 'rt' | 'tp' | 'bt', string>

export class Sky {
  readonly root: THREE.Mesh

  constructor(base: string, faces: SkyFaces, size: number, mirror: boolean) {
    const loader = new THREE.TextureLoader()
    const tex = (f: string) => {
      const t = loader.load(base + f)
      t.colorSpace = THREE.NoColorSpace // no conversions anywhere, as the level's own textures
      // a box's faces are seen from inside here, which reads them back to front: flip them across
      t.wrapS = THREE.RepeatWrapping
      t.repeat.x = -1
      return t
    }
    // BoxGeometry's faces: +x, -x, +y, -y, +z, -z
    const order = [faces.rt, faces.lt, faces.tp, faces.bt, faces.bk, faces.ft]
    const mats = order.map((f, i) => {
      const map = tex(f)
      // top and bottom turned round: measured — the colour jump across their edges (Hood 1's top,
      // Toytanic 1's bottom) was smallest of the 8 ways round by far (17 vs 35+, 22 vs 29+)
      if (i === 2 || i === 3) {
        map.center.set(0.5, 0.5)
        map.rotation = Math.PI
      }
      return new THREE.MeshBasicMaterial({ map, side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false })
    })
    this.root = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mats)
    this.root.renderOrder = -1000
    this.root.frustumCulled = false
    // a mirrored course is drawn flipped in x: so is its sky
    if (mirror) this.root.scale.x = -1
  }

  /** Keep it centred on the camera. */
  update(camera: THREE.Camera) {
    this.root.position.copy(camera.position)
  }
}
