// Is a prop solid? A ray down onto each instance of a model (from 3 m above its origin): the height
// where it lands vs the floor next to it. Equal = no collision for the prop.
import { Physics } from '../src/physics'
const ROOT = new URL('../public/', import.meta.url).pathname
const [level, ...names] = process.argv.slice(2)
const info = await Bun.file(ROOT + `game/${level}/track.json`).json()
const col = await Bun.file(ROOT + `game/${level}/collision.bin`).arrayBuffer()
const nt = info.collision.triangles
const ph = await Physics.load(ROOT + 'box3d.wasm')
ph.addMesh(new Float32Array(col, 0, nt * 9), new Float32Array(col, nt * 36, nt), 0.5)
for (const p of (info.props ?? [])) {
  if (names.length && !names.includes(p.name)) continue
  const [x, y, z] = p.pos
  const on = ph.raycast([x, y + 3, z], [0, -1, 0], 10)
  const off = ph.raycast([x + 3, y + 3, z], [0, -1, 0], 10)
  console.log(p.name, 'origin y', y.toFixed(2), 'hit on', on?.point[1].toFixed(2), 'beside', off?.point[1].toFixed(2))
}
