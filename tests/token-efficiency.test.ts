import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed, newCharacter } from '../src/data/seed';
import { drainContent } from '../src/ai/content-queue';
import { defaultPrompts } from '../src/ai/prompts';
import { contentPlan } from '../src/core/adaptive-batching';
import { HOUR, type ContentJob, type ActivityEvent } from '../src/core/types';
import type { ChatInput, Provider } from '../src/ai/provider';
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
            result: output(t.contract ?? p.sharedContract, {
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

import { cachedMessages } from '../src/ai/model-policy';
import { batchEnvelope } from '../src/ai/batch-request';
// This entire comparison is offline: the hard paid-request budget is ZERO.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Paid/network request forbidden in token audit');
  });
});
afterEach(() => vi.unstubAllGlobals());
async function boundedDrain(d: AquariumDB, p: Provider) {
  expect(await d.characters.count()).toBeLessThanOrEqual(8);
  expect(await d.groups.count()).toBeLessThanOrEqual(2);
  const jobs = await d.contentJobs.toArray();
  expect(Math.max(...jobs.map((j) => j.event.end)) - NOW).toBeLessThanOrEqual(HOUR);
  for (let i = 0; i < 16; i++) {
    if (!(await d.contentJobs.filter((j) => j.status !== 'complete').count())) return;
    await drainContent('w-harbor', d, p);
  }
  throw new Error('Offline drain hard limit exceeded');
}
it('compares identical one-hour plans at normal speed without changing visible content', async () => {
  const rows: any[] = [];
  for (const enabled of [false, true]) {
    const d = await fixture(5, 1, enabled),
      p = new FixtureProvider();
    try {
      for (let i = 0; i < 4; i++) await addJob(d, 'life-' + i, 'life');
      for (let i = 0; i < 2; i++) await addJob(d, 'chat-' + i, 'chat');
      await addJob(d, 'scene', 'scene');
      await boundedDrain(d, p);
      const messages = (await d.messages.toArray()).filter((m) => m.planVersion === 1);
      const scenes = await d.scenes.toArray();
      const dialogue = scenes
        .flatMap((s) => s.phases.flatMap((p) => p.entries))
        .filter((e) => e.kind === 'dialogue');
      rows.push({
        enabled,
        requests: p.calls.length,
        input: p.calls.reduce((n, c) => n + Math.ceil(JSON.stringify(c).length / 2), 0),
        output: (await d.usage.toArray()).reduce((n, u) => n + u.outputTokens, 0),
        messages: messages.map((m) => [m.senderId, m.text, m.simAt, m.conversationId]).sort(),
        dialogue: dialogue.map((e) => [e.speakerId, e.text, e.at]),
        complete: await d.contentJobs.filter((j) => j.status === 'complete').count(),
      });
    } finally {
      await d.delete();
    }
  }
  expect(rows[1].requests).toBeLessThan(rows[0].requests);
  expect(rows[1].input).toBeLessThan(rows[0].input);
  expect(rows[1].messages).toEqual(rows[0].messages);
  expect(rows[1].dialogue).toEqual(rows[0].dialogue);
  expect(rows[1].complete).toBe(7);
  console.log(
    'OFFLINE_TOKEN_COMPARISON',
    JSON.stringify(
      rows.map((r) => ({ ...r, messages: r.messages.length, dialogue: r.dialogue.length })),
    ),
  );
});
it('retains good children and retries only a missing child at normal speed', async () => {
  const d = await fixture(5, 1),
    p = new FixtureProvider();
  try {
    await addJob(d, 'a', 'life');
    await addJob(d, 'b', 'life');
    await drainContent('w-harbor', d, {
      complete: async (m) => {
        const r = await p.complete(m),
          v = JSON.parse(r.content);
        v.results = v.results.slice(0, 1);
        return { ...r, content: JSON.stringify(v) };
      },
    });
    expect(await d.contentJobs.filter((j) => j.status === 'complete').count()).toBe(1);
    await d.contentJobs.filter((j) => j.status !== 'complete').modify({ nextAttemptAt: 0 });
    await boundedDrain(d, p);
    expect(p.calls).toHaveLength(2);
    expect(JSON.parse(p.calls[1][1].content).batchId).toBeUndefined();
  } finally {
    await d.delete();
  }
});
it('keeps shared facts and contracts ahead of volatile batch IDs on the wire', () => {
  const unit = (id: string) => ({
    id,
    privacy: 'same',
    at: NOW,
    createdAt: NOW,
    outputTokens: 200,
    request: [
      { role: 'system' as const, content: 'rules【不可覆盖的输出契约】\nJSON' },
      {
        role: 'user' as const,
        content: JSON.stringify({
          world: { name: 'world' },
          history: ['known fact'],
          state: { id },
        }),
      },
    ],
  });
  const a = batchEnvelope([unit('a'), unit('b')], 'first');
  const b = batchEnvelope([unit('c'), unit('d')], 'second');
  const parsed = JSON.parse(a[1].content);
  expect(parsed.sharedContract).toBe('\nJSON');
  expect(parsed.tasks.every((t: any) => !t.contract)).toBe(true);
  const wireA = cachedMessages(a)[1].content,
    wireB = cachedMessages(b)[1].content;
  expect(wireA.split('"batchId"')[0]).toBe(wireB.split('"batchId"')[0]);
  expect(wireA.indexOf('known fact')).toBeLessThan(wireA.indexOf('first'));
});
it('does not pool different speakers or execute a dependent job before its predecessor', async () => {
  const d = await fixture(5, 1),
    p = new FixtureProvider();
  try {
    const a = await addJob(d, 'private-a', 'chat');
    const b = await addJob(d, 'private-b', 'chat');
    await d.contentJobs.update(b.id, {
      speakerId: b.conversation!.participants.find((id) => id !== a.speakerId)!,
    });
    const c = await addJob(d, 'dependent', 'chat');
    await d.contentJobs.update(c.id, { dependsOn: [a.id] });
    await drainContent('w-harbor', d, p);
    expect(JSON.parse(p.calls[0][1].content).batchId).toBeUndefined();
    expect((await d.contentJobs.get(a.id))?.status).toBe('complete');
    expect((await d.contentJobs.get(b.id))?.status).toBe('pending');
    expect((await d.contentJobs.get(c.id))?.status).toBe('pending');
    await boundedDrain(d, p);
    expect(await d.messages.filter((m) => m.planVersion === 1).count()).toBe(9);
  } finally {
    await d.delete();
  }
});
