// Floor height along the racing line: finds steps/ramps the cars can't take.
//   bun test/profile.ts [fromNode] [toNode]
import { Physics } from '../src/physics'
import type { TrackInfo } from '../src/assets'
const ROOT = new URL('../public/', import.meta.url).pathname
const physics = await Physics.load(ROOT + 'box3d.wasm')
const info: TrackInfo = await Bun.file(ROOT + 'game/toy2/track.json').json()
const col = await Bun.file(ROOT + 'game/toy2/collision.bin').arrayBuffer()
const nt = info.collision.triangles
physics.addMesh(new Float32Array(col, 0, nt * 9), new Float32Array(col, nt * 36, nt), 0.5)
const a = Number(process.argv[2] ?? 0), b = Number(process.argv[3] ?? info.pan.nodes.length - 1)
let prev: number | null = null
for (let i = a; i <= b; i++) {
  const n = info.pan.nodes[i], m = info.pan.nodes[n.next[0] ?? i]
  for (let k = 0; k < 4; k++) {
    const f = k / 4
    const x = n.pos[0] + (m.pos[0] - n.pos[0]) * f, z = n.pos[2] + (m.pos[2] - n.pos[2]) * f
    const y = n.pos[1] + (m.pos[1] - n.pos[1]) * f
    const h = physics.raycast([x, y + 1.0, z], [0, -1, 0], 3)
    const fy = h ? h.point[1] : NaN
    const step = prev !== null && h ? fy - prev : 0
    console.log(`${i}+${f} x=${x.toFixed(1)} z=${z.toFixed(1)} nodeY=${y.toFixed(2)} floor=${fy.toFixed(2)} ny=${h ? h.normal[1].toFixed(2) : '-'} ${Math.abs(step) > 0.06 ? 'STEP ' + step.toFixed(2) : ''}`)
    if (h) prev = fy
  }
}
