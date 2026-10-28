// AI racers, simulated on the server with the same code the browsers run
// (Box3D wasm, Car, Autopilot, LapTracker, Weapons — headless).
//
// To the browsers an AI car is just another player: it appears in the player
// list (ai: true) and sends the same timestamped 72-byte state packets, so it
// is drawn, predicted, collided with and ranked like anyone else. Human cars
// live in this world as RemoteCars (bodies pulled to their reported state), so
// AI cars bump into people, and the server judges weapon hits on AI cars the
// way each browser judges its own car.
import { courseFiles, mirrorCollision, mirrorInfo, parseCourse } from './course'
import { TrainBody } from './train'
import { ObjectBodies } from './objects'
import { ForceFields } from './fields'
import { ObjectNet } from './objnet'
import * as THREE from 'three'
import { Physics } from '../src/physics'
import { Car, stopping, type Controls } from '../src/car'
import { RemoteCar } from '../src/remote'
import { AiDriver, TUNE, loadMemory } from '../src/aidriver'
import { LapTracker, TrackMeter, gridSlot, rescuePoint } from '../src/race'
import { LOCK_MS, Weapons, type Owned } from '../src/weapons'
import type { CarInfo, LoadedCar, TrackInfo } from '../src/assets'
import { LAPS, STATE_FLOATS, packCars, serverClock, type ClientMsg, type Phase, type ServerMsg } from './protocol'

const ROOT = new URL('../public/', import.meta.url).pathname
// how hard CPU cars lean on rivals alongside / cover one behind (src/aidriver.ts `aggro`)
const AGGRO = Number(process.env.AI_AGGRO ?? 1)
// tests: AI_SEEK=0 (no steering for pickup stars), AI_EAGER=0 (the weapon timings from before 2026-10-14)
const SEEK = process.env.AI_SEEK !== '0'
const EAGER = process.env.AI_EAGER !== '0'
const DT = 1 / 120

const AI_STATE_HZ = 60

export interface AiHooks {
  /** a message from AI player `id`, handled like one from a browser */
  message(id: number, m: ClientMsg): void
  /** publish a car-state packet (this tick's CPU cars, shared/protocol.ts) to every browser */
  state(packet: Uint8Array): void
  finish(id: number, time: number, best: number | null): void
  /** a CPU car completed lap `n` in `ms` (the lobby keeps the CPU's best per class, shared/laps.ts) */
  lap?(id: number, n: number, ms: number): void
  /** publish a loose-objects packet (shared/objnet.ts) to every browser */
  objects?(packet: Uint8Array): void
}

interface Driver {
  id: number
  key: string
  car: Car
  pilot: AiDriver
  lap: LapTracker
  meter: TrackMeter
  finished: boolean
  bestLap: number | null
  heldSince: number
  nextThink: number
  lockId: number // the car its firework reticle is on (as a player's: it fires once it has held it LOCK_MS)
  lockSince: number
  lastShot: number
  resets: number
  best: number // lap zones passed in order (LapTracker.passes) at `bestAt`
  bestAt: number
  holdUntil: number // performance.now() until which it stands still after a reset
  shots: number
}

const carCache = new Map<string, CarInfo>()
async function loadCarInfo(key: string): Promise<LoadedCar> {
  let info = carCache.get(key)
  if (!info) {
    info = (await Bun.file(ROOT + `game/cars/${key}/car.json`).json()) as CarInfo
    carCache.set(key, info)
  }
  return { info, body: new THREE.Mesh(), wheels: info.wheels.map(() => new THREE.Mesh()) }
}

