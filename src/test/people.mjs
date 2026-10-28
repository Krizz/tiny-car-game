// Three people racing (each its own Chrome, as on three computers), driving like people on a keyboard
// (?bot=human), one far from the server (~70 ms) and two near it (~37 ms). Every frame
// each browser records where it draws its own car and every other car (on the server clock). Then:
//   view error  = where X draws Y's car vs where Y itself had it at that moment
//   jumps       = frame-to-frame jerks in how a remote car is drawn
//   bumps       = a knock between two people: does the other one feel it too, at about the same time?
// Needs a private server (README: Multiplayer) and the playwright 1.48 package (npm i playwright@1.48.0 in a
// scratch folder, mounted at /w with this file):
//   docker run --rm --network <docker-network> --shm-size=1g -v <folder>:/w -w /w \
//     mcr.microsoft.com/playwright:v1.48.0-noble node people.mjs http://<server>:8090 [races=1]
import { chromium } from 'playwright'
const [base, races] = [process.argv[2], Number(process.argv[3] ?? 1)]
const who = [
  { name: 'Far', q: 'lag=70&jitter=12&loss=1' },
  { name: 'Near1', q: 'lag=36&jitter=6&loss=0.5' },
  { name: 'Near2', q: 'lag=38&jitter=6&loss=0.5' },
]
const init = () => {
  const rec = (window.__rec = { f: [], k: [], fps: [] })
  let lastV = null, lastT = 0
  const sample = (t) => {
    const g = window.__game
    if (!g || g.phase !== 'race' || !g.car || !g.myId) { lastV = null; return }
    const sT = g.net.serverNow() - (performance.now() - t)
    const me = g.car.root.position
    const row = [sT, g.myId, me.x, me.y, me.z]
    let near = -1, nd = 1e9, rel = null
    for (const [id, r] of g.remotes) {
      if (!r.car.root.visible) continue
      const p = r.car.root.position
      row.push(id, p.x, p.y, p.z)
      const d = p.distanceTo(me)
      if (d < nd) { nd = d; near = id; rel = me.clone().sub(p) }
    }
    rec.f.push(row)
    const v = g.car.velocity.clone()
    // a knock: a sudden change of velocity; kept from 1 m/s (the other side of a bump may feel less)
    if (lastV && t - lastT < 60 && v.distanceTo(lastV) > 1) {
      const dv = v.clone().sub(lastV)
      rec.k.push([sT, near, nd, dv.length(), rel ? dv.dot(rel) / (dv.length() * rel.length()) : 0])
    }
    lastV = v
    lastT = t
  }
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) => raf((t) => { cb(t); try { sample(t) } catch (e) { rec.err = String(e) } })
}
const browsers = [], pages = []
for (const w of who) {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const p = await b.newPage({ viewport: { width: 320, height: 180 } })
  p.on('pageerror', (e) => console.log(w.name, 'page error:', e.message))
  await p.addInitScript(init)
  await p.goto(`${base}/?bot=human&${w.q}`)
  browsers.push(b)
  pages.push(p)
}
let done = 0, last = ''
const t0 = Date.now()
while (done < races && Date.now() - t0 < 15 * 60_000) {
  await new Promise((r) => setTimeout(r, 1000))
  const ph = await pages[0].evaluate(() => window.__game?.phase).catch(() => null)
  if (ph === 'results' && last !== 'results') done++
  if (ph && ph !== last) console.log(Math.round((Date.now() - t0) / 1000) + ' s', ph)
  if (ph) last = ph
}
const data = []
for (const [i, p] of pages.entries()) {
  data.push(await p.evaluate(() => ({ f: window.__rec.f, k: window.__rec.k, err: window.__rec.err, rtt: window.__game.net.rtt(), tr: window.__game.net.transport(), id: window.__game.myId })))
  console.log(`${who[i].name}: id ${data[i].id}, ping ${Math.round(data[i].rtt)} ms over ${data[i].tr}, ${data[i].f.length} frames recorded${data[i].err ? ', error ' + data[i].err : ''}`)
}
for (const b of browsers) await b.close()

