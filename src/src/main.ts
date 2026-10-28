// cargame client: open the page, you're in the lobby driving around; the
// server's countdown puts everyone on the grid and starts the race.
import * as THREE from 'three'
import { loadTrack, loadCar, loadCarIndex, type LoadedCar } from './assets'
import { GRAVITY, Physics } from './physics'
import { Car, stopping, type Controls } from './car'
import { clearTaps, initInput, readControls, useTouch } from './input'
import { TouchControls } from './touch'
import { Weather } from './weather'
import { NameTags } from './nametags'
import { ChaseCam, StartCam } from './camera'
import { LapTracker, SplitTimes, TrackMeter, gridSlot, rescuePoint } from './race'
import { Piano } from './piano'
import { connect } from './net'
import { RemoteCar } from './remote'
import { Hud, fmtTime, ordinal } from './hud'
import { AiDriver } from './aidriver'
import { AmbientSounds, EngineSound, Music, play, unlockAudio } from './sound'
import { Fx, SPR } from './fx'
import { Countdown } from './countdown'
import { LoadScreen } from './loadscreen'
import { Sky } from './sky'
import { TrainView } from './train'
import { Signs } from './signs'
import { courseFiles, parseCourse, setLevelNames } from '../shared/course'
import { surface } from './surfaces'
import { TrainBody } from '../shared/train'
import { ObjectBodies, T } from '../shared/objects'
import { ForceFields } from '../shared/fields'
import { ObjectNet } from '../shared/objnet'
import { ObjectViews } from './objects'
import { SkidMarks } from './skids'
import { Shadows } from './shadows'
import { Mirrors } from './mirrors'
import { CarLighting } from './carlight'
import { CarParticles } from './sparks'
import { Weapons } from './weapons'
import { LAPS, STATE_FLOATS, STATE_HZ, TRACKS, type Phase, type PlayerInfo, type ResultRow } from '../shared/protocol'

const params = new URLSearchParams(location.search)
const canvas = document.getElementById('c') as HTMLCanvasElement
// no multisampling on high-density screens: at 1.5x and up the edges are fine already,
// and MSAA on top of 2x the pixels was most of the GPU's work on Retina screens and phones
const renderer = new THREE.WebGLRenderer({ canvas, antialias: devicePixelRatio < 1.5, powerPreference: 'high-performance', stencil: true }) // stencil: mirrors.ts
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.LinearSRGBColorSpace
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 200)
function resize() {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

// the levels' names, from the user's game files (tool/prepare.py)
setLevelNames(await fetch('/game/levels.json').then((r) => r.json()).catch(() => ({})))

// the track the server is running (offline: ?track=, else the default)
const hint = (() => { try { return sessionStorage.getItem('track') ?? '' } catch { return '' } })()
let trackName = params.get('track') ?? ''
if (!TRACKS[trackName] && TRACKS[hint]) trackName = hint // the server told us last time
if (!TRACKS[trackName]) {
  trackName = Object.keys(TRACKS)[0]
  if (!params.has('offline')) {
    try {
      const r = await (await fetch('/api/track', { cache: 'no-store' })).json()
      if (TRACKS[r.track]) trackName = r.track
    } catch { /* default */ }
  }
}
// original game's loading screen (src/loadscreen.ts): length and car filled in as they arrive
const carPref = params.get('car') || (() => { try { return localStorage.getItem('car') } catch { return null } })() || 'rc'
const loading = new LoadScreen([
  ['Game Mode', params.has('offline') ? 'Practice' : 'Multi-Player'],
  ['Track', TRACKS[trackName] ?? trackName],
  ['Length', ''],
  ['Laps', String(LAPS)],
  ['Car', ''],
])
const [physics, track, carIndex] = await Promise.all([
  Physics.load(),
  loadTrack(trackName, (info) => loading.set('Length', `${Math.round(new TrackMeter(info).length)}m`)),
  loadCarIndex().then((list) => {
    loading.set('Car', list.find((c) => c.key === carPref)?.name ?? list.find((c) => c.key === 'rc')?.name ?? '')
    return list
  }),
])
scene.add(track.mesh)
const mirrors = new Mirrors(track.info, scene, physics)
const carLighting = new CarLighting(track.info)
const fc = track.info.fog.color
scene.background = new THREE.Color(fc[0] / 255, fc[1] / 255, fc[2] / 255)
// draw distance: the level's own fog and far clip, twice as far ("can the draw
// distance be further?" — the 1999 figures were for 1999 cards: Toy World 1 ended at 80 m, several
// levels faded in over the last 10 m; the whole level is drawn anyway, so further costs ~nothing)
const DRAW = 2
scene.fog = new THREE.Fog(scene.background as THREE.Color, track.info.fog.start * DRAW, track.info.fog.far * DRAW)
camera.far = track.info.fog.far * DRAW
camera.updateProjectionMatrix()
// the level's skybox, where it has one (the rest show their fog colour)
const sky = track.info.sky
  ? new Sky(courseFiles(parseCourse(trackName) ?? parseCourse('toylite')!).base, track.info.sky, camera.far * 0.9, !!parseCourse(trackName)?.mirror)
  : null
if (sky) scene.add(sky.root)
physics.addMesh(track.collision.tris, track.collision.materials, 0.5)
physics.mirrored = !!parseCourse(trackName)?.mirror
// the level's force fields (water) push every car (shared/fields.ts)
physics.fields = (track.info as any).fields?.length ? new ForceFields((track.info as any).fields) : null
let floorY = Infinity
for (let i = 1; i < track.collision.tris.length; i += 3) floorY = Math.min(floorY, track.collision.tris[i])

// cars offered in the picker: the original's selectable roster minus novelties
const cars = carIndex.filter((c) => !['trolley', 'wincar', 'wincar2', 'wincar3', 'wincar4'].includes(c.key))
cars.sort((a, b) => a.rating - b.rating || a.name.localeCompare(b.name))
const hud = new Hud(cars, TRACKS[trackName] ?? track.info.name, TRACKS, trackName)
initInput(() => hud.typing())
const touch = new TouchControls(hud.root, params.has('touch'))
useTouch(touch)
hud.onWeaponIcon = (cell) => touch.weapon(cell)
unlockAudio()
const engineKind = (key: string) => {
  const c = carIndex.find((x) => x.key === key)
  return c?.class === 1 ? 'petrol' : 'moto'
}

// ------------------------------------------------------------ local player
const NAMES = ['Turbo', 'Sparky', 'Rusty', 'Zippy', 'Nitro', 'Bolt', 'Gizmo', 'Dash', 'Fuzz', 'Rocket', 'Pixel', 'Jolt']
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}
let myName = store.get('name') || `${NAMES[Math.floor(Math.random() * NAMES.length)]} ${Math.floor(Math.random() * 90 + 10)}`
let myCarKey = params.get('car') || store.get('car') || 'rc'
if (!cars.some((c) => c.key === myCarKey)) myCarKey = 'rc'
store.set('name', myName)
hud.nameInput.value = myName
hud.carSelect.value = myCarKey

