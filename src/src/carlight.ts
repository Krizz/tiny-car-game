// Cars lit by the level, as in original game: the .lit lights flagged for cars and objects (convert.py
// read_lights, flag 2) brighten — or, the negative ones, darken — a car as it passes them: under
// the ceiling spots, in Toy World 1's green corridor, beneath a table. Away from every light a
// car is drawn a little darker than its paint (AMBIENT), times the level's MODELRGBPER: original executable
// scales the cars' vertex colours by it on loading the level (50% on Toy World and Toytanic 2, 32% in
// the museums, 60% in the supermarkets) and the car lights add on top. Done per car by tinting its
// own materials. The lamps that move or blink (strobes, lanterns, ship lights, lightning:
// src/objects.ts, src/weather.ts) come in each frame as `extra`.
import * as THREE from 'three'
import { LIGHT_SCALE, type TrackInfo } from './assets'

export interface LevelLight {
  pos: number[]
  reach: number
  dir: number[]
  cone: number
  rgb: number[]
  flag: number
  type: number
}

const AMBIENT = 0.8
const WEIGHT = 0.6 // of a light's colour (0..255) at full strength
const MIN = 0.3, MAX = 1.5

/** What the level's lights add at p, 0..1 per channel of a 255 light (before AMBIENT/WEIGHT). */
export function lightAt(lights: LevelLight[], p: THREE.Vector3): [number, number, number] {
  let r = 0, g = 0, b = 0
  for (const L of lights) {
    const dx = p.x - L.pos[0], dy = p.y - L.pos[1], dz = p.z - L.pos[2]
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 >= L.reach * L.reach) continue
    const d = Math.sqrt(d2) || 1e-6
    let k = 1 - d / L.reach
    if (L.type === 2 || L.type === 3) {
      const c = (L.dir[0] * dx + L.dir[1] * dy + L.dir[2] * dz) / d
      const ang = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI
      if (ang >= L.cone) continue
      k *= 1 - ang / L.cone
    }
    if (L.type === 1 || L.type === 3) k *= 0.7 // the side facing it (a car has faces all round)
    r += (L.rgb[0] / 255) * k
    g += (L.rgb[1] / 255) * k
    b += (L.rgb[2] / 255) * k
  }
  return [r, g, b]
}

export class CarLighting {
  private lights: LevelLight[]
  private p = new THREE.Vector3()
  private base: number

  constructor(info: TrackInfo) {
    this.lights = (info as any).lights ?? []
    this.base = AMBIENT * ((info as any).modelRgbPer ?? 1)
  }

  /** Tint each car's materials for where it is now (eased, so passing a light isn't a flash). */
  update(roots: THREE.Object3D[], dt: number, extra: LevelLight[] = []) {
    const lights = extra.length ? this.lights.concat(extra) : this.lights
    for (const root of roots) {
      root.getWorldPosition(this.p)
      this.p.y += 0.3
      const [r, g, b] = lights.length ? lightAt(lights, this.p) : [0, 0, 0]
      const want = [r, g, b].map((v) => Math.max(MIN, Math.min(MAX, this.base + v * WEIGHT)))
      const k = Math.min(1, dt * 6)
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material
        if (!m) return
        for (const mat of Array.isArray(m) ? m : [m]) {
          if (mat.userData.shared || mat.userData.putty || !(mat as THREE.MeshBasicMaterial).color) continue
          const cur = (mat.userData.lit ??= [1, 1, 1]) as number[]
          for (let i = 0; i < 3; i++) cur[i] += (want[i] - cur[i]) * k
          ;(mat as THREE.MeshBasicMaterial).color.setRGB(LIGHT_SCALE * cur[0], LIGHT_SCALE * cur[1], LIGHT_SCALE * cur[2])
        }
      })
    }
  }
}
