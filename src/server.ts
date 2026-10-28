// cargame server: serves the built client (dist/, pre-gzipped siblings when
// present) and the lobby WebSocket on /ws. One process, port 80.
import { join, normalize } from 'node:path'
import { Lobby } from './shared/lobby'

const DIST = join(import.meta.dir, 'dist')
const PORT = Number(process.env.PORT ?? 80)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
}

// gzipped once in memory for compressible files without a .gz sibling (vite's bundle, the wasm):
// the 600 KB script went out uncompressed
const ZIP = new Set(['.html', '.js', '.css', '.json', '.wasm', '.svg'])
const zipped = new Map<string, { stamp: string; body: Uint8Array }>()

async function serveFile(path: string, req: Request): Promise<Response | null> {
  const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '')
  const file = join(DIST, rel)
  if (!file.startsWith(DIST)) return null
  const ext = file.slice(file.lastIndexOf('.'))
  const type = TYPES[ext] ?? 'application/octet-stream'
  // hashed assets never change; everything else revalidates — against an ETag (size + mtime of
  // what is sent): without one "no-cache" meant every file again on every load, and the page
  // reloads after each course vote
  const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  const gzipOk = (req.headers.get('accept-encoding') ?? '').includes('gzip')
  const send = (body: Blob | Uint8Array, stamp: string, gzip: boolean) => {
    const etag = `W/"${stamp}${gzip ? '-gz' : ''}"`
    const headers: Record<string, string> = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding' }
    if (gzip) headers['Content-Encoding'] = 'gzip'
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
    return new Response(body, { headers })
  }
  const stampOf = (f: ReturnType<typeof Bun.file>) => `${f.size.toString(36)}-${Math.floor(f.lastModified).toString(36)}`
  const gz = Bun.file(file + '.gz')
  if (gzipOk && (await gz.exists())) return send(gz, stampOf(gz), true)
  const f = Bun.file(file)
  if (!(await f.exists())) return null
  const stamp = stampOf(f)
  if (gzipOk && ZIP.has(ext) && f.size > 1024) {
    let z = zipped.get(file)
    if (!z || z.stamp !== stamp) zipped.set(file, (z = { stamp, body: Bun.gzipSync(new Uint8Array(await f.arrayBuffer())) }))
    return send(z.body, stamp, true)
  }
  return send(f, stamp, false)
}

const lobby = new Lobby()

const server = Bun.serve<{ id: number }>({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      if (srv.upgrade(req, { data: { id: 0 } })) return
      return new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname === '/api/track') {
      return Response.json({ track: lobby.track }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname
    // nothing at all = dist/ is being rebuilt (vite empties it first): try again in a moment
    return (await serveFile(path, req)) ?? (await serveFile('/index.html', req)) ??
      new Response('rebuilding, try again', { status: 503, headers: { 'Retry-After': '2' } })
  },
  websocket: {
    idleTimeout: 60,
    maxPayloadLength: 64 * 1024,
    open(ws) {
      lobby.open(ws)
    },
    message(ws, msg) {
      lobby.message(ws, msg)
    },
    close(ws) {
      lobby.close(ws)
    },
  },
})
lobby.server = server
console.log(`cargame on :${server.port}`)