const start = gridSlot(track.info, physics, 0)
let me = new Car(physics, await loadCar(myCarKey), start.pos, start.yaw)
scene.add(me.root)
let myEngine = new EngineSound(engineKind(myCarKey))
const cam = new ChaseCam(camera, physics)
const startCam = new StartCam(camera, physics) // the grid's fly-in
let gridLen = 0 // ms the grid phase lasts (the fly-in's clock)
cam.snap(me)

async function switchCar(key: string) {
  const loaded = await loadCar(key)
  const p = me.position.clone(), f = me.forward
  const yaw = Math.atan2(-f.x, -f.z)
  me.destroy()
  me = new Car(physics, loaded, p.add(new THREE.Vector3(0, 0.15, 0)), yaw)
  scene.add(me.root)
  myEngine.stop()
  myEngine = new EngineSound(engineKind(key))
}

// ------------------------------------------------------------ game state
let myId = 0
let phase: Phase = 'lobby'
let phaseEnds = 0 // performance.now() when the server's timer runs out (0 = none)
let players: PlayerInfo[] = []
let results: ResultRow[] | null = null
let racing = false // I have a grid slot in the current race
let raceStart = 0
let finishedAt: number | null = null
let bestLap: number | null = null
let parked = false // spectating: my car is out of the world
const finishPlaces = new Map<number, number>() // id -> place
const lap = new LapTracker(track.info)
const meter = new TrackMeter(track.info) // metres along the race: order + gaps
const piano = new Piano(track.info, play)
const signs = new Signs(track.info)
const ambience = new AmbientSounds(track.info.ambient ?? [])
const music = new Music(track.info.music ?? [])
addEventListener('keydown', (ev) => {
  const e = ev as KeyboardEvent
  if (e.code !== 'KeyM' || e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return
  hud.toast(music.toggle() ? 'Music on' : 'Music off')
})
const remotes = new Map<number, RemoteCar>()
const loadingRemote = new Set<number>()

function myInfo() {
  return players.find((p) => p.id === myId)
}

function park(on: boolean) {
  parked = on
  me.root.visible = !on
  if (on) me.place(new THREE.Vector3(0, floorY - 200, 0), 0)
}

function syncRemotes() {
  const want = new Map(players.filter((p) => p.id !== myId).map((p) => [p.id, p]))
  for (const [id, r] of remotes) {
    const p = want.get(id)
    if (!p || p.car !== r.carKey) {
      r.engine?.stop()
      r.destroy()
      remotes.delete(id)
    }
  }
  for (const [id, p] of want) {
    if (remotes.has(id) || loadingRemote.has(id)) continue
    loadingRemote.add(id)
    loadCar(p.car).then((loaded: LoadedCar) => {
      loadingRemote.delete(id)
      const still = players.find((q) => q.id === id)
      if (!still || still.car !== p.car || remotes.has(id)) return
      const r = new RemoteCar(physics, loaded, id, p.car)
      r.engine = new EngineSound(engineKind(p.car))
      r.car.root.visible = false
      scene.add(r.car.root)
      remotes.set(id, r)
    })
  }
}

function onPlayers(list: PlayerInfo[]) {
  players = list
  hud.markCpu(list.filter((p) => p.ai).map((p) => p.id))
  hud.players(list, myId, phase)
  syncRemotes()
}

function enterPhase(p: Phase, remaining: number, list: PlayerInfo[], res?: ResultRow[]) {
  const prev = phase
  phase = p
  phaseEnds = remaining >= 0 ? performance.now() + remaining : 0
  onPlayers(list)
  const mine = myInfo()
  racing = !!mine?.racing && (p === 'grid' || p === 'race')
  hud.showLobby(p === 'lobby')
  hud.raceHud(racing || p === 'race') // a spectator sees the HUD of the car being watched
  if (p === 'grid') {
    finishPlaces.clear()
    finishedAt = null
    bestLap = null
    results = null
    hud.showResults(null, myId, '')
    weapons?.reset()
    if (racing) {
      park(false)
      const g = gridSlot(track.info, physics, mine!.slot)
      me.place(g.pos, g.yaw)
      cam.snap(me)
      startCam.begin(me)
      gridLen = remaining
    } else {
      park(true)
      hud.setStatus('Race in progress — you’re in the next one')
    }
    lap.reset()
    meter.reset()
  }
  if (p === 'race') {
    raceStart = performance.now()
    lap.reset()
    splits.reset()
    lap.lapStart = raceStart
    if (prev === 'grid' && racing) {
      countdown?.show('go')
      play('countdown', 1, 1.5)
    }
    beeped = -1
    if (!racing) park(true)
  }
  if (p === 'results') {
    hud.starting(false) // the next lobby votes again
    results = res ?? []
    hud.showResults(results, myId, '')
    hud.countdown('')
    countdown?.show(null)
    hud.wrongWay(false)
  }
  if (p === 'lobby') {
    hud.setStatus('')
    hud.showResults(null, myId, '')
    hud.countdown('')
    countdown?.show(null)
    hud.wrongWay(false)
    if (parked) {
      park(false)
      const g = rescuePoint(track.info, physics, new THREE.Vector3(...track.info.start.pos))
      me.place(g.pos, g.yaw)
      cam.snap(me)
    }
  }
}

let standing = { place: 1, of: 1, progress: 0, racing: false }
let lastOrder: number[] = [] // race order last frame (ids), for hysteresis
let rolling = false // the vote's roulette is running
let switchTo = '' // the course the lobby moved to (reload into it once the roulette has landed)
function switchCourse(id: string) {
  hud.setStatus(`Loading ${TRACKS[id] ?? id}…`)
  setTimeout(() => location.reload(), 300)
}
let watchId = 0 // spectating: the car the camera follows (and the HUD shows)
// above connect(): the welcome can arrive during the awaits below, and enterPhase sets it
let beeped = -1
const fx = new Fx(scene)
const skids = new SkidMarks(scene, physics)
const shadows = new Shadows(scene, physics)
const carParticles = new CarParticles(fx, physics)
let weapons: Weapons
let countdown: Countdown | undefined // the 3D 3-2-1-GO (after weapons.load: its models are fx models)
const offline = params.has('offline') // free drive, no server (debugging)
// the loose objects' states from the server (shared/objnet.ts); made with the level's objects below
let objNet: ObjectNet | null = null
const net = offline
  ? { send() {}, sendState() {}, connected: () => false, serverNow: () => performance.now(), rtt: () => 0, transport: () => 'tcp' as const }
  : connect(
  (m) => {
    switch (m.t) {
      case 'welcome':
        if (m.track !== trackName && TRACKS[m.track] && hint !== m.track) {
          // the lobby runs another track: remember it and load that (once — no reload loops)
          try { sessionStorage.setItem('track', m.track) } catch { /* private mode */ }
          return location.reload()
        }
        myId = m.id
        hud.setOffer(m.offer ?? [])
        if (m.drawn) hud.showNext(m.track)
        weapons?.onMessage({ t: 'pickups', taken: m.taken })
        weapons?.onMessage({ t: 'bomb', holder: m.bomb.holder, until: m.bomb.until })
        net.send({ t: 'hello', name: myName, car: myCarKey })
        enterPhase(m.phase, m.remaining, m.players)
        // joined mid-race: the race clock runs from the server's start, not from now
        if (m.phase === 'race') raceStart = performance.now() - Math.max(0, net.serverNow() - m.raceAt)
        if (m.phase === 'grid' || m.phase === 'race') {
          park(true)
          hud.setStatus('Race in progress — you’re in the next one')
        }
        break
      case 'players':
        onPlayers(m.players)
        break
      case 'phase':
        enterPhase(m.phase, m.remaining, m.players, m.results)
        break
      case 'offer':
        hud.setOffer(m.courses)
        break
      case 'drawn':
        // the roulette runs first; a switch to another course reloads once it has landed
        rolling = true
        hud.drawn(m.track, m.votes, () => {
          rolling = false
          if (switchTo) switchCourse(switchTo)
        })
        break
      case 'track':
        if (m.track !== trackName) {
          switchTo = m.track
          try { sessionStorage.setItem('track', m.track) } catch { /* private mode */ }
          if (!rolling) switchCourse(m.track)
        }
        break
      case 'pickups':
      case 'weapon':
      case 'fire':
      case 'det':
      case 'bomb':
      case 'boom':
        weapons?.onMessage(m)
        break
      case 'finished': {
        finishPlaces.set(m.id, m.place)
        const who = m.id === myId ? 'You' : players.find((p) => p.id === m.id)?.name ?? 'Someone'
        hud.toast(`${who} finished ${ordinal(m.place)} · ${fmtTime(m.time)}`)
        break
      }
    }
  },
  (id, time, f) => remotes.get(id)?.push(time, f, performance.now()),
  () => hud.setStatus(''),
  () => hud.setStatus('Reconnecting…'),
  (b) => objNet?.receive(b),
)
if (offline) {
  hud.showLobby(false)
  hud.setStatus('Offline practice')
}
// Toy World 2's train runs on the server clock: the same place in every browser and the server
const train = track.info.train ? new TrainBody(track.info.train, physics, net.serverNow()) : null
const trainView = track.info.train ? new TrainView(track.info.train, trackName, scene, fx, physics) : null
const objectBodies = track.info.objects?.length ? new ObjectBodies(track.info, physics) : null
const objectViews = new ObjectViews(track.info, trackName, scene, fx, objectBodies, physics, camera.far)
// the practice stars: in the lobby's free drive (the game hides them outside Practice mode)
objectViews.onStar = (n, of) => hud.toast(n < of ? `Star ${n} of ${of} found!` : `All ${of} stars found!`)
// the loose objects follow the server's world (shared/objnet.ts); Supermarket 1 and 2's trolleys are
// cars with nobody driving
objNet = objectBodies ? new ObjectNet(objectBodies, physics) : null
objectBodies?.addTrolleys(loadCar).then(() => objectBodies!.trolleys.forEach((t) => scene.add(t.car.root)))
  .catch((e) => console.warn('trolleys:', e))
const splits = new SplitTimes(track.info)
// the other people's names over their cars (not the CPU cars')
const nameTags = new NameTags(scene)
const water = objectViews.water
// Toytanic 2's rain and lightning; its thunder now follows the flashes
const weather = new Weather(track.info, scene, () => ambience.fire('ship/thunder1'))
if (weather.lightning) ambience.hold('ship/thunder1')
const inWater = new WeakMap<Car, boolean>()
/** Splashes as cars drop into the pool, rings where they drive through the garden's stream. */
function waterFx(cars: Car[]) {
  for (const c of cars) {
    const v = Math.abs(c.speed)
    const wet = !!water.inBox(c.position)
    if (wet && !inWater.get(c)) {
      const d = c.position.distanceTo(camera.position)
      if (d < 40) play('splash', Math.min(1, 1.4 / (1 + d * 0.08)), 0.9 + Math.random() * 0.2)
      for (let i = 0; i < 14; i++) {
        const vel = new THREE.Vector3((Math.random() - 0.5) * 3, 2.5 + Math.random() * 3, (Math.random() - 0.5) * 3)
        fx.sprite(SPR.drop, c.position.clone().add(new THREE.Vector3(0, 0.3, 0)), { size: 0.25, sizeEnd: 0.12, life: 0.9, vel, gravity: 9, color: 0xc8e8ff })
      }
    }
    inWater.set(c, wet)
    if (wet && v > 2 && Math.random() < 0.3) {
      const vel = new THREE.Vector3((Math.random() - 0.5) * 1.5, 1.5 + Math.random() * 1.5, (Math.random() - 0.5) * 1.5)
      fx.sprite(SPR.drop, c.position.clone().add(new THREE.Vector3(0, 0.2, 0)), { size: 0.18, sizeEnd: 0.1, life: 0.6, vel, gravity: 9, color: 0xc8e8ff })
    }
    if (v > 1 && water.onRipples(c.position)) water.drop(c.position.x, c.position.z, Math.min(1, v / 8))
  }
}

weapons = new Weapons({
  scene, physics, track: track.info, fx, play, listener: () => camera.position,
  send: (_owner, m) => net.send(m),
  serverNow: () => net.serverNow(),
  local: () => myId,
  // this browser owns (judges hits for, picks up with) only its player's car
  owned: () => [{ id: myId, car: me, canPick: !parked && phase !== 'grid', standing }],
  cars: () => {
    const list = parked ? [] : [{ id: myId, car: me }]
    for (const r of remotes.values()) if (r.car.root.visible) list.push({ id: r.id, car: r.car })
    return list
  },
})
await weapons.load()
// the race's star: touching it asks the server to fire the race's one Global Pulse; when one goes
// off (ours or anyone's) the star is gone
objectViews.onRaceStar = (at) => { if (!offline) net.send({ t: 'star', p: at.toArray() }) }
weapons.onGlobal = () => objectViews.takeRaceStar()
// camera shake: explosions near our car (or the camera, when watching) jolt the view —
// strongest on the spot, nothing from 14 m. `shake` fades out over ~0.6 s; applied only for drawing
let shake = 0
weapons.onBlast = (at, power) => {
  const d = at.distanceTo(parked ? camera.position : me.position)
  shake = Math.min(1, shake + power * Math.max(0, 1 - d / 14))
}
const shakeSaved = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }
// compile the weapon models' shaders now, in the background (the first one fired froze a frame)
renderer.compileAsync(weapons.warmGroup(), camera, scene).catch(() => {})
renderer.compileAsync(fx.warmGroup(SPR.flare), camera, scene).catch(() => {})
countdown = new Countdown((k) => weapons.make(k))
renderer.compileAsync(countdown.root, camera).catch(() => {})
if (offline) {
  // no server to hand out weapons: grab one locally for practice
  const orig = net.send
  ;(net as any).send = (m: any) => {
    if (m.t === 'pick') {
      const all = ['shockwave', 'firework', 'fireworkPack', 'waterBalloons', 'electroPulse', 'oilSlick', 'ballBearing', 'turbo', 'clone', 'globalPulse'] as const
      const w = all[Math.floor(Math.random() * all.length)]
      weapons.onMessage({ t: 'weapon', w, n: w === 'fireworkPack' || w === 'waterBalloons' ? 3 : 1 })
    }
    orig(m)
  }
}
loading.remove()

