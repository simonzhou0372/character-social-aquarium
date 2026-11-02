import { it, expect, beforeEach, afterEach } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { runFastCatchUp } from '../src/core/fast-catch-up';
import { setFastCatchUp } from '../src/core/time';
import { MockProvider } from '../src/ai/provider';
import { HOUR, type ContentJob } from '../src/core/types';
import { defaultPrompts } from '../src/ai/prompts';
import { contentPlan } from '../src/core/adaptive-batching';

let d: AquariumDB;
const now = Date.parse('2026-10-22T10:00:00Z'),
  worldId = 'w-harbor';

beforeEach(async () => {
  d = new AquariumDB('fast-catch-up-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  await d.delete();
});

const output = {
  events: [
    {
      at: 10,
      duration: 40,
      participants: ['c-nagi', 'c-mio'],
      location: '白昼咖啡',
      type: 'social',
      description: '凪夏生和森川澪在白昼咖啡碰面，交换了最近拍的照片。',
      importance: 0.7,
    },
    {
      at: 75,
      duration: 30,
      participants: ['c-nagi'],
      location: '海滨步道',
      type: 'rest',
      description: '凪夏生沿着海滨步道慢慢走，画了几张速写。',
    },
  ],
  chats: [
    {
      at: 55,
      eventIndex: 0,
      participants: ['c-nagi', 'c-mio'],
      messages: [
        { speakerId: 'c-nagi', text: '照片洗出来了，晚点给你带一张。', offset: 0 },
        { speakerId: 'c-mio', text: '好，我留一杯咖啡给你。', offset: 30 },
      ],
    },
  ],
  scenes: [
    {
      eventIndex: 0,
      title: '咖啡店的下午',
      type: 'meal',
      phases: [
        {
          title: '碰面',
          entries: [
            { kind: 'dialogue', speakerId: 'c-nagi', text: '今天的海风很轻。' },
            { kind: 'dialogue', speakerId: 'c-mio', text: '所以适合坐窗边。' },
          ],
        },
      ],
    },
  ],
};

it('fills an entire jump with one agent request instead of the per-segment queue', async () => {
  await d.checkpoints.update(worldId, {
    paused: false,
    mode: 'live',
    simTime: now,
    realTime: now,
    clockAnchor: { simTime: now, realTime: now },
    recoveryStart: now,
    recoveryTarget: now + 2 * HOUR,
    recoveryRealTarget: now,
    jumpTarget: now + 2 * HOUR,
  });
  const stale: ContentJob = {
    id: 'stale-window-job',
    worldId,
    kind: 'life',
    event: {
      id: 'stale-event',
      worldId,
      type: 'rest',
      start: now + 30 * 60000,
      end: now + 60 * 60000,
      participants: ['c-nagi'],
      location: '家',
      description: '旧任务',
      phone: 0.5,
      status: 'completed',
    },
    at: now + 30 * 60000,
    snapshot: (await import('../src/ai/prompts')).defaultPrompts(now),
    recovery: true,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
  };
  await d.contentJobs.put(stale);
  const provider = new MockProvider(output);
  await runFastCatchUp(worldId, { provider, now: now + 1000 }, d);
  const cp = (await d.checkpoints.get(worldId))!;
  expect(provider.calls).toHaveLength(1);
  expect(cp.simTime).toBe(now + 2 * HOUR);
  expect(cp.recoveryTarget).toBeUndefined();
  expect(cp.jumpTarget).toBeUndefined();
  expect(cp.paused).toBe(false);
  expect((await d.contentJobs.get(stale.id))?.status).toBe('complete');
  const events = await d.events
    .where('worldId')
    .equals(worldId)
    .and((e) => e.origin === 'backfill')
    .toArray();
  expect(events).toHaveLength(2);
  const direct = (await d.conversations.get('conv-nm'))!;
  expect(direct.lastAt).toBeGreaterThan(now);
  const messages = await d.messages.where('conversationId').equals('conv-nm').sortBy('seq');
  expect(messages.slice(-2).map((m) => [m.senderId, m.text])).toEqual([
    ['c-nagi', '照片洗出来了，晚点给你带一张。'],
    ['c-mio', '好，我留一杯咖啡给你。'],
  ]);
  expect(messages.at(-1)!.seq).toBe(4);
  const scenes = await d.scenes.where('worldId').equals(worldId).toArray();
  expect(scenes).toHaveLength(1);
  expect(scenes[0].phases[0].entries).toHaveLength(2);
  expect(provider.calls[0][1].content).toContain('fastCatchUp');
});

it('toggles the per-world fast catch-up switch and preserves it in the checkpoint', async () => {
  await setFastCatchUp(worldId, true, d);
  expect((await d.checkpoints.get(worldId))?.fastCatchUp).toBe(true);
  await setFastCatchUp(worldId, false, d);
  expect((await d.checkpoints.get(worldId))?.fastCatchUp).toBe(false);
});

it('drains an existing backlog through the same fast path without waiting for foreground ticks', async () => {
  const snapshot = defaultPrompts(now);
  const event = {
    id: 'backlog-event',
    worldId,
    type: 'rest' as const,
    start: now,
    end: now + HOUR,
    participants: ['c-nagi'],
    location: '家',
    description: '旧的生活描述',
    phone: 0.8,
    status: 'completed' as const,
  };
  await d.events.put(event);
  const job: ContentJob = {
    id: 'backlog-life',
    worldId,
    kind: 'life',
    event,
    at: now + 1000,
    snapshot,
    recovery: true,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    plan: contentPlan('life', 42, snapshot, event),
  };
  await d.contentJobs.put(job);
  await d.checkpoints.update(worldId, {
    paused: false,
    mode: 'live',
    simTime: now + HOUR,
    realTime: now,
    clockAnchor: { simTime: now + HOUR, realTime: now },
    recoveryTarget: undefined,
  });
  const provider = new MockProvider({ description: '补全后的生活描述' });
  await runFastCatchUp(worldId, { provider, now: now + 1000 }, d);
  expect((await d.contentJobs.get(job.id))?.status).toBe('complete');
  expect((await d.events.get(event.id))?.description).toBe('补全后的生活描述');
});
