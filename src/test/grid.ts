// The start grid on every course: 16 slots from gridSlot() — all distinct, how close the nearest
// two are, how far back it reaches.   bun test/grid.ts [course prefix]
import { Physics } from '../src/physics'
import type { TrackInfo } from '../src/assets'
import { gridSlot } from '../src/race'
import { COURSES, courseFiles, mirrorCollision, mirrorInfo, parseCourse } from '../shared/course'
const ROOT = new URL('../public/', import.meta.url).pathname
const only = process.argv[2]
for (const id of COURSES) {
  if (only && !id.startsWith(only)) continue
  const c = parseCourse(id)!
  const f = courseFiles(c)
  const info: TrackInfo = await Bun.file(ROOT + f.base.slice(1) + f.info).json()
  if (c.mirror) mirrorInfo(info)
  const col = await Bun.file(ROOT + f.base.slice(1) + (info.colBin ?? 'collision.bin')).arrayBuffer()
  const nt = info.collision.triangles
  const tris = new Float32Array(col, 0, nt * 9)
  if (c.mirror) mirrorCollision(tris)
  const ph = await Physics.load(ROOT + 'box3d.wasm')
  ph.addMesh(tris, new Float32Array(col, nt * 36, nt), 0.5)
  const slots = Array.from({ length: 16 }, (_, i) => gridSlot(info, ph, i).pos)
  if (process.env.WHY) slots.forEach((p, i) => console.log(`  ${i}: ${p.toArray().map((v) => v.toFixed(1)).join(",")}`))
  let near = Infinity
  for (let a = 0; a < 16; a++) for (let b = a + 1; b < 16; b++) near = Math.min(near, slots[a].distanceTo(slots[b]))
  const back = Math.max(...slots.map((p) => p.distanceTo(slots[0])))
  console.log(`${id.padEnd(14)} grid ${info.start.grid ?? 0}  nearest pair ${near.toFixed(2)} m  reaches ${back.toFixed(1)} m  start→floor ${(info.start.pos[1] - slots[1].y).toFixed(1)} m`)
}
