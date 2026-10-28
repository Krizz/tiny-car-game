// One global room: lobby -> grid -> race -> results -> lobby.
//
// Everyone who opens the page is in it at once. In the lobby people free-drive
// (and see each other); the first arrival starts a countdown, later arrivals
// stretch it to at least JOIN_MIN, and when every connected player is ready it
// shortens to READY_MS. The grid phase is the 3-2-1-GO on the start line; who
// arrives during grid/race watches until the next race.
//
// Each browser simulates its own car: the server relays its binary state
// packet to everybody else (prefixed with the sender id) — over a WebRTC data channel
// where the browser has one open (shared/rtc.ts), else its WebSocket — and keeps score from
// the clients' lap/finish reports. The only cars the server drives are the AI
// ones (shared/ai.ts): when a race starts with fewer than MIN_RACERS, AI fills
// the grid. To everyone else they are players like any other.
import { offerCourses } from './course'
import { drawWeapon } from './draw'
import { LapRecorder, RATING } from './laps'
import type { Server, ServerWebSocket } from 'bun'
import { AiWorldProxy as AiWorld } from './aiproxy' // each course's CPU world in a worker thread
import { RTC_PORT, RtcPeer } from './rtc'
import {
  AMMO, BOMB_FUSE_MS, PICKUP_RESPAWN_MS, WEAPONS, type Weapon,
  CAR_BYTES, CARS_HEAD, LAPS, MAX_PLAYERS, TRACKS, packCars, serverClock, unpackCars, type ClientMsg, type Phase, type PlayerInfo, type ResultRow, type ServerMsg,
} from './protocol'

type WS = ServerWebSocket<{ id: number }>

const LOBBY_FIRST_MS = 20_000
// after the vote is drawn: the roulette's time (same course; ~2.5–3.4 s in the browser), or at most
// this long for every browser to load the new one — the grid comes as soon as all of them have
// ("we do not need the time after the stage is chosen")
const DRAWN_MS = 3_500
const SWITCH_MS = 9_000
const LOADED_GO_MS = 300 // everyone is on the drawn course: this long, then the grid
const KEEP_WORLDS = 3 // CPU-car worlds kept (the drawn course's is built when it is drawn)
const JOIN_MIN_MS = 10_000
const OLD_STATE_BYTES = 72 // a car state from a page loaded before 2026-10-15 (see shared/protocol.ts)
const READY_MS = 3_000
const GRID_MS = 4_000 // 3, 2, 1, GO
const RACE_MAX_MS = 8 * 60_000
const AFTER_FIRST_MS = 45_000 // the rest have this long once someone has finished
const AI_RUN_IN_MS = 15_000 // once every person is over the line, CPU cars still out get this long to come home
const RESULTS_MS = 10_000
const MIN_RACERS = Math.max(1, Math.min(12, Number(process.env.AI_RACERS ?? 6))) // fill the grid up to this with AI
const AI_IDS = 200 // AI player ids are 200..; people get 1..199
const AI_NAMES = ['Sparky', 'Volty', 'Rusty', 'Nitro', 'Gizmo', 'Bolt', 'Fizz', 'Zapper', 'Tinker', 'Ratchet', 'Dynamo', 'Widget']
// (the R6 Turbo was left out until 2026-10-14 — it rolled over on barrier ends 2–3 times a lap; with
// today's driver it made 7 resets, 1 a roll-over, in 156 solo laps on all 52 courses, the fewest of the
// Advanced cars — so it replaced the Evil Weasel, whose slippery tyres made it 34: people can still pick it)
// Pole Poz and Genghis Kar out the same day: 31 resets each in those solo laps (the others 5–24)
// Evil Weasel, NY 54, Zipper, Pest Control, Pole Poz and Genghis Kar joined 2026-10-12 so every class
// has CPU cars (there was no Advanced one); checked as six-car fields on all 52 courses, resets per car
// as the others'. Left out: Bertha Ballistics (slow, 2.3+ resets), Rotor (2.1+), Mystery (cars that
// never finished), Panga TC (8.9 resets a car)
const AI_CARS = ['rc', 'phat', 'cougar', 'dino', 'mite', 'volken', 'candy', 'beatall', 'toyeca', 'amw', 'adeon', 'sugo', 'mouse',
  'r5', 'tc5', 'tc1', 'tc3']


