// The lobby's handle on a CPU-car world running in a worker thread (shared/aiworker.ts): the same
// calls as AiWorld, sent as messages; its hooks come back the same way.
import type { AiHooks } from './ai'
import type { Phase, ServerMsg } from './protocol'

export class AiWorldProxy {
  private progress = new Map<number, { done: number; total: number; finished: boolean }>()

  private constructor(private worker: Worker) {}

  static create(hooks: AiHooks, track: string): Promise<AiWorldProxy> {
    const worker = new Worker(new URL('./aiworker.ts', import.meta.url).href)
    const proxy = new AiWorldProxy(worker)
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data
        switch (m.op) {
          case 'state': hooks.state(m.p); break
          case 'message': hooks.message(m.id, m.m); break
          case 'finish': hooks.finish(m.id, m.time, m.best); break
          case 'lap': hooks.lap?.(m.id, m.n, m.ms); break
          case 'objects': hooks.objects?.(m.p); break
          case 'progress':
            for (const [id, done, total, finished] of m.list) proxy.progress.set(id, { done, total, finished })
            break
          case 'ready': resolve(proxy); break
          case 'failed': worker.terminate(); reject(new Error(m.error)); break
        }
      }
      worker.onerror = (e) => console.error(`AI worker (${track}):`, e.message)
      worker.postMessage({ op: 'create', track })
    })
  }

  setActive(on: boolean) { this.worker.postMessage({ op: 'active', on }) }
  setHumanCar(id: number, key: string | null) { this.worker.postMessage({ op: 'human', id, key }) }
  onHumanState(id: number, time: number, f: Float32Array) { this.worker.postMessage({ op: 'humanState', id, time, f }) }
  onServerMsg(m: ServerMsg) { this.worker.postMessage({ op: 'serverMsg', m }) }
  setPhase(phase: Phase) {
    if (phase === 'grid') this.progress.clear()
    this.worker.postMessage({ op: 'phase', phase })
  }
  addAi(id: number, key: string, slot: number) { this.worker.postMessage({ op: 'addAi', id, key, slot }) }
  removeAll() {
    this.progress.clear()
    this.worker.postMessage({ op: 'removeAll' })
  }
  give(id: number, w: string, n: number) { this.worker.postMessage({ op: 'give', id, w, n }) }
  dispose() {
    this.worker.postMessage({ op: 'dispose' })
    setTimeout(() => this.worker.terminate(), 1000)
  }

  /** As AiWorld.projectFinish, from the progress the worker reports 4× a second. */
  projectFinish(id: number, elapsed: number): number | null {
    const d = this.progress.get(id)
    if (!d || d.finished) return null
    if (d.done < d.total * 0.1 || elapsed < 5000) return null
    return Math.round(elapsed * Math.max(1, d.total / d.done))
  }
}
