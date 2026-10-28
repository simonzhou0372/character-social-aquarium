import { planSegment, type Plan } from './simulation';
type Args = Parameters<typeof planSegment>;
let worker: Worker | undefined;
let workerUnavailable = false;
let counter = 0;
const pending = new Map<
  number,
  { args: Args; resolve: (v: Plan) => void; reject: (e: unknown) => void }
>();
// Keep the same deterministic planner and seed. Only the execution location changes.
function localPlan(args: Args): Promise<Plan> {
  return Promise.resolve().then(() => planSegment(...args));
}
function recoverWorker(failed: Worker, reason: string) {
  if (worker !== failed) return;
  workerUnavailable = true;
  worker = undefined;
  failed.terminate();
  console.warn('生活规划线程不可用，已切换本地规划：', reason);
  const jobs = [...pending.values()];
  pending.clear();
  for (const job of jobs) localPlan(job.args).then(job.resolve, job.reject);
}
export function planInWorker(...args: Args): Promise<Plan> {
  if (typeof Worker === 'undefined' || workerUnavailable) return localPlan(args);
  if (!worker) {
    try {
      const created = new Worker(new URL('./planner.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker = created;
      created.onmessage = (e) => {
        if (worker !== created) return;
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        // A planner/data error is not a transport failure; do not retry it.
        e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
      };
      created.onerror = (e) => {
        e.preventDefault();
        recoverWorker(
          created,
          `${e.message || 'Worker加载或执行失败'} (${e.filename || 'unknown'}:${e.lineno || 0})`,
        );
      };
      created.onmessageerror = () => recoverWorker(created, 'Worker响应无法反序列化');
    } catch (e) {
      workerUnavailable = true;
      console.warn(
        '生活规划线程创建失败，已切换本地规划：',
        e instanceof Error ? e.message : '未知错误',
      );
      return localPlan(args);
    }
  }
  const id = ++counter;
  return new Promise((resolve, reject) => {
    pending.set(id, { args, resolve, reject });
    try {
      worker!.postMessage({ id, args });
    } catch (e) {
      recoverWorker(worker!, e instanceof Error ? e.message : 'Worker消息发送失败');
    }
  });
}
