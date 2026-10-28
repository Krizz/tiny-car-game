// Keyboard + Gamepad API -> Controls. Analog values are smoothed for keys so
// tapping steers gently, like the original's keyboard steering.
import type { Controls } from './car'
import type { TouchControls } from './touch'

const keys = new Set<string>()
const taps = new Set<string>()
let typing = () => false
let touch: TouchControls | null = null

export function useTouch(t: TouchControls) {
  touch = t
}

export function initInput(isTyping: () => boolean) {
  typing = isTyping
  addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent
    if (typing()) return
    if (!keys.has(e.code)) taps.add(e.code)
    keys.add(e.code)
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault()
  })
  addEventListener('keyup', (e) => keys.delete((e as KeyboardEvent).code))
  addEventListener('blur', () => keys.clear())
}

/** True once per key press. */
export function tapped(code: string): boolean {
  const t = taps.has(code)
  taps.delete(code)
  return t
}

export function clearTaps() {
  taps.clear()
}

let kSteer = 0
let lastPadButtons: boolean[] = []

export interface Read extends Controls {
  reset: boolean
  flip: boolean
  ready: boolean // lobby: toggle ready
  fire: boolean
  usingPad: boolean
}

export function readControls(dt: number): Read {
  const t = touch?.active ? touch.read() : null
  const left = keys.has('ArrowLeft') || keys.has('KeyA') || !!t?.left
  const right = keys.has('ArrowRight') || keys.has('KeyD') || !!t?.right
  const kTarget = (left ? 1 : 0) - (right ? 1 : 0)
  // keys ramp in over ~0.15 s and snap back faster
  const rate = (kTarget === 0 || Math.sign(kTarget) !== Math.sign(kSteer) ? 10 : 6) * dt
  kSteer += Math.max(-rate, Math.min(rate, kTarget - kSteer))
  let throttle = (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0) - (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0)
  let steer = kSteer
  let handbrake = keys.has('Space')
  let reset = tapped('KeyR')
  let flip = tapped('KeyE') || tapped('End')
  let ready = tapped('Enter')
  let fire = tapped('KeyF') || tapped('ControlLeft') || tapped('ControlRight')
  let usingPad = false

  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad) continue
    const b = (i: number) => pad.buttons[i]?.value ?? 0
    const pressed = (i: number) => !!pad.buttons[i]?.pressed
    const ax = pad.axes[0] ?? 0
    const stick = Math.abs(ax) > 0.12 ? -Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88) : 0
    const gas = Math.max(b(7), pressed(0) ? 1 : 0) // RT or A
    const brake = Math.max(b(6), pressed(2) ? 1 : 0) // LT or X
    if (stick || gas || brake || pressed(1)) usingPad = true
    if (stick) steer = stick
    if (gas || brake) throttle = gas - brake
    if (pressed(1)) handbrake = true // B
    const now = pad.buttons.map((x) => x.pressed)
    if (now[3] && !lastPadButtons[3]) reset = true // Y
    if (now[4] && !lastPadButtons[4]) flip = true // LB
    if (now[9] && !lastPadButtons[9]) ready = true // Start
    if (now[5] && !lastPadButtons[5]) fire = true // RB
    lastPadButtons = now
  }
  if (t) {
    if (t.gas || t.brake) throttle = t.gas - t.brake
    if (t.fire) fire = true
    if (t.reset) reset = true
  }
  return { throttle, steer, handbrake, reset, flip, ready, fire, usingPad }
}
