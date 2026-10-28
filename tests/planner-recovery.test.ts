import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const plan = vi.hoisted(() => vi.fn());
vi.mock('../src/core/simulation', () => ({ planSegment: plan }));
class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: any;
  onerror: any;
  onmessageerror: any;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    TestWorker.instances.push(this);
  }
}
beforeEach(() => {
  vi.resetModules();
  plan.mockReset().mockImplementation((...args) => ({
    seed: args[3]?.seed,
    events: [],
    states: [],
    socialCandidates: [],
  }));
  TestWorker.instances = [];
  vi.stubGlobal('Worker', TestWorker);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const args = [{}, [], [], { seed: 42 }, 1000, []] as unknown as Parameters<
  typeof import('../src/core/simulation').planSegment
>;
it('recovers all in-flight jobs with the original arguments and avoids restarting a broken worker', async () => {
  const { planInWorker } = await import('../src/core/planner');
  const a = planInWorker(...args),
    b = planInWorker(...args);
  const w = TestWorker.instances[0];
  w.onerror({ preventDefault: vi.fn(), message: 'module fetch failed' });
  expect((await a).seed).toBe(42);
  expect((await b).seed).toBe(42);
  expect(plan).toHaveBeenCalledWith(...args);
  expect(w.terminate).toHaveBeenCalledOnce();
  await planInWorker(...args);
  expect(TestWorker.instances).toHaveLength(1);
  expect(plan).toHaveBeenCalledTimes(3);
});
it('falls back when worker construction is blocked', async () => {
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('blocked');
      }
    },
  );
  const { planInWorker } = await import('../src/core/planner');
  expect((await planInWorker(...args)).seed).toBe(42);
});
it.each(['send', 'receive'])('recovers from %s serialization failures', async (kind) => {
  const { planInWorker } = await import('../src/core/planner');
  const first = planInWorker(...args),
    w = TestWorker.instances[0];
  if (kind === 'send') {
    w.postMessage.mockImplementation(() => {
      throw new Error('clone');
    });
    const second = planInWorker(...args);
    await expect(second).resolves.toHaveProperty('seed', 42);
  } else w.onmessageerror({});
  await expect(first).resolves.toHaveProperty('seed', 42);
});
it('preserves planner errors without rerunning the failed plan', async () => {
  const { planInWorker } = await import('../src/core/planner');
  const result = planInWorker(...args),
    w = TestWorker.instances[0];
  const id = w.postMessage.mock.calls[0][0].id;
  w.onmessage({ data: { id, error: 'invalid world date' } });
  await expect(result).rejects.toThrow('invalid world date');
  expect(plan).not.toHaveBeenCalled();
});
