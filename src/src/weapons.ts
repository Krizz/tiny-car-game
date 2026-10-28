// Pickups and weapons, after original game.
//
// Authority (what keeps 16 browsers + the server's AI in agreement):
//   - the SERVER owns the pickup stars (free/taken), what each star gives, and
//     the putty bomb (holder + fuse);
//   - firing is an event ({w, shot, at, d}) relayed to everyone; every instance
//     flies the projectile itself from the same start, fast-forwarded by the
//     event's age, so it's in the same place everywhere;
//   - each instance decides only what happens to the cars it OWNS (was it hit,
//     is it in the blast, did it drive over oil): a browser owns its player's
//     car, the server owns the AI cars — the same rule as the driving.
// The server runs this headless (deps.fx = null: no meshes, sprites or sound).
import * as THREE from 'three'
import type { Car } from './car'
import type { Physics } from './physics'
import type { TrackInfo } from './assets'
import { geometry, material, type MeshMeta } from './assets'
import { type Fx, SPR, loadFxPages, pageTexture } from './fx'
import { AMMO, BOMB_FUSE_MS, type ClientMsg, type ServerMsg, type Weapon } from '../shared/protocol'

type Play = (name: any, volume?: number, rate?: number) => void

export interface Standing { place: number; of: number; progress: number; racing: boolean }

/** A car this instance is responsible for. */
export interface Owned {
  id: number
  car: Car
  canPick: boolean // racing or free-driving, not on the grid / spectating
  standing: Standing
}

export interface WeaponDeps {
  scene: THREE.Scene
  physics: Physics
  track: TrackInfo
  fx: Fx | null // null = headless (the server)
  send: (owner: number, m: ClientMsg) => void
  serverNow: () => number
  owned: () => Owned[]
  /** every car in this world that is in play (owned and others) */
  cars: () => { id: number; car: Car }[]
  play: Play
  /** where the listener is (the camera): other cars' weapons fade with distance from it */
  listener?: () => THREE.Vector3
  local: number | (() => number) // the player whose HUD this is (0 on the server)
}

interface Projectile {
  kind: 'shock' | 'rocket' | 'balloon'
  shot: number
  owner: number
  pos: THREE.Vector3
  vel: THREE.Vector3
  target: number // player id, 0 = none
  age: number
  life: number
  felt?: boolean // the shockwave has shaken our car (one sound)
  mesh: THREE.Object3D | null
  trail: number
}

// The shockwave (as in the original executable): a ball along the nose (60 m/s there;
// 40 here — at 60 it passed too quickly to lift anyone, with our car masses) that,
// all the way, lifts every other car within 10 m of it (height counts 10×, so about a metre up or
// down) at up to 2 g and rolls it about its own length, both fading as 1 − r²/100 m². It flies
// through cars; only a wall stops it (and goes off there)
const SHOCK_SPEED = 40
const SHOCK_R = 10 // m
// ("much more powerful" — the exe multiplies its lift by the car's mass too)
const SHOCK_LIFT = 90 // m/s² at the centre (g = 22)
const SHOCK_ROLL = 45 // rad/s² at the centre
const SOUND_RANGE = 60 // m: other cars' weapons further away than this are not heard
const SHOCK_PUSH = 30 // m/s² away from the ball, along the ground — the knock-back (not in the exe)
const ROCKET_SPEED = 21
const ROCKET_SKIM = 0.35 // m: rockets fly at least this far over the floor; only walls and cars stop them
// original game's firework lock: the reticle sits red on the car ahead and turns green once it has held
// it LOCK_MS; a rocket fired locked homes hard (it nearly always hits), one fired before flies
// loose (below). The shot carries its target as +id (locked) or 0 / -id (not yet: loose).
export const LOCK_MS = 700
const HOME_LOCKED = 6 // turn rate, 1/s
// Not locked: no homing at all. In the original executable the rocket leaves
// along 2/3 nose + 1/3 roof (~27° up) at the car's own speed and is a loose body — gravity on, a
// motor of half a gravity along it — so it arcs, lands and bounces ahead of you until it goes off
// after 1.2 s; it never goes off on its owner by touch, but its blast reaches anyone (you included)
const FREE_LAUNCH = 7 // m/s on top of the car's velocity
const FREE_MOTOR = 11 // m/s² (half of g)
const FREE_LIFE = 1.2 // s
const GRAVITY = 22
const BALLOON_SPEED = 20 // + 7 m/s up: ~14 m on the flat (was 13 + 4: ~6 m)
const BALLOON_LIFT = 7
const FIREWORK_RANGE = 40 // lock-on reach (m); was 14
const PICK_RADIUS = 0.75
const ZAP_MS = 2500
const AURA_MS = 6000
const AURA_RADIUS = 2.2
const OIL_MS = 30000
const OIL_RADIUS = 0.7
const OIL_GRIP_MS = 1200 // a tyre out of the oil gets its grip back after this
const OIL_TRACK_MS = 3000 // ... and leaves an oily track this long, fading
const CLONE_MS = 40000
const BALL_MS = 20000

const v3 = (a: ArrayLike<number>, o = 0) => new THREE.Vector3(a[o], a[o + 1], a[o + 2])

// the ball bearing: 90 cm across ("make it bigger" — it was 60 cm), heavy to match
const BALL_R = 0.45, BALL_MASS = 14

export class Weapons {
  /** what each owned car is holding */
  inv = new Map<number, { w: Weapon; n: number }>()
  bomb = { holder: 0, until: 0 }
  private models: Record<string, () => THREE.Object3D> = {}
  private pickups: { pos: THREE.Vector3; mesh: THREE.Object3D | null; glow: THREE.Sprite | null; until: number; pending: number }[] = []
  private projectiles: Projectile[] = []
  private oils: { pos: THREE.Vector3; until: number }[] = []
  private clones: { shot: number; pos: THREE.Vector3; mesh: THREE.Object3D | null; until: number; armed: number }[] = []
  private balls: { id: number; mesh: THREE.Object3D | null; until: number }[] = []
  private auras = new Map<number, number>() // player id -> performance.now() until
  private shotSeq = 1
  private puttied: Car | null = null // the car drawn black (bomb holder)
  private reticle: THREE.Sprite | null = null
  private lockOn = 0 // car the reticle is on
  private lockSince = 0
  private lastPass = new Map<number, number>()
  private fxTimer = 0
  private lastFuseTick = 0
  private visual: boolean

