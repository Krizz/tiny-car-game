// WebRTC data channels for the 30 Hz car state (server side, libdatachannel via node-datachannel).
//
// Over the WebSocket (TCP) one lost packet holds up every packet behind it until it is resent —
// 100–400 ms during which other cars are drawn from an ever older state, then jump (measured in
// test/net.ts: LOSS=3 NET=tcp vs udp). A data channel that is unordered with no retransmits just
// drops the lost one; the next arrives 33 ms later and the prediction covers the gap.
//
// The browser offers (signalling over the lobby WebSocket: {t:'rtc'} / {t:'rtcCand'}), we answer.
// Every peer shares ONE UDP port (ICE UDP mux), published by Docker; the host candidate carries the
// container's address, so each one is also sent with RTC_PUBLIC_IP. No STUN/TURN: the server is
// public, and the browser's own address is learnt from its checks (peer-reflexive). A browser
// that can't reach the port keeps using the WebSocket for everything.
//   RTC_PORT=7903 RTC_PUBLIC_IP=203.0.113.10   (unset RTC_PORT = off; several addresses comma-separated,
//   e.g. public + LAN for a home server: each one becomes a candidate)
import { PeerConnection, type DataChannel } from 'node-datachannel'

export const RTC_PORT = Number(process.env.RTC_PORT ?? 0)
const PUBLIC_IPS = (process.env.RTC_PUBLIC_IP ?? '').split(',').map((s) => s.trim()).filter(Boolean)
// a congested channel keeps only fresh packets: drop when this much is queued already
const MAX_QUEUED = 4096

export interface RtcSignal {
  sdp?: string
  c?: string
  mid?: string
}

export class RtcPeer {
  private pc: PeerConnection
  private dc: DataChannel | null = null
  private open = false
  private closed = false

  constructor(
    private signal: (m: { t: 'rtc'; sdp: string } | { t: 'rtcCand'; c: string; mid: string }) => void,
    private onState: (b: Uint8Array) => void,
    private log: (s: string) => void,
  ) {
    this.pc = new PeerConnection('p', {
      iceServers: [],
      enableIceUdpMux: true,
      portRangeBegin: RTC_PORT,
      portRangeEnd: RTC_PORT,
      maxMessageSize: 1024,
    })
    this.pc.onLocalDescription((sdp) => this.signal({ t: 'rtc', sdp }))
    this.pc.onLocalCandidate((c, mid) => {
      this.signal({ t: 'rtcCand', c, mid })
      // host candidate = the container's address; the same port is published on the host
      const h = /^(a=)?candidate:(\S+)( \d+ udp \d+ )(\S+)( \d+ typ host.*)$/i.exec(c)
      if (h) PUBLIC_IPS.forEach((ip, k) => ip !== h[4] && this.signal({ t: 'rtcCand', c: `candidate:${h[2]}p${k || ''}${h[3]}${ip}${h[5]}`, mid }))
    })
    this.pc.onStateChange((s) => {
      if (s === 'failed' || s === 'closed') this.close()
    })
    this.pc.onDataChannel((dc: DataChannel) => {
      if (this.dc || dc.getLabel() !== 'state') return dc.close()
      this.dc = dc
      dc.onOpen(() => {
        this.open = true
        this.log('data channel open')
      })
      if (dc.isOpen()) this.open = true
      dc.onClosed(() => (this.open = false))
      dc.onMessage((msg) => {
        if (typeof msg !== 'string') this.onState(new Uint8Array(msg as ArrayBuffer))
      })
    })
  }

  offer(sdp: string) {
    try {
      this.pc.setRemoteDescription(sdp, 'offer')
    } catch (e) {
      this.log(`bad offer: ${e}`)
      this.close()
    }
  }

  candidate(c: string, mid: string) {
    try {
      this.pc.addRemoteCandidate(c, mid)
    } catch {
      // mDNS (.local) candidates can't be resolved here; the browser's checks reach us anyway
    }
  }

  /** false = not sent (no channel yet, or congested) — the caller decides on a fallback */
  send(b: Uint8Array): boolean {
    if (!this.open || !this.dc) return false
    try {
      if (this.dc.bufferedAmount() > MAX_QUEUED) return true // dropped on purpose: stale anyway
      return this.dc.sendMessageBinary(b)
    } catch {
      return false
    }
  }

  get ready() {
    return this.open
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.open = false
    try {
      this.dc?.close()
      this.pc.close()
    } catch {}
  }
}
