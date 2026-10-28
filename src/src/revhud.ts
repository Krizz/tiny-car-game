// original game's own HUD art, drawn on small canvases: the 8x16 font (gfx/Font.bmp, tinted by
// multiplying like the game's vertex colours), the blue rounded box (gfx/spru.bmp) and the
// speedometer balls (gfx/Fxpage2). Sizes are in font pixels, laid out after screenshots of the
// game at 640x480; `unit()` turns them into CSS pixels.

const img = (src: string) => Object.assign(new Image(), { src })
const FONT = img('/game/hud/font.png')
const FRAME = img('/game/hud/frame.png')
const FX2 = img('/game/fx/fx2.png')
// FX page 2 may be an AI upscale (e.g. 1024²) of the 256² original (convert/hd/); every source rect below is
// in the original's pixels, scaled by this
const k2 = () => (FX2.naturalWidth || 256) / 256
const ART = [FONT, FRAME, FX2]
export const artReady = Promise.all(ART.map((i) => i.decode().catch(() => {})))
const loaded = () => ART.every((i) => i.complete && i.naturalWidth)

export const COL = { white: '#ffffff', cyan: '#5ee0e0', green: '#64f046', red: '#ff4a36', grey: '#9aa3ad' }

/** CSS px per font px: 1 at 480 px tall, like the game at 640x480. */
export const unit = () => Math.max(1, Math.min(2.5, innerHeight / 480))

const tints = new Map<string, HTMLCanvasElement>()
function tinted(col: string): HTMLCanvasElement | null {
  let c = tints.get(col)
  if (c) return c
  // not before the font has loaded: a copy made from the empty image was cached for good (the
  // loading screen, drawn at once, got solid cyan blocks and no white text)
  if (!(FONT.complete && FONT.naturalWidth)) return null
  c = document.createElement('canvas')
  // (an upscale of the 256² font page, if there is one: cells are cut at the page's own scale, kf)
  c.width = c.height = FONT.naturalWidth
  const g = c.getContext('2d')!
  g.drawImage(FONT, 0, 0)
  if (col !== COL.white) {
    g.globalCompositeOperation = 'multiply'
    g.fillStyle = col
    g.fillRect(0, 0, c.width, c.height)
    g.globalCompositeOperation = 'destination-in'
    g.drawImage(FONT, 0, 0)
  }
  tints.set(col, c)
  return c
}

export const textW = (s: string, size = 1) => s.length * 8 * size

/** One line of the small font; (x, y) = top-left of the 8x16 cells. */
export function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, col: string, size = 1) {
  const t = tinted(col)
  if (!t) return
  const kf = t.width / 256
  for (const ch of s) {
    const i = ch.charCodeAt(0) - 33
    if (i >= 0 && i < 95) g.drawImage(t, (i % 32) * 8 * kf, (i >> 5) * 16 * kf, 8 * kf, 16 * kf, x, y, 8 * size, 16 * size)
    x += 8 * size
  }
}

/** The blue rounded box as a 9-slice: 16 px source corners drawn at 8, over a dark glass fill (`fill`). */
export function box(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill = true) {
  if (fill) {
    g.fillStyle = 'rgba(0,0,0,.66)'
    g.beginPath()
    g.roundRect(x + 2, y + 2, w - 4, h - 4, 6)
    g.fill()
  }
  const s = 16, d = 8, m = 64 - 2 * s
  const xs = [[0, x, d], [s, x + d, w - 2 * d], [64 - s, x + w - d, d]] as const
  const ys = [[0, y, d], [s, y + d, h - 2 * d], [64 - s, y + h - d, d]] as const
  for (const [sx, dx, dw] of xs)
    for (const [sy, dy, dh] of ys) {
      if (sx === s && sy === s) continue
      g.drawImage(FRAME, sx, sy, sx === s ? m : s, sy === s ? m : s, dx, dy, dw, dh)
    }
}

/** original game's weapon panel: FX page 2's dark red frame with the grey corner marks (64x61 at 190,157)
 *  and the weapon's 32 px icon in it (cell [column, row] from y 192). */
export function weaponFrame(g: CanvasRenderingContext2D, icon: [number, number] | null, x: number, y: number) {
  const k = k2()
  g.drawImage(FX2, 190 * k, 157 * k, 64 * k, 61 * k, x, y, 64, 61)
  if (icon) g.drawImage(FX2, icon[0] * 32 * k, (192 + icon[1] * 32) * k, 32 * k, 32 * k, x + 16, y + 14, 32, 32)
}

// speedometer balls on FX page 2, green (big) .. red (small): centre x, size; unlit row y 137.5, lit 161
const BALL_X = [10.5, 33, 56.5, 80, 103.5, 126, 149.5]
const BALL_S = [22, 21, 18, 17, 16, 15, 14]
// on screen, red (bottom left) .. green (top right), relative to the green ball's centre
const ARC = [[-121, 49], [-110, 34], [-94, 21], [-73, 11], [-50, 4], [-26, 0], [0, 0]]

export function ball(g: CanvasRenderingContext2D, slot: number, lit: boolean, cx: number, cy: number) {
  const i = 6 - slot
  const s = BALL_S[i] + 4
  const sy = lit ? 161 : 137.5
  const k = k2()
  g.drawImage(FX2, (BALL_X[i] - s / 2) * k, (sy - s / 2) * k, s * k, s * k, cx + ARC[slot][0] - s / 2, cy + ARC[slot][1] - s / 2, s, s)
}

