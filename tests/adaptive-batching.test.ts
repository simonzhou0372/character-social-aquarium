import { it, expect } from 'vitest';
import { appendFileSync } from 'node:fs';
import { AquariumDB } from '../src/data/db';
import { seed, newCharacter } from '../src/data/seed';
import { runWorld, setRunning } from '../src/core/engine';
import { rewindWorld } from '../src/core/time';
import { uploadGif } from '../src/data/gifs';
import { recycleEntity } from '../src/data/recycle';
import { drainContent } from '../src/ai/content-queue';
import { defaultPrompts } from '../src/ai/prompts';
import { contentPlan, adaptiveLimits, MAX_PENDING_CONTENT } from '../src/core/adaptive-batching';
import { exportBackup, importBackup, validateBackup } from '../src/data/backup';
import { DAY, HOUR, type ContentJob, type ActivityEvent } from '../src/core/types';
import type { ChatInput, Provider } from '../src/ai/provider';
import { ProviderError } from '../src/ai/provider';
const NOW = Date.parse('2026-10-25T00:00:00Z');
async function fixture(n = 5, speed = 1000, adaptive = true) {
  const d = new AquariumDB('batch-' + crypto.randomUUID());
  await seed(d, NOW);
  await d.settings.update('app', {
    unlimitedUsage: true,
    activity: 'lively',
    sceneFrequency: 1,
    sceneDailyBudget: 10,
    adaptiveBatching: adaptive,
  });
  await d.profiles.put({
    id: 'api',
    provider: 'fixture',
    model: 'fixture',
    baseUrl: 'https://fixture.invalid',
    persistKey: false,
    status: 'connected',
    contextBudgetTokens: 32000,
    outputBudgetTokens: 8192,
  });
  for (let i = 5; i < n; i++) {
    const id = 'test-' + i;
    await d.characters.put({ ...newCharacter('测试人物' + i), id });
    await d.memberships.put({
      id: 'member-' + i,
      worldId: 'w-harbor',
      characterId: id,
      identity: '',
      bioOverride: '',
      styleOverride: '',
    });
    await d.groupMembers.put({
      id: 'group-' + i,
      worldId: 'w-harbor',
      groupId: 'g-cafe',
      characterId: id,
      nickname: '',
      role: '成员',
    });
  }
  await d.checkpoints.update('w-harbor', {
    paused: false,
    mode: 'live',
    speed,
    seed: 42,
    simTime: NOW,
    realTime: NOW,
    clockAnchor: { simTime: NOW, realTime: NOW },
  });
  return d;
}
function output(contract: string, ctx: any) {
  const n = Number(contract.match(/正好生成 (\d+) 条/)?.[1] ?? 1);
  if (contract.includes('"entries"')) {
    const p = ctx.input.phase,
      event = ctx.input.event,
      existing = ctx.input.alreadyGenerated ?? [];
    const offset = Math.max(
      (p.start - event.start) / 1000 + 1,
      existing.at(-1) ? (existing.at(-1).at - event.start) / 1000 : 0,
    );
    return {
      entries: Array.from({ length: n }, (_, i) => ({
        kind: 'dialogue',
        speakerId: p.participants[i % p.participants.length],
        offset: offset + i,
        text: '这件事我也留意到了。',
      })),
    };
  }
  if (contract.includes('"speakerId"'))
    return {
      speakerId: contract.match(/"speakerId":"([^"]+)"/)![1],
      messages: Array.from({ length: n }, (_, i) => '我刚好想到这件事' + (i + 1) + '。'),
    };
  return { description: ctx.state.description };
}
class FixtureProvider implements Provider {
  calls: ChatInput[] = [];
  async complete(messages: ChatInput) {
    this.calls.push(structuredClone(messages));
    const p = JSON.parse(messages[1].content),
      contract = messages[0].content;
    const value = p.batchId
      ? {
          batchId: p.batchId,
          results: p.tasks.map((t: any) => ({
            taskId: t.taskId,
            result: output(t.contract, {
              ...p.sharedContext,
              ...t.context,
              input: { ...p.sharedContext?.input, ...t.context.input },
            }),
          })),
        }
      : output(contract, p);
    const content = JSON.stringify(value);
    return {
      content,
      inputTokens: Math.ceil(JSON.stringify(messages).length / 2),
      outputTokens: Math.ceil(content.length / 2),
      estimated: true,
    };
  }
}
async function drainAll(d: AquariumDB, p: Provider) {
  for (let i = 0; i < 800; i++) {
    const pending = await d.contentJobs.filter((j) => j.status !== 'complete').count();
    if (!pending) return;
    await drainContent('w-harbor', d, p);
    const failed = await d.contentJobs.filter((j) => j.status === 'failed').toArray();
    if (failed.length)
      throw new Error(
        JSON.stringify(failed.map((j) => ({ id: j.id, error: j.error, attempts: j.attempts }))),
      );
  }
  throw new Error('队列未排空');
}
async function planDay(d: AquariumDB, speed: number) {
  await runWorld(
    'w-harbor',
    {
      now: NOW + DAY / speed,
      foregroundSince: NOW,
      deferContent: true,
      dispatchContent: false,
      maxSegments: 2000,
    },
    d,
  );
}
const signature = (jobs: ContentJob[]) =>
  jobs
    .map((j) => ({
      id: j.id,
      at: j.at,
      kind: j.kind,
      participants: j.event.participants,
      plan: j.plan,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
it('keeps 24-hour fixed-seed plans identical at five speeds and 5/20/50-person scale', async () => {
  const results: any[] = [];
  for (const n of [5, 20, 50]) {
    let baseline: any;
    for (const speed of [1, 100, 300, 1000, 3000])
      for (const enabled of [false, true]) {
        const d = await fixture(n, speed, enabled);
        try {
          await planDay(d, speed);
          const cp = (await d.checkpoints.get('w-harbor'))!;
          expect(cp.simTime).toBe(NOW + DAY);
          const jobs = await d.contentJobs.toArray(),
            sig = signature(jobs);
          if (!baseline) baseline = sig;
          else expect(sig).toEqual(baseline);
          results.push({
            characters: n,
            speed,
            enabled,
            tasks: jobs.length,
            messages: jobs.reduce((s, j) => s + (j.plan?.expectedMessages ?? 0), 0),
            dialogue: jobs.reduce((s, j) => s + (j.plan?.expectedDialogue ?? 0), 0),
          });
        } finally {
          await d.delete();
        }
      }
  }
  console.log('24h planning matrix', JSON.stringify(results));
}, 240000);
it('drains identical plans without losing messages or scene phases and measures real request/token counts', async () => {
  const results: any[] = [];
  for (const characters of [5, 20, 50])
    for (const enabled of [false, true]) {
      const d = await fixture(characters, 1000, enabled),
        p = new FixtureProvider();
      try {
        await planDay(d, 1000);
        const plans = await d.contentJobs.toArray();
        const started = Date.now(),
          heap = process.memoryUsage().heapUsed;
        await drainAll(d, p);
        const performance = await measurements(d, started, heap, plans.length);
        const generated = await d.messages.filter((m) => m.id.startsWith('chat:')).count();
        const scenes = await d.scenes.toArray();
        expect(generated).toBe(plans.reduce((n, j) => n + (j.plan?.expectedMessages ?? 0), 0));
        expect(
          scenes.reduce(
            (n, s) =>
              n + s.phases.flatMap((p) => p.entries).filter((e) => e.kind === 'dialogue').length,
            0,
          ),
        ).toBe(plans.reduce((n, j) => n + (j.plan?.expectedDialogue ?? 0), 0));
        expect(scenes.reduce((n, s) => n + s.phases.length, 0)).toBe(
          plans.reduce((n, j) => n + (j.plan?.expectedPhases ?? 0), 0),
        );
        const usage = (await d.usage.toArray())[0];
        results.push({
          characters,
          ...performance,
          enabled,
          requests: p.calls.length,
          input: usage.inputTokens,
          output: usage.outputTokens,
          messages: generated,
          scenes: scenes.length,
          phases: scenes.reduce((n, s) => n + s.phases.length, 0),
        });
        const count = await d.messages.count();
        await drainContent('w-harbor', d, p);
        expect(await d.messages.count()).toBe(count);
      } finally {
        await d.delete();
      }
    }
  expect(results[1].requests).toBeLessThan(results[0].requests);
  expect(results[1].input).toBeLessThan(results[0].input);
  console.log('24h actual throughput comparison', JSON.stringify(results));
  capture('natural', results);
}, 180000);
async function addJob(d: AquariumDB, id: string, kind: 'chat' | 'scene' | 'life', at = NOW) {
  const e: ActivityEvent = {
    id: 'e-' + id,
    worldId: 'w-harbor',
    start: at,
    end: at + HOUR,
    type: 'social',
    participants: ['c-nagi', 'c-mio'],
    location: '咖啡馆',
    description: '一起喝咖啡',
    phone: 0.3,
    status: 'completed',
  };
  const snapshot = defaultPrompts(NOW);
  snapshot.rules.maxMessages = 3;
  snapshot.rules.minMessages = 3;
  const c =
    (await d.conversations.get('conv-nagi-mio')) ??
    (await d.conversations.toArray()).find((c) => c.kind === 'direct')!;
  const j: ContentJob = {
    id,
    worldId: e.worldId,
    kind,
    event: e,
    conversation: kind === 'chat' ? c : undefined,
    speakerId: 'c-nagi',
    at: at + 1000,
    snapshot,
    recovery: false,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
    plan: contentPlan(kind, 42, snapshot, e),
  };
  await d.events.put(e);
  await d.contentJobs.put(j);
  await d.checkpoints.update('w-harbor', { simTime: at + HOUR });
  return j;
}
it('stages short output, blocks dependants, survives backup and completes exactly once', async () => {
  const d = await fixture();
  try {
    const a = await addJob(d, 'short', 'chat'),
      b = await addJob(d, 'dependent', 'chat', NOW + HOUR);
    await d.contentJobs.update(b.id, { dependsOn: [a.id] });
    const one = new FixtureProvider();
    const partial = {
      complete: async (m: ChatInput) => {
        const r = await one.complete(m);
        const v = JSON.parse(r.content);
        v.messages = v.messages.slice(0, 1);
        return { ...r, content: JSON.stringify(v) };
      },
    };
    await drainContent('w-harbor', d, partial);
    expect((await d.contentJobs.get(a.id))?.status).toBe('pending');
    expect(await d.messages.filter((m) => m.id.startsWith('short:')).count()).toBe(0);
    const backup = validateBackup(await exportBackup(d));
    await importBackup(backup, d);
    await d.checkpoints.update('w-harbor', { paused: false });
    const p = new FixtureProvider();
    await drainAll(d, p);
    expect(await d.messages.filter((m) => m.id.startsWith('short:')).count()).toBe(3);
    expect(await d.messages.filter((m) => m.id.startsWith('dependent:')).count()).toBe(3);
  } finally {
    await d.delete();
  }
});
it.each(['rate', 'timeout', 'network'])(
  'retains plans after %s and recovers without duplication',
  async (code) => {
    const d = await fixture();
    try {
      const j = await addJob(d, 'fault', 'chat');
      await drainContent('w-harbor', d, {
        complete: async () => {
          throw new ProviderError(code, 'fixture ' + code);
        },
      });
      expect((await d.contentJobs.get(j.id))?.status).toBe('failed');
      expect((await d.contentJobs.get(j.id))?.plan?.expectedMessages).toBe(3);
      await d.contentJobs.update(j.id, { nextAttemptAt: 0 });
      await drainAll(d, new FixtureProvider());
      expect(await d.messages.filter((m) => m.id.startsWith('fault:')).count()).toBe(3);
    } finally {
      await d.delete();
    }
  },
);
it('preserves complete children of truncated envelopes and retries only missing children', async () => {
  const d = await fixture();
  try {
    await addJob(d, 'life-a', 'life');
    await addJob(d, 'life-b', 'life');
    const p = new FixtureProvider();
    let first = true;
    const broken = {
      complete: async (m: ChatInput) => {
        const r = await p.complete(m);
        if (first) {
          first = false;
          const v = JSON.parse(r.content);
          return {
            ...r,
            finishReason: 'length',
            content:
              '{"batchId":' +
              JSON.stringify(v.batchId) +
              ',"results":[' +
              JSON.stringify(v.results[0]) +
              ',{"taskId":',
          };
        }
        return r;
      },
    };
    await drainContent('w-harbor', d, broken);
    expect(await d.contentJobs.filter((j) => j.status === 'complete').count()).toBe(1);
    await d.contentJobs.filter((j) => j.status !== 'complete').modify({ nextAttemptAt: 0 });
    await drainAll(d, p);
    expect(await d.contentJobs.filter((j) => j.status === 'complete').count()).toBe(2);
    expect(p.calls).toHaveLength(2);
  } finally {
    await d.delete();
  }
});
it('cancels paused batches without writing new messages and retains resume work', async () => {
  const d = await fixture();
  try {
    const j = await addJob(d, 'pause', 'chat');
    let release!: (v: any) => void, called!: () => void;
    const started = new Promise<void>((r) => (called = r));
    const p = {
      complete: async (m: ChatInput) => {
        called();
        await new Promise((r) => (release = r));
        return new FixtureProvider().complete(m);
      },
    };
    const work = drainContent('w-harbor', d, p);
    await started;
    await setRunning('w-harbor', false, 'live', d);
    release(undefined);
    await work;
    expect(await d.messages.filter((m) => m.id.startsWith(j.id + ':')).count()).toBe(0);
    expect((await d.contentJobs.get(j.id))?.status).not.toBe('complete');
    await d.checkpoints.update('w-harbor', { paused: false });
    await d.contentJobs.update(j.id, { nextAttemptAt: 0 });
    await drainAll(d, new FixtureProvider());
  } finally {
    await d.delete();
  }
});
it('bounds expansion, keeps the clock target and restores shared prompt snapshots', async () => {
  const d = await fixture();
  try {
    const j = await addJob(d, 'pressure', 'chat');
    await d.contentJobs.bulkPut(
      Array.from({ length: MAX_PENDING_CONTENT }, (_, i) => ({ ...j, id: 'pressure-' + i })),
    );
    const before = (await d.checkpoints.get('w-harbor'))!;
    await runWorld(
      'w-harbor',
      { now: NOW + DAY / 1000, foregroundSince: NOW, deferContent: true, dispatchContent: false },
      d,
    );
    expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(before.simTime);
    const n = await d.contentJobs.count();
    expect(n).toBe(MAX_PENDING_CONTENT + 1);
    const id = 'content:test';
    await d.taskSnapshots.put({ id, config: j.snapshot });
    await d.contentJobs.update(j.id, { snapshotId: id, snapshot: { ...j.snapshot, entries: [] } });
    const backup = validateBackup(await exportBackup(d));
    await importBackup(backup, d);
    expect(await d.taskSnapshots.get(id)).toBeDefined();
    expect(
      adaptiveLimits(299, true, 8192, { scale: 1, latencyMs: 0, successes: 0, failures: 0 })
        .maxTasks,
    ).toBe(1);
    expect(
      adaptiveLimits(300, true, 8192, { scale: 0.5, latencyMs: 0, successes: 0, failures: 1 })
        .maxTasks,
    ).toBe(2);
  } finally {
    await d.delete();
  }
});
it('batches a complex world with multiple groups and long in-person stages without changing outputs', async () => {
  const rows: any[] = [];
  for (const speed of [300, 1000, 3000])
    for (const enabled of [false, true]) {
      const d = await fixture(20, speed, enabled),
        p = new FixtureProvider();
      try {
        for (let i = 0; i < 8; i++) {
          await addJob(d, 'scene-' + i, 'scene', NOW + i * 3 * HOUR);
          await addJob(d, 'chat-' + i, 'chat', NOW + i * 3 * HOUR);
          if (i) await d.contentJobs.update('chat-' + i, { dependsOn: ['chat-' + (i - 1)] });
        }
        for (let i = 0; i < 4; i++) await addJob(d, 'life-' + i, 'life', NOW + i * 6 * HOUR);
        await d.checkpoints.update('w-harbor', { simTime: NOW + DAY });
        const plans = await d.contentJobs.toArray();
        const started = Date.now(),
          heap = process.memoryUsage().heapUsed;
        await drainAll(d, p);
        const performance = await measurements(d, started, heap, plans.length);
        const scenes = await d.scenes.toArray();
        expect(scenes).toHaveLength(8);
        expect(scenes.every((s) => s.phases.length === 3)).toBe(true);
        expect(
          scenes
            .flatMap((s) => s.phases.flatMap((p) => p.entries))
            .filter((e) => e.kind === 'dialogue'),
        ).toHaveLength(plans.reduce((n, j) => n + (j.plan?.expectedDialogue ?? 0), 0));
        expect(await d.messages.filter((m) => m.planVersion === 1).count()).toBe(24);
        const u = (await d.usage.toArray())[0];
        rows.push({
          ...performance,
          speed,
          enabled,
          requests: p.calls.length,
          input: u.inputTokens,
          output: u.outputTokens,
          phases: 24,
          messages: 24,
          dialogue: plans.reduce((n, j) => n + (j.plan?.expectedDialogue ?? 0), 0),
        });
      } finally {
        await d.delete();
      }
    }
  for (const speed of [300, 1000, 3000]) {
    const [a, b] = rows.filter((r) => r.speed === speed);
    expect(b.requests).toBeLessThan(a.requests * 0.65);
    expect(b.input).toBeLessThan(a.input);
  }
  console.log('Complex scene batching benchmark', JSON.stringify(rows));
  capture('complex', rows);
}, 90000);

it('isolates malformed children, preserves siblings and retries only the invalid task', async () => {
  const d = await fixture();
  try {
    await addJob(d, 'valid-child', 'life');
    await addJob(d, 'invalid-child', 'life');
    const p = new FixtureProvider();
    await drainContent('w-harbor', d, {
      complete: async (m: ChatInput) => {
        const r = await p.complete(m),
          v = JSON.parse(r.content);
        v.results.find((r: any) => r.taskId === 'invalid-child').result = { description: 123 };
        return { ...r, content: JSON.stringify(v) };
      },
    });
    expect((await d.contentJobs.get('valid-child'))?.status).toBe('complete');
    expect((await d.contentJobs.get('invalid-child'))?.status).toBe('failed');
    await d.contentJobs.update('invalid-child', { nextAttemptAt: 0 });
    await drainAll(d, p);
    expect(p.calls).toHaveLength(2);
  } finally {
    await d.delete();
  }
});
it('keeps valid later phases across backup while retrying a missing earlier phase', async () => {
  const d = await fixture();
  try {
    const j = await addJob(d, 'scene-recovery', 'scene');
    const p = new FixtureProvider();
    await drainContent('w-harbor', d, {
      complete: async (m: ChatInput) => {
        const r = await p.complete(m),
          v = JSON.parse(r.content);
        v.results = v.results.filter((_: unknown, i: number) => i !== 0);
        return { ...r, content: JSON.stringify(v) };
      },
    });
    const partial = await d.contentJobs.get(j.id);
    expect(Object.keys(partial?.partial?.phases ?? {})).toHaveLength(2);
    expect((await d.scenes.get('scene:' + j.event.id))?.phases).toHaveLength(0);
    await importBackup(validateBackup(await exportBackup(d)), d);
    await d.checkpoints.update('w-harbor', { paused: false, speed: 300 });
    await d.contentJobs.update(j.id, { nextAttemptAt: 0 });
    await drainAll(d, p);
    const scene = (await d.scenes.get('scene:' + j.event.id))!;
    expect(scene.phases).toHaveLength(3);
    expect(
      scene.phases.flatMap((p) => p.entries).filter((e) => e.kind === 'dialogue'),
    ).toHaveLength(j.plan!.expectedDialogue);
    // Backup deliberately clears the API profile, so the 2048-token fallback splits the missing phase.
    expect(p.calls).toHaveLength(3);
    for (const m of p.calls.slice(1))
      expect(JSON.parse(m[1].content).input.phase.id).toBe('scene:' + j.event.id + ':phase:0');
  } finally {
    await d.delete();
  }
});
it('resumes exhausted internal-budget jobs after unlimited usage is enabled', async () => {
  const d = await fixture();
  try {
    const j = await addJob(d, 'budget-resume', 'chat');
    await d.contentJobs.update(j.id, {
      status: 'failed',
      attempts: 3,
      errorCode: 'budget',
      nextAttemptAt: Date.now() + 60000,
    });
    await drainAll(d, new FixtureProvider());
    expect((await d.contentJobs.get(j.id))?.status).toBe('complete');
  } finally {
    await d.delete();
  }
});
it('never batches private conversations with different speakers or worlds', async () => {
  const d = await fixture();
  try {
    await addJob(d, 'private-a', 'chat');
    const b = await addJob(d, 'private-b', 'chat');
    await d.contentJobs.update(b.id, {
      speakerId: b.conversation!.participants.find((id) => id !== b.speakerId)!,
    });
    const c = await addJob(d, 'other-world', 'chat');
    await d.contentJobs.update(c.id, { worldId: 'w-other' });
    const p = new FixtureProvider();
    await drainContent('w-harbor', d, p);
    expect(p.calls).toHaveLength(1);
    expect(JSON.parse(p.calls[0][1].content).batchId).toBeUndefined();
    expect((await d.contentJobs.get(c.id))?.status).toBe('pending');
    expect(await d.contentJobs.filter((j) => j.status === 'complete').count()).toBe(1);
  } finally {
    await d.delete();
  }
});

function capture(kind: string, rows: unknown[]) {
  if (process.env.AQUARIUM_BENCHMARK_FILE)
    appendFileSync(process.env.AQUARIUM_BENCHMARK_FILE, JSON.stringify({ kind, rows }) + '\n');
}
async function measurements(d: AquariumDB, started: number, heap: number, backlogPeak: number) {
  const rows = (await d.taskLogs.filter((l) => l.task === 'adaptive-metric').toArray()).map((l) =>
    JSON.parse(l.detail!),
  );
  const percentile = (key: string) =>
    rows.map((r) => r[key]).sort((a, b) => a - b)[Math.max(0, Math.ceil(rows.length * 0.95) - 1)] ??
    0;
  const elapsedMs = Date.now() - started;
  return {
    elapsedMs,
    backlogPeak,
    meanWaitMs: Math.round(rows.reduce((n, r) => n + r.waitMs, 0) / Math.max(1, rows.length)),
    p95WaitMs: percentile('waitMs'),
    p95RequestMs: percentile('latencyMs'),
    completedJobsPerMinute: Math.round((backlogPeak * 60000) / Math.max(1, elapsedMs)),
    heapDeltaMiB: Math.round((process.memoryUsage().heapUsed - heap) / 1048576),
  };
}

it('forks pending dependency chains into an independent past timeline', async () => {
  const d = await fixture();
  try {
    const a = await addJob(d, 'fork-a', 'chat'),
      b = await addJob(d, 'fork-b', 'chat');
    await d.contentJobs.update(b.id, { dependsOn: [a.id] });
    await d.checkpoints.update('w-harbor', {
      paused: true,
      simTime: NOW + 3 * HOUR,
      timeMode: 'god',
    });
    const fork = await rewindWorld('w-harbor', NOW + 2 * HOUR, d);
    if (!fork) throw new Error('新时间线未创建');
    const jobs = await d.contentJobs.where('worldId').equals(fork).toArray();
    expect(jobs).toHaveLength(2);
    expect(
      jobs.flatMap((j) => j.dependsOn ?? []).every((id) => jobs.some((j) => j.id === id)),
    ).toBe(true);
    expect(jobs.every((j) => j.event.worldId === fork && j.conversation?.worldId === fork)).toBe(
      true,
    );
    await d.checkpoints.update(fork, { paused: false });
    const p = new FixtureProvider();
    for (let i = 0; i < 4; i++) await drainContent(fork, d, p);
    expect(
      await d.contentJobs
        .where('worldId')
        .equals(fork)
        .filter((j) => j.status === 'complete')
        .count(),
    ).toBe(2);
    expect(
      await d.messages.filter((m) => jobs.some((j) => m.id.startsWith(j.id + ':'))).count(),
    ).toBe(6);
    expect((await d.contentJobs.get(a.id))?.status).toBe('pending');
  } finally {
    await d.delete();
  }
});

it('preserves GIF bubble position when a later partial completes the planned message array', async () => {
  const d = await fixture();
  try {
    const j = await addJob(d, 'partial-gif', 'chat');
    const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), (c) =>
      c.charCodeAt(0),
    );
    const gif = await uploadGif(
      new Blob([bytes], { type: 'image/gif' }),
      { name: '开心', scopeType: 'world', scopeId: j.worldId, tags: [], description: '开心' },
      d,
    );
    await drainContent(j.worldId, d, {
      complete: async () => ({
        content: JSON.stringify({ speakerId: j.speakerId, messages: ['刚想起来了。'] }),
        inputTokens: 10,
        outputTokens: 10,
        estimated: true,
      }),
    });
    await drainContent(j.worldId, d, {
      complete: async () => ({
        content: JSON.stringify({
          speakerId: j.speakerId,
          messages: ['给你看看。', '是不是挺好玩。'],
          gifAssetId: gif.id,
        }),
        inputTokens: 10,
        outputTokens: 20,
        estimated: true,
      }),
    });
    const messages = await d.messages.filter((m) => m.id.startsWith(j.id + ':')).sortBy('seq');
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.gifAssetId)).toEqual([undefined, gif.id, undefined]);
    expect(messages.map((m) => m.messageType)).toEqual(['text', 'gif', 'text']);
  } finally {
    await d.delete();
  }
});
it('refuses duplicate result IDs without committing either ambiguous child', async () => {
  const d = await fixture();
  try {
    await addJob(d, 'dupe-a', 'life');
    await addJob(d, 'dupe-b', 'life');
    const p = new FixtureProvider();
    await drainContent('w-harbor', d, {
      complete: async (m) => {
        const r = await p.complete(m),
          v = JSON.parse(r.content);
        v.results = [
          v.results[0],
          v.results[0],
          { taskId: 'unknown-id', result: { description: '错误内容' } },
        ];
        return { ...r, content: JSON.stringify(v) };
      },
    });
    expect(await d.contentJobs.filter((j) => j.status === 'complete').count()).toBe(0);
    await d.contentJobs.toCollection().modify({ nextAttemptAt: 0 });
    await drainAll(d, p);
    expect(await d.contentJobs.filter((j) => j.status === 'complete').count()).toBe(2);
  } finally {
    await d.delete();
  }
});

it('resumes the same queued task after restoring a recycled participant', async () => {
  const d = await fixture();
  try {
    const j = await addJob(d, 'recycled-job', 'chat');
    const p = new FixtureProvider();
    await recycleEntity('characters', j.speakerId!, false, d);
    await drainContent(j.worldId, d, p);
    expect(p.calls).toHaveLength(0);
    expect((await d.contentJobs.get(j.id))?.status).not.toBe('complete');
    await recycleEntity('characters', j.speakerId!, true, d);
    await drainAll(d, p);
    expect((await d.contentJobs.get(j.id))?.status).toBe('complete');
  } finally {
    await d.delete();
  }
});