// ---- analysis
const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN)
const cm = (v) => (v * 100).toFixed(0)
const tracks = data.map((d) => ({ id: d.id, t: d.f.map((r) => r[0]), p: d.f.map((r) => [r[2], r[3], r[4]]) }))
const truthAt = (tr, t) => {
  let lo = 0, hi = tr.t.length - 1
  if (hi < 1 || t < tr.t[0] || t > tr.t[hi]) return null
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr.t[m] <= t) lo = m; else hi = m }
  const dt = tr.t[hi] - tr.t[lo]
  if (dt > 120) return null // a hole in the recording
  const k = dt ? (t - tr.t[lo]) / dt : 0
  return tr.p[lo].map((v, i) => v + (tr.p[hi][i] - v) * k)
}
const byId = new Map(tracks.map((tr, i) => [tr.id, i]))
// resets: the owner's car moves > 3 m between two frames; frames within 1.5 s after one are left out
const resets = tracks.map((tr) => tr.t.filter((t, n) => n && Math.hypot(...tr.p[n].map((v, k) => v - tr.p[n - 1][k])) > 3))
const nearReset = (j, t) => resets[j].some((r) => t > r - 300 && t < r + 1500)
console.log('\nhow far from where its owner had it each car is drawn (cm: median / 90% / 99% / max) — jumps: frame-to-frame jerks > 15 cm per minute')
for (const [i, d] of data.entries()) {
  for (const [j, other] of tracks.entries()) {
    if (i === j) continue
    const errs = [], jerks = []
    let prev = null
    for (const r of d.f) {
      for (let k = 5; k < r.length; k += 4) {
        if (r[k] !== other.id) continue
        const p = [r[k + 1], r[k + 2], r[k + 3]]
        if (nearReset(j, r[0])) { prev = null; continue }
        const tru = truthAt(other, r[0])
        if (tru) errs.push(Math.hypot(p[0] - tru[0], p[1] - tru[1], p[2] - tru[2]))
        // jerk: second difference of the drawn position, against the owner's own (the real motion)
        if (prev && prev.length === 2 && r[0] - prev[1].t < 60 && prev[1].t - prev[0].t < 60) {
          const a = prev[0], b = prev[1]
          const k1 = (r[0] - b.t) / (b.t - a.t)
          const pred = b.p.map((v, n) => v + (v - a.p[n]) * k1)
          const tb = truthAt(other, b.t), ta = truthAt(other, a.t), tc = truthAt(other, r[0])
          const tpred = tb && ta && tc ? tb.map((v, n) => v + (v - ta[n]) * k1) : null
          if (tpred) {
            const jd = Math.hypot(p[0] - pred[0], p[1] - pred[1], p[2] - pred[2])
            const jt = Math.hypot(tc[0] - tpred[0], tc[1] - tpred[1], tc[2] - tpred[2])
            jerks.push(jd - jt)
          }
        }
        prev = [...(prev ?? []).slice(-1), { t: r[0], p }]
      }
    }
    const mins = (d.f.length ? (d.f[d.f.length - 1][0] - d.f[0][0]) / 60000 : 1) || 1
    console.log(`${who[i].name.padEnd(9)} sees ${who[j].name.padEnd(9)}: ${cm(pct(errs, 0.5))} / ${cm(pct(errs, 0.9))} / ${cm(pct(errs, 0.99))} / ${cm(pct(errs, 1))} cm   jumps ${(jerks.filter((x) => x > 0.15).length / mins).toFixed(1)}/min (${errs.length} frames)`)
  }
}
// CPU cars: two people's views of the same CPU car at the same moment
const cpuGap = []
for (const [i, d] of data.entries()) for (const [j] of data.entries()) {
  if (j <= i) continue
  const view = (n, id) => ({ t: data[n].f.map((r) => r[0]), p: data[n].f.map((r) => { for (let k = 5; k < r.length; k += 4) if (r[k] === id) return [r[k + 1], r[k + 2], r[k + 3]]; return null }) })
  const ids = new Set(d.f.flatMap((r) => r.filter((_, k) => k >= 5 && (k - 5) % 4 === 0)).filter((id) => id >= 200))
  for (const id of ids) {
    const a = view(i, id), b = view(j, id)
    const bt = { t: [], p: [] }
    b.t.forEach((t, n) => b.p[n] && (bt.t.push(t), bt.p.push(b.p[n])))
    a.t.forEach((t, n) => {
      if (!a.p[n]) return
      const q = truthAt(bt, t)
      if (q) cpuGap.push(Math.hypot(a.p[n][0] - q[0], a.p[n][1] - q[1], a.p[n][2] - q[2]))
    })
  }
}
console.log(`CPU cars, one person's view vs another's at the same moment: ${cm(pct(cpuGap, 0.5))} / ${cm(pct(cpuGap, 0.9))} / ${cm(pct(cpuGap, 0.99))} / ${cm(pct(cpuGap, 1))} cm`)
// bumps between people
console.log('\nbumps between people (a knock of 2.5 m/s+ pushing me away from that person\'s car, within 1.6 m on my screen — and do they feel a knock of 1 m/s+ within 250 ms):')
let felt = 0, all = 0
for (const [i, d] of data.entries()) {
  for (const [t, near, nd, dv, push] of d.k) {
    const j = byId.get(near)
    // a hit from that car: a knock of 2.5 m/s+, that car within 1.6 m, pushing us away from it
    if (j === undefined || nd > 1.6 || dv < 2.5 || push < 0.3) continue
    all++
    const back = data[j].k.find((k) => Math.abs(k[0] - t) < 250 && k[1] === d.id)
    if (back) felt++
    console.log(`  ${who[i].name} knocked ${dv.toFixed(1)} m/s by ${who[j].name} (${cm(nd)} cm apart on my screen): ${back ? `felt there too, ${Math.round(back[0] - t)} ms apart, ${back[3].toFixed(1)} m/s` : 'not felt there'}`)
  }
}
console.log(`  ${felt} of ${all} felt on both sides`)
for (const [i, d] of data.entries()) {
  const fr = d.f.length / (((d.f[d.f.length - 1]?.[0] ?? 0) - (d.f[0]?.[0] ?? 0)) / 1000 || 1)
  console.log(`${who[i].name}: ${fr.toFixed(0)} frames/s, ${resets[i].length} resets`)
}