export class AiWorld {
  physics!: Physics
  info!: TrackInfo
  star: THREE.Vector3 | null = null // the race's star (a .fob star of type 0)
  weapons!: Weapons
  private drivers = new Map<number, Driver>()
  private humans = new Map<number, RemoteCar>()
  private humanCars = new Map<number, string>()
  private phase: Phase = 'lobby'
  private starSent = false // a CPU car touched the race's star (the server takes the first)
  private raceStart = 0
  private acc = 0
  private last = performance.now()
  private sendAcc = 0
  private timer: ReturnType<typeof setInterval> | null = null
  resetLog: { why: string; pos: number[]; node: number }[] = []
  private train: TrainBody | null = null
  private objects: ObjectBodies | null = null
  private objNet: ObjectNet | null = null
  /** the lobby's current course: this world runs with people in it (not only CPU cars) and sends the
   *  loose objects' states — the worlds kept for other courses stay idle */
  private active = false
  // per race, for the log line at the end: how long ticks took, how late they ran
  private perf = { ticks: 0, total: 0, worst: 0, late: 0 }

  constructor(private hooks: AiHooks) {}

  static async create(hooks: AiHooks, track = 'toy2'): Promise<AiWorld> {
    const w = new AiWorld(hooks)
    const course = parseCourse(track)
    if (!course) throw new Error(`no course ${track}`)
    const files = courseFiles(course)
    w.physics = await Physics.load(ROOT + 'box3d.wasm')
    w.info = await Bun.file(ROOT + files.base.slice(1) + files.info).json()
    if (course.mirror) mirrorInfo(w.info)
    const col = await Bun.file(ROOT + files.base.slice(1) + (w.info.colBin ?? 'collision.bin')).arrayBuffer()
    const nt = w.info.collision.triangles
    const tris = new Float32Array(col, 0, nt * 9)
    if (course.mirror) mirrorCollision(tris)
    w.physics.mirrored = !!course.mirror
    w.physics.fields = (w.info as any).fields?.length ? new ForceFields((w.info as any).fields) : null
    w.physics.addMesh(tris, new Float32Array(col, nt * 36, nt), 0.5)
    // what CPU cars learnt on this course in training (test/train.ts): corners to take slower,
    // forks to leave alone
    const mem = Bun.file(ROOT + files.base.slice(1) + `ai-${course.id.replace(':', '-')}.json`)
    if (await mem.exists()) loadMemory(w.info, Object.assign(await mem.json(), process.env.AI_NOCAPS ? { caps: [] } : {}))
    if (process.env.AI_GRIP) TUNE.grip = Number(process.env.AI_GRIP)
    if (process.env.AI_BRAKE) TUNE.brake = Number(process.env.AI_BRAKE)
    if (process.env.AI_LEARN === '0') TUNE.learn = false
    const star = w.info.objects?.find((o) => o.type === 50 && !o.p[0])
    if (star) w.star = new THREE.Vector3(...star.pos)
    if (w.info.train) w.train = new TrainBody(w.info.train, w.physics, serverClock())
    if (w.info.objects?.length) {
      w.objects = new ObjectBodies(w.info, w.physics)
      await w.objects.addTrolleys(loadCarInfo)
      if (w.objects.net.size || w.info.throws?.length) w.objNet = new ObjectNet(w.objects, w.physics)
    }
    w.weapons = new Weapons({
      scene: new THREE.Scene(), physics: w.physics, track: w.info, fx: null, play: () => {},
      send: (owner, m) => hooks.message(owner, m),
      serverNow: serverClock,
      local: 0,
      owned: () => w.owned(),
      cars: () => w.allCars(),
    })
    await w.weapons.load()
    return w
  }

  get count() {
    return this.drivers.size
  }

  private standing(d: Driver) {
    const racing = this.phase === 'race' || this.phase === 'grid'
    const mine = d.meter.value
    let place = 1, of = 1
    if (racing) {
      for (const o of this.drivers.values()) if (o !== d) { of++; if (o.meter.value > mine) place++ }
      for (const h of this.humans.values()) if (h.flags & 2) { of++; if (h.progress > mine) place++ }
    }
    return { place, of, progress: mine, racing }
  }

