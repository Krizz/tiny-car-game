// DOM overlay: lobby panel, race HUD, countdown, results, toasts.
import type { CarIndexEntry } from './assets'
import { COL, Pad, arrow, ball, box, clock, fontEl, setFont, text, textW, uiUnit, unit, weaponFrame } from './revhud'
import { type PlayerInfo, type ResultRow, type Weapon } from '../shared/protocol'
import { LEVELS, parseCourse } from '../shared/course'

// icon cells on FX page 2 (32x32, from y=192): [column, row]
const ICON: Record<Weapon, [number, number]> = {
  // as original executable's table (in its weapon order): the clone (fake pickup) is the bolt (5,1),
  // the global pulse the star (3,0); the transmitter at (2,0) is no weapon's
  ballBearing: [0, 0], turbo: [1, 0], clone: [5, 1], globalPulse: [3, 0],
  shockwave: [0, 1], puttyBomb: [1, 1], firework: [2, 1], fireworkPack: [3, 1], waterBalloons: [4, 1],
  oilSlick: [6, 1], electroPulse: [7, 1],
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T

export function fmtTime(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return '–'
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const c = Math.floor((ms % 1000) / 10)
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export class Hud {
  root = $('#hud')
  lobby: HTMLElement
  race: HTMLElement
  count: HTMLElement
  results: HTMLElement
  toasts: HTMLElement
  status: HTMLElement
  nameInput: HTMLInputElement
  carSelect: HTMLSelectElement
  readyBtn: HTMLButtonElement
  onVote: (course: string) => void = () => {}
  private vote: HTMLElement
  private offer: string[] = []
  private drawnCourse = ''
  private roulette = 0
  onName: (n: string) => void = () => {}
  onCar: (c: string) => void = () => {}
  onReady: () => void = () => {}
  onWeaponIcon: (cell: [number, number] | null) => void = () => {} // the touch fire button
  private carNames = new Map<string, string>()

  constructor(cars: CarIndexEntry[], trackName: string, tracks: Record<string, string>, current: string) {
    cars.forEach((c) => this.carNames.set(c.key, c.name))
    // The lobby and vote use the game's logo, 8x16 font and blue rounded frame, like the results board.
    // Inputs stay real form controls, drawn over or under the font.
    this.root.innerHTML = `
      <div class="panel lobby rv">
        <img class="logo" src="/game/hud/logo.png" alt="Game logo">
        <div class="course-name"></div>
        <div class="timer"></div>
        <div class="field f-name"><span class="lab"></span><div class="rvin"><span class="val"></span><input class="name" maxlength="16" spellcheck="false" autocomplete="off" aria-label="Name"></div></div>
        <div class="field f-car"><span class="lab"></span><div class="rvin"><button class="arr prev" aria-label="Previous car"></button><span class="val"></span><button class="arr next" aria-label="Next car"></button><select class="car" aria-label="Car">${cars
          .map((c) => `<option value="${c.key}">${esc(c.name)}</option>`)
          .join('')}</select></div></div>
        <button class="ready rvbox"></button>
        <ul class="players"></ul>
        <div class="help keyhelp"></div>
        <div class="help touchhelp"></div>
      </div>
      <div class="panel vote rv" hidden><div class="vote-head"><span class="vt"></span><span class="vc"></span></div><div class="courses"></div></div>
      <div class="racehud" hidden></div>
      <div class="count"></div>
      <div class="panel results" hidden></div>
      <div class="toasts"></div>
      <div class="status"></div>
      <div class="ping"></div>`
    this.lobby = $('.lobby', this.root)
    this.race = $('.racehud', this.root)
    this.race.append(this.lapPad.el, this.timerPad.el, this.boardPad.el, this.splitPad.el)
    this.splitPad.el.hidden = true
    // (in the HUD itself, not the race's: stars give weapons in the lobby's free drive too)
    this.root.append(this.weaponPad.el, this.resultsPad.el)
    this.resultsPad.el.hidden = true
    this.weaponPad.el.hidden = true
    this.signPad.el.hidden = true
    this.root.append(this.speedPad.el, this.signPad.el)
    addEventListener('resize', () => this.paintBoard())
    this.count = $('.count', this.root)
    this.results = $('.results', this.root)
    this.toasts = $('.toasts', this.root)
    this.status = $('.status', this.root)
    this.nameInput = $<HTMLInputElement>('.name', this.root)
    this.carSelect = $<HTMLSelectElement>('.car', this.root)
    this.readyBtn = $<HTMLButtonElement>('.ready', this.root)
    this.vote = $('.vote', this.root)
    $('.courses', this.vote).addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.course')
      if (!card || this.drawnCourse) return
      this.onVote(card.classList.contains('mine') ? '' : card.dataset.id!)
      card.blur()
    })
    this.nameInput.addEventListener('change', () => this.onName(this.nameInput.value))
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.nameInput.blur()
      e.stopPropagation()
    })
    this.carSelect.addEventListener('change', () => {
      this.onCar(this.carSelect.value)
      this.carSelect.blur()
    })
    this.carSelect.addEventListener('keydown', (e) => e.preventDefault())
    this.readyBtn.addEventListener('click', () => {
      this.onReady()
      this.readyBtn.blur()
    })
    this.paintLobby(trackName)
    const fu = () => this.root.style.setProperty('--fu', String(uiUnit()))
    fu()
    addEventListener('resize', fu)
  }

  // ---- the lobby in the game's font
  private ft = {
    timer: fontEl('', COL.white),
    name: fontEl('', COL.white),
    car: fontEl('', COL.white),
    ready: fontEl('Ready', COL.white),
    voteTitle: fontEl('Pick the next track', COL.cyan),
    voteCount: fontEl('', COL.white),
  }
  private shownName = ''
  private shownCar = ''

  private paintLobby(trackName: string) {
    const put = (sel: string, el: HTMLElement, root: ParentNode = this.lobby) => $(sel, root).replaceChildren(el)
    put('.course-name', fontEl(trackName, COL.cyan))
    put('.timer', this.ft.timer)
    $('.f-name .lab', this.lobby).replaceChildren(fontEl('Name', COL.cyan))
    $('.f-car .lab', this.lobby).replaceChildren(fontEl('Car', COL.cyan))
    $('.f-name .val', this.lobby).replaceChildren(this.ft.name)
    $('.f-car .val', this.lobby).replaceChildren(this.ft.car)
    $('.f-car .prev', this.lobby).replaceChildren(fontEl('<', COL.cyan))
    $('.f-car .next', this.lobby).replaceChildren(fontEl('>', COL.cyan))
    this.readyBtn.replaceChildren(this.ft.ready)
    const W = 34
    $('.keyhelp', this.lobby).replaceChildren(
      fontEl('Drive around while you wait.', COL.cyan, 1, W),
      fontEl('Arrows/WASD drive, Space handbrake, F or Ctrl fire, R back on track, E flip over, M music', COL.white, 1, W),
      fontEl('Pad: RT/LT, left stick, RB fire, B handbrake, Y back on track, LB flip over', COL.white, 1, W),
      fontEl('Drive through the stars for weapons.', COL.cyan, 1, W))
    $('.touchhelp', this.lobby).replaceChildren(
      fontEl('Drive around while you wait.', COL.cyan, 1, W),
      fontEl('Left thumb steers (slide sideways), GAS and BRAKE on the right, FIRE uses your weapon, RESET puts you back on track.', COL.white, 1, W),
      fontEl('Drive through the stars for weapons.', COL.cyan, 1, W))
    $('.vt', this.vote).replaceChildren(this.ft.voteTitle)
    $('.vc', this.vote).replaceChildren(this.ft.voteCount)
    // the name: the font shows it, the real input takes over while typing
    const nameBox = $('.f-name .rvin', this.lobby)
    nameBox.addEventListener('click', () => this.nameInput.focus())
    this.nameInput.addEventListener('focus', () => nameBox.classList.add('editing'))
    this.nameInput.addEventListener('blur', () => {
      nameBox.classList.remove('editing')
      this.syncFields()
    })
    this.nameInput.addEventListener('input', () => this.syncFields())
    // the car: < > step through the list, the (invisible) select over the name opens it
    const step = (d: number) => {
      const n = this.carSelect.options.length
      this.carSelect.selectedIndex = (this.carSelect.selectedIndex + d + n) % n
      this.carSelect.dispatchEvent(new Event('change'))
    }
    $('.f-car .prev', this.lobby).addEventListener('click', (e) => { e.preventDefault(); step(-1) })
    $('.f-car .next', this.lobby).addEventListener('click', (e) => { e.preventDefault(); step(1) })
    this.carSelect.addEventListener('change', () => this.syncFields())
    setTimeout(() => this.syncFields(), 0)
  }

  /** The font's copies of the name and car (main.ts sets the controls' values directly). */
  private syncFields() {
    if (this.nameInput.value !== this.shownName) {
      this.shownName = this.nameInput.value
      setFont(this.ft.name, this.shownName || ' ')
    }
    const car = this.carName(this.carSelect.value)
    if (car !== this.shownCar) {
      this.shownCar = car
      setFont(this.ft.car, car)
    }
  }

  typing() {
    return document.activeElement === this.nameInput
  }

  carName(key: string) {
    return this.carNames.get(key) ?? key
  }

  /** The 12 courses this lobby votes between (cards with the level's picture; flipped when mirrored). */
  setOffer(courses: string[]) {
    this.offer = courses
    this.drawnCourse = ''
    this.vote.classList.remove('drawn')
    this.starting(false)
    $('.courses', this.vote).innerHTML = courses.map((id) => {
      const c = parseCourse(id)!
      return `<button class="course" data-id="${id}" aria-label="${esc(LEVELS[c.level])}${c.rev ? ' reversed' : ''}${c.mirror ? ' mirrored' : ''}">` +
        `<img src="/game/${c.level}/preview.png" alt="" class="${c.mirror ? 'flip' : ''}">` +
        `<b></b><i></i><span class="voters"></span></button>`
    }).join('')
    for (const card of this.vote.querySelectorAll<HTMLElement>('.course')) {
      const c = parseCourse(card.dataset.id!)!
      $('b', card).append(fontEl(LEVELS[c.level], COL.white, 1, 15))
      const tags = (c.rev ? 'R' : '') + (c.mirror ? 'M' : '')
      if (tags) $('i', card).append(fontEl(tags, COL.cyan))
    }
    this.paintVotes()
  }

  private lastPlayers: PlayerInfo[] = []
  private me = 0
  private paintVotes() {
    for (const card of this.vote.querySelectorAll<HTMLElement>('.course')) {
      const who = this.lastPlayers.filter((p) => !p.ai && p.vote === card.dataset.id)
      card.classList.toggle('mine', who.some((p) => p.id === this.me))
      card.classList.toggle('voted', who.length > 0)
      const key = who.map((p) => p.id + p.name).join('|') + this.me
      const box = $('.voters', card)
      if (box.dataset.key !== key) {
        box.dataset.key = key
        box.replaceChildren(...who.map((p) => fontEl(p.name.slice(0, 10), p.id === this.me ? COL.green : COL.white)))
      }
    }
    const n = this.lastPlayers.filter((p) => !p.ai && p.vote).length
    const all = this.lastPlayers.filter((p) => !p.ai).length
    setFont(this.ft.voteCount, this.drawnCourse ? ' ' : all ? `${n}/${all} voted` : ' ')
  }

  /** The draw: a roulette over the voted cards (all of them when nobody voted), landing on `won`. */
  drawn(won: string, votes: string[], done: () => void) {
    this.drawnCourse = won
    this.vote.classList.add('drawn')
    setFont(this.ft.voteCount, ' ')
    const pool = [...new Set(votes.length ? votes : this.offer)].filter((id) => this.offer.includes(id))
    const cards = [...this.vote.querySelectorAll<HTMLElement>('.course')]
    const light = (id: string) => cards.forEach((c) => c.classList.toggle('lit', c.dataset.id === id))
    clearTimeout(this.roulette)
    const landed = () => {
      this.starting(true)
      done()
    }
    if (pool.length < 2) {
      light(won)
      this.roulette = window.setTimeout(landed, 900)
      return
    }
    // slow down over ~2 s, then stop on the winner
    let i = Math.floor(Math.random() * pool.length), t = 0, step = 70
    const tick = () => {
      i = (i + 1) % pool.length
      light(pool[i])
      t += step
      if (t > 1600 && pool[i] === won) {
        this.roulette = window.setTimeout(landed, 900)
        return
      }
      step = Math.min(260, step * 1.12)
      this.roulette = window.setTimeout(tick, step)
    }
    tick()
  }

  /** The vote is over and this course is next (after a reload into it). */
  showNext(id: string) {
    this.drawnCourse = id || this.drawnCourse
    this.vote.classList.add('drawn')
    for (const c of this.vote.querySelectorAll<HTMLElement>('.course')) c.classList.toggle('lit', c.dataset.id === id)
    setFont(this.ft.voteCount, ' ')
    this.starting(true)
  }

  /** Course drawn, race about to start: the lobby shows only the course and the countdown. */
  starting(on: boolean) {
    this.root.classList.toggle('starting', on)
  }

  showLobby(on: boolean) {
    this.vote.hidden = !on
    this.lobby.hidden = !on
  }

  lobbyTimer(text: string) {
    setFont(this.ft.timer, text)
  }

  players(list: PlayerInfo[], me: number, phase: string) {
    this.lastPlayers = list
    this.me = me
    this.paintVotes()
    // each line: the name (cyan, mine green; CPU cars marked), the car, and READY in green
    const key = JSON.stringify([list.map((p) => [p.id, p.name, p.car, p.ready, p.ai, p.racing]), me, phase])
    const ul = $('.players', this.lobby)
    if (ul.dataset.key !== key) {
      ul.dataset.key = key
      ul.replaceChildren(...list.map((p) => {
        const li = document.createElement('li')
        li.className = p.id === me ? 'me' : ''
        const name = document.createElement('b')
        name.append(fontEl(p.name.slice(0, 16), p.id === me ? COL.green : COL.cyan))
        if (p.ai) name.append(fontEl('CPU', COL.grey))
        const car = document.createElement('span')
        car.append(fontEl(this.carName(p.car) + (phase !== 'lobby' && p.racing ? ' *' : ''), COL.white))
        const ok = document.createElement('i')
        if (p.ready) ok.append(fontEl('Ready', COL.green))
        li.append(name, ok, car)
        return li
      }))
    }
    const mine = list.find((p) => p.id === me)
    this.readyBtn.classList.toggle('on', !!mine?.ready)
    setFont(this.ft.ready, mine?.ready ? 'Ready!' : 'Ready', mine?.ready ? COL.green : COL.white)
    this.syncFields()
  }

  raceHud(on: boolean) {
    this.race.hidden = !on
    this.lastWeapon = '' // the weapon panel moves with it
  }

  // original game's race HUD (revhud.ts): lap top left, the clocks top right, the place over the
  // gaps box bottom left, the ball speedometer bottom right
  private lapPad = new Pad('hud-lap', 64, 40)
  // the weapon in hand, under the lap (as in original game): its icon in FX page 2's frame
  private weaponPad = new Pad('hud-weapon', 80, 72)
  private timerPad = new Pad('hud-timers', 89, 166)
  // a split time, under the clocks for a few seconds (as the game shows it)
  private splitPad = new Pad('hud-split', 120, 40)
  private splitUntil = 0
  private boardPad = new Pad('hud-board', 168, 58)
  private speedPad = new Pad('hud-speed', 160, 87)
  private signPad = new Pad('hud-sign', 64, 64)
  private place = ''
  private gapLines: [string, string, string][] = []

  setRace(r: { pos: number; lap: number; laps: number; race: number; lapTime: number | null; last: number | null; best: number | null; finished: boolean }) {
    const lap = `${Math.min(r.lap, r.laps)}/${r.laps}`
    this.lapPad.draw(lap, (g) => {
      text(g, 'Lap', 8, 8, COL.cyan)
      text(g, lap, 8, 23, COL.white)
    })
    const rows: [string, string][] = [['Last Lap', clock(r.last)], ['Best Lap', clock(r.best)], ['Lap', clock(r.lapTime)], ['Race', clock(r.race)]]
    this.timerPad.draw(rows.map((x) => x[1]).join(), (g) => {
      rows.forEach(([label, t], i) => {
        text(g, label, 72 - textW(label), 8 + i * 42, COL.cyan)
        text(g, t, 72 - textW(t), 23 + i * 42, COL.white)
      })
    })
    const place = ordinal(r.pos)
    if (place !== this.place) {
      this.place = place
      this.paintBoard()
    }
  }

  /** Show a split: its number, the lap time there, the gap to the best lap's (null on the first lap). */
  split(n: number, time: number, diff: number | null) {
    this.splitUntil = performance.now() + 3000
    this.splitPad.el.hidden = false
    this.splitPad.el.style.top = `${170 * unit()}px`
    const d = diff == null ? '' : `${diff < 0 ? '-' : '+'}${(Math.abs(diff) / 1000).toFixed(2)}`
    this.splitPad.draw(`${n}|${time}|${d}`, (g, w) => {
      const label = `Split ${n}`, t = clock(time)
      text(g, label, w - 8 - textW(label), 2, COL.cyan)
      text(g, d || t, w - 8 - textW(d || t), 20, d ? (diff! < 0 ? COL.green : COL.red) : COL.white)
    })
  }

  splitTick(now: number) {
    if (!this.splitPad.el.hidden && now > this.splitUntil) this.splitPad.el.hidden = true
  }

  private paintBoard() {
    const lines = this.gapLines
    const h = lines.length ? 26 + 8 + 16 * lines.length : 20
    this.boardPad.draw(this.place + JSON.stringify(lines), (g) => {
      const n = this.place.replace(/\D+$/, '')
      text(g, n, 7, 2, COL.white)
      text(g, this.place.slice(n.length), 7 + textW(n), 0, COL.cyan, 0.6)
      if (!lines.length) return
      box(g, 0, 26, 168, 8 + 16 * lines.length)
      lines.forEach(([d, col, name], i) => {
        text(g, d, 6, 30 + 16 * i, col)
        text(g, name, 63, 30 + 16 * i, COL.white)
      })
    }, h)
  }

  /** The speed balls light up from red to green as the car nears its top speed. */
  speed(mps: number, vtop: number, on = true) {
    this.speedPad.el.hidden = !on
    const mph = String(Math.round(Math.abs(mps) * 1.17))
    const lit = Math.min(7, Math.ceil((Math.abs(mps) / vtop) * 7 - 0.05))
    this.speedPad.draw(mph + ':' + lit, (g, w) => {
      for (let k = 0; k < 7; k++) ball(g, k, k < lit, w - 24, 14)
      text(g, ' mph', w - 16 - 32, 56, COL.cyan)
      text(g, mph, w - 48 - textW(mph), 56, COL.white)
    })
  }

  countdown(text: string, cls = '') {
    this.count.textContent = text
    this.count.className = 'count ' + cls
  }

  /** The level's direction arrow (signs.ts), or null for none. Going the wrong way overrides it. */
  sign(k: number | null) {
    if (this.wrong !== null) k = Math.floor(performance.now() / 300) % 2 ? null : this.wrong
    this.signPad.el.hidden = k === null
    if (k !== null) this.signPad.draw(String(k), (g) => arrow(g, k!, 0, 0, 64))
  }

  // original game's wrong-way warning: the U-turn arrow, flashing in the sign's place (1 = round to the
  // left, 5 = to the right) — it was the words WRONG WAY
  private wrong: number | null = null
  wrongWay(on: boolean, turnRight = false) {
    this.wrong = on ? (turnRight ? 5 : 1) : null
  }

  private cpu = new Set<number>()
  markCpu(ids: number[]) {
    this.cpu = new Set(ids)
  }

  // original game's results: the blue box, "Race Results" and one line a car —
  // place 01.., name (cyan; mine green), time MM:SS:mmm — in the game's font; the countdown under it
  private resultsPad = new Pad('hud-results', 248, 64)
  private resultRows: ResultRow[] | null = null
  private resultsMe = 0
  private resultsNote = ''

  showResults(rows: ResultRow[] | null, me: number, nextIn: string) {
    this.resultRows = rows
    this.resultsMe = me
    this.resultsNote = nextIn
    this.paintResults()
  }

  resultsNext(text: string) {
    if (text === this.resultsNote) return
    this.resultsNote = text
    this.paintResults()
  }

  private paintResults() {
    const rows = this.resultRows
    this.resultsPad.el.hidden = !rows
    if (!rows) return
    const lines = rows.length ? rows : null
    const h = 16 + 16 + 12 + (lines ? lines.length * 20 : 20) + 8 + (this.resultsNote ? 22 : 0) + 8
    const key = JSON.stringify([rows.map((r) => [r.id, r.time, r.name]), this.resultsMe, this.resultsNote])
    this.resultsPad.draw(key, (g, w) => {
      box(g, 0, 0, w, h)
      text(g, 'Race Results', 12, 12, COL.cyan)
      let y = 12 + 16 + 12
      if (!lines) text(g, 'Nobody finished', 12, y, COL.white)
      ;(lines ?? []).forEach((r, i) => {
        const time = r.time != null ? clock(r.time) : 'DNF'
        text(g, String(i + 1).padStart(2, '0'), 12, y, COL.white)
        text(g, r.name.slice(0, 13), 12 + 3 * 8, y, r.id === this.resultsMe ? COL.green : COL.cyan)
        text(g, time, w - 12 - textW(time), y, COL.white)
        y += 20
      })
      if (this.resultsNote) text(g, this.resultsNote, (w - textW(this.resultsNote)) / 2, y + 8, COL.white)
    }, h)
  }

  toast(text: string) {
    const d = document.createElement('div')
    d.className = 'toast'
    d.textContent = text
    this.toasts.appendChild(d)
    setTimeout(() => d.remove(), 3500)
  }

  setStatus(text: string) {
    this.status.textContent = text
    this.status.hidden = !text
  }

  private lastWeapon = ''
  weapon(w: Weapon | null, n: number, fuseMs: number | null) {
    const key = `${w}:${n}:${fuseMs === null ? '' : Math.ceil(fuseMs / 1000)}`
    if (key === this.lastWeapon) return
    this.lastWeapon = key
    this.onWeaponIcon(w ? ICON[w] : null)
    // in a race always there, empty with no weapon in hand, under the lap counter; in the
    // lobby's free drive only with one, bottom left (the lobby panel has the top left)
    const racing = !this.race.hidden
    this.weaponPad.el.hidden = !racing && !w
    this.weaponPad.el.style.top = racing ? `${40 * unit()}px` : ''
    this.weaponPad.el.style.bottom = racing ? '' : '16px'
    this.weaponPad.draw(key, (g) => {
      weaponFrame(g, w ? ICON[w] : null, 8, 2)
      // several of it (firework pack, water balloons): how many, in the frame's corner
      if (w && n > 1) text(g, String(n), 8 + 64 - 14, 2 + 61 - 20, COL.white)
    })
    // (no "PUTTY BOMB!" banner — the black car and the fuse sound say it)
  }

  /** original game's bottom-left box: "-1m" (green) to the car ahead, "+2m" (red) to the one behind. */
  gaps(ahead: { name: string; m: number } | null, behind: { name: string; m: number } | null) {
    const line = (g: { name: string; m: number } | null, sign: string, col: string): [string, string, string][] =>
      g ? [[`${sign}${Math.round(g.m)}m`, col, g.name.slice(0, 13)]] : []
    const lines = [...line(ahead, '-', COL.green), ...line(behind, '+', COL.red)]
    if (JSON.stringify(lines) === JSON.stringify(this.gapLines)) return
    this.gapLines = lines
    this.paintBoard()
  }

  private lastPing = ''
  /** tcp = car state fell back to the WebSocket (no data channel) */
  ping(ms: number, tcp = false) {
    const t = ms < 0 ? 'offline' : ms ? `${Math.round(ms)} ms${tcp ? ' · tcp' : ''}` : ''
    if (t === this.lastPing) return
    this.lastPing = t
    const el = $('.ping', this.root)
    el.textContent = t
    el.className = 'ping' + (ms > 150 || ms < 0 ? ' bad' : ms > 80 ? ' meh' : '')
  }

}