const CARS = new Set([
  'rc', 'phat', 'cougar', 'dino', 'mite', 'volken', 'candy', 'beatall', 'toyeca', 'amw', 'adeon', 'panga',
  'r5', 'sugo', 'moss', 'flag', 'fone', 'gencar', 'mouse', 'mud', 'q', 'rotor', 'sgt', 'tc1', 'tc2', 'tc3',
  'tc4', 'tc5', 'tc6', 'ufo',
])

interface Player extends PlayerInfo {
  ws: WS | null // null = AI
  rtc?: RtcPeer // unreliable data channel for car state
  finish: number | null
  best: number | null
  weapon: Weapon | null
  ammo: number
  helloAt?: number // performance.now() of its hello (sent once its browser has the room's course loaded)
}

function cleanName(s: unknown): string {
  const n = String(s ?? '').replace(/[^\p{L}\p{N} _.\-!?']/gu, '').trim().slice(0, 16)
  return n || 'Racer'
}

export class Lobby {
  server: Server<{ id: number }> | null = null
  private players = new Map<number, Player>()
  private nextId = 1
  private phase: Phase = 'lobby'
  private deadline = 0 // ms timestamp the current phase ends (0 = no timer)
  private timer: ReturnType<typeof setTimeout> | null = null
  private results: ResultRow[] = []
  private raceStart = 0
  private taken = new Map<number, number>() // pickup index -> respawn time
  private laps = new LapRecorder() // player laps for the CPU drivers to learn from (shared/laps.ts)
  private bomb = { holder: 0, until: 0, passedFrom: 0, passedAt: 0 }
  private bombTimer: ReturnType<typeof setTimeout> | null = null
  private worlds = new Map<string, AiWorld>() // CPU-car worlds by course, most recent last
  private making = new Set<string>()
  track = process.env.TRACK && TRACKS[process.env.TRACK] ? process.env.TRACK : 'toylite'
  private drawn = false // this lobby's votes are drawn: next comes the grid
  private switchedAt = 0 // performance.now() of a draw that moved the room to another course (0 = none)
  private offer = offerCourses() // what this lobby votes between

  private get ai(): AiWorld | null {
    return this.worlds.get(this.track) ?? null
  }

  constructor() {
    this.makeWorld(this.track)
  }

  /** A fresh choice of courses for the next vote. */
  private newOffer() {
    this.offer = offerCourses()
    this.broadcast({ t: 'offer', courses: this.offer })
  }

  private makeWorld(track: string) {
    if (this.worlds.has(track) || this.making.has(track)) return
    this.making.add(track)
    AiWorld.create({
      message: (id, m) => {
        const p = this.players.get(id)
        if (p?.ai) this.handle(p, m)
      },
      state: (packet) => this.relayState(-1, packet), // the CPU cars of one tick, in one packet
      // the loose objects of the course people are on (shared/objnet.ts)
      objects: (packet) => track === this.track && this.relayState(-1, packet),
      finish: (id, time, best) => {
        const p = this.players.get(id)
        if (p?.ai) this.finish(p, time, best)
      },
      // every CPU lap, not just finishers' bests: once the people are home the CPU cars still out are DNF
      lap: (id, n, ms) => {
        const p = this.players.get(id)
        if (p?.ai && track === this.track && this.phase === 'race') this.laps.cpuLap(track, p.car, ms)
      },
    }, track).then((w) => {
      this.making.delete(track)
      this.worlds.set(track, w)
      for (const p of this.humans()) w.setHumanCar(p.id, p.car)
      w.setActive(track === this.track)
      console.log(`AI ready on ${track}`)
      // drop the oldest worlds (never the current course's)
      for (const [k, old] of this.worlds) {
        if (this.worlds.size <= KEEP_WORLDS) break
        if (k === this.track) continue
        old.dispose()
        this.worlds.delete(k)
      }
    }, (e) => {
      this.making.delete(track)
      console.error(`AI unavailable on ${track}:`, e)
    })
  }

  /** Human cars live in every AI world (whichever track is up next). */
  private humanCar(id: number, car: string | null) {
    for (const w of this.worlds.values()) w.setHumanCar(id, car)
  }

  private humans(): Player[] {
    return [...this.players.values()].filter((p) => !p.ai)
  }

  /** Fill the grid with AI so nobody races alone. */
  private addAi(from: number) {
    if (!this.ai) return
    const want = MIN_RACERS - from
    // CPU cars of the people's class (a Pro car among Rookies just drove away from them): each
    // takes the class of one person in turn, then the car nearest it — an unused one first; a
    // second of the same car beats one a class off, a third doesn't
    const uses = new Map<string, number>()
    for (const p of this.players.values()) uses.set(p.car, (uses.get(p.car) ?? 0) + 1)
    const classes = this.humans().map((p) => RATING[p.car] ?? 0)
    if (!classes.length) classes.push(0)
    const names = [...AI_NAMES].sort(() => Math.random() - 0.5)
    for (let i = 0; i < want; i++) {
      const id = AI_IDS + i
      const target = classes[i % classes.length]
      const score = (c: string) => Math.abs(RATING[c] - target) + 0.6 * (uses.get(c) ?? 0) + Math.random() * 0.3
      const car = AI_CARS.map((c) => [c, score(c)] as const).sort((x, y) => x[1] - y[1])[0][0]
      uses.set(car, (uses.get(car) ?? 0) + 1)
      const p: Player = {
        id, name: names[i % names.length], car, ready: true, racing: true, slot: from + i, ws: null, ai: true,
        finish: null, best: null, weapon: null, ammo: 0,
      }
      this.players.set(id, p)
      this.ai.addAi(id, car, p.slot)
    }
  }

  private removeAi() {
    for (const p of [...this.players.values()]) if (p.ai) this.players.delete(p.id)
    this.ai?.removeAll()
  }

  private takenList(): [number, number][] {
    const now = serverClock()
    return [...this.taken].filter(([, t]) => t > now)
  }

  private resetWeapons() {
    this.taken.clear()
    for (const p of this.players.values()) {
      p.weapon = null
      p.ammo = 0
    }
    this.setBomb(0, 0)
    this.broadcast({ t: 'pickups', taken: [] })
    for (const p of this.players.values()) this.toPlayer(p, { t: 'weapon', w: null, n: 0 })
  }

  private setBomb(holder: number, until: number) {
    if (this.bombTimer) clearTimeout(this.bombTimer)
    this.bombTimer = null
    this.bomb.holder = holder
    this.bomb.until = until
    this.broadcast({ t: 'bomb', holder, until })
    if (holder) {
      this.bombTimer = setTimeout(() => {
        const h = this.bomb.holder
        this.setBomb(0, 0)
        if (h) this.broadcast({ t: 'boom', holder: h })
      }, Math.max(0, until - serverClock()))
    }
  }

  private weaponsAllowed() {
    return this.phase !== 'grid'
  }

  private remaining() {
    return this.deadline ? Math.max(0, this.deadline - serverClock()) : -1
  }

  private list(): PlayerInfo[] {
    return [...this.players.values()].map(({ id, name, car, ready, racing, slot, ai, vote }) => ({ id, name, car, ready, racing, slot, ai, vote }))
  }

  private send(ws: WS, m: ServerMsg) {
    ws.send(JSON.stringify(m))
  }

  /** To one player: a browser over its socket, an AI straight into the AI world. */
  private toPlayer(p: Player, m: ServerMsg) {
    if (p.ws) this.send(p.ws, m)
    else if (m.t === 'weapon') this.ai?.give(p.id, m.w as string, m.n)
  }

  /** A car's state (relay format, sender id in byte 0) to every other browser. */
  private relayState(from: number, out: Uint8Array) {
    for (const p of this.players.values()) {
      if (!p.ws || p.id === from) continue
      if (p.rtc?.send(out)) continue
      // TCP: if the socket is backed up, a state packet would only arrive stale — skip it
      if (p.ws.getBufferedAmount() < 32 * 1024) p.ws.send(out)
    }
  }

  private stateIn(p: Player, raw: Uint8Array) {
    let out: Uint8Array
    if (raw.byteLength === OLD_STATE_BYTES) {
      // a page from before the packed format (f64 time + 16 f32): repack it, so the others see its car
      const b = raw.slice().buffer
      out = packCars(new Float64Array(b, 0, 1)[0], [{ id: p.id, f: new Float32Array(b, 8, 16) }])
    } else {
      if (raw.byteLength !== CARS_HEAD + CAR_BYTES || raw[1] !== 1) return
      out = raw.slice()
      out[CARS_HEAD] = p.id // the sender's id: a browser sends 0
    }
    this.relayState(p.id, out)
    unpackCars(out, (_, time, f) => {
      if (this.phase === 'race' && p.racing) this.laps.state(p.id, time, f)
      this.ai?.onHumanState(p.id, time, f)
    })
  }

  private broadcast(m: ServerMsg) {
    this.server?.publish('all', JSON.stringify(m))
    this.ai?.onServerMsg(m)
  }

  /** Everyone but the sender (it already has it): browsers + the AI world. */
  private relayFrom(p: Player, m: ServerMsg) {
    const json = JSON.stringify(m)
    if (p.ws) {
      p.ws.publish('all', json)
      this.ai?.onServerMsg(m)
    } else this.server?.publish('all', json)
  }

  private setTimer(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (ms < 0) {
      this.deadline = 0
      return
    }
    this.deadline = serverClock() + ms
    this.timer = setTimeout(() => this.advance(), ms)
  }

  private starTaken = false // the race's star (the Global Pulse) has been touched

  private enter(phase: Phase, ms: number) {
    this.phase = phase
    if (phase === 'grid') this.starTaken = false
    this.setTimer(ms)
    const m: ServerMsg = { t: 'phase', phase, remaining: this.remaining(), players: this.list() }
    if (phase === 'results') m.results = this.results
    this.broadcast(m)
    this.ai?.setPhase(phase)
    console.log(`phase ${phase} (${this.humans().length} people, ${this.players.size - this.humans().length} AI)`)
  }

  private advance() {
    switch (this.phase) {
      case 'lobby': {
        if (this.humans().length === 0) {
          if (this.drawn) this.newOffer()
          this.drawn = false
          return this.enter('lobby', -1)
        }
        if (!this.drawn) {
          // Mario Kart 8 style: one of the courses people picked, at random (two votes = twice
          // the chance); nobody voted = any course
          const votes = this.humans().map((p) => p.vote).filter((v): v is string => !!v && this.offer.includes(v))
          const pool = votes.length ? votes : this.offer
          const pick = pool[Math.floor(Math.random() * pool.length)]
          this.drawn = true
          for (const p of this.players.values()) p.vote = undefined
          this.broadcast({ t: 'drawn', track: pick, votes })
          console.log(`vote: ${pick} from [${votes.join(', ') || 'no votes'}]`)
          if (pick === this.track) {
            this.switchedAt = 0
            return this.enter('lobby', DRAWN_MS)
          }
          this.switchedAt = performance.now()
          this.track = pick
          this.taken.clear()
          this.makeWorld(pick)
          for (const [k, w] of this.worlds) w.setActive(k === pick)
          this.broadcast({ t: 'track', track: pick })
          return this.enter('lobby', SWITCH_MS)
        }
        this.drawn = false
        this.results = []
        this.removeAi()
        let slot = 0
        for (const p of this.players.values()) {
          p.racing = true
          p.slot = slot++
          p.ready = false
          p.finish = null
          p.best = null
        }
        this.addAi(slot)
        this.resetWeapons()
        return this.enter('grid', GRID_MS)
      }
      case 'grid':
        this.raceStart = serverClock()
        return this.enter('race', RACE_MAX_MS)
      case 'race':
        return this.endRace()
      case 'results':
        this.removeAi()
        for (const p of this.players.values()) {
          p.racing = false
          p.slot = -1
        }
        this.drawn = false
        this.newOffer()
        return this.enter('lobby', this.players.size ? LOBBY_FIRST_MS : -1)
    }
  }

  private endRace() {
    const racers = [...this.players.values()].filter((p) => p.racing)
    const elapsed = serverClock() - this.raceStart
    // finished first by time; CPU cars still out get a time projected from their pace (as in
    // original game), slotted in by it; people who didn't finish are DNF
    const done: ResultRow[] = this.results.filter((r) => r.time !== null)
    const dnf: ResultRow[] = []
    for (const p of racers) {
      if (p.finish !== null) continue
      const t = p.ai ? this.ai?.projectFinish(p.id, elapsed) ?? null : null
      if (t !== null) done.push({ id: p.id, name: p.name, car: p.car, time: Math.max(t, elapsed), best: p.best, est: true })
      else dnf.push({ id: p.id, name: p.name, car: p.car, time: null, best: p.best })
    }
    done.sort((a, b) => a.time! - b.time!)
    this.results = [...done, ...dnf]
    this.enter('results', RESULTS_MS)
  }

  /**
   * Over when every person in it has finished — then the CPU cars still out get AI_RUN_IN_MS
   * to come home (it used to end at once: a CPU car a second behind you was DNF).
   */
  private checkRaceOver() {
    if (this.phase !== 'race') return
    const racers = this.humans().filter((p) => p.racing)
    if (racers.length === 0) return this.endRace()
    if (!racers.every((p) => p.finish !== null)) return
    const aiOut = [...this.players.values()].some((p) => p.ai && p.racing && p.finish === null)
    if (!aiOut) return this.endRace()
    if (this.remaining() > AI_RUN_IN_MS) this.setTimer(AI_RUN_IN_MS)
  }

  private finish(p: Player, reported: number, best: number | null) {
    if (this.phase !== 'race' || !p.racing || p.finish !== null) return
    // trust but clamp: the server's own clock bounds the reported time
    const serverTime = serverClock() - this.raceStart
    const time = Math.max(5000, Math.min(serverTime + 500, Number(reported) || serverTime))
    p.finish = time
    if (typeof best === 'number' && best > 3000) p.best = Math.min(p.best ?? Infinity, best)
    this.results.push({ id: p.id, name: p.name, car: p.car, time, best: p.best })
    const place = this.results.length
    this.broadcast({ t: 'finished', id: p.id, time, place })
    if (place === 1 && this.remaining() > AFTER_FIRST_MS) this.setTimer(AFTER_FIRST_MS)
    this.checkRaceOver()
  }

  open(ws: WS) {
    if (this.players.size >= MAX_PLAYERS * 2) {
      ws.close(1013, 'full')
      return
    }
    let id = this.nextId++
    if (this.nextId >= AI_IDS) this.nextId = 1
    while (this.players.has(id)) id = this.nextId++ % AI_IDS || 1
    ws.data.id = id
    const p: Player = {
      id, name: `Racer ${id}`, car: 'rc', ready: false, racing: false, slot: -1, ws, finish: null, best: null, weapon: null, ammo: 0,
    }
    this.players.set(id, p)
    ws.subscribe('all')
    this.send(ws, {
      t: 'welcome', id, phase: this.phase, remaining: this.remaining(), players: this.list(), laps: LAPS, track: this.track, drawn: this.drawn, offer: this.offer, raceAt: this.raceStart,
      taken: this.takenList(), bomb: { holder: this.bomb.holder, until: this.bomb.until },
    })
    if (this.phase === 'lobby') {
      if (!this.deadline) this.setTimer(LOBBY_FIRST_MS)
      // (not once the course is drawn: everyone reconnects after reloading into it, and each one
      // pushed the start back to 10 s)
      else if (this.remaining() < JOIN_MIN_MS && !this.drawn) this.setTimer(JOIN_MIN_MS)
      this.broadcast({ t: 'phase', phase: 'lobby', remaining: this.remaining(), players: this.list() })
    } else {
      this.broadcast({ t: 'players', players: this.list() })
    }
  }

  message(ws: WS, raw: string | Buffer) {
    const p = this.players.get(ws.data.id)
    if (!p) return
    if (typeof raw !== 'string') {
      // binary state: relay with the sender id in front
      this.stateIn(p, new Uint8Array(raw))
      return
    }
    let m: ClientMsg
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    this.handle(p, m)
  }

  /** One message from a player — a browser or an AI (same rules for both). */
  private handle(p: Player, m: ClientMsg) {
    const ws = p.ws
    switch (m.t) {
      case 'hello':
        p.name = cleanName(m.name)
        if (CARS.has(m.car) && !(p.racing && this.phase !== 'lobby')) p.car = m.car
        p.helloAt = performance.now()
        this.humanCar(p.id, p.car)
        this.broadcast({ t: 'players', players: this.list() })
        this.goWhenLoaded()
        break
      case 'name':
        p.name = cleanName(m.name)
        this.broadcast({ t: 'players', players: this.list() })
        break
      case 'car':
        if (CARS.has(m.car) && (this.phase === 'lobby' || this.phase === 'results' || !p.racing)) {
          p.car = m.car
          this.humanCar(p.id, p.car)
          this.broadcast({ t: 'players', players: this.list() })
        }
        break
      case 'ready':
        if (this.phase !== 'lobby') break
        p.ready = !!m.on
        if (this.humans().every((q) => q.ready) && this.remaining() > READY_MS) this.setTimer(READY_MS)
        this.broadcast({ t: 'phase', phase: 'lobby', remaining: this.remaining(), players: this.list() })
        break
      case 'lap':
        if (this.phase === 'race' && p.racing) {
          if (typeof m.time === 'number' && m.time > 3000 && (p.best === null || m.time < p.best)) p.best = m.time
          // a clean flying lap faster than the CPU's best in this class: kept for the CPU drivers to learn from
          const why = this.laps.lap(p.id, this.track, p.car, Math.floor(Number(m.lap)), Number(m.time))
          if (why === 'stored' || process.env.LAPS_LOG) console.log(`lap: ${p.name} (${p.car}) lap ${m.lap} ${(Number(m.time) / 1000).toFixed(2)} s on ${this.track}: ${why}`)
        }
        break
      case 'finish':
        this.finish(p, m.time, m.best)
        break
      case 'star': {
        // the first to touch it fires it at once: every other car is zapped (src/weapons.ts)
        if (this.phase !== 'race' || !p.racing || this.starTaken || !Array.isArray(m.p)) break
        this.starTaken = true
        const at = m.p.slice(0, 3).map((x) => Number(x) || 0)
        this.broadcast({ t: 'fire', id: p.id, w: 'globalPulse', shot: p.id * 100000 + 99999, at: serverClock(), d: [0, ...at] })
        console.log(`star: ${p.name} fired the Global Pulse`)
        break
      }
      case 'pick': {
        // still holding something by our count while the browser thinks its slot is empty (a fire we
        // turned down, a message lost in a reconnect): say what it holds, or every star it touches is
        // ignored for the rest of the race ("should get a new powerup if the slot is empty")
        if (p.weapon) {
          this.toPlayer(p, { t: 'weapon', w: p.weapon, n: p.ammo })
          break
        }
        if (!this.weaponsAllowed() || (this.phase === 'race' && !p.racing)) break
        const i = Math.floor(Number(m.i))
        if (!(i >= 0 && i < 256) || (this.taken.get(i) ?? 0) > serverClock()) break
        this.taken.set(i, serverClock() + PICKUP_RESPAWN_MS)
        const of = Math.max(1, Math.min(64, Math.floor(Number(m.of)) || 1))
        const place = Math.max(1, Math.min(of, Math.floor(Number(m.place)) || 1))
        let w = drawWeapon(place, of)
        if (w === 'puttyBomb' && this.bomb.holder) w = 'shockwave' // one bomb at a time
        p.weapon = w
        p.ammo = AMMO[w]
        this.toPlayer(p, { t: 'weapon', w, n: p.ammo })
        this.broadcast({ t: 'pickups', taken: this.takenList() })
        break
      }
      case 'fire': {
        if (!this.weaponsAllowed() || !p.weapon || m.w !== p.weapon || !Array.isArray(m.d) || m.d.length > 16) {
          if (p.ws) this.send(p.ws, { t: 'weapon', w: p.weapon, n: p.ammo }) // the browser's slot follows ours
          break
        }
        p.ammo--
        if (p.ammo <= 0) p.weapon = null
        if (ws) this.send(ws, { t: 'weapon', w: p.weapon, n: p.ammo }) // the AI world counted it already
        if (m.w === 'puttyBomb') {
          if (!this.bomb.holder) this.setBomb(p.id, serverClock() + BOMB_FUSE_MS)
          break
        }
        this.relayFrom(p, {
          t: 'fire', id: p.id, w: m.w, shot: Number(m.shot) || 0, at: Number(m.at) || serverClock(),
          d: m.d.map((x) => Number(x) || 0),
        })
        break
      }
      case 'det':
        if (Array.isArray(m.p)) {
          this.relayFrom(p, { t: 'det', id: p.id, shot: Number(m.shot) || 0, p: m.p.slice(0, 3).map(Number) })
        }
        break
      case 'bombPass': {
        const to = this.players.get(Number(m.to))
        const now = serverClock()
        if (this.bomb.holder !== p.id || !to || to.id === p.id) break
        // no instant pass-back
        if (to.id === this.bomb.passedFrom && now - this.bomb.passedAt < 1200) break
        this.bomb.passedFrom = p.id
        this.bomb.passedAt = now
        this.setBomb(to.id, this.bomb.until)
        break
      }
      case 'vote':
        // a course for the next race (drawn when the lobby's time runs out); '' takes it back
        if (this.drawn && this.phase === 'lobby') break
        if (m.course !== '' && !this.offer.includes(m.course)) break
        p.vote = m.course || undefined
        this.broadcast({ t: 'players', players: this.list() })
        break
      case 'rtc':
        // the browser's offer for a state data channel (a new one replaces the old)
        if (!ws || !RTC_PORT || typeof m.sdp !== 'string' || m.sdp.length > 10_000) break
        p.rtc?.close()
        p.rtc = new RtcPeer((s) => p.ws === ws && this.send(ws, s), (b) => this.stateIn(p, b), (s) => console.log(`rtc ${p.id}: ${s}`))
        p.rtc.offer(m.sdp)
        break
      case 'rtcCand':
        if (typeof m.c === 'string' && typeof m.mid === 'string' && m.c.length < 500) p.rtc?.candidate(m.c, m.mid)
        break
      case 'ping':
        // clock sync for the clients' state timestamps
        if (ws && typeof m.c === 'number') this.send(ws, { t: 'pong', c: m.c, s: serverClock() })
        break
    }
  }

  close(ws: WS) {
    const p = this.players.get(ws.data.id)
    if (!p) return
    this.players.delete(p.id)
    this.laps.forget(p.id)
    p.rtc?.close()
    this.humanCar(p.id, null)
    if (this.bomb.holder === p.id) this.setBomb(0, 0)
    if (this.humans().length === 0) {
      // nobody left to race the AI
      this.removeAi()
      this.results = []
      this.broadcast({ t: 'players', players: this.list() })
      // everyone is reloading into the drawn course: keep it and its countdown (if nobody comes
      // back, advance() finds the room empty and goes idle)
      if (this.phase === 'lobby' && this.drawn) return
      this.drawn = false
      if (this.phase !== 'lobby') this.enter('lobby', -1)
      else this.setTimer(-1)
      return
    }
    this.broadcast({ t: 'players', players: this.list() })
    if (this.phase === 'lobby' && this.humans().every((q) => q.ready) && this.remaining() > READY_MS) {
      this.setTimer(READY_MS)
    }
    this.goWhenLoaded()
    this.checkRaceOver()
  }

  /** The room moved to the drawn course: the grid as soon as every person is back on it. */
  private goWhenLoaded() {
    if (this.phase !== 'lobby' || !this.drawn || !this.switchedAt) return
    const people = this.humans()
    if (!people.length || people.some((p) => (p.helloAt ?? 0) <= this.switchedAt)) return
    if (this.remaining() > LOADED_GO_MS) {
      this.setTimer(LOADED_GO_MS)
      this.broadcast({ t: 'phase', phase: 'lobby', remaining: this.remaining(), players: this.list() })
    }
  }
}
