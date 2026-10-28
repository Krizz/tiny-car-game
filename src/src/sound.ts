// Web Audio with the original original game effects (public/game/sfx). Browsers
// only allow sound after a user gesture, so everything waits for the first
// key/click/pad press.
const NAMES = [
  'moto', 'petrol', 'clockwork', 'skid', 'hit', 'hit_soft', 'scrape', 'countdown', 'horn', 'piano',
  'pickup', 'pickgen', 'shockfire', 'shock', 'firefire', 'firebang', 'electro', 'electrozap', 'oildrop',
  'wbombfire', 'wbombhit', 'wbombbounce', 'balldrop', 'ball', 'fuse', 'puttbang', 'turbo', 'starfire', 'splash',
  'train', 'whistle', 'skid_rough', 'dragon',
] as const
type Name = (typeof NAMES)[number]

let ctx: AudioContext | null = null
let master: GainNode | null = null
const buffers = new Map<Name, AudioBuffer>()

async function init() {
  if (ctx) return
  ctx = new AudioContext()
  master = ctx.createGain()
  master.gain.value = 0.36 // (60% of the 0.6 it was)
  master.connect(ctx.destination)
  await Promise.all(NAMES.map(async (n) => {
    try { buffers.set(n, await loadSfx(n)) } catch { /* a missing effect is not fatal */ }
  }))
  for (const e of engines) e.start()
}

/** An effect under /game/sfx/: the Opus copy (convert/opus.sh, ~¼ the size), else the original wav. */
let opusOk = true
async function loadSfx(name: string): Promise<AudioBuffer> {
  if (opusOk) {
    try {
      const r = await fetch(`/game/sfx/${name}.ogg`)
      if (r.ok) return await ctx!.decodeAudioData(await r.arrayBuffer())
    } catch { opusOk = false } // a browser that can't decode Opus (older Safari): wavs from now on
  }
  const r = await fetch(`/game/sfx/${name}.wav`)
  return await ctx!.decodeAudioData(await r.arrayBuffer())
}

const unlockHooks: (() => void)[] = []

export function unlockAudio() {
  const go = () => {
    init()
    ctx?.resume()
    // media elements may only start inside the gesture itself (Safari)
    for (const f of unlockHooks.splice(0)) f()
  }
  for (const ev of ['keydown', 'pointerdown', 'touchstart']) addEventListener(ev, go, { passive: true })
  const poll = setInterval(() => {
    if ((navigator.getGamepads?.() ?? []).some((p) => p?.buttons.some((b) => b.pressed))) {
      go()
      clearInterval(poll)
    }
  }, 300)
}

export function play(name: Name, volume = 1, rate = 1) {
  const b = buffers.get(name)
  if (!ctx || !master || !b) return
  const src = ctx.createBufferSource()
  src.buffer = b
  src.playbackRate.value = rate
  const g = ctx.createGain()
  g.gain.value = volume
  src.connect(g).connect(master)
  src.start()
}

const engines = new Set<{ start(): void }>()

/** One looping effect (the train) whose volume the caller sets each frame. */
export class LoopSound {
  private src: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null

  constructor(private name: Name) {
    engines.add(this)
    if (ctx) this.start()
  }

  start() {
    if (!ctx || !master || this.src) return
    const b = buffers.get(this.name)
    if (!b) return
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.gain.connect(master)
    this.src = ctx.createBufferSource()
    this.src.buffer = b
    this.src.loop = true
    this.src.connect(this.gain)
    this.src.start()
  }

  volume(v: number) {
    if (ctx && this.gain) this.gain.gain.setTargetAtTime(v, ctx.currentTime, 0.1)
  }
}

/** A looping engine (+ skid) for one car; volume falls off with distance. */
export class EngineSound {
  private src: AudioBufferSourceNode | null = null
  private skidSrc: AudioBufferSourceNode | null = null
  private roughSrc: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null
  private skidGain: GainNode | null = null
  private roughGain: GainNode | null = null
  private rev = 0

  constructor(private kind: 'moto' | 'petrol' | 'clockwork') {
    engines.add(this)
    if (ctx) this.start()
  }

