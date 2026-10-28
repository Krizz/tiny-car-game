// Particle/sprite effects from original game's own FX pages (gfx/Fxpage1-3 -> /game/fx/fx*.png).
// Rects are in the pages' 256x256 pixels.
import * as THREE from 'three'

export type Rect = [page: 1 | 2 | 3, x: number, y: number, w: number, h: number]

export const SPR = {
  smoke: [1, 0, 0, 64, 64],
  fire: [1, 64, 0, 64, 64],
  flare: [1, 128, 0, 64, 64],
  electric: [1, 0, 64, 64, 64],
  bolt: [1, 64, 64, 64, 64],
  cloud: [1, 128, 64, 64, 64],
  glint: [1, 192, 64, 64, 64],
  ring: [1, 0, 128, 64, 64],
  boltRed: [1, 64, 128, 64, 64],
  boltGreen: [1, 128, 128, 64, 64],
  disc: [1, 192, 128, 64, 64],
  spark: [1, 128, 0, 64, 64],
  bigRing: [3, 0, 128, 128, 128],
  crosshair: [1, 32, 224, 32, 32],
  drop: [1, 192, 16, 16, 16], // a water drop (splashes)
} satisfies Record<string, Rect>

/** 16 explosion frames on page 3: two rows of eight 32x32. */
export const BOOM_FRAMES: Rect[] = Array.from({ length: 16 }, (_, i) => [3, (i % 8) * 32, 32 + Math.floor(i / 8) * 32, 32, 32])

const loader = new THREE.TextureLoader()
const pages: Partial<Record<1 | 2 | 3, THREE.Texture>> = {}
export async function loadFxPages() {
  await Promise.all(([1, 2, 3] as const).map(async (k) => {
    const t = await loader.loadAsync(`/game/fx/fx${k}.png`)
    t.colorSpace = THREE.NoColorSpace
    t.flipY = false
    pages[k] = t
  }))
}

export function pagesLoaded(): boolean {
  return !!(pages[1] && pages[2] && pages[3])
}

export function pageTexture(k: 1 | 2 | 3): THREE.Texture {
  return pages[k]!
}

function texFor(r: Rect): THREE.Texture {
  const base = pages[r[0]]!
  const t = base.clone()
  t.repeat.set(r[3] / 256, r[4] / 256)
  t.offset.set(r[1] / 256, r[2] / 256)
  t.needsUpdate = true
  return t
}

const rectCache = new Map<string, THREE.Texture>()
/** One sprite of an FX page as a texture (cached: one per rect). */
export function rectTexture(r: Rect): THREE.Texture {
  const key = r.join(',')
  let t = rectCache.get(key)
  if (!t) rectCache.set(key, (t = texFor(r)))
  return t
}

interface Particle {
  obj: THREE.Sprite | THREE.Mesh
  mat: THREE.SpriteMaterial | THREE.MeshBasicMaterial
  life: number
  age: number
  size0: number
  size1: number
  vel: THREE.Vector3
  gravity: number
  alpha: number
  spin: number
  frames?: Rect[]
  follow?: () => THREE.Vector3 | null
  offset?: THREE.Vector3
}

export interface SpriteOpts {
  size?: number
  sizeEnd?: number
  life?: number
  color?: THREE.ColorRepresentation
  additive?: boolean
  vel?: THREE.Vector3
  gravity?: number
  alpha?: number
  spin?: number
  frames?: Rect[]
  follow?: () => THREE.Vector3 | null // stick to a moving thing (offset kept)
}

export class Fx {
  private list: Particle[] = []
  constructor(private scene: THREE.Scene) {}

