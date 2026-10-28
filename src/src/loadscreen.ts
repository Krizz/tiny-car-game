// Loading screen: the blue picture (gfx/loadlevel1-4) in the game's
// rounded frame, the game's logo (gfx/loading.bmp), the race's details in the game's font — white
// names, cyan values — and a bar underneath with the file being loaded, filling as files come in.
// Laid out on the game's 640x480 screen, scaled to fit.
import * as THREE from 'three'
import { COL, artReady, box, text, textW } from './revhud'

const W = 640, H = 480
const img = (src: string) => Object.assign(new Image(), { src })
const BG = img('/game/hud/loading.png')
const LOGO = img('/game/hud/logo.png')

export class LoadScreen {
  readonly el = document.createElement('canvas')
  private g = this.el.getContext('2d')!
  private rows: [string, string][]
  private file = ''
  private started = 0
  private done = 0
  private restore: (() => void) | null = null

  constructor(rows: [string, string][]) {
    this.rows = rows
    this.el.className = 'loadscreen'
    document.body.appendChild(this.el)
    addEventListener('resize', this.draw)
    for (const i of [BG, LOGO]) i.decode().then(this.draw, () => {})
    artReady.then(this.draw)
    this.watch()
    this.draw()
  }

  /** Fill in a row (the track's length, the car's name) once it is known. */
  set(name: string, value: string) {
    const r = this.rows.find((x) => x[0] === name)
    if (r) r[1] = value
    this.draw()
  }

  /** Every file the page asks for while it loads — fetches and three.js's texture loads. */
  private watch() {
    const show = (url: string) => {
      try { this.file = new URL(url, location.href).pathname.replace(/^\//, '').replaceAll('/', '\\') } catch { /* keep the last */ }
    }
    const orig = window.fetch
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      this.started++
      show(url)
      this.draw()
      return orig(input, init).finally(() => { this.done++; this.draw() })
    }) as typeof fetch
    // textures load through three.js (image elements, not fetch): its manager sees each one
    const m = THREE.DefaultLoadingManager
    const { itemStart, itemEnd } = m
    m.itemStart = (url: string) => { this.started++; show(url); this.draw(); itemStart.call(m, url) }
    m.itemEnd = (url: string) => { this.done++; this.draw(); itemEnd.call(m, url) }
    this.restore = () => {
      window.fetch = orig
      m.itemStart = itemStart
      m.itemEnd = itemEnd
    }
  }

  remove() {
    this.restore?.()
    removeEventListener('resize', this.draw)
    this.el.remove()
  }

  private draw = () => {
    const k = Math.min(innerWidth / W, innerHeight / H) * (devicePixelRatio || 1)
    const cw = Math.round(W * k), ch = Math.round(H * k)
    if (this.el.width !== cw || this.el.height !== ch) {
      this.el.width = cw
      this.el.height = ch
      this.el.style.width = `${cw / (devicePixelRatio || 1)}px`
      this.el.style.height = `${ch / (devicePixelRatio || 1)}px`
    }
    const g = this.g
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, cw, ch)
    g.setTransform(k, 0, 0, k, 0, 0)
    g.imageSmoothingEnabled = true
    // the picture inside the big frame
    const fx = 40, fy = 6, fw = 560, fh = 384
    if (BG.complete && BG.naturalWidth) {
      g.save()
      g.beginPath()
      g.roundRect(fx + 3, fy + 3, fw - 6, fh - 6, 8)
      g.clip()
      g.drawImage(BG, fx, fy, fw, fh)
      g.restore()
    }
    box(g, fx, fy, fw, fh, false)
    if (LOGO.complete && LOGO.naturalWidth) g.drawImage(LOGO, (W - 356) / 2, 28, 356, 88)
    // the details: names right-aligned on the colon, values after it
    const colon = 316
    this.rows.forEach(([name, value], i) => {
      const y = 140 + i * 30
      text(g, name + ':', colon - textW(name + ':'), y, COL.white)
      if (value) text(g, value, colon + 14, y, COL.cyan)
    })
    // the bar: how many of the files asked for so far have come in, and the one asked for last
    const bx = 40, by = 400, bw = 560, bh = 40
    g.fillStyle = '#070b2c'
    g.beginPath()
    g.roundRect(bx + 3, by + 3, bw - 6, bh - 6, 6)
    g.fill()
    const f = this.started ? Math.min(1, this.done / this.started) : 0
    g.fillStyle = '#18249a'
    g.beginPath()
    g.roundRect(bx + 3, by + 3, (bw - 6) * f, bh - 6, 6)
    g.fill()
    box(g, bx, by, bw, bh, false)
    const name = this.file.length > 60 ? '…' + this.file.slice(-59) : this.file
    text(g, name, (W - textW(name)) / 2, by + (bh - 16) / 2, COL.white)
  }
}