hud.onName = (n) => {
  myName = n.trim().slice(0, 16) || myName
  hud.nameInput.value = myName
  store.set('name', myName)
  net.send({ t: 'name', name: myName })
}
hud.onCar = (key) => {
  if ((phase === 'grid' || phase === 'race') && racing) {
    hud.carSelect.value = myCarKey
    return
  }
  myCarKey = key
  store.set('car', key)
  net.send({ t: 'car', car: key })
  switchCar(key)
}
hud.onVote = (course) => net.send({ t: 'vote', course })
hud.onReady = () => {
  if (phase === 'lobby') net.send({ t: 'ready', on: !myInfo()?.ready })
}

// ------------------------------------------------------------ main loop
const DT = 1 / 120
let acc = 0
let last = performance.now()
let sendAcc = 0
let sendNow = false
const stateBuf = new Float32Array(STATE_FLOATS)
const NONE: Controls = { throttle: 0, steer: 0, handbrake: false }
let wrongTime = 0
let lastProgress = 0
const lastVel = new THREE.Vector3()
;(window as any).__game = { get objects() { return objectViews }, get objectBodies() { return objectBodies }, get objNet() { return objNet }, skids, get car() { return me }, get weapons() { return weapons }, remotes, net, physics, lap, camera, freeCam: false, controls: null as Controls | null, get phase() { return phase }, get myId() { return myId }, hud }