  /** A sprite and a ground decal as sprite()/decal() make them, for compiling their shaders at load
   *  (the first oil slick a CPU car dropped compiled one mid-race). Not added to the scene. */
  warmGroup(r: Rect): THREE.Group {
    const g = new THREE.Group()
    g.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: texFor(r), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })))
    g.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: texFor(r), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    })))
    return g
  }

  sprite(r: Rect, pos: THREE.Vector3, o: SpriteOpts = {}) {
    const mat = new THREE.SpriteMaterial({
      map: texFor(o.frames ? o.frames[0] : r),
      color: new THREE.Color(o.color ?? 0xffffff),
      transparent: true,
      depthWrite: false,
      blending: o.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
      fog: false,
      opacity: o.alpha ?? 1,
    })
    mat.rotation = Math.random() * Math.PI * 2
    const s = new THREE.Sprite(mat)
    s.position.copy(pos)
    const size = o.size ?? 0.5
    s.scale.setScalar(size)
    this.scene.add(s)
    const follow = o.follow
    this.list.push({
      obj: s, mat, life: o.life ?? 0.6, age: 0, size0: size, size1: o.sizeEnd ?? size, vel: o.vel ?? new THREE.Vector3(),
      gravity: o.gravity ?? 0, alpha: o.alpha ?? 1, spin: o.spin ?? 0, frames: o.frames, follow,
      offset: follow ? pos.clone().sub(follow() ?? pos) : undefined,
    })
    return s
  }

  /** A flat patch on the ground (oil). Returns a handle to remove it early. */
  decal(r: Rect, pos: THREE.Vector3, normal: THREE.Vector3, size: number, color: THREE.ColorRepresentation, life: number, alpha = 0.85) {
    const mat = new THREE.MeshBasicMaterial({
      map: texFor(r), color: new THREE.Color(color), transparent: true, depthWrite: false, opacity: alpha,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    })
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
    m.position.copy(pos).addScaledVector(normal, 0.01)
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
    m.scale.setScalar(size)
    this.scene.add(m)
    const p: Particle = { obj: m, mat, life, age: 0, size0: size, size1: size, vel: new THREE.Vector3(), gravity: 0, alpha, spin: 0 }
    this.list.push(p)
    return { remove: () => (p.age = p.life) }
  }

  update(dt: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]
      p.age += dt
      const k = Math.min(1, p.age / p.life)
      if (k >= 1) {
        p.obj.removeFromParent()
        p.mat.map?.dispose()
        p.mat.dispose()
        if (p.obj instanceof THREE.Mesh) p.obj.geometry.dispose()
        this.list.splice(i, 1)
        continue
      }
      if (p.follow) {
        const f = p.follow()
        if (f) p.obj.position.copy(f).add(p.offset!)
      } else {
        p.vel.y -= p.gravity * dt
        p.obj.position.addScaledVector(p.vel, dt)
      }
      if (p.obj instanceof THREE.Sprite) {
        p.obj.scale.setScalar(p.size0 + (p.size1 - p.size0) * k)
        ;(p.mat as THREE.SpriteMaterial).rotation += p.spin * dt
      }
      // fade over the last 60%
      p.mat.opacity = p.alpha * Math.min(1, (1 - k) / 0.6)
      if (p.frames) {
        const f = p.frames[Math.min(p.frames.length - 1, Math.floor(k * p.frames.length))]
        p.mat.map!.offset.set(f[1] / 256, f[2] / 256)
      }
    }
  }

  // ------------------------------------------------------------ recipes

  explosion(at: THREE.Vector3, scale = 1) {
    this.sprite(SPR.flare, at, { size: 1.2 * scale, sizeEnd: 2.6 * scale, life: 0.35, color: 0xffeeaa })
    for (let i = 0; i < 3; i++) {
      const p = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, Math.random() * 0.3, (Math.random() - 0.5) * 0.4).multiplyScalar(scale))
      this.sprite(BOOM_FRAMES[0], p, { frames: BOOM_FRAMES, size: 0.9 * scale, sizeEnd: 1.8 * scale, life: 0.7 + i * 0.1, additive: false, vel: new THREE.Vector3(0, 0.6, 0) })
    }
    for (let i = 0; i < 10; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(4 + Math.random() * 4)
      this.sprite(SPR.spark, at, { size: 0.12, life: 0.5 + Math.random() * 0.4, vel: v, gravity: 22, color: 0xffcc66 })
    }
    this.sprite(SPR.smoke, at.clone().add(new THREE.Vector3(0, 0.3, 0)), { size: 0.8 * scale, sizeEnd: 2.2 * scale, life: 1.4, additive: false, alpha: 0.5, vel: new THREE.Vector3(0, 0.8, 0), color: 0x555555 })
  }

  shockBlast(at: THREE.Vector3) {
    this.sprite(SPR.electric, at, { size: 1, sizeEnd: 3.5, life: 0.45, color: 0x99ccff, spin: 4 })
    this.sprite(SPR.ring, at, { size: 0.6, sizeEnd: 4.5, life: 0.5, color: 0x88bbff })
    this.sprite(SPR.flare, at, { size: 2, sizeEnd: 0.5, life: 0.3, color: 0xccddff })
  }

  splash(at: THREE.Vector3) {
    for (let i = 0; i < 14; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.3, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3)
      this.sprite(SPR.cloud, at, { size: 0.25, sizeEnd: 0.45, life: 0.6, vel: v, gravity: 22, color: 0x6fb6ff, alpha: 0.8 })
    }
    this.sprite(SPR.ring, at, { size: 0.3, sizeEnd: 2, life: 0.4, color: 0x9fd0ff })
  }

  zap(at: THREE.Vector3, follow?: () => THREE.Vector3 | null) {
    for (let i = 0; i < 3; i++) {
      const off = new THREE.Vector3((Math.random() - 0.5) * 0.5, Math.random() * 0.3, (Math.random() - 0.5) * 0.5)
      this.sprite(Math.random() < 0.5 ? SPR.bolt : SPR.boltRed, at.clone().add(off), { size: 0.45, sizeEnd: 0.6, life: 0.18, color: 0xaaccff, follow, spin: 8 })
    }
  }

  pulseRing(at: THREE.Vector3) {
    this.sprite(SPR.bigRing, at, { size: 1, sizeEnd: 9, life: 0.8, color: 0xffe0a0 })
    this.sprite(SPR.flare, at, { size: 3, sizeEnd: 1, life: 0.5, color: 0xffeecc })
  }
}