  start() {
    if (!ctx || !master || this.src) return
    const b = buffers.get(this.kind), s = buffers.get('skid'), rs = buffers.get('skid_rough')
    if (!b) return
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.gain.connect(master)
    this.src = ctx.createBufferSource()
    this.src.buffer = b
    this.src.loop = true
    this.src.connect(this.gain)
    this.src.start()
    if (s) {
      this.skidGain = ctx.createGain()
      this.skidGain.gain.value = 0
      this.skidGain.connect(master)
      this.skidSrc = ctx.createBufferSource()
      this.skidSrc.buffer = s
      this.skidSrc.loop = true
      this.skidSrc.connect(this.skidGain)
      this.skidSrc.start()
    }
    if (rs) {
      this.roughGain = ctx.createGain()
      this.roughGain.gain.value = 0
      this.roughGain.connect(master)
      this.roughSrc = ctx.createBufferSource()
      this.roughSrc.buffer = rs
      this.roughSrc.loop = true
      this.roughSrc.connect(this.roughGain)
      this.roughSrc.start()
    }
  }

  /** speed01: |speed| / top speed; throttle 0..1; skid 0..1; distance in m; rough = on a rough
   *  floor (dirt, grass, carpet: surfaces.ts), which has its own skid sound. */
  update(speed01: number, throttle: number, skid: number, distance: number, dt: number, rough = false) {
    if (!ctx || !this.src || !this.gain) return
    const want = Math.min(1.2, speed01 * 0.9 + throttle * 0.25)
    this.rev += (want - this.rev) * Math.min(1, dt * 6)
    const t = ctx.currentTime
    const fall = 1 / (1 + Math.max(0, distance - 2) * 0.35)
    this.src.playbackRate.setTargetAtTime(0.55 + this.rev * 1.5, t, 0.03)
    this.gain.gain.setTargetAtTime((0.12 + this.rev * 0.35) * fall, t, 0.05)
    this.skidGain?.gain.setTargetAtTime(rough ? 0 : Math.min(1, skid) * 0.35 * fall, t, 0.05)
    this.roughGain?.gain.setTargetAtTime(rough ? Math.min(1, skid) * 0.35 * fall : 0, t, 0.05)
  }

  stop() {
    engines.delete(this)
    try {
      this.src?.stop()
      this.skidSrc?.stop()
      this.roughSrc?.stop()
    } catch { /* already stopped */ }
    this.gain?.disconnect()
    this.skidGain?.disconnect()
    this.roughGain?.disconnect()
  }
}

// ------------------------------------------------------------ level ambience

/** A level's ambient sound (.fob type 49, convert.py ambient_sounds). */
export interface AmbientSource {
  pos: number[]
  sound: string // 'folder/file' under /game/sfx/
  range: number // m; 0 = heard everywhere
  occasional: boolean // a call now and then (animals, thunder) instead of a loop
}

const levelBuffers = new Map<string, AudioBuffer | null>()
function levelBuffer(name: string): AudioBuffer | null {
  if (!ctx) return null
  if (!levelBuffers.has(name)) {
    levelBuffers.set(name, null)
    loadSfx(name)
      .then((b) => levelBuffers.set(name, b))
      .catch(() => {})
  }
  return levelBuffers.get(name) ?? null
}

const AMBIENT_VOLUME = 0.45

/** Loops fade with distance to the listener (full volume inside a third of the range), panned
 *  left/right; occasional sounds play every few seconds while the listener is in range. */
export class AmbientSounds {
  private loops = new Map<AmbientSource, { gain: GainNode; pan: StereoPannerNode }>()
  private due = new Map<AmbientSource, number>()
  private held = new Set<string>()

  constructor(private list: AmbientSource[]) {}

  /** Stop playing this occasional sound by itself (something else times it: fire()). */
  hold(sound: string) {
    this.held.add(sound)
  }

  /** Play the level's sound now, full volume (Toytanic 2's thunder after a flash). */
  fire(sound: string, vol = 1) {
    const buf = levelBuffer(sound)
    if (buf && ctx && master) this.voice(buf, false, vol * AMBIENT_VOLUME, 0)
  }

