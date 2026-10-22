import { planSegment, type Plan } from './simulation';
let worker: Worker | undefined;
let counter = 0;
const pending = new Map<number, { resolve: (v: Plan) => void; reject: (e: Error) => void }>();
export function planInWorker(...args: Parameters<typeof planSegment>): Promise<Plan> {
  if (typeof Worker === 'undefined') return Promise.resolve(planSegment(...args));
  if (!worker) {
    worker = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
    };
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error('生活规划线程异常，请刷新重试。'));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  const id = ++counter;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, args });
  });
}