  private owned(): Owned[] {
    return [...this.drivers.values()].map((d) => ({
      id: d.id, car: d.car, canPick: this.phase !== 'grid', standing: this.standing(d),
    }))
  }

  private allCars() {
    const list: { id: number; car: Car }[] = []
    for (const d of this.drivers.values()) list.push({ id: d.id, car: d.car })
    for (const [id, r] of this.humans) if (performance.now() - r.lastHeard < 2500) list.push({ id, car: r.car })
    return list
  }

  async addAi(id: number, key: string, slot: number) {
    const loaded = await loadCarInfo(key)
    const g = gridSlot(this.info, this.physics, slot)
    const car = new Car(this.physics, loaded, g.pos, g.yaw)
    car.iceLag = Number(process.env.AI_ICELAG ?? 0.15)
    // a little variety: some dare more grip in the corners than others
    const pace = 0.95 + Math.random() * 0.1
    this.drivers.set(id, {
      id, key, car, pilot: new AiDriver(this.info, {
        // every third grid slot (0, 3, 6…) knows the course's shortcuts (AiDriver smart)
        pace, route: 0.3, physics: this.physics, smart: process.env.AI_SMART ? process.env.AI_SMART === '1' : slot % 3 === 0,
        hasTurbo: () => this.weapons.inv.get(id)?.w === 'turbo',
        // loose props, and the oil, ball bearings and fake stars on the track ("CPU should avoid hazards on road")
        obstacles: () => (process.env.AI_HAZARDS === '0' ? this.objects?.obstacles() ?? [] : [...(this.objects?.obstacles() ?? []), ...this.weapons.hazards()]),
        // empty-handed: steer through the pickup stars near the way (they only had what they ran over)
        seek: () => (!SEEK || this.weapons.inv.has(id) || this.phase !== 'race' ? [] : this.weapons.freePickups()),
        aggro: AGGRO * (0.7 + Math.random() * 0.3),
        seekLat: Number(process.env.AI_SEEKLAT ?? 1.2),
        chase: () => this.bombPrey(id),
      }),
      lap: new LapTracker(this.info), meter: new TrackMeter(this.info), finished: false, bestLap: null, heldSince: 0, nextThink: 0, lockId: 0, lockSince: 0, lastShot: 0, resets: 0, shots: 0, best: 0, bestAt: 0, holdUntil: 0,
    })
    this.ensureRunning()
  }

  removeAll() {
    for (const d of this.drivers.values()) d.car.destroy()
    this.drivers.clear()
    this.weapons.reset()
    this.weapons.inv.clear()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // people still on the course: the loose objects keep going
    if (this.active && this.humans.size && this.objNet) this.ensureRunning()
  }

  /** Put an AI back on its grid slot (new race). */
  placeOnGrid(id: number, slot: number) {
    const d = this.drivers.get(id)
    if (!d) return
    const g = gridSlot(this.info, this.physics, slot)
    d.car.place(g.pos, g.yaw)
  }

  setPhase(p: Phase) {
    this.phase = p
    if (p === 'results' && this.drivers.size) this.report()
    if (p === 'race') {
      this.perf = { ticks: 0, total: 0, worst: 0, late: 0 }
      this.raceStart = performance.now()
      for (const d of this.drivers.values()) {
        d.lap.reset()
        d.lap.lapStart = this.raceStart
        d.finished = false
        d.bestLap = null
      }
    }
    if (p === 'grid') {
      this.starSent = false
      this.weapons.reset()
      for (const d of this.drivers.values()) { d.meter.reset(); d.best = 0; d.bestAt = 0 }
    }
  }

  /**
   * A CPU car still out when the race ends: its finishing time projected from its pace so far
   * (as original game fills in the cars still running), or null if it has barely moved.
   */
  projectFinish(id: number, elapsed: number): number | null {
    const d = this.drivers.get(id)
    if (!d || d.finished) return null
    const done = d.meter.value, total = LAPS * d.meter.length
    if (done < total * 0.1 || elapsed < 5000) return null
    return Math.round(elapsed * Math.max(1, total / done))
  }

