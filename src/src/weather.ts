// Toytanic 2's storm, after original executable's Rain (type 63) and Lightning (type 64) objects:
// - rain: 500 grey (0x606060) streaks falling round the camera;
// - lightning: every 10-40 s a flash lasting 0.2-1.2 s that flickers (|sin| of 20.9 rad/s)
//   — in the game a white light 100 m up reaching 500 m, so everything flashes. Here the flash
//   lights the cars (`light`, src/carlight.ts) and the screen, and the level's thunder (an
//   "occasional" 3D sound in the original, out of step with the flashes) follows each one.
//   The flashes come from the server clock, so everyone sees the same ones.
import * as THREE from 'three'
import { T, type ObjectsInfo } from '../shared/objects'
import type { LevelLight } from './carlight'

const DROPS = 500
const RAIN_BOX = 26 // m across, round the camera
const RAIN_H = 16
const RAIN_SPEED = 15 // m/s
const STREAK = 0.55 // m
const SLOT_MS = 25000 // one flash in each slot, at a place in it drawn from the slot's number
const THUNDER_DELAY = [400, 1800]

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

export class Weather {
  readonly rain: boolean
  readonly lightning: boolean
  private lines: THREE.LineSegments | null = null
  private drops = new Float32Array(DROPS * 3)
  private flash: HTMLDivElement | null = null
  private thundered = -1
  /** The lightning's light while it flashes (for the cars), or null. */
  light: LevelLight | null = null

  constructor(info: ObjectsInfo, scene: THREE.Scene, private thunder: () => void) {
    const objs = info.objects ?? []
    this.rain = objs.some((o) => o.type === T.RAIN)
    this.lightning = objs.some((o) => o.type === T.LIGHTNING)
    if (this.rain) {
      for (let i = 0; i < DROPS; i++) {
        this.drops[i * 3] = (Math.random() - 0.5) * RAIN_BOX
        this.drops[i * 3 + 1] = Math.random() * RAIN_H
        this.drops[i * 3 + 2] = (Math.random() - 0.5) * RAIN_BOX
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DROPS * 6), 3))
      this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x8a8f98, transparent: true, opacity: 0.55, fog: false, depthWrite: false }))
      this.lines.frustumCulled = false
      scene.add(this.lines)
    }
    if (this.lightning) {
      this.flash = document.createElement('div')
      this.flash.className = 'lightning'
      document.body.insertBefore(this.flash, document.getElementById('hud')) // under the HUD
    }
  }

  update(ms: number, dt: number, eye: THREE.Vector3) {
    if (this.lines) {
      const pos = (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
      const half = RAIN_BOX / 2, slant = 0.12
      for (let i = 0; i < DROPS; i++) {
        let y = this.drops[i * 3 + 1] - RAIN_SPEED * dt
        if (y < 0) y += RAIN_H
        this.drops[i * 3 + 1] = y
        // the box moves with the camera: each drop wraps round it, so none pops in front of you
        const wx = eye.x + ((((this.drops[i * 3] - eye.x) % RAIN_BOX) + RAIN_BOX * 1.5) % RAIN_BOX) - half
        const wz = eye.z + ((((this.drops[i * 3 + 2] - eye.z) % RAIN_BOX) + RAIN_BOX * 1.5) % RAIN_BOX) - half
        const wy = eye.y - RAIN_H * 0.45 + y
        const j = i * 6
        pos[j] = wx; pos[j + 1] = wy; pos[j + 2] = wz
        pos[j + 3] = wx + slant * STREAK; pos[j + 4] = wy + STREAK; pos[j + 5] = wz
      }
      this.lines.geometry.getAttribute('position').needsUpdate = true
    }
    if (this.flash) {
      const slot = Math.floor(ms / SLOT_MS)
      const at = slot * SLOT_MS + hash(slot) * (SLOT_MS - 2000)
      const len = 200 + hash(slot + 0.5) * 1000
      const k = ms >= at && ms < at + len ? Math.abs(Math.sin(((ms - at) / 1000) * 20.944)) : 0
      this.flash.style.opacity = k ? String(0.12 + 0.38 * k) : '0'
      this.light = k ? { pos: [eye.x, eye.y + 100, eye.z], reach: 500, dir: [0, -1, 0], cone: 180, rgb: [1000 * k, 1000 * k, 1000 * k], flag: 2, type: 0 } : null
      const delay = THUNDER_DELAY[0] + hash(slot + 0.25) * (THUNDER_DELAY[1] - THUNDER_DELAY[0])
      if (this.thundered !== slot && ms >= at + delay && ms < at + delay + 3000) {
        this.thundered = slot
        this.thunder()
      }
    }
  }

  dispose() {
    this.flash?.remove()
  }
}
