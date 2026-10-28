// Drawing the level's moving objects (shared/objects.ts says where they are and why): Toy World's
// planes circling on their strings with spinning propellers, the helicopter hovering with its
// rotors, rocking horses, the balloon, the radar dish, boats bobbing in the water, the dragon
// breathing fire, the beach ball; Museum 2's planets orbiting the sun; the strobes chasing along
// Museum 2's floor and Toys in the Hood 1's road, Ghost Town 2's flickering lanterns, Toytanic 2's
// deck lights, Supermarket 2's sliding doors, Ghost Town's tumbleweeds; the water (src/water.ts).
// All on the server clock. The lamps also light the cars as they pass (`lights`, src/carlight.ts).
import * as THREE from 'three'
import { loadLevelModels } from './assets'
import { SPR, type Fx } from './fx'
import type { Physics } from './physics'
import { play } from './sound'
import { T, horseTilt, sliderOffset, type LevelObject, type ObjectBodies, type ObjectsInfo } from '../shared/objects'
import type { LevelLight } from './carlight'
import { Glow } from './glow'
import { Waters } from './water'
import { LevelFx } from './levelfx'
import { courseFiles, parseCourse } from '../shared/course'

// strobes (as in the original executable): each one of a row lights up in turn — the row's
// clock counts 50 a second round `count` (its 3rd number), this one's turn is at `seq` (its 2nd);
// it fades up over 5 counts before and down over 10 after. Light colour by kind (its 1st number),
// the light reaching 10.24 m, from 12 cm under the lamp on the kinds that hang
const STROBE_RGB = [[0, 192, 192], [128, 0, 0], [128, 64, 0]]
const STROBE_UP = 5, STROBE_DOWN = 10, STROBE_REACH = 10.24
// lanterns: a brightness that wanders at random, light (150..450, 123..369, 72..216)
// reaching 6..14 m; ship lights a steady (363, 298, 173) to 15 m with a glow 80 cm above
const LANTERN_GLOW_Y = 0.4
const SHIP_GLOW_Y = 0.8

const PROP_AT = new THREE.Vector3(0, 1.17, -1.42) // plane nose (model frame: it faces -z)
const ROTOR_AT = new THREE.Vector3(0, 3.28, -0.66) // copter main rotor hub
const TAIL_AT = new THREE.Vector3(0.12, 3.1, 2.3) // copter tail rotor
const DRAGON_EVERY = 9000 // ms between breaths
const DRAGON_BREATH = 2200

interface Live {
  glow?: Glow
  level?: number // a lantern's flicker 0..1
  o: LevelObject
  root: THREE.Group // at the object's spot, turned like it
  body: THREE.Group // what moves inside it
  parts: THREE.Object3D[]
  base: THREE.Quaternion
}

/** The beach ball: eight gores, green / blue / yellow / red round it with white caps, shaded
 *  from above — worked out per pixel from the model's own sphere (clean gore edges).
 *  models/beachball.m maps a whole texture page by its index 0, which on every level is the
 *  floor; the ball's own picture isn't on the disc. The look is taken from the game. */
const BALL_MATERIAL = new THREE.ShaderMaterial({
  vertexShader: `
    varying vec3 vP;
    void main() {
      vP = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    varying vec3 vP;
    void main() {
      vec3 n = normalize(vP);
      float a = atan(n.x, n.z) / 6.2831853 + 0.5;
      int g = int(mod(floor(a * 8.0), 4.0));
      vec3 c = g == 0 ? vec3(0.22, 0.72, 0.2) : g == 1 ? vec3(0.1, 0.28, 0.85) : g == 2 ? vec3(0.95, 0.8, 0.12) : vec3(0.85, 0.13, 0.1);
      if (abs(n.y) > 0.93) c = vec3(0.95);
      float shade = 0.45 + 0.7 * max(0.0, dot(n, normalize(vec3(0.4, 0.8, 0.45))));
      gl_FragColor = vec4(c * shade, 1.0);
    }`,
})

