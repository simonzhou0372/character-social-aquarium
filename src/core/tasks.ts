const tasks = new Map<string, AbortController>();
export function cancelWorld(worldId: string) {
  tasks.get(worldId)?.abort();
}
export function startWorldTask(worldId: string, external?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) controller.abort();
  tasks.set(worldId, controller);
  return {
    signal: controller.signal,
    done: () => {
      external?.removeEventListener('abort', abort);
      if (tasks.get(worldId) === controller) tasks.delete(worldId);
    },
  };
}
