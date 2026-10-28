// Can a peer open the car-state data channel (shared/rtc.ts) to the server at these addresses?
//   bun /tool/udpcheck.ts ws://<address>:<port>/ws <address>[,<address>…]
// Only the server's candidates at the given addresses are tried (its host candidate is the container's
// own address, which another container would reach without going through the published port). Prints
// "ok <address>" or "no", exit 0 / 1. Joins the lobby's socket for a moment without saying hello (not a
// racer).
import { PeerConnection } from 'node-datachannel'

const [url, list] = process.argv.slice(2)
const allowed = new Set((list ?? '').split(',').filter(Boolean))
const ws = new WebSocket(url)
const pc = new PeerConnection('check', { iceServers: [] })
let dc: ReturnType<PeerConnection['createDataChannel']> | null = null
let done = false
const finish = (ok: boolean, msg: string) => {
  if (done) return
  done = true
  console.log(msg)
  try { dc?.close(); pc.close(); ws.close() } catch { /* closing anyway */ }
  setTimeout(() => process.exit(ok ? 0 : 1), 100)
}
setTimeout(() => finish(false, 'no'), 8000)
let via = ''
pc.onLocalDescription((sdp, type) => type === 'offer' && ws.readyState === 1 && ws.send(JSON.stringify({ t: 'rtc', sdp })))
pc.onLocalCandidate((c, mid) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'rtcCand', c, mid })))
// the channel is made once the socket is open: making it starts the offer (onLocalDescription)
ws.onopen = () => {
  dc = pc.createDataChannel('state', { unordered: true, maxRetransmits: 0 })
  dc.onOpen(() => {
    const pair = (pc as any).getSelectedCandidatePair?.()
    finish(true, `ok ${pair?.remote?.address ?? via}`)
  })
}
ws.onerror = () => finish(false, 'no (the server did not answer)')
ws.onmessage = (e) => {
  let m: any
  try { m = JSON.parse(String(e.data)) } catch { return }
  // (candidates inside the answer would bypass the filter: only the trickled ones count)
  if (m.t === 'rtc') pc.setRemoteDescription(String(m.sdp).split(/\r?\n/).filter((l) => !/^a=candidate:/.test(l)).join('\r\n'), 'answer')
  else if (m.t === 'rtcCand') {
    const ip = /^(?:a=)?candidate:\S+ \d+ udp \d+ (\S+) /i.exec(m.c)?.[1]
    if (ip && allowed.has(ip)) {
      via ||= ip
      pc.addRemoteCandidate(m.c.replace(/^a=/, ''), m.mid)
    }
  }
}