export class ObjectViews {
  private list: Live[] = []
  private byPlanet = new Map<number, Live>()
  private orbits = new Map<Live, { z: THREE.Vector3; y: THREE.Vector3; dist: number }>() // planets' orbit frames
  private breath = -1
  private mirrored: boolean
  readonly water: Waters
  levelFx: LevelFx | null = null
  /** Lights the lamps cast this frame (for the cars, src/carlight.ts). */
  readonly lights: LevelLight[] = []

  onStar: (found: number, of: number) => void = () => {}
  onRaceStar: (at: THREE.Vector3) => void = () => {}
  /** a Global Pulse went off: the race's star is gone */
  takeRaceStar() {
    this.levelFx?.takeRaceStar()
  }

  constructor(private info: ObjectsInfo, course: string, private scene: THREE.Scene, private fx: Fx, private bodies: ObjectBodies | null, private physics: Physics, private farPlane = 1000) {
    this.mirrored = !!info.objectsMirror
    this.water = new Waters(info, scene)
    const objs = info.objects ?? []
    if (!objs.length || !info.objectModels) return
    loadLevelModels(course, 'objects.bin', info.objectModels).then((make) => {
      const files = courseFiles(parseCourse(course) ?? parseCourse('toylite')!)
      this.levelFx = new LevelFx(info as any, scene, fx, physics, bodies, (n) => (make as Record<string, () => THREE.Mesh>)[n]?.(), files, this.farPlane)
      this.levelFx.onStar = (n, of) => this.onStar(n, of)
      this.levelFx.onRaceStar = (at) => this.onRaceStar(at)
      for (const o of objs) {
        const root = new THREE.Group()
        const m = new THREE.Matrix4().set(
          o.rot[0][0], o.rot[0][1], o.rot[0][2], 0,
          o.rot[1][0], o.rot[1][1], o.rot[1][2], 0,
          o.rot[2][0], o.rot[2][1], o.rot[2][2], 0,
          0, 0, 0, 1,
        )
        root.quaternion.setFromRotationMatrix(m)
        root.position.set(o.pos[0], o.pos[1], o.pos[2])
        const body = new THREE.Group()
        if (info.objectsMirror) body.scale.x = -1
        root.add(body)
        const parts: THREE.Object3D[] = []
        let glow: Glow | undefined
        const model = (name: string) => (make as Record<string, () => THREE.Mesh>)[name]?.()
        if (o.type === T.PLANE) {
          body.add(model('plane'))
          const prop = new THREE.Group()
          prop.position.copy(PROP_AT)
          const pm = model('plane2')
          if (pm) prop.add(pm)
          body.add(prop)
          parts.push(prop)
        } else if (o.type === T.COPTER) {
          body.add(model('copter'))
          for (const [name, at] of [['copter2', ROTOR_AT], ['copter3', TAIL_AT]] as const) {
            const g = new THREE.Group()
            g.position.copy(at)
            const mm = model(name)
            if (mm) g.add(mm)
            body.add(g)
            parts.push(g)
          }
        } else if (o.type === T.BOAT) {
          body.add(model(o.p[0] ? 'boat2' : 'boat1'))
        } else if (o.type === T.DRAGON) {
          body.add(model('dragon1'))
          const head = new THREE.Group()
          head.add(model('dragon2'))
          const jaw = new THREE.Group()
          jaw.add(model('dragon3'))
          body.add(head, jaw)
          parts.push(head, jaw)
        } else if (o.type === T.PLANET && o.p[0] === 11) {
          // the sun: a bright sphere and a glow
          const sun = new THREE.Mesh(new THREE.SphereGeometry(4, 32, 16), new THREE.MeshBasicMaterial({ color: 0xffd860, fog: false }))
          body.add(sun)
        } else if (o.type === T.PACKET) {
          body.add(model(o.p[0] ? 'packet1' : 'packet'))
        } else if (o.type === T.STROBE || o.type === T.LANTERN || o.type === T.SHIPLIGHT) {
          for (const n of o.models) {
            const mm = model(n)
            if (mm) body.add(mm)
          }
          // strobes in their light's colour (0..128 = full), lanterns and ship lights 0xffd17a
          // original executable turns the ship light over (it builds its matrix from a down axis): the
          // file's lantern stands on its top — drawn as it is, the lamp sat on the deck under its glow
          if (o.type === T.SHIPLIGHT) body.rotation.x = Math.PI
          const c = o.type === T.STROBE ? (STROBE_RGB[o.p[0]] ?? [128, 128, 128]).map((v) => Math.min(1, v / 128)) : [1, 0.82, 0.48]
          glow = new Glow(new THREE.Color(c[0], c[1], c[2]), o.type === T.STROBE, o.type === T.LANTERN ? 0.8 : 0.35)
          scene.add(glow.root)
        } else if (o.type === T.SPRINKLER) {
          // the base, and the head 38 cm above it turning round (src/levelfx.ts)
          const base = model(o.models[0])
          if (base) body.add(base)
          const head = new THREE.Group()
          head.position.set(0, 0.38, 0)
          const hm = model(o.models[1])
          if (hm) head.add(hm)
          body.add(head)
          this.levelFx!.addSprinkler(o, head)
        } else if (o.type === T.STAR) {
          const st = model('star')
          if (st) body.add(st)
          root.visible = false
          this.levelFx!.addStar(o, root)
        } else if (o.type === T.THROWER) {
          // nothing to see: it throws basketballs (src/levelfx.ts)
        } else if (o.type === T.WATER || o.type === T.RIPPLES || o.type === T.STREAM) {
          const mm = model(o.models[0])
          if (mm) body.add(this.water.surface(o, mm))
        } else if (o.type === T.BALL) {
          // models/beachball.m maps a whole page we don't have (the level's page 0 is floorboards)
          const mm = model('beachball')
          if (mm) body.add(new THREE.Mesh(mm.geometry, BALL_MATERIAL))
        } else {
          for (const n of o.models) {
            const mm = model(n)
            if (mm) body.add(mm)
          }
        }
        scene.add(root)
        const live: Live = { o, root, body, parts, base: root.quaternion.clone(), glow, level: 0.5 }
        this.list.push(live)
        if (o.type === T.PLANET) this.byPlanet.set(o.p[0], live)
      }
    }).catch((e) => console.warn('objects:', e))
  }

