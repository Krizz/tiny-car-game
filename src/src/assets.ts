// Loads what convert/convert.py wrote into public/game/ and turns it into
// three.js objects. Geometry arrives as one binary per track/car:
// positions f32 | uv f32 | colour u8x4, split into material groups.
import { courseFiles, mirrorCollision, mirrorInfo, parseCourse } from '../shared/course'
import * as THREE from 'three'
import type { ObjectsInfo } from '../shared/objects'

export interface Group {
  env?: boolean // car body: chrome (environment map) on these faces
  tex: number
  blend: number // 0 opaque (black keyed out), 1 vertex-alpha translucent, 2 additive
  double: boolean
  start: number
  count: number
  texture: string | null
}

export interface MeshMeta {
  vertices: number
  groups: Group[]
  layout: { position: number; uv: number; color: number }
  part?: string
}

export interface Zone {
  id: number
  pos: [number, number, number]
  rot: number[][] // 3x3, columns = zone axes in world
  half: [number, number, number]
}

export interface PanNode {
  pos: [number, number, number]
  dist: number
  prev: number[]
  next: number[]
}

export interface TrackInfo extends ObjectsInfo {
  name: string
  start: { pos: [number, number, number]; rot: number; grid?: number; side?: number }
  fog: { color: number[]; start: number; far: number }
  sky?: import('./sky').SkyFaces // skybox faces (Toys in the Hood 1, Toytanic)
  geometry: MeshMeta
  collision: { triangles: number }
  colBin?: string // collision file, when not collision.bin (props and their collision differ reversed)
  bin?: string // geometry file, when not track.bin (a reversed run with its own props)
  props?: { name: string; pos: [number, number, number]; flags: number }[]
  zones: Zone[]
  pan: { start: number; total: number; nodes: PanNode[] }
  pickups?: [number, number, number][]
  piano?: { pos: [number, number, number]; rot: number[][]; half: number[]; data: number }[]
  signs?: { pos: [number, number, number]; rot: number[][]; half: number[]; sign: number }[]
  ai?: { a: number[]; b: number[]; line: number; over: number; dist: number; prio: number; prev: number[]; next: number[] }[]
  train?: import('../shared/train').TrainInfo
  ambient?: import('./sound').AmbientSource[]
  music?: number[] // [first, last] CD track (public/game/music/trackNN.mp3)
  mirrors?: { strength: number; fade: number; planes: { y: number; x: number[]; z: number[] }[] } | null
}

export interface WheelInfo {
  offset1: number[]
  offset2: number[]
  present: boolean
  powered: boolean
  turnable: boolean
  steerRatio: number
  engineRatio: number
  radius: number
  mass: number
  maxPos: number
  skidWidth: number
  axleFriction: number
  grip: number
  staticFriction: number
  kineticFriction: number
}

export interface LinkInfo {
  mesh: number // index into CarInfo.meshes, -1 = none
  offset: number[]
  length: number
}

export interface SpringInfo {
  mesh: number
  offset: number[]
  length: number
  stiffness: number
  damping: number
  restitution: number
}

export interface CarInfo {
  key: string
  name: string
  topEnd: number
  acc: number
  steerRate: number
  steerMod: number
  engineRate: number
  topSpeed: number
  downForceMod: number
  com: number[]
  body: {
    mass: number
    inertia: number[]
    resistance: number
    angRes: number
    resMod: number
    grip: number
    staticFriction: number
    kineticFriction: number
  }
  wheels: WheelInfo[]
  springs: SpringInfo[]
  axles: LinkInfo[]
  aerial?: import('./aerial').AerialInfo
  pins: LinkInfo[]
  hull: number[][]
  texture: string | null
  meshes: (MeshMeta | null)[]
  env?: number[] // the body's chrome tint, 0..1 (EnvRGB)
  shadow?: { box: number[]; uv: number[] } // left, right, front, back (m, original game axes); cell on fx/shadow.png
}

export interface CarIndexEntry {
  key: string
  name: string
  class: number
  rating: number
  topEnd: number
  acc: number
  weight: number
  handling: number
}

/** Vertex colours in original game are baked light: 128 is roughly "as textured". */
export const LIGHT_SCALE = 1.6

const texLoader = new THREE.TextureLoader()
const texCache = new Map<string, Promise<THREE.Texture>>()

export function loadTexture(url: string): Promise<THREE.Texture> {
  let p = texCache.get(url)
  if (!p) {
    p = texLoader.loadAsync(url).then((t) => {
      t.flipY = false // PNGs are written top-down, original game UVs have v=0 at the top
      t.colorSpace = THREE.NoColorSpace // no conversions anywhere: look like the 1999 game
      t.anisotropy = 4
      t.generateMipmaps = true
      t.minFilter = THREE.LinearMipmapLinearFilter
      t.magFilter = THREE.LinearFilter
      return t
    })
    texCache.set(url, p)
  }
  return p
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  return r.json()
}