const bot = params.has('bot') ? new AiDriver(track.info, { pace: 0.95, physics }) : null
// ?bot=human: the bot's controls as a person on a keyboard gives them — a reaction time late, all or
// nothing, each press held at least a moment, and now and then a wobble — to test what the others see
// of a jerky driver (a smooth bot is easy to predict)
const humanize = params.get('bot') === 'human' ? (() => {
  const past: { t: number; c: Controls }[] = []
  const react = 120 + Math.random() * 100 // ms
  let steer = 0, since = 0, wobble = 0
  return (c: Controls, now: number): Controls => {
    past.push({ t: now, c })
    while (past.length > 1 && past[1].t <= now - react) past.shift()
    const late = past[0].c
    const want = late.steer > 0.3 ? 1 : late.steer < -0.3 ? -1 : 0
    if (want !== steer && now - since > 90) { steer = want; since = now }
    if (now > wobble + 600 && Math.random() < 0.004) wobble = now // a twitch of ~0.25 s the other way
    const s = now - wobble < 250 ? (steer ? -steer : Math.random() < 0.5 ? 1 : -1) : steer
    return { ...late, steer: s, throttle: late.throttle > 0.3 ? 1 : late.throttle < -0.3 ? -1 : 0 }
  }
})() : null

// R / Y: back on the track — on the AI line, never ahead of where the car was, then held still for
// RESET_HOLD (resetting must never beat driving out); once per RESET_GAP
const RESET_HOLD = 1000, RESET_GAP = 3000, FLIP_GAP = 2000
const HOLD: Controls = { throttle: 0, steer: 0, handbrake: true }
let resetAt = -1e9, holdUntil = 0, flipAt = -1e9
function rescue(force = false) {
  const now = performance.now()
  if (!force && now - resetAt < RESET_GAP) return
  resetAt = now
  flipping = null
  const r = rescuePoint(track.info, physics, me.position, true)
  me.place(r.pos, r.yaw)
  holdUntil = now + RESET_HOLD
  sendNow = true
}

