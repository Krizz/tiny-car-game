// which forks the load-time checks rule out, per course
import { Physics } from '../src/physics'
import { AiDriver } from '../src/aidriver'
import { COURSES, courseFiles, mirrorCollision, mirrorInfo, parseCourse } from '../shared/course'
const ROOT = new URL('../public/', import.meta.url).pathname
for (const id of COURSES) {
  const course = parseCourse(id)!
  const cf = courseFiles(course)
  const info: any = await Bun.file(ROOT + cf.base.slice(1) + cf.info).json()
  if (course.mirror) mirrorInfo(info)
  const col = await Bun.file(ROOT + cf.base.slice(1) + (info.colBin ?? 'collision.bin')).arrayBuffer()
  const nt = info.collision.triangles
  if (course.mirror) mirrorCollision(new Float32Array(col, 0, nt * 9))
  const ph = await Physics.load(ROOT + 'box3d.wasm')
  ph.addMesh(new Float32Array(col, 0, nt * 9), new Float32Array(col, nt * 36, nt), 0.5)
  const d = new AiDriver(info, { physics: ph }) as any
  const forks = info.ai.map((n: any, i: number) => n.next.length > 1 ? i : -1).filter((i: number) => i >= 0)
  console.log(id.padEnd(14), 'forks', forks.length, 'ruled out', [...d.bad].map(([i, p]: number[]) => `${i}->${info.ai[i].next[p]}`).join(' '))
}