async function fetchBin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  return r.arrayBuffer()
}

// Level lighting: ×LIGHT_SCALE as before up to KNEE, then a soft shoulder towards white instead of
// clipping — sunlit pale concrete (Toys in the Hood's pavements) came out as flat white, curbs and all.
const KNEE = 0.55
function softLight(m: THREE.MeshBasicMaterial) {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec3 y = diffuseColor.rgb * ${LIGHT_SCALE.toFixed(3)};
    vec3 s = ${KNEE.toFixed(3)} + ${(1 - KNEE).toFixed(3)} * (1.0 - exp(-(y - ${KNEE.toFixed(3)}) / ${(1 - KNEE).toFixed(3)}));
    diffuseColor.rgb = mix(y, s, step(${KNEE.toFixed(3)}, y));
  }`)
  }
  m.customProgramCacheKey = () => 'soft'
}

/** `soft`: level geometry (baked light, see softLight); cars keep the plain ×LIGHT_SCALE (carlight.ts tints it). */
export function material(g: Group, tex: THREE.Texture | null, soft = false): THREE.Material {
  const m = new THREE.MeshBasicMaterial({
    map: tex,
    vertexColors: true,
    side: g.double ? THREE.DoubleSide : THREE.FrontSide,
    fog: true,
  })
  if (soft) softLight(m)
  else m.color.setScalar(LIGHT_SCALE)
  if (g.blend === 0) {
    m.alphaTest = tex ? 0.5 : 0
  } else if (g.blend === 1) {
    m.transparent = true
    m.depthWrite = false
    m.alphaTest = 0.02
  } else {
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
  }
  return m
}

// Car chrome, as in the game: gfx/envroll.bmp used as a sphere map (looked up by the face's
// view-space normal) and added on top of the paint, tinted by the car's EnvRGB.
const ENV_STRENGTH = 0.55
let envTex: THREE.Texture | null = null
function chrome(m: THREE.MeshBasicMaterial, tint: number[]) {
  envTex ??= (() => {
    const t = texLoader.load('/game/fx/envroll.png')
    t.colorSpace = THREE.NoColorSpace
    return t
  })()
  const col = new THREE.Vector3(...tint).multiplyScalar(ENV_STRENGTH)
  m.onBeforeCompile = (sh) => {
    sh.uniforms.envRoll = { value: envTex }
    sh.uniforms.envCol = { value: col }
    sh.vertexShader = 'varying vec3 vEnvN;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vEnvN = normalize(normalMatrix * normal);')
    sh.fragmentShader = 'uniform sampler2D envRoll;\nuniform vec3 envCol;\nvarying vec3 vEnvN;\n' + sh.fragmentShader.replace(
      '#include <envmap_fragment>',
      '#include <envmap_fragment>\n  outgoingLight += texture2D(envRoll, vec2(vEnvN.x, -vEnvN.y) * 0.5 + 0.5).rgb * envCol;')
  }
  m.customProgramCacheKey = () => 'chrome'
}

/** Smooth normals for unwelded triangles: faces meeting at a corner share its normal. */
function smoothNormals(g: THREE.BufferGeometry) {
  const p = g.attributes.position as THREE.BufferAttribute
  const n = new Float32Array(p.count * 3)
  const sum = new Map<string, number[]>()
  const key = (i: number) => `${Math.round(p.getX(i) * 1000)},${Math.round(p.getY(i) * 1000)},${Math.round(p.getZ(i) * 1000)}`
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i)
    b.fromBufferAttribute(p, i + 1)
    c.fromBufferAttribute(p, i + 2)
    const f = c.sub(b).cross(a.sub(b)) // area-weighted face normal
    for (let k = 0; k < 3; k++) {
      const s = sum.get(key(i + k)) ?? [0, 0, 0]
      s[0] += f.x; s[1] += f.y; s[2] += f.z
      sum.set(key(i + k), s)
    }
  }
  for (let i = 0; i < p.count; i++) {
    const s = sum.get(key(i))!
    const l = Math.hypot(s[0], s[1], s[2]) || 1
    n.set([s[0] / l, s[1] / l, s[2] / l], i * 3)
  }
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3))
}

export function geometry(buf: ArrayBuffer, meta: MeshMeta): THREE.BufferGeometry {
  const n = meta.vertices
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, meta.layout.position, n * 3), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, meta.layout.uv, n * 2), 2))
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(buf, meta.layout.color, n * 4), 4, true))
  meta.groups.forEach((gr, i) => g.addGroup(gr.start, gr.count, i))
  g.computeBoundingSphere()
  return g
}

export interface LoadedTrack {
  info: TrackInfo
  mesh: THREE.Mesh
  collision: { tris: Float32Array; materials: Float32Array }
}

/** A course: `level`, `level:r` (reversed), `level:m` (mirrored), `level:rm` (shared/course.ts). */
export async function loadTrack(name: string, onInfo?: (info: TrackInfo) => void): Promise<LoadedTrack> {
  const course = parseCourse(name) ?? parseCourse('toylite')!
  const { base, info: infoFile } = courseFiles(course)
  // a reversed run can have its own props, so its own geometry file (info.bin)
  const info = await fetchJson<TrackInfo>(base + infoFile)
  onInfo?.(info) // (the loading screen's track length)
  const [bin, col] = await Promise.all([fetchBin(base + (info.bin ?? 'track.bin')), fetchBin(base + (info.colBin ?? 'collision.bin'))])
  const geo = geometry(bin, info.geometry)
  const mats = await Promise.all(
    info.geometry.groups.map(async (g) => material(g, g.texture ? await loadTexture(base + g.texture) : null, true)),
  )
  const mesh = new THREE.Mesh(geo, mats)
  const nt = info.collision.triangles
  const tris = new Float32Array(col, 0, nt * 9)
  if (course.mirror) {
    // flipped left-right: three.js turns the winding round for a negative scale by itself
    mesh.scale.set(-1, 1, 1)
    mirrorInfo(info)
    mirrorCollision(tris)
  }
  mesh.updateMatrix()
  mesh.matrixAutoUpdate = false
  return {
    info,
    mesh,
    collision: { tris, materials: new Float32Array(col, nt * 36, nt) },
  }
}

/** A level object's models (one .bin in the level's folder, on the level's texture pages): a maker per model. */
export async function loadLevelModels<K extends string>(course: string, file: string, metas: Record<K, MeshMeta>): Promise<Record<K, () => THREE.Mesh>> {
  const base = courseFiles(parseCourse(course) ?? parseCourse('toylite')!).base
  const bin = await fetchBin(base + file)
  const out = {} as Record<K, () => THREE.Mesh>
  for (const k of Object.keys(metas) as K[]) {
    const meta = metas[k]
    const geo = geometry(bin, meta)
    const mats = await Promise.all(meta.groups.map(async (g) => material(g, g.texture ? await loadTexture(base + g.texture) : null, true)))
    out[k] = () => new THREE.Mesh(geo, mats)
  }
  return out
}

export interface LoadedCar {
  info: CarInfo
  body: THREE.Mesh
  wheels: (THREE.Mesh | null)[]
  /** a fresh mesh of CarInfo.meshes[i] (springs, axles, pins) */
  part?: (i: number) => THREE.Mesh | null
}

const carCache = new Map<string, Promise<{ info: CarInfo; bin: ArrayBuffer; tex: THREE.Texture | null }>>()

/** A fresh set of meshes for one car (geometry/materials shared between copies). */
export async function loadCar(key: string): Promise<LoadedCar> {
  let p = carCache.get(key)
  if (!p) {
    const base = `/game/cars/${key}/`
    p = (async () => {
      const [info, bin] = await Promise.all([fetchJson<CarInfo>(base + 'car.json'), fetchBin(base + 'car.bin')])
      const tex = info.texture ? await loadTexture(base + info.texture) : null
      return { info, bin, tex }
    })()
    carCache.set(key, p)
  }
  const { info, bin, tex } = await p
  const make = (meta: MeshMeta | null) => {
    if (!meta) return null
    const geo = geometry(bin, meta)
    const shiny = meta.groups.some((g) => g.env) && info.env && Math.max(...info.env) > 0
    if (shiny) smoothNormals(geo)
    const mats = meta.groups.map((g) => {
      const m = material(g, g.tex >= 0 ? tex : null)
      if (shiny && g.env) chrome(m as THREE.MeshBasicMaterial, info.env!)
      return m
    })
    return new THREE.Mesh(geo, mats)
  }
  return {
    info,
    body: make(info.meshes[0])!,
    wheels: [1, 2, 3, 4].map((i) => make(info.meshes[i])),
    part: (i) => (i >= 0 ? make(info.meshes[i] ?? null) : null),
  }
}

export function loadCarIndex(): Promise<CarIndexEntry[]> {
  return fetchJson('/game/cars/index.json')
}