// direction signs on FX page 2 (64 px cells; every turn is drawn to the right): the level's sign
// number -> [cell x, cell y, mirrored]. 0-3 chicane / U-turn / sharp / bend left, 4-7 right,
// 8 straight on, 9 danger, 10 fork, 11 cross.
const SIGN_CELLS: [number, number, boolean][] = [
  [64, 0, true], [0, 0, true], [64, 64, true], [192, 0, true],
  [64, 0, false], [0, 0, false], [64, 64, false], [192, 0, false],
  [0, 64, false], [128, 0, false], [192, 64, false], [128, 64, false],
]

export function arrow(g: CanvasRenderingContext2D, sign: number, x: number, y: number, size: number) {
  const c = SIGN_CELLS[sign]
  if (!c) return
  g.save()
  if (c[2]) {
    g.translate(x * 2 + size, 0)
    g.scale(-1, 1)
  }
  const k = k2()
  g.drawImage(FX2, c[0] * k, c[1] * k, 64 * k, 64 * k, x, y, size, size)
  g.restore()
}

/** A canvas in the HUD sized in font px; redraws only when its key changes (or the art arrives). */
export class Pad {
  readonly el = document.createElement('canvas')
  private g = this.el.getContext('2d')!
  private key = ''
  constructor(cls: string, private w: number, private h: number) {
    this.el.className = cls
    artReady.then(() => (this.key = ''))
  }
  draw(key: string, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void, h = this.h) {
    if (!loaded()) return
    const u = unit(), dpr = devicePixelRatio || 1
    key += `|${u}|${dpr}|${h}`
    if (key === this.key) return
    this.key = key
    const W = Math.round(this.w * u * dpr), H = Math.round(h * u * dpr)
    if (this.el.width !== W || this.el.height !== H) {
      this.el.width = W
      this.el.height = H
      this.el.style.width = `${W / dpr}px`
      this.el.style.height = `${H / dpr}px`
    }
    const g = this.g
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, W, H)
    g.setTransform(u * dpr, 0, 0, u * dpr, 0, 0)
    g.imageSmoothingEnabled = true
    paint(g, this.w, h)
  }
}

/** original game's lap clock: MM:SS:mmm. */
export function clock(ms: number | null | undefined) {
  if (ms == null || !isFinite(ms)) return '--:--:---'
  ms = Math.max(0, Math.floor(ms))
  const p = (n: number, k = 2) => String(n).padStart(k, '0')
  return `${p(Math.min(99, Math.floor(ms / 60000)))}:${p(Math.floor(ms / 1000) % 60)}:${p(ms % 1000, 3)}`
}

export const ARC_W = 121 + 14, ARC_DROP = 49

// ------------------------------------------------------------ the game's font in the DOM (lobby, vote)

interface FontLine { el: HTMLCanvasElement; text: string; col: string; size: number; wrap: number; born: number }
const fontLines = new Set<FontLine>()
// (lines taken off the page are forgotten here — a list repainted with new ones would pile up)
const repaintAll = () => fontLines.forEach((f) => {
  if (!f.el.isConnected && performance.now() - f.born > 2000) fontLines.delete(f)
  else paintLine(f)
})
artReady.then(repaintAll)
addEventListener('resize', repaintAll)

function lines(text: string, wrap: number): string[] {
  if (!wrap) return text.split('\n')
  const out: string[] = []
  for (const para of text.split('\n')) {
    let cur = ''
    for (const w of para.split(' ')) {
      if (cur && (cur + ' ' + w).length > wrap) {
        out.push(cur)
        cur = w
      } else cur = cur ? cur + ' ' + w : w
    }
    out.push(cur)
  }
  return out
}

/** CSS px per font px for the lobby and vote panels (smaller than the race HUD's on big screens). */
export const uiUnit = () => Math.max(1, Math.min(1.6, innerHeight / 560, innerWidth / 420))

function paintLine(f: FontLine) {
  const u = uiUnit(), dpr = devicePixelRatio || 1
  const ls = lines(f.text, f.wrap)
  const cols = Math.max(1, ...ls.map((l) => l.length))
  const W = Math.round(cols * 8 * f.size * u * dpr), H = Math.round(ls.length * 16 * f.size * u * dpr)
  f.el.width = Math.max(1, W)
  f.el.height = Math.max(1, H)
  f.el.style.width = `${W / dpr}px`
  f.el.style.height = `${H / dpr}px`
  const g = f.el.getContext('2d')!
  g.setTransform(u * dpr, 0, 0, u * dpr, 0, 0)
  g.imageSmoothingEnabled = true
  ls.forEach((l, i) => text(g, l, 0, i * 16 * f.size, f.col, f.size))
}

/** A canvas with one (or, wrapped at `wrap` characters, several) lines in the game's font, at the
 *  HUD's scale; repainted when the font arrives and on resize. setFont() changes it. */
export function fontEl(s: string, col: string = COL.white, size = 1, wrap = 0, cls = ''): HTMLCanvasElement {
  if (fontLines.size > 300) repaintAll() // (forgets the ones no longer on the page)
  const el = document.createElement('canvas')
  el.className = 'ft' + (cls ? ' ' + cls : '')
  const f: FontLine = { el, text: s, col, size, wrap, born: performance.now() }
  ;(el as any).__ft = f
  fontLines.add(f)
  paintLine(f)
  return el
}

export function setFont(el: HTMLCanvasElement, s: string, col?: string) {
  const f = (el as any).__ft as FontLine | undefined
  if (!f || (f.text === s && (!col || col === f.col))) return
  f.text = s
  if (col) f.col = col
  paintLine(f)
}
