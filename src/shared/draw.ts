// What a pickup star gives: the server's draw (shared/lobby.ts), also used by test/race.ts.
import { WEAPONS, type Weapon } from './protocol'

/** The turbo's share of the draw at the back of the field (a battery for whoever is
 *  behind): last 40 %, second to last 20 %, third to last 10 %; never for the leader, so in a 2-car race
 *  the second car gets 40 %. Everyone else: the curve in drawWeapon (~3 % leading, ~9 % mid-field). */
export const TURBO_BACK = [0.4, 0.2, 0.1]

/** original game style draw: the further back you are, the better the weapon. place 1 = leading, of = cars racing. */
export function drawWeapon(place: number, of: number, back = TURBO_BACK): Weapon {
  const f = of > 1 ? Math.max(0, Math.min(1, (place - 1) / (of - 1))) : 0.5 // 0 leader .. 1 last
  const w: Record<Weapon, number> = {
    shockwave: 1 + f * 2, firework: 1 + f, fireworkPack: 0.4 + f * 1.6, puttyBomb: 1.4 - f * 0.8,
    waterBalloons: 1.5 - f * 0.6, electroPulse: 0.6 + f, oilSlick: 1.5 - f, ballBearing: 1,
    turbo: 0.3 + f * 1.4, clone: 1 - f * 0.5,
    // never from a pickup: original executable's draw picks among the first 10 weapons only; the
    // Global Pulse is the race's star (a `.fob` star of type 0, one a level), fired on touch
    globalPulse: 0,
  }
  const share = place > 1 ? back[of - place] : undefined
  if (share !== undefined) {
    let rest = 0
    for (const k of WEAPONS) if (k !== 'turbo') rest += w[k]
    w.turbo = (share * rest) / (1 - share)
  }
  let total = 0
  for (const k of WEAPONS) total += w[k]
  let r = Math.random() * total
  for (const k of WEAPONS) if ((r -= w[k]) <= 0) return k
  return 'shockwave'
}
