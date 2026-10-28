// Players' names over their cars ("player names over the cars in multiplayer —
// only for human players, original game font"): a sprite a little above each other person's car with the
// name in the game's 8x16 font (revhud), cyan as on the results board, on a faint dark plate. A
// constant size on screen, fading out with distance; walls hide it (depth tested).
import * as THREE from 'three'
import { COL, artReady, text, textW } from './revhud'

const LIFT = 0.55 // m above the car's origin
const SCREEN_H = 0.032 // of the view's height
const FAR = 70 // m: gone by here
const SCALE = 3 // canvas px per font px

interface Tag { name: string; sprite: THREE.Sprite; tex: THREE.CanvasTexture; aspect: number }

export class NameTags {
  private tags = new Map<number, Tag>()
  private ready = false

  constructor(private scene: THREE.Scene) {
    artReady.then(() => {
      this.ready = true
      for (const t of this.tags.values()) this.paint(t)
    })
  }

  private paint(t: Tag) {
    const c = t.tex.image as HTMLCanvasElement
    const w = textW(t.name) + 8, h = 20
    c.width = w * SCALE
    c.height = h * SCALE
    const g = c.getContext('2d')!
    g.clearRect(0, 0, c.width, c.height)
    g.fillStyle = 'rgba(0,0,0,.45)'
    g.beginPath()
    g.roundRect(0, 0, c.width, c.height, 5 * SCALE)
    g.fill()
    g.setTransform(SCALE, 0, 0, SCALE, 0, 0)
    g.imageSmoothingEnabled = true // the font page is a 1024² upscale: smooth, not blocky
    text(g, t.name, 4, 2, COL.cyan)
    t.aspect = w / h
    t.tex.needsUpdate = true
  }

  /** Each frame: the cars of the other people (id -> car root position, name), the camera. */
  update(cars: { id: number; pos: THREE.Vector3; name: string }[], camera: THREE.PerspectiveCamera) {
    const seen = new Set<number>()
    for (const c of cars) {
      seen.add(c.id)
      let t = this.tags.get(c.id)
      if (!t || t.name !== c.name) {
        if (t) this.drop(c.id)
        const tex = new THREE.CanvasTexture(document.createElement('canvas'))
        tex.colorSpace = THREE.NoColorSpace // as every texture here: no conversions
        tex.minFilter = THREE.LinearFilter
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false, fog: false }))
        sprite.renderOrder = 6
        this.scene.add(sprite)
        t = { name: c.name, sprite, tex, aspect: 4 }
        this.tags.set(c.id, t)
        if (this.ready) this.paint(t)
      }
      const d = c.pos.distanceTo(camera.position)
      t.sprite.visible = d < FAR
      if (!t.sprite.visible) continue
      t.sprite.position.copy(c.pos).add(new THREE.Vector3(0, LIFT, 0))
      // sizeAttenuation off: scale is in clip units — keep it SCREEN_H of the view's height
      const k = SCREEN_H * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      t.sprite.scale.set(k * t.aspect, k, 1)
      ;(t.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, (FAR - d) / 15)
    }
    for (const id of [...this.tags.keys()]) if (!seen.has(id)) this.drop(id)
  }

  private drop(id: number) {
    const t = this.tags.get(id)
    if (!t) return
    this.scene.remove(t.sprite)
    t.tex.dispose()
    ;(t.sprite.material as THREE.SpriteMaterial).dispose()
    this.tags.delete(id)
  }
}