  /** What shows in reflective floors (mirrors.ts fades out whatever is high above them). */
  get roots(): THREE.Object3D[] {
    return this.list.map((l) => l.root)
  }

  update(ms: number, dt: number, listener: THREE.Vector3, cars: { position: THREE.Vector3 }[] = [], lobby = false) {
    const t = ms / 1000
    this.lights.length = 0
    this.water.update(ms, dt)
    this.levelFx?.update(ms, dt, listener, cars, lobby)
    for (const l of this.list) {
      const { o, root, body, parts } = l
      switch (o.type) {
        case T.PLANE: {
          // round its spot on a radius, nose along the circle, banked in
          const dir = o.p[3] ? -1 : 1
          const r = o.p[1] / 100, a = dir * t * (o.p[0] * Math.PI / 180)
          body.position.set(Math.sin(a) * r, 0, Math.cos(a) * r)
          // the model faces -z: along the circle is a + π/2 (dir 1) turned half round
          body.rotation.set(0, a + (dir * Math.PI) / 2 + Math.PI, dir * (o.p[2] * Math.PI) / 180, 'YXZ')
          parts[0].rotation.z = t * 40
          break
        }
        case T.COPTER: {
          // drift about the spot (a slow Lissajous over its ranges), turning into the way it goes
          const rx = o.p[0] / 20, ry = o.p[1] / 20, rz = o.p[2] / 20
          const x = Math.sin(t * 0.21) * rx, z = Math.sin(t * 0.13 + 1) * rz, y = o.p[3] / 20 + Math.sin(t * 0.7) * ry
          const vx = Math.cos(t * 0.21) * 0.21 * rx, vz = Math.cos(t * 0.13 + 1) * 0.13 * rz
          body.position.set(x, y, z)
          body.rotation.set(Math.sin(t * 0.9) * 0.05, Math.atan2(-vx, -vz), Math.sin(t * 0.7) * 0.06, 'YXZ')
          parts[0].rotation.y = t * 30
          parts[1].rotation.x = t * 40
          break
        }
        case T.HORSE:
          body.rotation.x = horseTilt(o, ms)
          break
        case T.BALLOON:
          body.position.y = Math.sin(t * 0.4) * 0.6
          body.rotation.y = t * 0.1
          break
        case T.RADAR:
          body.rotation.y = t * 1.2
          break
        case T.BOAT:
          body.position.y = Math.sin(t * 1.3 + o.pos[0]) * 0.05
          body.rotation.set(Math.sin(t * 1.1 + o.pos[2]) * 0.06, Math.sin(t * 0.3) * 0.2, Math.sin(t * 0.9) * 0.05)
          break
        case T.PLANET: {
          if (o.p[0] === 11) break
          const sun = this.byPlanet.get(o.p[1])
          if (sun && sun !== l) {
            // original executable: the orbit's frame looks from the parent to where the level puts the
            // planet, rolled 0.1 turn (36°) about that line, and turns about its own x — a steep,
            // tilted circle through the planet's place, not a flat one (flat, Mars ran along the
            // planetarium's track ring and Jupiter crossed it). |p[2]| × 72 / 32768 turns a second
            // (the sign isn't used)
            let f = this.orbits.get(l)
            if (!f) {
              const z = new THREE.Vector3(o.pos[0] - sun.o.pos[0], o.pos[1] - sun.o.pos[1], o.pos[2] - sun.o.pos[2])
              const dist = z.length()
              z.divideScalar(Math.max(1e-6, dist))
              const x = new THREE.Vector3(z.z, 0, -z.x).normalize()
              const y = new THREE.Vector3().crossVectors(z, x).applyAxisAngle(z, Math.PI * 0.2)
              f = { z, y, dist }
              this.orbits.set(l, f)
            }
            const c = sun.root.position, a = t * Math.abs(o.p[2]) * 72 / 32768 * Math.PI * 2
            root.position.copy(c).addScaledVector(f.z, f.dist * Math.cos(a)).addScaledVector(f.y, f.dist * Math.sin(a))
          }
          body.rotation.y = t * (o.p[3] * Math.PI) / 180
          break
        }
        case T.DRAGON:
          this.dragon(l, ms, listener)
          break
        case T.STROBE: {
          const count = Math.max(1, o.p[2]), u = ms / 20
          let ph = (u % count) - o.p[1]
          if (ph < -count / 2) ph += count
          if (ph > count / 2) ph -= count
          const k = ph < -STROBE_UP || ph > STROBE_DOWN ? 0 : ph < 0 ? (STROBE_UP + ph) / STROBE_UP : (STROBE_DOWN - ph) / STROBE_DOWN
          const at = root.localToWorld(new THREE.Vector3(0, o.p[0] ? -0.12 : 0, 0))
          l.glow?.set(at, 2 * (0.16 + 0.64 * k) * 0.8, k, listener, t)
          if (k > 0) {
            const c = STROBE_RGB[o.p[0]] ?? [255, 255, 255]
            this.light(at, STROBE_REACH, c.map((v) => v * k))
          }
          break
        }
        case T.LANTERN: {
          // the game's random walk, drawn back towards half
          let b = l.level ?? 0.5
          b += (0.5 - b) * dt * 0.2
          b += (Math.random() * 2 - 1) * dt * 1.2
          b = Math.max(0, Math.min(1, b))
          l.level = b
          const at = root.localToWorld(new THREE.Vector3(0, LANTERN_GLOW_Y, 0))
          l.glow?.set(at, 1.6, 0.4 + 0.6 * b, listener)
          this.light(at, 6 + 8 * b, [150 + 300 * b, 123 + 246 * b, 72 + 144 * b])
          break
        }
        case T.SHIPLIGHT: {
          const at = root.position.clone().add(new THREE.Vector3(0, SHIP_GLOW_Y, 0))
          l.glow?.set(at, 1.3, 1, listener)
          this.light(at, 15, [363, 298, 173])
          break
        }
        case T.SLIDER: {
          const d = sliderOffset(o, ms, this.mirrored)
          root.position.set(o.pos[0] + d[0], o.pos[1] + d[1], o.pos[2] + d[2])
          break
        }
        case T.TUMBLEWEED: {
          const w = this.bodies?.weeds.find((x) => x.o === o)
          if (w) {
            const s = this.physics.state(w.id)
            root.position.set(s.pos[0], s.pos[1], s.pos[2])
            root.quaternion.set(s.quat[0], s.quat[1], s.quat[2], s.quat[3])
          }
          break
        }
        case T.BARREL:
          // Museum 2's space tunnel turns about its long axis (speed / 32768 × 72 turns a second)
          body.rotation.x = t * (o.p[0] / 32768) * 72 * Math.PI * 2
          break
        case T.SPRINKLER:
        case T.BOTTLE:
        case T.CONE:
        case T.PACKET:
        case T.ABC: {
          const id = this.bodies?.loose.get(o)
          if (id !== undefined) {
            const s = this.physics.state(id)
            root.position.set(s.pos[0], s.pos[1], s.pos[2])
            root.quaternion.set(s.quat[0], s.quat[1], s.quat[2], s.quat[3])
          }
          break
        }
        case T.BALL: {
          const b = this.bodies?.balls.find((x) => x.o === o)
          if (b) {
            const s = this.physics.state(b.id)
            root.position.set(s.pos[0], s.pos[1] - 1.0, s.pos[2])
            body.position.y = 1.0
            body.quaternion.set(s.quat[0], s.quat[1], s.quat[2], s.quat[3])
            root.quaternion.identity()
          }
          break
        }
      }
    }
  }

