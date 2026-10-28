// Toy World 1's piano: drive over it and it plays. The level's trigger (type 0
// in ToyLite.tri) is a box over the keyboard; the key under a car comes from
// where it is along the box, and the one piano sample (wavs/toy/piano.wav) is
// pitch-shifted to that note. The keyboard on the texture runs F..F, 32 white
// keys; black keys sit on the far ~60% of the key length, between the white
// keys that have one (C D F G A).
import * as THREE from 'three'
import type { TrackInfo } from './assets'
import type { Car } from './car'

const WHITE_KEYS = 32
const WHITE_FROM_F = [0, 2, 4, 6, 7, 9, 11] // F G A B C D E, semitones above F
const HAS_SHARP = [true, true, true, false, true, true, false] // F# G# A# - C# D# -
const LOWEST = 53 // F3 (MIDI); the sample is taken to be middle C (60)
const BLACK_DEPTH = 0.6 // of the key length, from the far end

type Play = (name: 'piano', volume?: number, rate?: number) => void

interface Box { pos: THREE.Vector3; rot: number[][]; half: number[] }

export class Piano {
  private boxes: Box[]
  private last = new Map<number, number>() // car id -> key it's on (-1 = off)

  constructor(info: TrackInfo, private play: Play) {
    this.boxes = (info.piano ?? []).map((p) => ({ pos: new THREE.Vector3(...p.pos), rot: p.rot, half: p.half }))
  }

  /** The note (MIDI) under a point, or -1. */
  noteAt(p: THREE.Vector3): number {
    for (const b of this.boxes) {
      const d = p.clone().sub(b.pos)
      const r = b.rot
      const lx = d.x * r[0][0] + d.y * r[1][0] + d.z * r[2][0]
      const ly = d.x * r[0][1] + d.y * r[1][1] + d.z * r[2][1]
      const lz = d.x * r[0][2] + d.y * r[1][2] + d.z * r[2][2]
      if (Math.abs(lx) > b.half[0] || Math.abs(ly) > b.half[1] + 0.5 || Math.abs(lz) > b.half[2]) continue
      const along = ((lx + b.half[0]) / (2 * b.half[0])) * WHITE_KEYS // 0..32 in white keys
      const w = Math.min(WHITE_KEYS - 1, Math.floor(along))
      const f = along - w
      const octave = Math.floor(w / 7), k = w % 7
      let note = LOWEST + octave * 12 + WHITE_FROM_F[k]
      // black keys: the far part of the keys (-z), near the gap after a white key that has a sharp
      const far = (lz + b.half[2]) / (2 * b.half[2]) < BLACK_DEPTH
      if (far && f > 0.68 && HAS_SHARP[k]) note += 1
      else if (far && f < 0.32 && w > 0 && HAS_SHARP[(k + 6) % 7]) note -= 1
      return note
    }
    return -1
  }

  /** Call every frame with the cars in play; plays a note whenever a car moves onto a new key. */
  update(cars: { id: number; car: Car }[], listener: THREE.Vector3) {
    if (!this.boxes.length) return
    for (const { id, car } of cars) {
      const note = this.noteAt(car.position)
      if (note !== (this.last.get(id) ?? -1) && note >= 0) {
        const dist = car.position.distanceTo(listener)
        const vol = Math.min(1, 1.6 / (1 + Math.max(0, dist - 2) * 0.25))
        if (vol > 0.03) this.play('piano', vol, Math.pow(2, (note - 60) / 12))
      }
      this.last.set(id, note)
    }
  }
}
