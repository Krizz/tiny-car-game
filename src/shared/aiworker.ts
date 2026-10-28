// One course's CPU-car world (shared/ai.ts) in its own thread: its physics, drivers, weapons, its
// garbage collection and the loading of it no longer hold up the main thread, which relays every
// browser's state packets. Talks to shared/aiproxy.ts by messages.
import { AiWorld } from './ai'

declare const self: Worker
let world: AiWorld | null = null

self.onmessage = async (e: MessageEvent) => {
  const m = e.data
  if (m.op === 'create') {
    try {
      world = await AiWorld.create({
        message: (id, msg) => postMessage({ op: 'message', id, m: msg }),
        // a fresh packet each tick: handed over, not copied
        state: (p) => postMessage({ op: 'state', p }, [p.buffer as ArrayBuffer]),
        finish: (id, time, best) => postMessage({ op: 'finish', id, time, best }),
        lap: (id, n, ms) => postMessage({ op: 'lap', id, n, ms }),
        objects: (p) => postMessage({ op: 'objects', p }, [p.buffer as ArrayBuffer]),
      }, m.track)
      postMessage({ op: 'ready' })
      // CPU cars' progress for the main thread's projectFinish() (results when time runs out)
      setInterval(() => world && postMessage({ op: 'progress', list: world.progress() }), 250)
    } catch (err) {
      postMessage({ op: 'failed', error: String(err) })
    }
    return
  }
  const w = world
  if (!w) return
  switch (m.op) {
    case 'human': w.setHumanCar(m.id, m.key); break
    case 'humanState': w.onHumanState(m.id, m.time, m.f); break
    case 'serverMsg': w.onServerMsg(m.m); break
    case 'phase': w.setPhase(m.phase); break
    case 'active': w.setActive(m.on); break
    case 'addAi': w.addAi(m.id, m.key, m.slot); break
    case 'removeAll': w.removeAll(); break
    case 'give': w.give(m.id, m.w, m.n); break
    case 'dispose': w.dispose(); world = null; process.exit(0)
  }
}