// E / End / LB (original game's "Flip car"): on its roof or side and nearly stopped, the car rises straight
// up, turns upright in the air (same heading) and is let go onto its wheels where it was (
// "raised until it can fully flip, then flipped and dropped"). Never automatic
// ...and lowered to its ride height before it is let go: dropped from the top, 0.6 m at ~5 m/s, it
// sank into the floor and stuck there, wheels below the ground
const FLIP_UP_S = 0.3, FLIP_TURN_S = 0.4, FLIP_DOWN_S = 0.15, FLIP_LIFT = 0.6
const FLIP_S = FLIP_UP_S + FLIP_TURN_S + FLIP_DOWN_S
let flipping: { t0: number; from: number[]; q0: THREE.Quaternion; q1: THREE.Quaternion; yaw: number; lift: number; rest: number } | null = null
function flip() {
  const now = performance.now()
  if (flipping || now - flipAt < FLIP_GAP || me.upAxis.y > 0.5 || Math.abs(me.speed) > 2) return
  flipAt = now
  const f = me.forward
  const yaw = Math.hypot(f.x, f.z) > 0.2 ? Math.atan2(-f.x, -f.z) : rescuePoint(track.info, physics, me.position).yaw
  const st = physics.state(me.id)
  // as high as there is room for: less under a table or a ceiling
  const roof = physics.raycast([st.pos[0], st.pos[1] + 0.1, st.pos[2]], [0, 1, 0], FLIP_LIFT + 0.5)
  const floor = physics.raycast([st.pos[0], st.pos[1] + 0.3, st.pos[2]], [0, -1, 0], 2)
  flipping = {
    rest: floor ? floor.point[1] + 0.32 : st.pos[1], // where place() would put it, just over the floor
    t0: now, from: [...st.pos], q0: new THREE.Quaternion(...st.quat),
    q1: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), yaw,
    lift: Math.max(0.15, Math.min(FLIP_LIFT, roof ? roof.dist - 0.4 : FLIP_LIFT)),
  }
  holdUntil = now + FLIP_S * 1000
  sendNow = true
}
/** Where the flip has the car now (held there through the physics steps), or null once it's let go. */
function flipPose(now: number): { pos: number[]; quat: number[] } | null {
  if (!flipping) return null
  const t = (now - flipping.t0) / 1000
  if (t >= FLIP_S) {
    // let go the way R / the old instant flip did (pose, still, state re-read): released straight
    // out of the hold, the car settled 25 cm and wouldn't drive
    me.place(new THREE.Vector3(flipping.from[0], flipping.rest, flipping.from[2]), flipping.yaw)
    flipping = null
    return null
  }
  const ease = (x: number) => x * x * (3 - 2 * x)
  const top = flipping.from[1] + flipping.lift
  const y = t < FLIP_UP_S + FLIP_TURN_S
    ? flipping.from[1] + flipping.lift * ease(Math.min(1, t / FLIP_UP_S))
    : top + (flipping.rest - top) * ease((t - FLIP_UP_S - FLIP_TURN_S) / FLIP_DOWN_S)
  const q = flipping.q0.clone().slerp(flipping.q1, ease(Math.min(1, Math.max(0, (t - FLIP_UP_S) / FLIP_TURN_S))))
  return { pos: [flipping.from[0], y, flipping.from[2]], quat: [q.x, q.y, q.z, q.w] }
}

/** A car drawn `ahead` s past its last physics step, moving as it was then (frames don't fall on the steps). */
function syncAhead(car: Car, s: ReturnType<Car['readState']>, ahead: number) {
  const w = new THREE.Vector3(...s.ang)
  const lever = car.position.clone().sub(new THREE.Vector3(...s.com))
  const v = new THREE.Vector3(...s.vel).add(w.clone().cross(lever))
  const angle = w.length() * ahead
  const q = angle > 1e-6 ? new THREE.Quaternion().setFromAxisAngle(w.normalize(), angle).multiply(car.quaternion) : car.quaternion
  car.sync(car.position.clone().addScaledVector(v, ahead), q)
}

