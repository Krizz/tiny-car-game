// Messages between the lobby server (shared/lobby.ts) and the client (src/net.ts).
// Control messages are JSON; car state is a small binary packet relayed as-is.

export const LAPS = 3

/** Tracks on offer (key = level folder). The first is the default. */
export { TRACKS, COURSES } from './course' // every course id (level[:r][:m]) -> name
export const MAX_PLAYERS = 16
export const STATE_HZ = 30

export type Phase = 'lobby' | 'grid' | 'race' | 'results'

// original game's weapons. The pickup stars hand one out (the server draws it).
export const WEAPONS = [
  'shockwave', 'firework', 'fireworkPack', 'puttyBomb', 'waterBalloons', 'electroPulse',
  'oilSlick', 'ballBearing', 'turbo', 'clone', 'globalPulse',
] as const
export type Weapon = (typeof WEAPONS)[number]
export const AMMO: Record<Weapon, number> = {
  shockwave: 1, firework: 1, fireworkPack: 3, puttyBomb: 1, waterBalloons: 3, electroPulse: 1,
  oilSlick: 1, ballBearing: 1, turbo: 1, clone: 1, globalPulse: 1,
}
export const WEAPON_NAMES: Record<Weapon, string> = {
  shockwave: 'Shockwave', firework: 'Firework', fireworkPack: 'Firework Pack', puttyBomb: 'Putty Bomb',
  waterBalloons: 'Water Balloons', electroPulse: 'Electro Pulse', oilSlick: 'Oil Slick', ballBearing: 'Ball Bearing',
  turbo: 'Turbo Battery', clone: 'Clone Pickup', globalPulse: 'Global Pulse',
}
export const PICKUP_RESPAWN_MS = 6000
export const BOMB_FUSE_MS = 7000

export interface PlayerInfo {
  id: number
  name: string
  car: string
  ready: boolean
  racing: boolean // has a grid slot in the current race
  slot: number
  ai?: boolean // a computer driver (simulated on the server)
  vote?: string // the course this person picked in the lobby (a course id)
}

export interface ResultRow {
  id: number
  name: string
  car: string
  time: number | null // ms, null = did not finish
  best: number | null // best lap ms
  est?: boolean // a CPU car still running when the race ended: time projected from its pace
}

export type ServerMsg =
  | { t: 'rtc'; sdp: string } // the answer
  | { t: 'rtcCand'; c: string; mid: string }
  | { t: 'welcome'; id: number; phase: Phase; remaining: number; players: PlayerInfo[]; laps: number; track: string
      drawn?: boolean; offer: string[]; raceAt: number; taken: [number, number][]; bomb: { holder: number; until: number } }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'phase'; phase: Phase; remaining: number; players: PlayerInfo[]; results?: ResultRow[] }
  | { t: 'offer'; courses: string[] } // the 12 courses this lobby votes between
  | { t: 'finished'; id: number; time: number; place: number }
  | { t: 'chat'; id: number; text: string }
  | { t: 'pong'; c: number; s: number } // c = the client's ping time, s = server clock (ms)
  | { t: 'pickups'; taken: [number, number][] } // [pickup index, respawns at (server ms)]
  | { t: 'weapon'; w: Weapon | null; n: number } // what the receiver now holds
  | { t: 'fire'; id: number; w: Weapon; shot: number; at: number; d: number[] }
  | { t: 'det'; id: number; shot: number; p: number[] } // a dropped item went off (clone)
  | { t: 'bomb'; holder: number; until: number } // putty bomb: who has it (0 = nobody), explodes at
  | { t: 'boom'; holder: number }
  | { t: 'track'; track: string } // the lobby switched track: browsers reload it
  // the votes were drawn: `track` won (out of `votes`, one per person who voted); the grid follows
  | { t: 'drawn'; track: string; votes: string[] }

export type ClientMsg =
  | { t: 'hello'; name: string; car: string }
  | { t: 'name'; name: string }
  | { t: 'car'; car: string }
  | { t: 'ready'; on: boolean }
  | { t: 'lap'; lap: number; time: number }
  | { t: 'finish'; time: number; best: number | null }
  | { t: 'ping'; c?: number }
  | { t: 'pick'; i: number; place: number; of: number }
  /** touched the race's star (where our car is) — the server fires the one Global Pulse of the race */
  | { t: 'star'; p: number[] }
  | { t: 'fire'; w: Weapon; shot: number; at: number; d: number[] }
  | { t: 'det'; shot: number; p: number[] }
  | { t: 'bombPass'; to: number }
  | { t: 'vote'; course: string } // pick a course in the lobby ('' = take it back)
  | { t: 'rtc'; sdp: string } // WebRTC offer for the state data channel (shared/rtc.ts)
  | { t: 'rtcCand'; c: string; mid: string }

