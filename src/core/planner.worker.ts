import { planSegment } from './simulation';
self.onmessage = (event: MessageEvent) => {
  try {
    self.postMessage({
      id: event.data.id,
      result: planSegment(...(event.data.args as Parameters<typeof planSegment>)),
    });
  } catch (e) {
    self.postMessage({ id: event.data.id, error: e instanceof Error ? e.message : '规划失败' });
  }
};
