// WebSocket to the lobby. JSON for control, a binary packet for car state.
//
// Clock sync: every few seconds we ping with our clock and the server answers
// with its own; the sample with the smallest round trip (least queuing) gives
// the offset. serverNow() is then good to a few ms, which is what lets a
// receiver predict a remote car forward by exactly the age of its packet.
//
// Car state goes over a WebRTC data channel when one opens (unordered, no retransmits — a lost
// packet is skipped instead of holding up the ones behind it, see shared/rtc.ts), else over the
// WebSocket. ?rtc=0 forces the WebSocket.
//
// ?lag=<ms> adds that much round-trip delay (half each way) to test bad pings. On the data channel
// only (car state over UDP: unordered, losses not resent), ?jitter=<ms> adds 0..that much more to each
// packet each way and ?loss=<%> drops that share each way.
import type { ClientMsg, ServerMsg } from '../shared/protocol'
import { OBJ_MARK } from '../shared/objnet'
import { packCars, unpackCars } from '../shared/protocol'

export interface Net {
  send(m: ClientMsg): void
  /** time = when the state was taken, on the server clock (ms) */
  sendState(time: number, f: Float32Array): void
  connected(): boolean
  serverNow(): number
  rtt(): number
  /** 'udp' while car state goes over the data channel, else 'tcp' */
  transport(): 'udp' | 'tcp'
}

interface Sample { rtt: number; offset: number; at: number }

export function connect(
  onMsg: (m: ServerMsg) => void,
  onState: (id: number, time: number, f: Float32Array) => void,
  onOpen: () => void,
  onClose: () => void,
  onObjects: (b: ArrayBuffer) => void = () => {},
): Net {
  const lag = Math.max(0, Number(new URLSearchParams(location.search).get('lag') ?? 0)) / 2
  const later = (fn: () => void) => (lag ? setTimeout(fn, lag) : fn())
  const q = new URLSearchParams(location.search)
  const jitter = Math.max(0, Number(q.get('jitter') ?? 0)), loss = Math.max(0, Number(q.get('loss') ?? 0)) / 100
  const laterUdp = (fn: () => void) => {
    if (loss && Math.random() < loss) return
    const d = lag + Math.random() * jitter
    if (d) setTimeout(fn, d)
    else fn()
  }
  let ws: WebSocket | null = null
  let retry = 500
  let samples: Sample[] = []
  let offset = Date.now() - performance.now()
  let rtt = 0
  let pc: RTCPeerConnection | null = null
  let dc: RTCDataChannel | null = null
  let signals: Promise<unknown> = Promise.resolve()
  const useRtc = typeof RTCPeerConnection !== 'undefined' && new URLSearchParams(location.search).get('rtc') !== '0'
  const wsSend = (m: ClientMsg) => ws?.readyState === 1 && ws.send(JSON.stringify(m))

  const onBinary = (b: ArrayBuffer) => {
    // the loose objects' states (shared/objnet.ts) start with 0xFF, cars' with CARS_MARK
    if (b.byteLength >= 16 && new Uint8Array(b, 0, 1)[0] === OBJ_MARK) return onObjects(b)
    unpackCars(b, onState)
  }
  const closeRtc = () => {
    dc = null
    pc?.close()
    pc = null
  }
  const startRtc = async () => {
    closeRtc()
    const my = (pc = new RTCPeerConnection({ iceServers: [] }))
    const ch = my.createDataChannel('state', { ordered: false, maxRetransmits: 0 })
    ch.binaryType = 'arraybuffer'
    ch.onopen = () => pc === my && (dc = ch)
    ch.onclose = () => dc === ch && (dc = null)
    ch.onmessage = (e) => laterUdp(() => onBinary(e.data as ArrayBuffer))
    my.onconnectionstatechange = () => my.connectionState === 'failed' && pc === my && closeRtc()
    my.onicecandidate = (e) => e.candidate?.candidate && wsSend({ t: 'rtcCand', c: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' })
    signals = Promise.resolve()
    await my.setLocalDescription(await my.createOffer())
    if (pc === my) wsSend({ t: 'rtc', sdp: my.localDescription!.sdp })
  }
  const onSignal = (m: ServerMsg) => {
    const my = pc
    if (!my) return
    signals = signals
      .then(() =>
        m.t === 'rtc'
          ? my.setRemoteDescription({ type: 'answer', sdp: m.sdp })
          : m.t === 'rtcCand'
            ? my.addIceCandidate({ candidate: m.c.replace(/^a=/, ''), sdpMid: m.mid })
            : undefined,
      )
      .catch(() => {})
  }

  const ping = () => {
    if (ws?.readyState === 1) {
      const c = performance.now()
      later(() => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'ping', c })))
    }
  }
  const onPong = (c: number, s: number) => {
    const now = performance.now()
    const r = now - c
    samples.push({ rtt: r, offset: s + r / 2 - now, at: now })
    samples = samples.filter((x) => now - x.at < 60_000).slice(-16)
    const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
    offset = best.offset
    // shown ping: recent average, not the best
    const recent = samples.slice(-5)
    rtt = recent.reduce((a, b) => a + b.rtt, 0) / recent.length
  }

  const open = () => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      retry = 500
      samples = []
      onOpen()
      // a quick burst to sync the clock, then every 2 s
      for (let i = 0; i < 5; i++) setTimeout(ping, i * 150)
      if (useRtc) startRtc().catch(() => closeRtc())
    }
    ws.onmessage = (e) =>
      later(() => {
        if (typeof e.data === 'string') {
          let m: ServerMsg
          try {
            m = JSON.parse(e.data)
          } catch {
            return
          }
          if (m.t === 'pong') onPong(m.c, m.s)
          else if (m.t === 'rtc' || m.t === 'rtcCand') onSignal(m)
          else onMsg(m)
        } else onBinary(e.data as ArrayBuffer)
      })
    ws.onclose = () => {
      closeRtc()
      onClose()
      setTimeout(open, retry)
      retry = Math.min(8000, retry * 2)
    }
  }
  open()
  setInterval(ping, 2000)

  return {
    send(m) {
      if (ws?.readyState === 1) {
        const s = JSON.stringify(m)
        later(() => ws?.readyState === 1 && ws.send(s))
      }
    },
    sendState(time, f) {
      if (ws?.readyState !== 1) return
      const copy = packCars(time, [{ id: 0, f }])
      if (dc?.readyState === 'open') {
        laterUdp(() => {
          if (dc?.readyState === 'open' && dc.bufferedAmount < 4096) dc.send(copy) // congested: skip, it would arrive stale
        })
      } else later(() => ws?.readyState === 1 && ws.send(copy))
    },
    connected: () => ws?.readyState === 1,
    serverNow: () => performance.now() + offset,
    rtt: () => rtt,
    transport: () => (dc?.readyState === 'open' ? 'udp' : 'tcp'),
  }
}