// Binary car state. A car's state is STATE_FLOATS numbers:
//   [x,y,z, qx,qy,qz,qw, vx,vy,vz, wx,wy,wz, steer, progress, flags]
// flags: 1 finished, 2 racing, 4 zapped, 8 turbo, 16 electro aura, 32 oiled, 64 thrown by a weapon
// (2.5 s), 128 put back on the track / flipped (1.5 s)
// On the wire (packed 2026-10-15; it was 72 bytes of f64 + f32s a car, 80 relayed, one packet per car):
//   u8 CARS_MARK, u8 count, f64 time the states were taken, on the server's clock (ms, see pong) —
//   then per car CAR_BYTES = 31: u8 id, u8 flags, i8 steer ×127, position 3 × i24 (mm), rotation u32
//   ("smallest three": 2-bit index of the largest component, left out, + the other three in 10 bits
//   each, ≤ 0.25°), velocity 3 × i16 (cm/s), spin 3 × i16 (1/500 rad/s), progress i24 (cm).
// A browser sends its own car (count 1, id 0: the server writes the id in) and the server relays the
// packet as it is; a CPU world's cars of one tick go out together in one packet.
// The timestamp lets every receiver predict the car forward to "now".
export const STATE_FLOATS = 16
export const CARS_MARK = 0xc1
export const CARS_HEAD = 10
export const CAR_BYTES = 31

const QS = Math.SQRT1_2 // the three smaller components of a unit quaternion are within ±1/√2
const int = (v: number, lim: number) => Math.max(-lim, Math.min(lim, Math.round(v))) | 0
const setI24 = (dv: DataView, o: number, v: number) => {
  v = int(v, 0x7fffff)
  dv.setUint16(o, v & 0xffff, true)
  dv.setInt8(o + 2, v >> 16)
}
const getI24 = (dv: DataView, o: number) => dv.getUint16(o, true) | (dv.getInt8(o + 2) << 16)

/** One packet of car states (`f` = the STATE_FLOATS numbers), all taken at server time `time`. */
export function packCars(time: number, cars: { id: number; f: ArrayLike<number> }[]): Uint8Array {
  const b = new Uint8Array(CARS_HEAD + cars.length * CAR_BYTES)
  const dv = new DataView(b.buffer)
  b[0] = CARS_MARK
  b[1] = cars.length
  dv.setFloat64(2, time, true)
  cars.forEach(({ id, f }, k) => {
    const o = CARS_HEAD + k * CAR_BYTES
    b[o] = id
    b[o + 1] = f[15] & 0xff
    dv.setInt8(o + 2, int(f[13] * 127, 127))
    for (let i = 0; i < 3; i++) setI24(dv, o + 3 + i * 3, f[i] * 1000)
    // rotation: drop the largest component (made positive: q and −q are the same turn)
    let big = 3
    for (let i = 0; i < 3; i++) if (Math.abs(f[3 + i]) > Math.abs(f[3 + big])) big = i
    const sign = f[3 + big] < 0 ? -1 : 1
    let q = big
    for (let i = 0; i < 4; i++) {
      if (i === big) continue
      q = q * 1024 + Math.max(0, int(((sign * f[3 + i]) / QS + 1) * 511.5, 1023))
    }
    dv.setUint32(o + 12, q >>> 0, true)
    for (let i = 0; i < 3; i++) dv.setInt16(o + 16 + i * 2, int(f[7 + i] * 100, 32767), true)
    for (let i = 0; i < 3; i++) dv.setInt16(o + 22 + i * 2, int(f[10 + i] * 500, 32767), true)
    setI24(dv, o + 28, f[14] * 100)
  })
  return b
}

/** Calls `each` for every car in a packet; false if it isn't a car-state packet. */
export function unpackCars(data: ArrayBuffer | Uint8Array, each: (id: number, time: number, f: Float32Array) => void): boolean {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (b.byteLength < CARS_HEAD || b[0] !== CARS_MARK || b.byteLength !== CARS_HEAD + b[1] * CAR_BYTES) return false
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const time = dv.getFloat64(2, true)
  for (let k = 0; k < b[1]; k++) {
    const o = CARS_HEAD + k * CAR_BYTES
    const f = new Float32Array(STATE_FLOATS)
    for (let i = 0; i < 3; i++) f[i] = getI24(dv, o + 3 + i * 3) / 1000
    let q = dv.getUint32(o + 12, true)
    const big = q >>> 30
    let sum = 0
    for (let i = 3; i >= 0; i--) {
      if (i === big) continue
      const c = ((q & 1023) / 511.5 - 1) * QS
      q >>>= 10
      f[3 + i] = c
      sum += c * c
    }
    f[3 + big] = Math.sqrt(Math.max(0, 1 - sum))
    for (let i = 0; i < 3; i++) f[7 + i] = dv.getInt16(o + 16 + i * 2, true) / 100
    for (let i = 0; i < 3; i++) f[10 + i] = dv.getInt16(o + 22 + i * 2, true) / 500
    f[13] = dv.getInt8(o + 2) / 127
    f[14] = getI24(dv, o + 28) / 100
    f[15] = b[o + 1]
    each(b[o], time, f)
  }
  return true
}

/**
 * The server's clock (ms): monotonic and sub-millisecond, unlike Date.now(). Every time the server
 * sends (pongs for the clients' clock sync, the AI cars' state stamps, deadlines) is on it.
 */
export const serverClock = () => performance.timeOrigin + performance.now()