  private light(at: THREE.Vector3, reach: number, rgb: number[]) {
    this.lights.push({ pos: [at.x, at.y, at.z], reach, dir: [0, -1, 0], cone: 180, rgb, flag: 2, type: 0 })
  }

  /** Every few seconds the dragon lifts its head, opens its jaw and breathes fire. */
  private dragon(l: Live, ms: number, listener: THREE.Vector3) {
    const k = ms % DRAGON_EVERY
    const on = k < DRAGON_BREATH
    const open = on ? Math.sin((k / DRAGON_BREATH) * Math.PI) : 0
    const [head, jaw] = l.parts
    head.rotation.z = -open * 0.12
    jaw.rotation.z = open * 0.25
    const cycle = Math.floor(ms / DRAGON_EVERY)
    if (on && this.breath !== cycle) {
      this.breath = cycle
      const d = l.root.position.distanceTo(listener)
      play('dragon', Math.min(1, 1.5 / (1 + Math.max(0, d - 8) * 0.06)))
    }
    if (!on || open < 0.35) return
    // fire from the mouth (model frame: the head reaches to x -6.9), out along the snout
    const mouth = new THREE.Vector3(-6.6, -0.9, 0.5)
    const along = new THREE.Vector3(-1, -0.15, 0.1).normalize()
    if (this.info.objectsMirror) {
      mouth.x = -mouth.x
      along.x = -along.x
    }
    l.root.localToWorld(mouth)
    along.applyQuaternion(l.root.quaternion)
    for (let i = 0; i < 2; i++) {
      const vel = along.clone().multiplyScalar(7 + Math.random() * 3).add(new THREE.Vector3((Math.random() - 0.5) * 1.5, Math.random() * 1.2, (Math.random() - 0.5) * 1.5))
      this.fx.sprite(SPR.fire, mouth, { size: 0.6, sizeEnd: 2.4, life: 0.7, vel, spin: 2, color: 0xff7a2a })
    }
  }
}
