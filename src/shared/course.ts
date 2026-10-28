// The courses: original game's 13 race tracks, each forwards, reversed (the level's own reversed/ route:
// AI line, checkpoints, start), mirrored (flipped left-right as it loads, like the game's Mirror
// mode) or both. A course id is `<level>`, `<level>:r`, `<level>:m` or `<level>:rm`.
// Shared by the browsers and the server's CPU cars, so every one of them flips a course the same way.
import type { TrackInfo } from '../src/assets'

/** The race levels' folders under /game/, in the order of the original game's championship cups. */
export const LEVEL_IDS = ['nhood1', 'market2', 'muse2', 'garden1', 'toylite', 'wild_west1', 'ship1', 'nhood2', 'toy2',
  'wild_west2', 'ship2', 'muse1', 'market1']

/** Folder -> the name shown in the game. The names come from the user's own game files at conversion
 *  (tool/prepare.py writes game/levels.json; setLevelNames); until then a level is called by its folder. */
export const LEVELS: Record<string, string> = Object.fromEntries(LEVEL_IDS.map((l) => [l, l]))

export interface Course {
  id: string
  level: string
  rev: boolean
  mirror: boolean
}

export function parseCourse(id: unknown): Course | null {
  if (typeof id !== 'string') return null
  const m = /^([a-z0-9_]+)(?::(r?)(m?))?$/.exec(id)
  if (!m || !LEVELS[m[1]]) return null
  const rev = m[2] === 'r', mirror = m[3] === 'm'
  return { id: courseId(m[1], rev, mirror), level: m[1], rev, mirror }
}

export function courseId(level: string, rev: boolean, mirror: boolean): string {
  return rev || mirror ? `${level}:${rev ? 'r' : ''}${mirror ? 'm' : ''}` : level
}

/** Every course id, level by level: forwards, reversed, mirrored, reversed + mirrored. */
export const COURSES: string[] = Object.keys(LEVELS).flatMap((l) => [
  courseId(l, false, false), courseId(l, true, false), courseId(l, false, true), courseId(l, true, true),
])

/** id -> display name ("Toy World 2 R M"); also the old TRACKS map's role. */
export const TRACKS: Record<string, string> = Object.fromEntries(COURSES.map((id) => [id, courseName(id)]))

/** Names from game/levels.json ({folder: name}); unknown folders and empty names are ignored. */
export function setLevelNames(names: Record<string, unknown>) {
  for (const l of LEVEL_IDS) if (typeof names[l] === 'string' && names[l]) LEVELS[l] = names[l] as string
  for (const id of COURSES) TRACKS[id] = courseName(id)
}

export function courseName(id: string): string {
  const c = parseCourse(id)
  if (!c) return id
  return LEVELS[c.level] + (c.rev ? ' R' : '') + (c.mirror ? ' M' : '')
}

/** The files of a course: geometry/collision are the level's; the route file depends on the direction. */
export function courseFiles(c: Course) {
  return { base: `/game/${c.level}/`, info: c.rev ? 'track-rev.json' : 'track.json' }
}

// ------------------------------------------------------------ mirroring (x -> -x)

const mx = (p: number[]) => {
  p[0] = -p[0]
}
// a 3x3 whose columns are axes: M' = S M S with S = diag(-1, 1, 1)
const mrot = (r: number[][]) => {
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) if ((i === 0) !== (k === 0)) r[i][k] = -r[i][k]
}

/** Flip a track's route data left-right in place (start, checkpoints, nodes, pickups, piano). */
export function mirrorInfo(info: TrackInfo): TrackInfo {
  mx(info.start.pos)
  info.start.rot = -info.start.rot // yaw = -rot·2π, and a mirrored heading is -yaw
  info.start.side = -(info.start.side ?? 1) // the grid's pole side flips too
  for (const z of info.zones) {
    mx(z.pos)
    mrot(z.rot)
  }
  for (const n of info.pan.nodes) mx(n.pos)
  for (const p of info.pickups ?? []) mx(p)
  for (const p of info.piano ?? []) {
    mx(p.pos)
    mrot(p.rot)
  }
  for (const a of info.ambient ?? []) mx(a.pos)
  for (const L of (info as any).lights ?? []) {
    mx(L.pos)
    mx(L.dir)
  }
  for (const o of info.objects ?? []) {
    mx(o.pos)
    mrot(o.rot)
  }
  if (info.objects) info.objectsMirror = true
  for (const m of info.mirrors?.planes ?? []) m.x = [-m.x[1], -m.x[0]]
  for (const b of [...((info as any).splits ?? []), ...((info as any).throws ?? [])]) {
    mx(b.pos)
    mrot(b.rot)
  }
  for (const f of (info as any).fields ?? []) {
    mx(f.pos)
    mrot(f.rot)
    mx(f.dir)
  }
  for (const p of info.signs ?? []) {
    mx(p.pos)
    mrot(p.rot)
    if (p.sign < 8) p.sign ^= 4 // left turns become right turns
  }
  for (const n of info.ai ?? []) {
    mx(n.a)
    mx(n.b)
  }
  if (info.train) {
    mx(info.train.pos)
    mx(info.train.fwd)
    info.train.mirror = true // its model is drawn flipped
  }
  return info
}

/** Flip collision triangles left-right in place; the winding is swapped so they still face up. */
export function mirrorCollision(tris: Float32Array): Float32Array {
  for (let t = 0; t < tris.length; t += 9) {
    tris[t] = -tris[t]
    tris[t + 3] = -tris[t + 3]
    tris[t + 6] = -tris[t + 6]
    for (let k = 0; k < 3; k++) {
      const a = tris[t + 3 + k]
      tris[t + 3 + k] = tris[t + 6 + k]
      tris[t + 6 + k] = a
    }
  }
  return tris
}

/**
 * A lobby's choice: 12 of the 13 levels (one left out at random), each in a random direction —
 * forwards, reversed, mirrored or both — in championship order.
 */
export function offerCourses(n = 12): string[] {
  const levels = Object.keys(LEVELS)
  const out = new Set(levels)
  while (out.size > n) out.delete(levels[Math.floor(Math.random() * levels.length)])
  return levels.filter((l) => out.has(l)).map((l) => courseId(l, Math.random() < 0.5, Math.random() < 0.5))
}