  /** listener position and the camera's right-hand direction (world). */
  update(at: ArrayLike<number>, right: ArrayLike<number>, now: number) {
    if (!ctx || !master) return
    for (const s of this.list) {
      const dx = s.pos[0] - at[0], dy = s.pos[1] - at[1], dz = s.pos[2] - at[2]
      const d = Math.hypot(dx, dy, dz)
      const vol = s.range <= 0 ? 1 : Math.max(0, Math.min(1, 1 - (d - s.range / 3) / (s.range * 2 / 3)))
      const pan = s.range <= 0 || d < 0.5 ? 0 : ((dx * right[0] + dy * right[1] + dz * right[2]) / d) * 0.7
      const buf = levelBuffer(s.sound)
      if (!buf) continue
      if (s.occasional) {
        if (this.held.has(s.sound)) continue
        const due = this.due.get(s) ?? now + Math.random() * 8000
        if (now >= due) {
          this.due.set(s, now + 5000 + Math.random() * 10000)
          if (vol > 0.03) this.voice(buf, false, vol * AMBIENT_VOLUME, pan)
        } else this.due.set(s, due)
        continue
      }
      let v = this.loops.get(s)
      if (!v) {
        if (vol <= 0) continue
        v = this.voice(buf, true, 0, pan)
        this.loops.set(s, v)
      }
      v.gain.gain.setTargetAtTime(vol * AMBIENT_VOLUME, ctx.currentTime, 0.15)
      v.pan.pan.setTargetAtTime(pan, ctx.currentTime, 0.15)
    }
  }

  private voice(buf: AudioBuffer, loop: boolean, vol: number, pan: number) {
    const src = ctx!.createBufferSource()
    src.buffer = buf
    src.loop = loop
    const gain = ctx!.createGain()
    gain.gain.value = vol
    const p = ctx!.createStereoPanner()
    p.pan.value = pan
    src.connect(gain).connect(p).connect(master!)
    src.start(0, loop ? Math.random() * buf.duration : 0) // loops out of step with each other
    return { gain, pan: p }
  }
}

// ------------------------------------------------------------ music

const MUSIC_VOLUME = 0.18 // (60% of the 0.3 it was)

/** The level's CD music (REDBOOK: CD tracks first..last, ripped by convert/music.sh): a random
 *  track, then another when it ends. M turns it off and on (kept in localStorage). */
export class Music {
  private el = new Audio()
  private on = true
  private track = 0

  constructor(private range: number[]) {
    try { this.on = localStorage.getItem('music') !== 'off' } catch { /* private mode */ }
    this.el.volume = MUSIC_VOLUME
    this.el.preload = 'auto'
    this.el.addEventListener('ended', () => this.next())
    unlockHooks.push(() => this.on && this.next())
  }

  private next() {
    const [a, b] = this.range
    if (!a) return
    let t = a + Math.floor(Math.random() * (b - a + 1))
    if (t === this.track && b > a) t = t === b ? a : t + 1 // not the same one twice
    this.track = t
    this.el.src = `/game/music/track${String(t).padStart(2, '0')}.mp3`
    this.el.play().catch(() => {})
  }

  /** Returns whether music is now on. */
  toggle(): boolean {
    this.on = !this.on
    try { localStorage.setItem('music', this.on ? 'on' : 'off') } catch { /* private mode */ }
    if (!this.on) this.el.pause()
    else if (this.el.src) this.el.play().catch(() => {})
    else this.next()
    return this.on
  }
}

// ------------------------------------------------------------ level sounds for objects

/** One of the level's wavs (`folder/name`, convert.py level_wavs) at a volume (0 = silent). */
export function playLevel(sound: string, volume: number, rate = 1) {
  const b = levelBuffer(sound)
  if (!ctx || !master || !b || volume <= 0.01) return
  const src = ctx.createBufferSource()
  src.buffer = b
  src.playbackRate.value = rate
  const g = ctx.createGain()
  g.gain.value = volume * AMBIENT_VOLUME
  src.connect(g).connect(master)
  src.start()
}

/** A level wav looping at a volume the caller sets each frame (the museum's laser hum). */
export class LevelLoop {
  private gain: GainNode | null = null
  constructor(private sound: string) {}
  volume(v: number) {
    if (!ctx || !master) return
    if (!this.gain) {
      const b = levelBuffer(this.sound)
      if (!b) return
      this.gain = ctx.createGain()
      this.gain.gain.value = 0
      this.gain.connect(master)
      const src = ctx.createBufferSource()
      src.buffer = b
      src.loop = true
      src.connect(this.gain)
      src.start()
    }
    this.gain.gain.setTargetAtTime(v * AMBIENT_VOLUME, ctx.currentTime, 0.15)
  }
}