renderer.setAnimationLoop((t) => {
  const now = performance.now()
  const frame = Math.min(0.1, (t - last) / 1000)
  last = t
  // the server-clock time of this frame's timestamp — the clock the simulation runs on (frame
  // lengths come from t). Reading serverNow() wherever the code happens to be instead added the
  // few ms (more on a slow machine) spent before that line, differently each frame: the other
  // cars' targets and our own packets' stamps jittered by that much (~10–30 cm at speed).
  const sFrame = net.serverNow() - (now - t)
  const input = readControls(frame)
  let forced = (window as any).__game.controls as Controls | null
  if (bot && !parked) {
    let b = bot.drive(me, frame, [...remotes.values()].filter((r) => r.car.root.visible).map((r) => r.car))
    if (humanize) b = { ...humanize(b, now), reset: b.reset }
    forced = b
    if (b.reset) input.reset = true
    if (weapons.held && Math.random() < frame * 0.7) input.fire = true
    if (phase === 'lobby' && !myInfo()?.ready) hud.onReady()
  }
  const frozen = phase === 'grid' || parked
  // over the line (or the race is over): the car brakes to a stop and stays there
  const done = (racing && finishedAt !== null) || phase === 'results'
  const held = now < holdUntil // just put back on the track
  const ctl: Controls = frozen ? NONE : done ? stopping(me) : held ? HOLD : forced ?? input

  if (input.ready && phase === 'lobby') hud.onReady()
  me.now = now
  if (input.fire && !frozen && !done && !held) weapons.fire()
  // only on a key press — ?bot=1 still resets itself when it lands on its roof
  if (!frozen && (input.reset || (bot && me.upsideTime > 1.8))) rescue()
  if (!frozen && !done && input.flip) flip()
  // touch screens have no flip button: a car stuck on its roof or side rights itself
  if (touch.active && !frozen && !done && !parked && me.upsideTime > 1) flip()
  if (!parked && me.position.y < floorY - 8) rescue(true)

  // physics
  const flipHold = flipPose(now)
  acc += frame
  let steps = 0
  while (acc >= DT && steps < 12) {
    // the moment this step brings the world to (not "now": a frame runs several steps, and
    // aiming every one at the same instant pulled the other cars back, then let them jump ahead)
    const sNow = sFrame - (acc - DT) * 1000
    for (const r of remotes.values()) r.step(sNow, now)
    if (!parked) me.drive(ctl, DT)
    else physics.setVelocity(me.id, [0, 0, 0], [0, 0, 0]) // spectating: stay put, don't fall forever
    if (flipHold && !parked) { // the flip holds the car where its animation is
      physics.setPose(me.id, flipHold.pos, flipHold.quat)
      physics.setVelocity(me.id, [0, 0, 0], [0, 0, 0])
    }
    train?.step(sNow - DT * 1000)
    objNet?.pull(sNow, parked ? null : me.position)
    objectBodies?.step(sNow - DT * 1000)
    physics.step(DT, 2)
    for (const r of remotes.values()) {
      r.nearLocal = !parked && r.car.position.distanceToSquared(me.position) < 2.5 * 2.5
      r.afterStep(now, DT, GRAVITY)
    }
    if (phase === 'grid' && racing) {
      // hold position on the grid but let the springs settle
      const s = me.readState()
      physics.setVelocity(me.id, [0, Math.min(0, s.vel[1]), 0], [0, 0, 0])
    }
    acc -= DT
    steps++
  }
  if (steps === 12) acc = 0
  const sNow = me.readState()
  // draw the car where it is at this frame, not at the last fixed step: frames take 0, 1 or 2 of the
  // 120 Hz steps unevenly, so drawing the step itself moved the car 0 / 18 / 36 cm per frame at 22 m/s
  // and the chase camera (aimed at it) shook — worst in the fastest cars (the Cougar)
  const ahead = Math.min(acc, DT)
  if (!frozen) syncAhead(me, sNow, ahead)
  else me.sync()
  if (!parked) meter.update(me.position)
  // impacts: a sudden change of velocity is a crash
  const vNow = new THREE.Vector3(...sNow.vel)
  const dv = vNow.distanceTo(lastVel)
  if (dv > 1.5) sendNow = true // a knock: tell the others now, not at the next tick
  lastVel.copy(vNow)
  if (!parked && dv > 2.5 && frame < 0.05) play(dv > 6 ? 'hit' : 'hit_soft', Math.min(1, dv / 10), 0.9 + Math.random() * 0.2)
  const skid = me.grounded ? Math.max(...me.wheels.map((w) => w.skid)) * Math.min(1, Math.abs(me.speed) / 4) : 0
  const rough = me.wheels.some((w) => w.contact && surface(w.surface).rough)
  myEngine.update(parked ? 0 : Math.abs(me.speed) / me.vtop, parked ? 0 : Math.max(0, ctl.throttle), parked ? 0 : skid, parked ? 99 : 0, frame, rough)
  for (const r of remotes.values()) {
    // the others too (2026-10-15): drawn at their last step, they were 0–8 ms behind our car, a
    // different amount each frame — a jerk of up to ~20 cm at racing speed against our own car
    syncAhead(r.car, r.car.readState(), ahead)
    r.car.root.visible = now - r.lastHeard < 2500
    const d = r.car.position.distanceTo(camera.position)
    r.engine?.update(r.car.root.visible ? Math.abs(r.car.speed) / r.car.vtop : 0, 0.3, 0, r.car.root.visible ? d : 99, frame)
  }

  // race logic
  const showRace = phase === 'race' || (phase === 'grid' && racing)
  if (phase === 'race' && racing && finishedAt === null) {
    if (lap.update(me.position, now) === 'lap') {
      const lt = lap.lapTimes[lap.lapTimes.length - 1]
      if (bestLap === null || lt < bestLap) bestLap = lt
      splits.lapDone(lt === bestLap)
      net.send({ t: 'lap', lap: lap.completedLaps(), time: lt })
      if (lap.completedLaps() >= LAPS) {
        finishedAt = now
        net.send({ t: 'finish', time: now - raceStart, best: bestLap })
      } else if (lap.completedLaps() === LAPS - 1) hud.toast('Final lap!')
      else hud.toast(`Lap ${fmtTime(lt)}`)
    }
    else {
      const sp = splits.update(me.position, now - lap.lapStart)
      if (sp && lap.crossings >= 1) hud.split(sp.n, sp.time, sp.diff)
    }
    // wrong way: progress keeps dropping while moving
    const pr = meter.value
    wrongTime = pr < lastProgress - 0.01 && Math.abs(me.speed) > 2 ? wrongTime + frame : Math.max(0, wrongTime - frame * 2)
    lastProgress = pr
    if (wrongTime > 1) {
      // which way round: the race's direction at the nearest AI node, against the car's right
      let best = Infinity, dir: number[] = [0, 0]
      for (const n of track.info.pan.nodes) {
        const d = (n.pos[0] - me.position.x) ** 2 + ((n.pos[1] - me.position.y) * 2) ** 2 + (n.pos[2] - me.position.z) ** 2
        const m = track.info.pan.nodes[n.next[0]]
        if (d < best && m) { best = d; dir = [m.pos[0] - n.pos[0], m.pos[2] - n.pos[2]] }
      }
      const f = me.forward
      hud.wrongWay(true, dir[0] * -f.z + dir[1] * f.x > 0)
    } else hud.wrongWay(false)
  } else hud.wrongWay(false)
  if (!showRace) {
    standing = { place: 1, of: 1, progress: 0, racing: false }
    hud.gaps(null, null)
  }

  // race order: finished by place, the rest by progress
  if (showRace) {
    const racers = players.filter((p) => p.racing)
    // everyone measured the same way, from where they are drawn now: a remote's reported progress
    // is a packet old (1-2 m at speed), so a car beside us swapped places with us every frame.
    // Its report only says which lap it is on.
    const L = meter.length
    for (const r of remotes.values()) {
      if (!r.car.root.visible) continue
      ;(r as any).meter ??= new TrackMeter(track.info)
      const along = ((((r as any).meter as TrackMeter).update(r.car.position) % L) + L) % L
      ;(r as any).live = Math.round((r.progress - along) / L) * L + along
    }
    const key = (id: number) => {
      const place = finishPlaces.get(id)
      if (place) return 1e6 - place
      if (id === myId) return meter.value
      const r = remotes.get(id)
      return (r as any)?.live ?? r?.progress ?? 0
    }
    // and a pass has to be a clear one (half a metre) before the order changes
    const was = new Map(lastOrder.map((id, i) => [id, i]))
    const biased = (id: number) => key(id) - (was.get(id) ?? racers.length) * 0.5
    racers.sort((a, b) => biased(b.id) - biased(a.id))
    lastOrder = racers.map((p) => p.id)
    const pos = racers.findIndex((p) => p.id === myId) + 1
    standing = { place: pos || 1, of: racers.length, progress: meter.value, racing }
    // original game's bottom-left gaps: metres to the car ahead and to the one behind
    // with other people in the race, only people: the nearest one ahead / behind
    const gaps = (me: number, at: number) => {
      const people = racers.some((p, i) => i !== me && !p.ai)
      const near = (dir: number) => {
        for (let i = me + dir; i >= 0 && i < racers.length; i += dir) {
          const p = racers[i]
          if (people && p.ai) continue
          return finishPlaces.has(p.id) ? null : { name: p.name, m: Math.abs(key(p.id) - at) }
        }
        return null
      }
      hud.gaps(near(-1), near(1))
    }
    if (racing && pos > 0 && finishedAt === null) gaps(pos - 1, meter.value)
    else hud.gaps(null, null)
    const time = phase === 'grid' ? 0 : (finishedAt ?? now) - raceStart
    const done = finishedAt !== null
    if (racing) hud.setRace({ pos: pos || 1, lap: lap.lap, laps: LAPS, race: time, best: bestLap, finished: done,
      last: lap.lapTimes.length ? lap.lapTimes[lap.lapTimes.length - 1] : null,
      lapTime: phase === 'grid' ? 0 : done ? null : now - lap.lapStart })
    else {
      // spectating: the HUD of the car the camera follows — the leader still running
      const w = racers.find((p) => p.id !== myId && !finishPlaces.has(p.id) && remotes.get(p.id)?.car.root.visible)
      watchId = w?.id ?? 0
      const wp = w ? key(w.id) : 0
      const wpos = w ? racers.indexOf(w) + 1 : 1
      hud.setRace({ pos: wpos, lap: Math.max(1, Math.floor(wp / meter.length)), laps: LAPS, race: phase === 'race' ? now - raceStart : 0,
        best: null, finished: false, last: null, lapTime: null })
      if (w) gaps(wpos - 1, wp)
      else hud.gaps(null, null)
    }
  }

  // countdown / timers
  const left = phaseEnds ? Math.max(0, phaseEnds - now) : -1
  if (phase === 'grid' && racing) {
    // original game's 3, 2, 1, GO a second apart: the grid's first second is for settling on the line
    const n = Math.ceil(left / 1000) - 1 // 3 .. 0
    countdown?.show(n >= 0 && n <= 2 ? (String(n + 1) as '1' | '2' | '3') : null)
    if (n !== beeped && n >= 0 && n <= 2) {
      beeped = n
      play('countdown', 0.8)
    }
  }
  if (phase === 'lobby') {
    hud.lobbyTimer(left < 0 ? 'Waiting for players…' : `Race starts in ${Math.ceil(left / 1000)}`)
  }
  if (phase === 'results') hud.resultsNext(left >= 0 ? `Back to the lobby in ${Math.ceil(left / 1000)}` : '')
  const watched = parked ? remotes.get(watchId)?.car : me
  hud.speed(watched?.speed ?? 0, watched?.vtop ?? me.vtop, !!watched)
  hud.sign(signs.update(watched && (racing || parked || offline) && phase !== 'results' ? watched.position : null, now, watched?.forward))
  weapons.update(frame)
  trainView?.update(sFrame, frame, camera.position)
  {
    const onTrack: Car[] = parked ? [] : [me]
    for (const r of remotes.values()) if (r.car.root.visible) onTrack.push(r.car)
    objectBodies?.throwCheck(onTrack.map((c) => c.position), now)
    objectViews.update(sFrame, frame, camera.position, onTrack, phase === 'lobby' && !parked)
  }
  hud.splitTick(now)
  {
    const tags: { id: number; pos: THREE.Vector3; name: string }[] = []
    for (const r of remotes.values()) {
      if (!r.car.root.visible) continue
      const p = players.find((x) => x.id === r.id)
      if (p && !p.ai) tags.push({ id: r.id, pos: r.car.position, name: p.name })
    }
    nameTags.update(tags, camera)
  }
  weather.update(sFrame, frame, camera.position)
  water.camera(camera.position)
  ambience.update(camera.position.toArray(), new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).toArray(), now)
  fx.update(frame)
  {
    const onFloor = parked ? [] : [me]
    for (const r of remotes.values()) if (r.car.root.visible) onFloor.push(r.car)
    for (const t of objectBodies?.trolleys ?? []) {
      t.car.readState()
      t.car.sync()
      onFloor.push(t.car)
    }
    skids.update(onFloor)
    shadows.update(onFloor)
    carLighting.update(onFloor.map((c) => c.root), frame, weather.light ? [...objectViews.lights, weather.light] : objectViews.lights)
    waterFx(onFloor)
    carParticles.update(onFloor, frame)
  }
  {
    const onPiano = parked ? [] : [{ id: myId, car: me }]
    for (const r of remotes.values()) if (r.car.root.visible) onPiano.push({ id: r.id, car: r.car })
    piano.update(onPiano, camera.position)
  }
  if (parked) {
    // spectating: the weapon in the watched car's hand (every browser follows everyone's pickups)
    const inv = watchId ? weapons.inv.get(watchId) : undefined
    hud.weapon(inv?.w ?? null, inv?.n ?? 0, null)
  } else hud.weapon(weapons.held, weapons.ammo, weapons.bombFuse())
  touch.mode(phase === 'lobby', !parked && !done)
  if (!offline) hud.ping(net.connected() ? net.rtt() : -1, net.transport() === 'tcp')

  // send my state
  sendAcc += frame
  // due within a few ms counts (two 16.67 ms frames are a hair under 1/30 s: that made it every
  // third frame, 20 Hz); keep the remainder so the average is STATE_HZ
  if ((sendAcc >= 1 / STATE_HZ - 0.004 || (sendNow && sendAcc >= 1 / 90)) && !parked && myId) {
    sendAcc = Math.min(1 / STATE_HZ, Math.max(0, sendAcc - 1 / STATE_HZ))
    sendNow = false
    const s = physics.state(me.id)
    stateBuf.set(s.pos, 0)
    stateBuf.set(s.quat, 3)
    stateBuf.set(s.vel, 7)
    stateBuf.set(s.ang, 10)
    stateBuf[13] = me.steer
    stateBuf[14] = racing ? meter.value : 0
    // 64: a weapon threw it about in the last 2.5 s, 128: put back / flipped in the last 1.5 s
    // (the server keeps only laps without either for the CPU drivers to learn from — shared/laps.ts)
    const pn = performance.now()
    const trouble = (me.now - me.hitAt < 2500 ? 64 : 0) | (flipping || pn - resetAt < 1500 || pn - flipAt < FLIP_S * 1000 + 1500 ? 128 : 0)
    stateBuf[15] = (racing ? 2 : 0) | (finishedAt !== null ? 1 : 0) | weapons.flags() | trouble
    // the physics state is `acc` behind the frame clock (fixed steps): stamp the state's own time
    net.sendState(sFrame - acc * 1000, stateBuf)
  }

  // camera: my car, or (spectating) whoever leads
  let target: Car = me
  if (parked) {
    let best: RemoteCar | null = remotes.get(watchId) ?? null
    if (!best?.car.root.visible) {
      best = null
      for (const r of remotes.values()) if (r.car.root.visible && (!best || r.progress > best.progress)) best = r
    }
    if (best) target = best.car
  }
  if ((window as any).__game.freeCam) { /* debugging */ }
  else if (parked && target === me) {
    // spectating with nobody to watch (no CPU cars, nobody visible yet): the parked car is far under
    // the track, and following it showed a black screen — look over the start line instead
    const s = track.info.start, yaw = -s.rot * Math.PI * 2
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
    const at = new THREE.Vector3(...s.pos)
    camera.position.copy(at).addScaledVector(fwd, -6).add(new THREE.Vector3(0, 3.5, 0))
    camera.lookAt(at.clone().addScaledVector(fwd, 4))
  } else if (phase === 'grid' && racing && gridLen > 0 && left >= 0) {
    // timed by this frame's own timestamp (t), not the moment this line runs: the gap between the
    // two changes from frame to frame and showed as the camera speeding up and slowing down
    startCam.update(me, 1 - Math.max(0, phaseEnds - t) / gridLen)
  }
  else cam.update(target, frame)
  clearTaps()
  const shaking = shake > 0.001
  if (shaking) {
    shakeSaved.pos.copy(camera.position)
    shakeSaved.quat.copy(camera.quaternion)
    const s = shake * shake, k = t / 1000
    camera.translateX(s * 0.3 * (Math.sin(k * 61) + Math.sin(k * 37.3)) * 0.5)
    camera.translateY(s * 0.3 * (Math.sin(k * 53.7) + Math.sin(k * 29.1)) * 0.5)
    camera.rotateZ(s * 0.05 * Math.sin(k * 41.9))
    shake = Math.max(0, shake - frame * 1.6)
  }
  sky?.update(camera)
  renderer.render(scene, camera)
  {
    const shown: THREE.Object3D[] = parked ? [] : [me.root]
    for (const r of remotes.values()) if (r.car.root.visible) shown.push(r.car.root)
    if (trainView) shown.push(trainView.root)
    shown.push(...objectViews.roots)
    mirrors.render(renderer, camera, shown)
  }
  countdown?.render(renderer)
  if (shaking) {
    camera.position.copy(shakeSaved.pos)
    camera.quaternion.copy(shakeSaved.quat)
  }
})
