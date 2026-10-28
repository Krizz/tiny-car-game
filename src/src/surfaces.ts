// original game's 27 floor materials (the surface id each collision triangle carries, handed back by
// raycasts). Values are the original game's defaults (its MATERIAL, CORRUGATION and DUST
// tables), converted to metres and our axes (x, -y, -z):
//   grip      multiplies the tyres' friction (ice 0.4, grass 0.5, sand 0.6)
//   skid      whether skid marks show; skidColor is subtracted from the floor (darkens), 0..255
//   rough     the rough skid sound (skid_rough.wav) instead of the normal one
//   bump      corrugation: height amplitude and wavelengths along x / z, m (gravel, grass, dirt, metal)
//   dust      dust type kicked up by sliding wheels (fx), 0 = none
//   move      conveyor velocity, m/s (museum escalators, supermarket belts)
//   slip      how much of that grip a tyre keeps once it slides (1 = original game's own kinetic friction)
export interface Surface {
  name: string
  grip: number
  /** what the tyres' static and kinetic friction are multiplied by: the material's ROUGHNESS in
   *  original executable's table (40 bytes a material: flags, roughness, grip, hardness...) — its
   *  wheel code puts roughness on the friction and grip on the tyre's grip, a stiffness our
   *  tyre model doesn't have. The friction had been the grip: grass 0.5 where the game has 0.7 (
   *  "unable to go up this grass" — the Panga TC spun its wheels on Toys in the Hood 2's stream banks) */
  friction: number
  skid: boolean
  skidColor: [number, number, number]
  rough: boolean
  bump: [number, number, number] | null
  dust: number
  move: [number, number, number] | null
  slip: number
  /** s: how long a tyre takes to stop a sideways slide on it (0 = at once). original executable's table has a
   *  tyre GRIP per material besides the friction (ice 0.4 / 0.45 / 0.5): a stiffness — on ice a
   *  tyre only gradually stops a slide, so the car drifts out of a turn instead of snapping straight */
  lag: number
}

const CORRUGATION: ([number, number, number] | null)[] = [
  null,
  [0.03, 0.7, 0.7], // pebbles
  [0.01, 0.4, 0.4], // gravel
  [0.01, 0.4, 0.4], // steel
  [0.01, 0.8, 0.8], // conveyor
  [0.01, 0.8, 0.8], // dirt 1
  [0.01, 0.8, 0.8], // dirt 2
  [0.01, 0.8, 0.8], // dirt 3
]

// name, skid, grip, skid colour, rough, corrugation, dust, velocity (original game cm/s, y down)
type Row = [string, boolean, number, [number, number, number], boolean, number, number, [number, number, number]?]
const ROWS: Row[] = [
  ['default', true, 1.0, [112, 112, 112], false, 0, 0],
  ['marble', true, 0.9, [112, 112, 112], false, 0, 0],
  ['stone', true, 0.9, [144, 144, 144], false, 0, 0],
  ['wood', false, 0.8, [64, 64, 64], false, 0, 0],
  ['sand', false, 0.6, [0, 12, 40], true, 0, 2],
  ['plastic', false, 0.9, [64, 64, 64], false, 0, 0],
  ['carpet tile', false, 0.7, [32, 32, 32], true, 0, 0],
  ['carpet shag', false, 0.7, [32, 32, 32], true, 0, 0],
  ['boundary', false, 1.0, [0, 0, 0], false, 0, 0],
  ['glass', true, 0.8, [48, 48, 48], false, 0, 0],
  ['ice 1', true, 0.33, [48, 48, 48], true, 0, 0],
  ['metal', true, 0.8, [80, 80, 80], false, 0, 0],
  ['grass', false, 0.5, [128, 96, 255], true, 3, 3],
  ['bump metal', true, 0.8, [80, 80, 80], false, 3, 0],
  ['pebbles', true, 0.7, [48, 48, 48], true, 1, 1],
  ['gravel', true, 0.8, [48, 48, 48], true, 2, 1],
  ['conveyor 1', false, 1.0, [0, 0, 0], false, 3, 0, [0, -500, 0]],
  ['conveyor 2', false, 1.0, [0, 0, 0], false, 3, 0, [0, 500, 0]],
  ['dirt 1', false, 1.0, [136, 187, 221], true, 5, 4],
  ['dirt 2', false, 1.0, [136, 187, 221], true, 6, 4],
  ['dirt 3', false, 1.0, [136, 187, 221], true, 7, 4],
  ['ice 2', true, 0.38, [48, 48, 48], true, 0, 0],
  ['ice 3', true, 0.43, [48, 48, 48], true, 0, 0],
  ['wood 2', false, 0.8, [48, 48, 48], false, 0, 0],
  ['conveyor market 1', false, 1.0, [0, 0, 0], false, 3, 0, [0, 0, 357.78]],
  ['conveyor market 2', false, 1.0, [0, 0, 0], false, 3, 0, [-357.78, 0, 0]],
  ['paving', true, 0.9, [144, 144, 144], false, 0, 5],
]

// Ice ("the ice does not seem very icy and slippery" — Supermarket 2's freezer, the
// only ice in the game): grip 0.33 / 0.38 / 0.43 (the original's: 0.4 / 0.45 / 0.5), and a tyre that breaks
// loose keeps 70% of that, so a slide carries on. At 0.4 a car still cornered at ~0.6 g and, with
// kinetic friction nearly the static, gripped again at once — it barely felt different. (0.3 with
// half kept: CPU cars slid into the freezer walls and stuck there, 4–10 resets a race)
const SLIP: Record<string, number> = { 'ice 1': 0.7, 'ice 2': 0.7, 'ice 3': 0.7 }
// ("ice is too easy, not the original's feel — should be more icy"): the slide lag
const LAG: Record<string, number> = { 'ice 1': 0.12, 'ice 2': 0.1, 'ice 3': 0.08 }
// original executable's roughness where it isn't the grip (the ices keep their tuned grip, above)
const ROUGHNESS: Record<string, number> = {
  sand: 0.5, plastic: 0.7, 'carpet tile': 1.0, 'carpet shag': 1.0, glass: 0.7, grass: 0.7, gravel: 0.9,
}

export const SURFACES: Surface[] = ROWS.map(([name, skid, grip, skidColor, rough, corr, dust, vel]) => ({
  name, skid, grip, skidColor, rough, bump: CORRUGATION[corr], dust,
  move: vel ? [vel[0] * 0.01, -vel[1] * 0.01, -vel[2] * 0.01] : null,
  slip: SLIP[name] ?? 1,
  lag: LAG[name] ?? 0,
  friction: ROUGHNESS[name] ?? grip,
}))

export const surface = (id: number): Surface => SURFACES[id] ?? SURFACES[0]

/** Corrugation height (m) at a world point: a gentle washboard. */
export function bumpAt(s: Surface, x: number, z: number): number {
  const b = s.bump
  if (!b) return 0
  return b[0] * 0.5 * (Math.sin((x / b[1]) * Math.PI * 2) + Math.sin((z / b[2]) * Math.PI * 2))
}
