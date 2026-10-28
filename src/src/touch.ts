// Touch controls for phones and tablets: two steering buttons under the left thumb, pedals
// and buttons under the right thumb (no handbrake or flip button — a car on its roof is
// flipped back by itself on a touch screen, main.ts). They show on touch screens only (a coarse pointer, the
// first touch, or ?touch=1) and read into input.ts like a gamepad.
//
// The lobby's panels lie over the left half on a phone, so in the lobby a button at the top
// folds them away to free-drive (and back), next to one for full screen where the browser has it.

// Steering = two buttons, read like the arrow keys (input.ts ramps them in over ~0.15 s, the way the
// cars and the CPU drivers are tuned). A slide-to-steer stick came first and was dropped (
// "turning on mobile is very difficult and kinda feels loose" — the stick's centre is wherever the
// thumb landed, so there was nothing to steer against). The whole left half answers: left of the
// gap between the two buttons steers left, right of it right, and a thumb rocking across switches.

export interface TouchRead {
  left: boolean
  right: boolean
  gas: number
  brake: number
  fire: boolean
  reset: boolean
}

type Btn = 'gas' | 'brake' | 'fire' | 'reset'

export class TouchControls {
  readonly el = document.createElement('div')
  active = false
  private steering = new Map<number, -1 | 1>() // pointer -> side (-1 left, 1 right)
  private held = new Map<Btn, Set<number>>()
  private taps = new Set<Btn>()
  private leftEl: HTMLElement
  private rightEl: HTMLElement
  private fireIcon: HTMLElement
  private menuBtn: HTMLButtonElement
  private fullBtn: HTMLButtonElement
  onPanels: (shown: boolean) => void = () => {}
  private panels = true

  constructor(private hud: HTMLElement, force = false) {
    this.el.className = 'touch'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="t-steer"><div class="t-arrow t-left">◀</div><div class="t-arrow t-right">▶</div></div>
      <div class="t-top"><button class="t-menu">Hide lobby</button><button class="t-full">Full screen</button></div>
      <button class="t-btn t-gas" data-b="gas"><span>▲</span>GAS</button>
      <button class="t-btn t-brake" data-b="brake"><span>▼</span>BRAKE</button>
      <button class="t-btn t-fire" data-b="fire"><i></i>FIRE</button>
      <button class="t-btn t-small t-reset" data-b="reset">RESET</button>`
    hud.prepend(this.el) // under the panels: a touch on a panel is the panel's
    this.leftEl = this.el.querySelector('.t-left')!
    this.rightEl = this.el.querySelector('.t-right')!
    this.fireIcon = this.el.querySelector('.t-fire i')!
    this.menuBtn = this.el.querySelector('.t-menu')!
    this.fullBtn = this.el.querySelector('.t-full')!

    const zone = this.el.querySelector<HTMLElement>('.t-steer')!
    const side = (x: number): -1 | 1 => {
      const l = this.leftEl.getBoundingClientRect(), r = this.rightEl.getBoundingClientRect()
      return x < (l.right + r.left) / 2 ? -1 : 1
    }
    const paint = () => {
      const v = [...this.steering.values()]
      this.leftEl.classList.toggle('down', v.includes(-1))
      this.rightEl.classList.toggle('down', v.includes(1))
    }
    zone.addEventListener('pointerdown', (e) => {
      zone.setPointerCapture(e.pointerId)
      this.steering.set(e.pointerId, side(e.clientX))
      paint()
      navigator.vibrate?.(8)
      e.preventDefault()
    })
    zone.addEventListener('pointermove', (e) => {
      if (!this.steering.has(e.pointerId)) return
      const s = side(e.clientX)
      if (s !== this.steering.get(e.pointerId)) {
        this.steering.set(e.pointerId, s)
        paint()
      }
    })
    const endSteer = (e: PointerEvent) => {
      this.steering.delete(e.pointerId)
      paint()
    }
    zone.addEventListener('pointerup', endSteer)
    zone.addEventListener('pointercancel', endSteer)

    for (const b of this.el.querySelectorAll<HTMLElement>('.t-btn')) {
      const name = b.dataset.b as Btn
      const set = new Set<number>()
      this.held.set(name, set)
      b.addEventListener('pointerdown', (e) => {
        b.setPointerCapture(e.pointerId)
        if (!set.size) this.taps.add(name)
        set.add(e.pointerId)
        b.classList.add('down')
        navigator.vibrate?.(8)
        e.preventDefault()
      })
      const up = (e: PointerEvent) => {
        set.delete(e.pointerId)
        if (!set.size) b.classList.remove('down')
      }
      b.addEventListener('pointerup', up)
      b.addEventListener('pointercancel', up)
      b.addEventListener('contextmenu', (e) => e.preventDefault())
    }

    this.menuBtn.addEventListener('click', () => {
      this.panels = !this.panels
      this.hud.classList.toggle('panels-off', !this.panels)
      this.menuBtn.textContent = this.panels ? 'Hide lobby' : 'Show lobby'
      this.onPanels(this.panels)
    })
    const fs = document.documentElement
    if (!fs.requestFullscreen) this.fullBtn.hidden = true
    this.fullBtn.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else {
          await fs.requestFullscreen({ navigationUI: 'hide' })
          await (screen.orientation as any)?.lock?.('landscape').catch(() => {})
        }
      } catch { /* refused */ }
    })
    document.addEventListener('fullscreenchange', () => {
      this.fullBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'
    })
    // iOS Safari: no pinch-zoom or double-tap zoom while playing
    document.addEventListener('gesturestart', (e) => e.preventDefault())
    document.addEventListener('dblclick', (e) => e.preventDefault())

    if (force || matchMedia('(pointer: coarse)').matches) this.enable()
    else addEventListener('touchstart', () => this.enable(), { once: true, passive: true })
  }

  private enable() {
    if (this.active) return
    this.active = true
    this.el.hidden = false
    this.hud.classList.add('touch')
  }

  /** Lobby (the fold-away and full screen buttons) or not; driving (pedals) or not (spectating). */
  mode(lobby: boolean, driving: boolean) {
    this.el.classList.toggle('t-inlobby', lobby)
    this.hud.classList.toggle('t-lobby', lobby)
    this.el.classList.toggle('t-idle', !driving)
    if (!lobby && !this.panels) {
      // the next lobby opens with its panels
      this.panels = true
      this.hud.classList.remove('panels-off')
      this.menuBtn.textContent = 'Hide lobby'
    }
  }

  /** The weapon in hand on the fire button: its FX page 2 icon cell, or none. */
  weapon(cell: [number, number] | null) {
    this.el.querySelector('.t-fire')!.classList.toggle('armed', !!cell)
    this.fireIcon.style.backgroundPosition = cell ? `${-cell[0] * 32}px ${-(192 + cell[1] * 32)}px` : ''
  }

  read(): TouchRead {
    const on = (b: Btn) => (this.held.get(b)?.size ?? 0) > 0
    const tap = (b: Btn) => this.taps.delete(b)
    return {
      left: [...this.steering.values()].includes(-1),
      right: [...this.steering.values()].includes(1),
      gas: on('gas') ? 1 : 0,
      brake: on('brake') ? 1 : 0,
      fire: tap('fire'),
      reset: tap('reset'),
    }
  }
}