  /** Each CPU car's progress, for projectFinish() from outside a worker: [id, metres, race metres, finished]. */
  progress(): [number, number, number, boolean][] {
    return [...this.drivers.values()].map((d) => [d.id, d.meter.value, LAPS * d.meter.length, d.finished])
  }

  // --- humans (their cars in this world)

  setHumanCar(id: number, key: string | null) {
    const had = this.humanCars.get(id)
    if (had === key) return
    this.humans.get(id)?.destroy()
    this.humans.delete(id)
    if (!key) {
      this.humanCars.delete(id)
      return
    }
    this.humanCars.set(id, key)
    loadCarInfo(key).then((loaded) => {
      if (this.humanCars.get(id) !== key || this.humans.has(id)) return
      this.humans.set(id, new RemoteCar(this.physics, loaded, id, key))
      if (this.active && this.objNet) this.ensureRunning()
    })
  }

  onHumanState(id: number, time: number, f: Float32Array) {
    this.humans.get(id)?.push(time, f, performance.now())
  }

  onServerMsg(m: ServerMsg) {
    // who had the bomb before: can't take it straight back (the lobby refuses a pass-back for 1.2 s)
    if (m.t === 'bomb' && m.holder !== this.weapons.bomb.holder) this.bombFrom = { id: this.weapons.bomb.holder, at: performance.now() }
    if (m.t === 'pickups' || m.t === 'fire' || m.t === 'det' || m.t === 'bomb' || m.t === 'boom') this.weapons.onMessage(m)
  }

  private bombFrom = { id: 0, at: 0 }
  /** A CPU car holding the putty bomb: the nearest rival it can see within 35 m to ram (AiDriver chase). */
  private bombPrey(id: number): { pos: THREE.Vector3; vel: THREE.Vector3 } | null {
    if (this.weapons.bomb.holder !== id || this.phase !== 'race' || process.env.AI_CHASE === '0') return null
    const me = this.drivers.get(id)?.car
    if (!me) return null
    let best: Car | null = null, bd = 35 * 35
    for (const o of this.allCars()) {
      if (o.id === id || (o.id === this.bombFrom.id && performance.now() - this.bombFrom.at < 1300)) continue
      const d2 = o.car.position.distanceToSquared(me.position)
      if (d2 >= bd || Math.abs(o.car.position.y - me.position.y) > 1.5) continue
      // a clear line to it (not through a wall)
      const from = me.position.clone().add(new THREE.Vector3(0, 0.2, 0)), dir = o.car.position.clone().add(new THREE.Vector3(0, 0.2, 0)).sub(from)
      const len = dir.length()
      const hit = this.physics.raycast(from.toArray(), dir.divideScalar(len).toArray(), len)
      if (hit && hit.dist < len - 0.6) continue
      best = o.car
      bd = d2
    }
    if (!best) return null
    const v = (best as { velocity?: THREE.Vector3 }).velocity
    return { pos: best.position.clone(), vel: v ? new THREE.Vector3(v.x, 0, v.z) : new THREE.Vector3() }
  }

  give(id: number, w: Parameters<Weapons['give']>[1], n: number) {
    this.weapons.give(id, w, n)
    const d = this.drivers.get(id)
    if (d) d.heldSince = performance.now()
  }

  // --- simulation

