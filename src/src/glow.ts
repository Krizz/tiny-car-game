// Light glows as original game draws them over its lamps (original executable's strobe, lantern and ship light
// render functions): FX page 1's flare in the light's colour, additive, and for the strobes two
// glints turning against each other over it. Drawn a little towards the camera so the lamp's own
// glass doesn't hide them (the game draws them with a depth bias).
import * as THREE from 'three'
import { SPR, pagesLoaded, rectTexture } from './fx'


export class Glow {
  readonly root = new THREE.Group()
  private flare: THREE.Sprite
  private glints: THREE.Sprite[] = []
  private at = new THREE.Vector3()

  /** pull: m towards the camera (out of the lamp's glass: a lantern's box is 62 cm across) */
  constructor(color: THREE.ColorRepresentation, glints = false, private pull = 0.35) {
    // (the FX pages may still be loading: the textures are put on at the first set() after)
    const mat = (r: typeof SPR.flare) => new THREE.SpriteMaterial({
      map: pagesLoaded() ? rectTexture(r) : null, color: new THREE.Color(color), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    })
    this.flare = new THREE.Sprite(mat(SPR.flare))
    this.root.add(this.flare)
    if (glints) for (let i = 0; i < 2; i++) {
      const g = new THREE.Sprite(mat(SPR.glint))
      this.glints.push(g)
      this.root.add(g)
    }
    this.root.renderOrder = 5
  }

  /** At p (world), `size` m across, brightness 0..1 (0 hides it); t in s turns the glints. */
  set(p: THREE.Vector3, size: number, k: number, eye: THREE.Vector3, t = 0) {
    const fm = this.flare.material as THREE.SpriteMaterial
    if (!fm.map) {
      if (!pagesLoaded()) return void (this.root.visible = false)
      fm.map = rectTexture(SPR.flare)
      fm.needsUpdate = true
      for (const g of this.glints) {
        ;(g.material as THREE.SpriteMaterial).map = rectTexture(SPR.glint)
        ;(g.material as THREE.SpriteMaterial).needsUpdate = true
      }
    }
    this.root.visible = k > 0.01
    if (!this.root.visible) return
    this.at.copy(eye).sub(p)
    const d = this.at.length()
    this.root.position.copy(p).addScaledVector(this.at, d > 1e-3 ? Math.min(this.pull, d * 0.5) / d : 0)
    this.flare.scale.setScalar(size)
    ;(this.flare.material as THREE.SpriteMaterial).opacity = k
    this.glints.forEach((g, i) => {
      g.scale.setScalar(size * 1.3)
      const m = g.material as THREE.SpriteMaterial
      m.rotation = (i ? -2 : 1) * t * 0.2 + i
      m.opacity = k * 0.8
    })
  }

  setColor(c: THREE.Color) {
    ;(this.flare.material as THREE.SpriteMaterial).color.copy(c)
    for (const g of this.glints) (g.material as THREE.SpriteMaterial).color.copy(c)
  }
}