  constructor(private d: WeaponDeps) {
    this.visual = !!d.fx
  }

  private get local(): number {
    return typeof this.d.local === 'function' ? this.d.local() : this.d.local
  }

  /** The local player's weapon (HUD). */
  get held(): Weapon | null {
    return this.inv.get(this.local)?.w ?? null
  }
  get ammo(): number {
    return this.inv.get(this.local)?.n ?? 0
  }

  async load() {
    if (this.visual) {
      await loadFxPages()
      const [meta, bin] = await Promise.all([
        fetch('/game/fx/models.json').then((r) => r.json() as Promise<Record<string, MeshMeta>>),
        fetch('/game/fx/models.bin').then((r) => r.arrayBuffer()),
      ])
      for (const [name, m] of Object.entries(meta)) {
        const geo = geometry(bin, m)
        const mats = m.groups.map((g) => material(g, g.texture ? pageTexture(Number(g.texture[2]) as 1 | 2 | 3) : null))
        this.models[name] = () => new THREE.Mesh(geo, mats)
      }
      // the ball bearing: Sphere.m has no texture of its own — the game draws it as dark steel
      // with gfx/envroll.bmp (a sphere map of streaky reflections) added on top
      const env = await new Promise<HTMLImageElement | null>((ok) => {
        const img = new Image()
        img.onload = () => ok(img)
        img.onerror = () => ok(null)
        img.src = '/game/fx/envroll.png'
      })
      // a chrome matcap: bright sky above a dark horizon, the warm floor below, a hard highlight;
      // the game's own envroll streaks over it, faintly (on their own they read as a dark rock)
      const cv = document.createElement('canvas')
      cv.width = cv.height = 256
      const g = cv.getContext('2d')!
      const sky = g.createLinearGradient(0, 0, 0, 256)
      sky.addColorStop(0, '#f4f8ff')
      sky.addColorStop(0.38, '#b9c9de')
      sky.addColorStop(0.5, '#3a4250')
      sky.addColorStop(0.54, '#20242b')
      sky.addColorStop(0.62, '#7d6f5e')
      sky.addColorStop(1, '#3b332b')
      g.fillStyle = sky
      g.beginPath()
      g.arc(128, 128, 128, 0, Math.PI * 2)
      g.fill()
      // darker towards the rim (Fresnel the other way round reads as metal)
      const rim = g.createRadialGradient(128, 128, 60, 128, 128, 128)
      rim.addColorStop(0, 'rgba(0,0,0,0)')
      rim.addColorStop(1, 'rgba(0,0,0,0.45)')
      g.fillStyle = rim
      g.fill()
      const hi = g.createRadialGradient(88, 70, 0, 88, 70, 40)
      hi.addColorStop(0, 'rgba(255,255,255,1)')
      hi.addColorStop(0.35, 'rgba(255,255,255,0.75)')
      hi.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = hi
      g.fillRect(0, 0, 256, 256)
      g.globalCompositeOperation = 'lighter'
      g.globalAlpha = 0.18
      if (env) g.drawImage(env, 0, 0, 256, 256)
      g.globalAlpha = 1
      const matcap = new THREE.CanvasTexture(cv)
      matcap.colorSpace = THREE.SRGBColorSpace
      const steel = new THREE.MeshMatcapMaterial({ matcap })
      const sphere = this.models.sphere ? (this.models.sphere() as THREE.Mesh).geometry.clone() : new THREE.SphereGeometry(0.15, 24, 16)
      // smooth: the model's faces share no vertices (flat facets), and it is a sphere — out from the centre
      sphere.computeBoundingSphere()
      const c = sphere.boundingSphere!.center, pa = sphere.getAttribute('position')
      const nrm = new Float32Array(pa.count * 3), t = new THREE.Vector3()
      for (let i = 0; i < pa.count; i++) {
        t.fromBufferAttribute(pa, i).sub(c).normalize()
        nrm.set([t.x, t.y, t.z], i * 3)
      }
      sphere.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
      // centred, and as big as the ball the physics rolls (BALL_R; Sphere.m itself is 60 cm across)
      sphere.translate(-c.x, -c.y, -c.z)
      const k = BALL_R / (sphere.boundingSphere!.radius || 0.15)
      this.models.steelBall = () => {
        const m = new THREE.Mesh(sphere, steel)
        m.scale.setScalar(k)
        return m
      }
    }
    // pickup stars on the track
    for (const p of this.d.track.pickups ?? []) {
      const pos = v3(p)
      let mesh: THREE.Object3D | null = null, glow: THREE.Sprite | null = null
      if (this.visual) {
        // as the level has it: pickup.m hangs 42 cm under its origin, which the .fob puts ~60 cm
        // over the floor, so the star floats ~18 cm up (it was shrunk to 0.75 and lifted 15 cm)
        mesh = this.model('pickup', 1)!
        mesh.position.copy(pos)
        glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: fxTex(SPR.flare), color: 0xffd060, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
        }))
        glow.scale.setScalar(0.9)
        glow.position.copy(mesh.position)
        this.d.scene.add(mesh, glow)
      }
      this.pickups.push({ pos, mesh, glow, until: 0, pending: 0 })
    }
  }

  /** A fresh mesh of one of the fx models (models.json), or null before load / unknown. */
  make(name: string): THREE.Object3D | null {
    return this.models[name]?.() ?? null
  }

  /** Every weapon model, for compiling their shaders at load (the first shot stuttered while they compiled). */
  warmGroup(): THREE.Group {
    const g = new THREE.Group()
    for (const make of Object.values(this.models)) g.add(make())
    return g
  }

  private model(name: string, scale: number, tint?: number): THREE.Object3D | null {
    if (!this.visual) return null
    const m = this.models[name]?.() ?? new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0x888888 }))
    if (tint !== undefined && m instanceof THREE.Mesh) {
      m.material = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => {
        const c = (x as THREE.MeshBasicMaterial).clone()
        c.color.set(tint)
        return c
      })
    }
    m.scale.setScalar(scale)
    return m
  }

  private add(o: THREE.Object3D | null) {
    if (o) this.d.scene.add(o)
  }

  /** at: where it happens — fades with the distance to the listener (every CPU car's weapons
   *  could be heard across the level). Without it, or for our own car's weapons: full volume */
  private sound(name: string, v = 1, rate = 1, at?: THREE.Vector3 | null, owner?: number) {
    if (!this.visual) return
    const ear = this.d.listener?.()
    if (at && ear && owner !== this.local) {
      const d = at.distanceTo(ear)
      if (d > SOUND_RANGE) return
      v *= 1 / (1 + Math.max(0, d - 4) * 0.2) * Math.min(1, (SOUND_RANGE - d) / 15)
      if (v < 0.02) return
    }
    this.d.play(name, v, rate)
  }

  // ------------------------------------------------------------ server messages

  onMessage(m: ServerMsg) {
    switch (m.t) {
      case 'pickups': {
        const map = new Map(m.taken)
        this.pickups.forEach((p, i) => (p.until = map.get(i) ?? 0))
        break
      }
      case 'weapon':
        this.give(this.local, m.w, m.n)
        break
      case 'fire':
        this.spawn(m.id, m.w, m.shot, m.at, m.d)
        break
      case 'det':
        this.detonateClone(m.shot, v3(m.p))
        break
      case 'bomb':
        this.bomb = { holder: m.holder, until: m.until }
        if (m.holder && m.holder === this.local) this.sound('fuse', 0.8)
        break
      case 'boom':
        this.boom(m.holder)
        break
    }
  }

  /** a Global Pulse went off: the race's star is gone (src/levelfx.ts) */
  onGlobal: () => void = () => {}
  /** an explosion (power 0..1) at a place: the game shakes the camera when it is near */
  onBlast: (at: THREE.Vector3, power: number) => void = () => {}

  give(id: number, w: Weapon | null, n: number) {
    if (w && w !== this.inv.get(id)?.w && id === this.local) this.sound('pickup', 0.8)
    if (w && n > 0) this.inv.set(id, { w, n })
    else this.inv.delete(id)
    // the putty bomb goes off by itself ("bomb should activate automatically"):
    // a car of ours that picks one up has it armed a moment later — no fire button
    if (w === 'puttyBomb' && n > 0 && this.d.owned().some((x) => x.id === id)) {
      setTimeout(() => {
        if (this.inv.get(id)?.w === 'puttyBomb') this.fire(id)
      }, 350)
    }
  }

  reset() {
    for (const p of this.projectiles) p.mesh?.removeFromParent()
    for (const c of this.clones) c.mesh?.removeFromParent()
    for (const b of this.balls) {
      this.d.physics.destroyCar(b.id)
      b.mesh?.removeFromParent()
    }
    this.projectiles = []
    this.clones = []
    this.balls = []
    this.oils = []
    this.auras.clear()
  }

  // ------------------------------------------------------------ firing (an owned car)

  fire(ownerId = this.local) {
    const held = this.inv.get(ownerId)
    const o = this.d.owned().find((x) => x.id === ownerId)
    if (!held || held.n <= 0 || !o) return
    const w = held.w
    const me = o.car
    const st = this.d.physics.state(me.id)
    const vel = v3(st.vel)
    const fwd = me.forward.clone()
    const up = me.upAxis.clone()
    const front = me.position.clone().addScaledVector(fwd, 0.55).addScaledVector(up, 0.12)
    const ownSpeed = Math.max(0, vel.dot(fwd)) // shots leave at their speed on top of ours: we can't catch them
    const back = me.position.clone().addScaledVector(fwd, -0.65).addScaledVector(up, 0.1)
    let d: number[] = []
    switch (w) {
      case 'shockwave': {
        const dir = fwd.clone().setY(0).normalize()
        d = [...front.toArray(), ...dir.multiplyScalar(SHOCK_SPEED + ownSpeed).toArray(), 0]
        break
      }
      case 'firework':
      case 'fireworkPack': {
        // off the roof and a touch upwards: along the nose from bumper height, a rocket with nothing
        // to home on met the floor at the first dip or rise — 8–11 m, never its full flight
        const target = this.shotTarget(ownerId, me, fwd)
        if (target > 0) {
          const dir = fwd.clone().addScaledVector(up, 0.06).normalize()
          const from = front.clone().addScaledVector(up, ROCKET_SKIM - 0.12)
          d = [...from.toArray(), ...dir.multiplyScalar(ROCKET_SPEED + ownSpeed).toArray(), target]
        } else {
          const dir = fwd.clone().multiplyScalar(2).add(up).normalize()
          const from = front.clone().addScaledVector(up, 0.2)
          d = [...from.toArray(), ...vel.clone().addScaledVector(dir, FREE_LAUNCH).toArray(), 0]
        }
        break
      }
      case 'waterBalloons':
        d = [...front.toArray(), ...fwd.clone().multiplyScalar(BALLOON_SPEED).add(vel).add(new THREE.Vector3(0, BALLOON_LIFT, 0)).toArray(), 0]
        break
      case 'oilSlick': {
        // its edge just clear of this car's back wheels (at 0.65 m behind the centre the dropper's own
        // back tyres were in it — "I get oiled myself when I drop it")
        let rear = 0
        me.info.wheels.forEach((wi, i) => {
          if (wi.present) rear = Math.max(rear, -me.wheels[i].rest.clone().applyQuaternion(me.quaternion).dot(fwd))
        })
        const at = me.position.clone().addScaledVector(fwd, -(rear + OIL_RADIUS + 0.25)).addScaledVector(up, 0.1)
        const hit = this.d.physics.raycast([at.x, at.y + 0.3, at.z], [0, -1, 0], 2)
        if (!hit) return
        d = [...hit.point, ...hit.normal]
        break
      }
      case 'ballBearing': {
        // dropped just clear of the tail, its foot near the floor (a bigger ball from `back` started
        // inside the car)
        const at = me.position.clone().addScaledVector(fwd, -(0.55 + BALL_R)).addScaledVector(up, BALL_R - 0.2)
        d = [...at.toArray(), ...vel.clone().multiplyScalar(0.5).addScaledVector(fwd, -1.5).toArray()]
        break
      }
      case 'clone': {
        const hit = this.d.physics.raycast([back.x, back.y + 0.3, back.z], [0, -1, 0], 2)
        d = hit ? [...hit.point] : back.toArray()
        break
      }
      case 'electroPulse':
        d = [AURA_MS]
        break
      case 'globalPulse':
        d = [o.standing.progress, ...me.position.toArray()]
        break
      case 'turbo':
      case 'puttyBomb':
        d = []
        break
    }
    const shot = ownerId * 100000 + this.shotSeq++
    const at = this.d.serverNow()
    this.d.send(ownerId, { t: 'fire', w, shot, at, d })
    held.n--
    if (held.n <= 0) this.inv.delete(ownerId)
    if (w !== 'puttyBomb') this.spawn(ownerId, w, shot, at, d)
  }

  /**
   * The nearest car roughly ahead of `me` within `range` that can be seen (not behind a wall),
   * else 0 — the firework's lock-on and the AI's aiming. Lock-on reaches FIREWORK_RANGE.
   */
  /** A rocket's target: +id when locked on, -id when the reticle is on it but not locked yet.
   *  The server's CPU cars aim before they fire: locked. */
  private shotTarget(ownerId: number, me: Car, fwd: THREE.Vector3): number {
    const id = this.targetAhead(ownerId, me, fwd)
    if (!id || ownerId !== this.local) return id
    return id === this.lockOn && performance.now() - this.lockSince >= LOCK_MS ? id : -id
  }

  /** Hazards on the track for CPU drivers to steer round, [x, y, z, r] like ObjectBodies.obstacles (r with
   *  0.3 m for the car's width): oil slicks and ball bearings (where they have rolled to). Not fake stars —
   *  a CPU driver can't tell one from a real star, so it goes for them (freePickups) */
  hazards(): number[][] {
    const out: number[][] = []
    const now = performance.now()
    for (const o of this.oils) if (o.until > now) out.push([o.pos.x, o.pos.y, o.pos.z, OIL_RADIUS + 0.3])
    for (const b of this.balls) {
      const p = this.d.physics.state(b.id).pos
      out.push([p[0], p[1], p[2], BALL_R + 0.3])
    }
    return out
  }

  /** Pickup stars that can be taken now, and armed fake stars (CPU drivers steer for them). */
  freePickups(): THREE.Vector3[] {
    const now = performance.now(), sNow = this.d.serverNow()
    // fake stars too: they look like the real thing (its position is the floor; a star floats 0.6 m up)
    return [...this.pickups.filter((p) => p.until <= sNow && p.pending < now).map((p) => p.pos),
      ...this.clones.filter((c) => c.armed < now).map((c) => c.pos)]
  }

  targetAhead(ownerId: number, me: Car, fwd = me.forward, range = FIREWORK_RANGE, cone = 0.55): number {
    let best = 0, bd = range
    for (const { id, car } of this.d.cars()) {
      if (id === ownerId) continue
      const to = car.position.clone().sub(me.position)
      const dist = to.length()
      if (dist < bd && to.normalize().dot(fwd) > cone && this.inSight(me.position, car.position, dist)) {
        bd = dist
        best = id
      }
    }
    return best
  }

  /** Nothing solid between two cars (a ray 25 cm up, so the floor doesn't count). */
  private inSight(a: THREE.Vector3, b: THREE.Vector3, dist: number): boolean {
    if (dist < 3) return true
    const from = a.clone().add(new THREE.Vector3(0, 0.25, 0))
    const dir = b.clone().add(new THREE.Vector3(0, 0.25, 0)).sub(from).normalize()
    const hit = this.d.physics.raycast(from.addScaledVector(dir, 0.8).toArray(), dir.toArray(), dist - 1.6)
    return !hit
  }

  private carOf(id: number): Car | null {
    return this.d.cars().find((c) => c.id === id)?.car ?? null
  }

  // ------------------------------------------------------------ spawning (everyone)

  private spawn(owner: number, w: Weapon, shot: number, at: number, d: number[]) {
    const now = performance.now()
    const fx = this.d.fx
    const age = Math.max(0, Math.min(0.5, (this.d.serverNow() - at) / 1000))
    const ownerCar = this.carOf(owner)
    switch (w) {
      case 'shockwave':
      case 'firework':
      case 'fireworkPack':
      case 'waterBalloons': {
        const kind = w === 'shockwave' ? 'shock' : w === 'waterBalloons' ? 'balloon' : 'rocket'
        const mesh = !this.visual ? null : kind === 'shock' ? this.shockMesh() : kind === 'balloon' ? this.model('wbomb', 0.42) /* a bit bigger (was 0.28) */ : this.model('firework', 0.35)
        const p: Projectile = { kind, shot, owner, pos: v3(d), vel: v3(d, 3), target: d[6] ?? 0, age: 0, life: kind === 'shock' ? 2.5 : kind === 'rocket' && !((d[6] ?? 0) > 0) ? FREE_LIFE : 3.2, mesh, trail: 0 }
        this.add(mesh)
        this.projectiles.push(p)
        this.sound(kind === 'shock' ? 'shockfire' : kind === 'balloon' ? 'wbombfire' : 'firefire', 0.8, 1, p.pos, owner)
        for (let t = 0; t < age; t += 1 / 60) if (!this.advance(p, Math.min(1 / 60, age - t))) break
        break
      }
      case 'oilSlick': {
        const pos = v3(d), n = v3(d, 3)
        fx?.decal(SPR.disc, pos, n, 1.3, 0x0a0806, OIL_MS / 1000, 0.92)
        fx?.decal(SPR.glint, pos.clone().addScaledVector(n, 0.002), n, 0.9, 0x6a5a8a, OIL_MS / 1000, 0.35)
        this.oils.push({ pos, until: now + OIL_MS })
        this.sound('oildrop', 0.8, 1, pos, owner)
        break
      }
      case 'ballBearing': {
        const pos = v3(d)
        const id = this.d.physics.createBall(BALL_R, BALL_MASS, pos.toArray(), [d[3], d[4], d[5]], 0.5, 0.25)
        if (id < 0) break
        const mesh = this.make('steelBall') // sized to BALL_R at load (Sphere.m; ball.m is the beach ball)
        this.add(mesh)
        this.balls.push({ id, mesh, until: now + BALL_MS })
        this.sound('balldrop', 0.8, 1, pos, owner)
        break
      }
      case 'clone': {
        const mesh = this.model('pickup', 1)
        const pos = v3(d)
        mesh?.position.copy(pos).add(new THREE.Vector3(0, 0.6, 0)) // d = the floor: at a real star's height
        this.add(mesh)
        // armed after a second, so it doesn't go off under the car that dropped it
        this.clones.push({ shot, pos, mesh, until: now + CLONE_MS, armed: now + 1000 - age * 1000 })
        break
      }
      case 'electroPulse':
        this.auras.set(owner, now + (d[0] || AURA_MS) - age * 1000)
        this.sound('electro', 0.7, 1, ownerCar?.position, owner)
        break
      case 'turbo': {
        const o = this.d.owned().find((x) => x.id === owner)
        if (o) o.car.turboUntil = now + 4000
        this.sound('turbo', 0.8, 1, ownerCar?.position, owner)
        break
      }
      case 'globalPulse': {
        // original executable: every car but the one that touched the star is zapped for 3 s (no
        // matter where it is), the screen flashes white and starfire plays for everyone
        fx?.pulseRing(ownerCar?.position ?? v3(d, 1))
        this.sound('starfire', 1)
        this.onGlobal()
        if (this.visual) flashScreen()
        for (const o of this.d.owned()) {
          if (o.id === owner) continue
          o.car.zappedUntil = now + 3000
          fx?.pulseRing(o.car.position)
          if (o.id === this.local) this.sound('electrozap', 0.9)
        }
        break
      }
    }
  }

  private shockMesh(): THREE.Object3D {
    const g = new THREE.Group()
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: fxTex(SPR.electric), color: 0x8fc4ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }))
    s.scale.setScalar(0.7)
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: fxTex(SPR.flare), color: 0xdde8ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }))
    core.scale.setScalar(0.5)
    g.add(s, core)
    return g
  }

  /** Move a projectile by dt. Returns false once it has gone off. */
  private advance(p: Projectile, dt: number): boolean {
    const ph = this.d.physics
    p.age += dt
    const free = p.kind === 'rocket' && p.target <= 0
    if (free) {
      // a loose rocket: falls, pushes along itself, wobbles (the same wobble in every browser: by shot)
      const dir = p.vel.lengthSq() > 1e-4 ? p.vel.clone().normalize() : new THREE.Vector3(0, 1, 0)
      p.vel.addScaledVector(dir, FREE_MOTOR * dt)
      p.vel.y -= GRAVITY * dt
      const yaw = Math.sin(p.shot * 1.37 + p.age * 11) * 2.5 * dt
      p.vel.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    } else if (p.kind === 'rocket') {
      const t = p.target ? this.carOf(Math.abs(p.target)) : null
      const speed = Math.min(Math.max(28, p.vel.length()), p.vel.length() + 8 * dt) // the motor: on with or without a target
      if (t) {
        const want = t.position.clone().add(new THREE.Vector3(0, 0.1, 0)).sub(p.pos).normalize()
        const cur = p.vel.clone().normalize()
        const turn = Math.min(1, HOME_LOCKED * dt)
        p.vel.copy(cur.lerp(want, turn).normalize().multiplyScalar(speed))
      } else p.vel.setLength(speed)
      // skim over the floor (up a rise, down a dip) instead of going off on it
      const down = ph.raycast([p.pos.x, p.pos.y + 0.5, p.pos.z], [0, -1, 0], 3)
      if (down && down.normal[1] > 0.6) {
        const lift = down.point[1] + ROCKET_SKIM - p.pos.y
        if (lift > 0) {
          p.pos.y += lift * Math.min(1, dt * 12)
          if (p.vel.y < 0) p.vel.y *= Math.max(0, 1 - dt * 12)
        } else if (lift > -1.5 && p.vel.y > 0 && !t) p.vel.y *= Math.max(0, 1 - dt * 3) // level off over the ground
      }
    } else if (p.kind === 'balloon') {
      p.vel.y -= 22 * dt
    } else {
      // shockwave skims ~25 cm over the floor
      const down = ph.raycast([p.pos.x, p.pos.y + 0.3, p.pos.z], [0, -1, 0], 1.2)
      if (down) p.pos.y += (down.point[1] + 0.25 - p.pos.y) * Math.min(1, dt * 15)
      this.shockField(p, dt)
    }
    const step = p.vel.clone().multiplyScalar(dt)
    const len = step.length()
    if (len > 1e-6) {
      const hit = ph.raycast(p.pos.toArray(), step.clone().divideScalar(len).toArray(), len + 0.1)
      if (hit && free) {
        // bounce off floors and walls alike, losing most of the speed into the surface
        const n = v3(hit.normal)
        const into = p.vel.dot(n)
        if (into < 0) p.vel.addScaledVector(n, -1.45 * into).multiplyScalar(0.8)
        p.pos.set(hit.point[0], hit.point[1], hit.point[2]).addScaledVector(n, 0.06)
        return true
      }
      // the shockwave and rockets ride over the floor and only stop at walls
      if (hit && ((p.kind !== 'shock' && p.kind !== 'rocket') || Math.abs(hit.normal[1]) < 0.6)) {
        p.pos.set(hit.point[0], hit.point[1], hit.point[2]).addScaledVector(v3(hit.normal), 0.05)
        this.detonate(p)
        return false
      }
    }
    p.pos.add(step)
    const reach = p.kind === 'shock' ? 0.6 : p.kind === 'rocket' ? 0.5 : 0.45
    for (const { id, car } of this.d.cars()) {
      if (id === p.owner || p.kind === 'shock') continue // your own shot never goes off on you (its blast can still reach you); the shockwave flies through cars
      if (car.position.distanceToSquared(p.pos) < reach * reach) {
        this.detonate(p)
        return false
      }
    }
    if (p.age >= p.life) {
      this.detonate(p)
      return false
    }
    return true
  }

  /** The shockwave's pull while it flies: our own cars near it are lifted and rolled. */
  private shockField(p: Projectile, dt: number) {
    for (const o of this.d.owned()) {
      if (o.id === p.owner) continue
      const d = o.car.position.clone().sub(p.pos)
      const r2 = d.x * d.x + d.z * d.z + (d.y * 10) ** 2
      if (r2 >= SHOCK_R * SHOCK_R) continue
      const k = 1 - r2 / (SHOCK_R * SHOCK_R)
      o.car.hitAt = o.car.now
      const st = this.d.physics.state(o.car.id)
      const fwd = o.car.forward
      const away = Math.hypot(d.x, d.z) > 0.05 ? [d.x / Math.hypot(d.x, d.z), d.z / Math.hypot(d.x, d.z)] : [0, 0]
      this.d.physics.setVelocity(o.car.id,
        [st.vel[0] + away[0] * SHOCK_PUSH * k * dt, st.vel[1] + SHOCK_LIFT * k * dt, st.vel[2] + away[1] * SHOCK_PUSH * k * dt],
        [st.ang[0] + fwd.x * SHOCK_ROLL * k * dt, st.ang[1] + fwd.y * SHOCK_ROLL * k * dt, st.ang[2] + fwd.z * SHOCK_ROLL * k * dt])
      if (o.id === this.local && k > 0.3 && !p.felt) {
        p.felt = true
        this.onBlast(o.car.position, 0.5 * k)
        this.sound('hit', 0.6 * k)
      }
    }
  }

  /** A blast: every owned car in range takes it. */
  private blastOwned(at: THREE.Vector3, radius: number, push: number, lift: number, spin: number) {
    for (const o of this.d.owned()) {
      const k = o.car.blast(at, radius, push, lift, spin)
      if (k > 0 && o.id === this.local) this.sound('hit', 0.6 * k)
    }
  }

  private detonate(p: Projectile) {
    p.mesh?.removeFromParent()
    const fx = this.d.fx
    const at = p.pos
    if (p.kind === 'shock') {
      fx?.shockBlast(at)
      this.sound('shock', 1, 1, at)
      this.onBlast(at, 1)
      this.blastOwned(at, 2.2, 9, 6.5, 30)
    } else if (p.kind === 'rocket') {
      fx?.explosion(at, 0.7)
      this.sound('firebang', 1, 1, at)
      this.onBlast(at, 0.6)
      this.blastOwned(at, 1.6, 4, 8.5, 35)
    } else {
      fx?.splash(at)
      this.sound('wbombhit', 0.9, 1, at)
      this.onBlast(at, 0.25)
      this.blastOwned(at, 1.3, 3.5, 3, 8)
    }
  }

  private detonateClone(shot: number, at: THREE.Vector3) {
    const i = this.clones.findIndex((c) => c.shot === shot)
    if (i < 0) return // already gone (we set it off ourselves)
    this.clones[i].mesh?.removeFromParent()
    this.clones.splice(i, 1)
    // the putty bomb's blast, not a firework's: original executable plays puttbang and puts an
    // armed putty bomb (object 20, set to go) on the car that touched the fake star
    this.d.fx?.explosion(at, 1.2)
    this.sound('puttbang', 1, 1, at)
    this.onBlast(at, 1)
    for (const o of this.d.owned()) {
      if (o.car.position.distanceTo(at) < 1.5) o.car.blast(at.clone().add(new THREE.Vector3(0, -0.3, 0)), 3, 3, 11, 45)
      else o.car.blast(at, 2.2, 7, 7, 30)
    }
  }

  private boom(holder: number) {
    const car = this.carOf(holder)
    const at = car?.position.clone() ?? null
    if (this.puttied) {
      this.puttied.putty(false)
      this.puttied = null
    }
    if (!at) return
    this.d.fx?.explosion(at, 1.2)
    this.sound('puttbang', 1, 1, at)
    this.onBlast(at, 1)
    for (const o of this.d.owned()) {
      if (o.id === holder) o.car.blast(at.clone().add(new THREE.Vector3(0, -0.3, 0)), 3, 3, 11, 45)
      else o.car.blast(at, 2.2, 7, 7, 30)
    }
  }

  // ------------------------------------------------------------ every frame

  update(dt: number) {
    const now = performance.now()
    const sNow = this.d.serverNow()
    const fx = this.d.fx
    const owned = this.d.owned()
    this.fxTimer += dt
    const t = now / 1000

    // pickup stars: spin, hide while taken, collect
    this.pickups.forEach((p, i) => {
      const free = p.until <= sNow && p.pending < now
      if (p.mesh && p.glow) {
        p.mesh.visible = p.glow.visible = free
        p.mesh.rotation.y = t * 2
        p.mesh.position.y = p.pos.y + 0.18 + Math.sin(t * 3 + i) * 0.05
        p.glow.position.copy(p.mesh.position)
        ;(p.glow.material as THREE.SpriteMaterial).opacity = 0.5 + Math.sin(t * 6 + i) * 0.2
      }
      if (!free) return
      for (const o of owned) {
        if (this.inv.has(o.id) || !o.canPick || o.car.position.distanceToSquared(p.pos) >= PICK_RADIUS * PICK_RADIUS) continue
        p.pending = now + 1500 // optimistic: hidden until the server answers
        this.d.send(o.id, { t: 'pick', i, place: o.standing.place, of: o.standing.of })
        fx?.sprite(SPR.flare, p.pos.clone().add(new THREE.Vector3(0, 0.2, 0)), { size: 0.6, sizeEnd: 1.8, life: 0.3, color: 0xffe080 })
        break
      }
    })

    // projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]
      let alive = true
      for (let left = dt; left > 1e-6 && alive; left -= 1 / 60) alive = this.advance(p, Math.min(1 / 60, left))
      if (!alive) {
        this.projectiles.splice(i, 1)
        continue
      }
      if (p.mesh) {
        p.mesh.position.copy(p.pos)
        if (p.kind !== 'shock') p.mesh.lookAt(p.pos.clone().add(p.vel))
        if (p.kind === 'rocket') p.mesh.rotateX(Math.PI / 2) // the model stands along y
      }
      p.trail += dt
      if (fx && p.trail > 0.03) {
        p.trail = 0
        if (p.kind === 'rocket') fx.sprite(SPR.fire, p.pos.clone(), { size: 0.18, sizeEnd: 0.05, life: 0.35, color: 0xffaa55 })
        if (p.kind === 'shock') fx.sprite(SPR.electric, p.pos.clone(), { size: 0.4, sizeEnd: 0.1, life: 0.25, color: 0x6fa8ff })
      }
    }

    // oil under owned wheels — each tyre that goes through it (the readme: "each tire that is driven
    // through this pool of oil temporarily loses traction"), and then leaves an oily track a while
    this.oils = this.oils.filter((o) => o.until > now)
    if (this.oils.length) {
      for (const o of owned) {
        o.car.wheels.forEach((w, i) => {
          if (!o.car.info.wheels[i]?.present) return
          const p = w.rest.clone().applyQuaternion(o.car.quaternion).add(o.car.position)
          for (const oil of this.oils) {
            const dx = p.x - oil.pos.x, dz = p.z - oil.pos.z
            if (dx * dx + dz * dz > OIL_RADIUS * OIL_RADIUS || Math.abs(p.y - oil.pos.y) > 0.5) continue
            if (w.oil < now && o.id === this.local) this.sound('skid', 0.5)
            w.oil = now + OIL_GRIP_MS
            w.oilMark = now + OIL_TRACK_MS
          }
        })
      }
    }

    // clones: whoever touches one sets it off
    for (let i = this.clones.length - 1; i >= 0; i--) {
      const c = this.clones[i]
      if (c.mesh) c.mesh.rotation.y = t * 2
      if (c.until < now) {
        c.mesh?.removeFromParent()
        this.clones.splice(i, 1)
        continue
      }
      if (c.armed >= now) continue
      const toucher = owned.find((o) => o.canPick && o.car.position.distanceToSquared(c.pos) < PICK_RADIUS * PICK_RADIUS)
      if (toucher) {
        this.d.send(toucher.id, { t: 'det', shot: c.shot, p: c.pos.toArray() })
        this.detonateClone(c.shot, c.pos.clone())
      }
    }

    // ball bearings
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i]
      const st = this.d.physics.state(b.id)
      if (b.until < now || st.pos[1] < -60) {
        this.d.physics.destroyCar(b.id)
        b.mesh?.removeFromParent()
        this.balls.splice(i, 1)
        continue
      }
      b.mesh?.position.set(st.pos[0], st.pos[1], st.pos[2])
      b.mesh?.quaternion.set(st.quat[0], st.quat[1], st.quat[2], st.quat[3])
    }

    // electro auras: zap owned cars near the owner
    for (const [owner, until] of this.auras) {
      if (until < now) {
        this.auras.delete(owner)
        continue
      }
      const car = this.carOf(owner)
      if (!car) continue
      if (fx && this.fxTimer > 0.08) fx.zap(car.position.clone().add(new THREE.Vector3(0, 0.15, 0)))
      for (const o of owned) {
        if (o.id === owner || o.car.position.distanceToSquared(car.position) >= AURA_RADIUS * AURA_RADIUS) continue
        if (o.car.zappedUntil < now && o.id === this.local) this.sound('electrozap', 0.8)
        o.car.zappedUntil = now + ZAP_MS
      }
    }

    // visuals for cars we don't own come in their state flags (4 zapped, 8 turbo)
    if (fx && this.fxTimer > 0.08) {
      const ownedIds = new Set(owned.map((o) => o.id))
      for (const { id, car } of this.d.cars()) {
        const flags = ownedIds.has(id) ? this.flagsOf(id, car) : car.netFlags
        if (flags & 4) fx.zap(car.position.clone().add(new THREE.Vector3(0, 0.1, 0)))
        if (flags & 8) this.exhaust(car)
      }
      this.fxTimer = 0
    }

    // fireworks in hand: original game's targeting reticle sits on the car they would home on
    if (this.visual) {
      const held = this.held
      const mine = owned.find((o) => o.id === this.local)
      const tid = mine && (held === 'firework' || held === 'fireworkPack') ? this.targetAhead(mine.id, mine.car) : 0
      const target = tid ? this.carOf(tid) : null
      if (tid !== this.lockOn) {
        this.lockOn = tid
        this.lockSince = performance.now()
      }
      const locked = !!tid && performance.now() - this.lockSince >= LOCK_MS
      if (target) {
        if (!this.reticle) {
          this.reticle = new THREE.Sprite(new THREE.SpriteMaterial({
            map: fxTex(SPR.crosshair), color: 0xff3020, transparent: true, depthWrite: false, depthTest: false, fog: false,
          }))
          this.reticle.renderOrder = 10
          this.add(this.reticle)
        }
        this.reticle.visible = true
        this.reticle.position.copy(target.position).addScaledVector(target.upAxis, 0.15)
        // red while it acquires (shrinking onto the car), green once locked
        const k = Math.min(1, (performance.now() - this.lockSince) / LOCK_MS)
        ;(this.reticle.material as THREE.SpriteMaterial).color.setHex(locked ? 0x30ff40 : 0xff3020)
        this.reticle.scale.setScalar((locked ? 0.75 + Math.sin(t * 12) * 0.06 : 1.3 - 0.55 * k))
        ;(this.reticle.material as THREE.SpriteMaterial).rotation = t * 2.5
      } else if (this.reticle) this.reticle.visible = false
    }

    // putty bomb: rides on the holder; a holder we own passes it by touching someone
    const holder = this.bomb.holder ? this.carOf(this.bomb.holder) : null
    if (this.puttied && this.puttied !== holder) {
      this.puttied.putty(false)
      this.puttied = null
    }
    if (holder) {
      // original game: the holder is covered in black putty with a fizzing fuse on the roof
      if (this.visual && this.puttied !== holder) {
        holder.putty(true)
        this.puttied = holder
      }
      if (fx && now - this.lastFuseTick > 60) {
        this.lastFuseTick = now
        // the aerial is the fuse: the spark starts at its tip and burns down it, reaching
        // the foot as the bomb goes off; the aerial itself stays as it is
        const left = Math.max(0, Math.min(1, (this.bomb.until - this.d.serverNow()) / BOMB_FUSE_MS))
        const top = holder.aerialPoint(left) ?? holder.position.clone().addScaledVector(holder.upAxis, 0.3)
        fx.sprite(SPR.flare, top, { size: 0.3, sizeEnd: 0.05, life: 0.3, color: 0xffaa33 })
        fx.sprite(SPR.flare, top, { size: 0.12, sizeEnd: 0.02, life: 0.5, color: 0xffe080,
          vel: new THREE.Vector3((Math.random() - 0.5) * 1.5, 1.5, (Math.random() - 0.5) * 1.5) })
      }
      const mine = owned.find((o) => o.id === this.bomb.holder)
      if (mine && now - (this.lastPass.get(mine.id) ?? 0) > 400) {
        for (const { id, car } of this.d.cars()) {
          // touching: an oval the shape of a car round the holder (0.62 m to the side, 1.2 m along it) —
          // a ring of 0.95 m round the centre missed a car shunted nose to tail (centres ~1.1 m apart)
          const off = car.position.clone().sub(mine.car.position)
          const along = off.dot(mine.car.forward), side = off.length() ** 2 - along * along
          if (id !== mine.id && Math.abs(off.y) < 0.8 && side / (0.62 * 0.62) + (along * along) / (1.2 * 1.2) < 1) {
            this.lastPass.set(mine.id, now)
            this.d.send(mine.id, { t: 'bombPass', to: id })
            break
          }
        }
      }
    }
  }

  private exhaust(car: Car) {
    const back = car.position.clone().addScaledVector(car.forward, -0.5).addScaledVector(car.upAxis, 0.1)
    this.d.fx?.sprite(SPR.fire, back, { size: 0.3, sizeEnd: 0.05, life: 0.25, color: 0x66aaff, vel: car.forward.clone().multiplyScalar(-2) })
  }

  private flagsOf(id: number, car: Car): number {
    const now = performance.now()
    return (car.zappedUntil > now ? 4 : 0) | (car.turboUntil > now ? 8 : 0) | ((this.auras.get(id) ?? 0) > now ? 16 : 0) |
      (car.wheels.some((w) => w.oilMark > now) ? 32 : 0)
  }

  /** Flags for an owned car's state packet. */
  flags(id = this.local): number {
    const o = this.d.owned().find((x) => x.id === id)
    return o ? this.flagsOf(id, o.car) : 0
  }

  bombFuse(): number | null {
    return this.bomb.holder && this.bomb.holder === this.local ? Math.max(0, this.bomb.until - this.d.serverNow()) : null
  }

  /** Is an electro aura (another car's) or a car within `r` of this one? (AI decisions) */
  carsNear(id: number, car: Car, r: number): number {
    let n = 0
    for (const c of this.d.cars()) if (c.id !== id && c.car.position.distanceToSquared(car.position) < r * r) n++
    return n
  }
}

// one texture per sprite rect (shared image)
const rectTex = new Map<string, THREE.Texture>()
function fxTex(r: readonly [1 | 2 | 3, number, number, number, number]): THREE.Texture {
  const key = r.join(',')
  let t = rectTex.get(key)
  if (!t) {
    t = pageTexture(r[0]).clone()
    t.repeat.set(r[3] / 256, r[4] / 256)
    t.offset.set(r[1] / 256, r[2] / 256)
    t.needsUpdate = true
    rectTex.set(key, t)
  }
  return t
}

export { AMMO }

/** The Global Pulse's white flash (original executable sets its screen fade to 0.5). */
function flashScreen() {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0.5;pointer-events:none;z-index:50;transition:opacity 0.6s ease-out'
  document.body.appendChild(el)
  requestAnimationFrame(() => requestAnimationFrame(() => (el.style.opacity = '0')))
  setTimeout(() => el.remove(), 800)
}