  /** Stop simulating (the world is being dropped). */
  dispose() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const d of this.drivers.values()) d.car.destroy()
    this.drivers.clear()
  }

  setActive(on: boolean) {
    this.active = on
    if (on && this.humans.size && this.objNet) this.ensureRunning()
  }

  private ensureRunning() {
    if (this.timer) return
    this.last = performance.now()
    this.timer = setInterval(() => this.tick(), 1000 / 60)
  }

  /** One log line per race: each AI's resets / shots / best lap, and the server's tick cost. */
  private report() {
    const p = this.perf
    const ai = [...this.drivers.values()].map((d) =>
      `${d.key} ${d.finished ? 'fin' : 'dnf'} best ${d.bestLap ? (d.bestLap / 1000).toFixed(1) : '-'}s resets ${d.resets} shots ${d.shots}`)
    console.log(`AI race: ${ai.join(' · ')} | tick ${p.ticks ? (p.total / p.ticks).toFixed(2) : 0} ms avg, ${p.worst.toFixed(1)} worst, ${p.late} late (>25 ms apart)`)
  }

  private tick() {
    const now = performance.now()
    if (this.phase === 'race' && now - this.last > 25) this.perf.late++
    try {
      this.step(now)
    } finally {
      if (this.phase === 'race') {
        const took = performance.now() - now
        this.perf.ticks++
        this.perf.total += took
        this.perf.worst = Math.max(this.perf.worst, took)
      }
    }
  }

  private step(now: number) {
    let frame = (now - this.last) / 1000
    this.last = now
    if (frame > 0.25) frame = 0.25
    if (this.drivers.size === 0 && !(this.active && this.objNet && this.humans.size)) return
    this.acc += frame
    const sNow = performance.timeOrigin + now // serverClock() at this tick's `now`
    while (this.acc >= DT) {
      for (const h of this.humans.values()) h.step(sNow - (this.acc - DT) * 1000, now) // the moment this step reaches
      for (const d of this.drivers.values()) this.drive(d, now)
      this.train?.step(sNow - this.acc * 1000) // where it is as this step begins
      this.objects?.step(sNow - this.acc * 1000)
      this.physics.step(DT, 2)
      for (const h of this.humans.values()) {
        h.nearLocal = [...this.drivers.values()].some((d) => d.car.position.distanceToSquared(h.car.position) < 6)
        h.afterStep(now, DT, 22)
      }
      if (this.phase === 'grid') {
        for (const d of this.drivers.values()) {
          const s = d.car.readState()
          this.physics.setVelocity(d.car.id, [0, Math.min(0, s.vel[1]), 0], [0, 0, 0])
        }
      }
      this.acc -= DT
    }
    for (const h of this.humans.values()) h.car.readState()
    for (const d of this.drivers.values()) {
      d.car.readState()
      d.car.now = now
      d.meter.update(d.car.position)
      // laps
      if (this.phase === 'race' && !d.finished && d.lap.update(d.car.position, now) === 'lap') {
        const lt = d.lap.lapTimes[d.lap.lapTimes.length - 1]
        if (d.bestLap === null || lt < d.bestLap) d.bestLap = lt
        this.hooks.lap?.(d.id, d.lap.completedLaps(), lt)
        if (d.lap.completedLaps() >= LAPS) {
          d.finished = true
          this.hooks.finish(d.id, now - this.raceStart, d.bestLap)
        }
      }
    }
    this.weapons.update(frame)
    // the loose objects: throws from the triggers, and their states for every browser
    if (this.objects && this.active) {
      const cars = [...this.drivers.values()].map((d) => d.car.position)
      for (const h of this.humans.values()) if (performance.now() - h.lastHeard < 2500) cars.push(h.car.position)
      this.objects.throwCheck(cars, now)
      for (const p of this.objNet?.packets(sNow - this.acc * 1000, frame) ?? []) this.hooks.objects?.(p)
    }
    // states out
    this.sendAcc += frame
    // CPU cars go out at AI_STATE_HZ — every 1/60 s tick (2026-10-12; at the browsers' 30 Hz each
    // update was on average ~16 ms old when it left). A hair's margin: two ticks can come in just
    // under 1/60 s apart
    if (this.sendAcc >= 1 / AI_STATE_HZ - 0.004) {
      this.sendAcc = Math.min(1 / AI_STATE_HZ, Math.max(0, this.sendAcc - 1 / AI_STATE_HZ))
      // all of them in one packet (one stamp: they are all at this tick)
      if (this.drivers.size) this.hooks.state(packCars(sNow - this.acc * 1000, [...this.drivers.values()].map((d) => ({ id: d.id, f: this.carState(d) }))))
    }
  }

  private drive(d: Driver, now: number) {
    let ctl: Controls = { throttle: 0, steer: 0, handbrake: false }
    if (d.finished || this.phase === 'results') {
      ctl = stopping(d.car) // past the line: pull up and stay put
    } else if (now < d.holdUntil) {
      ctl = { throttle: 0, steer: 0, handbrake: true } // just put back: held a second, as people are
    } else if (this.phase !== 'grid') {
      const others = this.allCars().filter((c) => c.id !== d.id).map((c) => c.car)
      const c = d.pilot.drive(d.car, DT, others)
      ctl = c
      // no new lap zone for 25 s, whatever the driver thinks: circling somewhere its own checks
      // don't catch (a field of CPU cars once went round near the start for 8 minutes). Zones, not
      // the TrackMeter: that jumps hundreds of metres where a road is driven both ways
      if (d.lap.passes > d.best || !d.bestAt) { d.best = d.lap.passes; d.bestAt = now }
      const lost = this.phase === 'race' && now - d.bestAt > 25000
      if (c.reset || lost || d.car.upsideTime > 1.8 || d.car.position.y < -40) {
        d.bestAt = now
        // kept for test/race.ts: where and why CPU cars needed putting back
        // (+hit: a weapon threw it about or zapped it in the last 4 s — not a driving mistake)
        const hit = now - d.car.hitAt < 4000 || now - d.car.zappedUntil < 2000 ? '+hit' : ''
        this.resetLog.push({ why: (c.reset ? 'stuck' : lost ? 'lost' : d.car.upsideTime > 1.8 ? 'flipped' : 'fell') + hit, pos: d.car.position.toArray(), node: (d.pilot as any).node })
        if (this.resetLog.length > 500) this.resetLog.shift()
        const r = d.pilot.rescueSpot(this.physics) ?? rescuePoint(this.info, this.physics, d.car.position, true)
        d.car.place(r.pos, r.yaw)
        d.holdUntil = now + 1000
        d.resets++
      }
      if (now > d.nextThink) {
        d.nextThink = now + 250
        this.think(d, now)
      }
      // the race's star (src/levelfx.ts): a CPU car driving through it fires the Global Pulse
      if (this.phase === 'race' && !this.starSent && this.star && d.car.position.distanceTo(this.star) < 1.3) {
        this.starSent = true
        this.hooks.message(d.id, { t: 'star', p: this.star.toArray() })
      }
    }
    d.car.now = now
    d.car.drive(ctl, DT)
  }

  /** When to use the weapon in hand. */
  /** How far a CPU car is from the front (AiDriver.risk): + from 15 m behind the leader, full at 60 m;
   *  − leading by 20 m and more, full at 50 m. */
  private setRisk(d: Driver) {
    if (this.phase !== 'race' || process.env.AI_RISK === '0') { d.pilot.risk = 0; return }
    const mine = d.meter.value
    const others: number[] = []
    for (const o of this.drivers.values()) if (o !== d) others.push(o.meter.value)
    for (const h of this.humans.values()) if (h.flags & 2) others.push(h.progress)
    if (!others.length) { d.pilot.risk = 0; return }
    const best = Math.max(...others)
    const behind = best - mine
    d.pilot.risk = behind > 0 ? Math.min(1, Math.max(0, (behind - 15) / 45)) : -Math.min(1, Math.max(0, (-behind - 20) / 30))
  }

  private think(d: Driver, now: number) {
    this.setRisk(d)
    const held = this.weapons.inv.get(d.id)
    if (!held) return
    const waited = now - d.heldSince
    const ahead = (range: number, cone: number) => this.weapons.targetAhead(d.id, d.car, d.car.forward, range, cone)
    const behind = (range: number) => this.weapons.targetAhead(d.id, d.car, d.car.forward.clone().negate(), range, 0.6)
    let go = false
    switch (held.w) {
      case 'shockwave':
      case 'waterBalloons':
        go = EAGER ? ahead(18, 0.85) !== 0 || waited > 8000 : ahead(12, 0.85) !== 0 || waited > 12000
        break
      case 'firework':
      case 'fireworkPack': {
        // aim like a player ("CPU players do not wait for rockets to lock, so they are not a
        // threat"): the reticle's reach and cone, and a shot only once it has sat on the same car for
        // the lock time (+ a reaction) — locked rockets home hard. No more blind shots after 12 s
        const tid = this.weapons.targetAhead(d.id, d.car)
        if (tid !== d.lockId) {
          d.lockId = tid
          d.lockSince = now + Math.random() * (EAGER ? 150 : 250)
        }
        go = !!tid && now - d.lockSince >= LOCK_MS && now - d.lastShot > 450
        if (go) {
          this.weapons.fire(d.id)
          d.heldSince = d.lastShot = now
          d.shots++
        }
        return
      }
      case 'oilSlick':
      case 'ballBearing':
      case 'clone':
        // ("if they have the oil and are close to a restriction like the piano in the toy store,
        // drop it there — only if close enough; don't keep the weapon a whole lap, just a bit"): at once on
        // a car close behind; in a narrow place (AiDriver.inNarrow) after half a second; held up to 12 s
        // for one coming within 60 m, else let go after 7 s
        if (!EAGER) go = behind(7) !== 0 || waited > 9000
        else go = behind(12) !== 0 || (waited > 500 && d.pilot.inNarrow()) || waited > (d.pilot.narrowAhead(60) ? 12000 : 7000)
        break
      case 'electroPulse':
        go = this.weapons.carsNear(d.id, d.car, 2.5) > 0 || waited > 10000
        break
      case 'turbo': {
        // a smart driver keeps it for a fork ahead where the way with a turbo is faster, and fires it there
        if (d.pilot.atTurboFork()) { go = true; d.pilot.turboFork = -1; break }
        if (waited < 20000 && d.pilot.turboForkAhead(150)) break
        // ("save it for the longest straight coming up, or for passing a car just ahead"): on one of
        // the course's longer straights, or a car within 8 m ahead with 25 m of straight to pass it on;
        // after 15 s any straight-ish bit will do
        const straight = d.pilot.straightAhead()
        const passing = ahead(8, 0.5) !== 0 && straight > 25
        go = d.pilot.bend < 0.2 && (straight >= Math.min(80, d.pilot.longStraight()) || passing || (waited > 15000 && straight > 20))
        if (process.env.AI_TURBO === '0') go = d.pilot.bend < 0.25 || waited > 5000
        break
      }
      case 'globalPulse':
      case 'puttyBomb':
        go = waited > 800
        break
    }
    if (go && (EAGER || Math.random() < 0.8)) {
      this.weapons.fire(d.id)
      d.heldSince = d.lastShot = now
      d.shots++
    }
  }

  private carState(d: Driver): Float32Array {
    const s = this.physics.state(d.car.id)
    const f = new Float32Array(STATE_FLOATS)
    f.set(s.pos, 0)
    f.set(s.quat, 3)
    f.set(s.vel, 7)
    f.set(s.ang, 10)
    f[13] = d.car.steer
    const racing = this.phase === 'race' || this.phase === 'grid'
    f[14] = racing ? d.meter.value : 0
    f[15] = (racing ? 2 : 0) | (d.finished ? 1 : 0) | this.weapons.flags(d.id)
    return f
  }
}
