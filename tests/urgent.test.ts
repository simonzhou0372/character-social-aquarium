import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { runWorld, setRunning } from '../src/core/engine';
import { clockTarget } from '../src/core/time';
import { generateCreationDraft } from '../src/ai/drafts';
import { generateScene } from '../src/ai/scenes';
import { defaultPrompts } from '../src/ai/prompts';
import { MockProvider } from '../src/ai/provider';
import { HOUR, type ActivityEvent } from '../src/core/types';
let d: AquariumDB;
const now = Date.parse('2026-10-22T10:00:00Z');
beforeEach(async () => {
  d = new AquariumDB('urgent-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  await d.delete();
});
it('schedules events and advances presentation while AI waits sixty seconds', async () => {
  await d.checkpoints.update('w-harbor', { paused: false, mode: 'live', speed: 60 });
  await d.settings.update('app', { activity: 'lively', unlimitedUsage: true, sceneDailyBudget: 0 });
  let release!: (v: any) => void;
  let requested!: () => void;
  const started = new Promise<void>((r) => (requested = r));
  const provider = {
    async complete(messages: any) {
      requested();
      await new Promise<void>((r) => (release = r));
      const speaker = messages[0].content.match(/"speakerId":"([^"]+)"/)?.[1];
      return {
        content: JSON.stringify(
          speaker
            ? { speakerId: speaker, messages: ['稍后见。'] }
            : { description: '按原日程生活。' },
        ),
        inputTokens: 1,
        outputTokens: 1,
        estimated: false,
      };
    },
  };
  await runWorld('w-harbor', { now: now + HOUR, provider, deferContent: true, maxSegments: 1 }, d);
  await started;
  const cp = (await d.checkpoints.get('w-harbor'))!;
  expect(cp.simTime).toBeGreaterThan(now);
  expect(await d.events.where('worldId').equals('w-harbor').count()).toBeGreaterThan(5);
  expect(clockTarget(cp, now + 60000, now) - clockTarget(cp, now, now)).toBe(60 * 60000);
  await setRunning('w-harbor', false, 'live', d);
  release(undefined);
  await vi.waitFor(async () =>
    expect((await d.contentJobs.toArray()).every((j) => j.status !== 'running')).toBe(true),
  );
});
it('accepts five name-only characters and preserves complete objects from truncation', async () => {
  const p = new MockProvider({
    world: { name: '校园' },
    characters: Array.from({ length: 5 }, (_, i) => ({ name: '人物' + i })),
    groups: [],
  });
  const draft = await generateCreationDraft('world', {}, '五个性格不同的高中女生', [], d, p);
  expect(draft.characters).toHaveLength(5);
  expect(draft.characters[0].style).toBe('');
  const truncated = {
    async complete() {
      return {
        content: '{"characters":[{"name":"已完成"},{"name":"未结束',
        inputTokens: 1,
        outputTokens: 1,
        estimated: false,
        finishReason: 'length',
      };
    },
  };
  const partial = await generateCreationDraft('world', {}, '创建人物', [], d, truncated);
  expect(partial.characters[0].name).toBe('已完成');
  expect(partial.partial).toBe(true);
});
it('saves successful scene phases, treats dialogue target as soft and resumes only missing phases', async () => {
  const event: ActivityEvent = {
    id: 'scene-p0',
    worldId: 'w-harbor',
    start: now,
    end: now + HOUR,
    type: 'social',
    participants: ['c-nagi', 'c-mio'],
    location: '咖啡馆',
    description: '一起喝咖啡',
    phone: 0.1,
    status: 'completed',
  };
  await d.events.put(event);
  let calls = 0;
  const p = {
    async complete() {
      calls++;
      if (calls === 1)
        return {
          content: JSON.stringify({
            title: '咖啡店',
            phases: [
              { title: '入店', startOffset: 0, endOffset: 1800, participants: event.participants },
              {
                title: '交谈',
                startOffset: 1800,
                endOffset: 3600,
                participants: event.participants,
              },
            ],
          }),
          inputTokens: 1,
          outputTokens: 1,
          estimated: false,
        };
      if (calls === 3) throw new Error('网络中断');
      return {
        content: JSON.stringify({
          entries: Array.from({ length: 20 }, (_, i) => ({
            kind: 'dialogue',
            offset: i + 1,
            speakerId: event.participants[i % 2],
            text: '自然交流。',
          })),
        }),
        inputTokens: 1,
        outputTokens: 1,
        estimated: false,
      };
    },
  };
  const partial = await generateScene(d, event, defaultPrompts(), p);
  expect(partial.phases.length).toBeGreaterThan(0);
  expect((await d.scenes.get(partial.id))?.phases[0].entries).toHaveLength(20);
  expect(partial.generationStatus).toBe('partial');
  const resumed = await generateScene(
    d,
    event,
    defaultPrompts(),
    new MockProvider({
      entries: [{ kind: 'dialogue', offset: 1801, speakerId: 'c-mio', text: '回来了。' }],
    }),
  );
  expect(resumed.generationStatus).toBe('complete');
  expect(resumed.phases[0].entries).toHaveLength(20);
});
it('retains long multi-person scene output by splitting phases and long visible dialogue safely', async () => {
  const event: ActivityEvent = {
    id: 'long-scene',
    worldId: 'w-harbor',
    start: now,
    end: now + 2 * HOUR,
    type: 'social',
    participants: ['c-nagi', 'c-mio', 'c-toru'],
    location: '活动室',
    description: '一起完成小组活动',
    phone: 0.1,
    status: 'completed',
  };
  await d.events.put(event);
  const scene = await generateScene(
    d,
    event,
    defaultPrompts(),
    new MockProvider({
      title: '小组活动',
      phases: [
        {
          title: '讨论与整理',
          startOffset: 0,
          endOffset: 7200,
          participants: event.participants,
          entries: Array.from({ length: 80 }, (_, i) => ({
            kind: i % 4 === 0 ? 'activity' : 'dialogue',
            offset: i + 1,
            ...(i % 4 === 0 ? {} : { speakerId: event.participants[i % 3] }),
            text: i === 1 ? '很'.repeat(900) : '继续整理手边的材料。',
          })),
        },
      ],
    }),
  );
  expect(scene.generationStatus).toBe('complete');
  expect(scene.phases.length).toBeGreaterThan(1);
  const entries = scene.phases.flatMap((p) => p.entries);
  expect(entries.length).toBe(82);
  expect(
    entries
      .filter((e) => e.text.startsWith('很'))
      .map((e) => e.text)
      .join(''),
  ).toBe('很'.repeat(900));
  expect(
    entries.filter((e) => e.kind === 'dialogue').every((e) => Array.from(e.text).length <= 300),
  ).toBe(true);
});
