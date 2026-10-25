import { ProviderError } from './provider';
let active = 0;
const queue: {
  priority: number;
  resolve: () => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  abort: () => void;
}[] = [];
function release() {
  active--;
  while (queue.length) {
    const next = queue.shift()!;
    next.signal?.removeEventListener('abort', next.abort);
    if (next.signal?.aborted) {
      next.reject(new ProviderError('cancelled', '任务已取消'));
      continue;
    }
    active++;
    next.resolve();
    break;
  }
}
/** Unlimited usage still has a fixed concurrency ceiling. No retry loop lives here. */
export async function withAISlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  priority = 0,
): Promise<T> {
  if (signal?.aborted) throw new ProviderError('cancelled', '任务已取消');
  if (active < 2) active++;
  else {
    if (queue.length >= 32) throw new ProviderError('busy', '生成通道繁忙，任务将保留后重试');
    await new Promise<void>((resolve, reject) => {
      const entry = {
        priority,
        resolve,
        reject,
        signal,
        abort: () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          reject(new ProviderError('cancelled', '任务已取消'));
        },
      };
      queue.push(entry);
      queue.sort((a, b) => b.priority - a.priority);
      signal?.addEventListener('abort', entry.abort, { once: true });
    });
  }
  try {
    if (signal?.aborted) throw new ProviderError('cancelled', '任务已取消');
    return await fn();
  } finally {
    release();
  }
}
