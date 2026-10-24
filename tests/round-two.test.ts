import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Dexie from 'dexie';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import {
  addMinutes,
  dayOrdinal,
  fromOrdinal,
  worldTime,
  calendarTick,
  formatWorldTime,
  realLocalDate,
  WorldDateTimeSchema,
  daysInMonth,
} from '../src/core/calendar';
import {
  CharacterSchema,
  HOUR,
  DAY,
  type ActivityEvent,
  type InPersonScene,
} from '../src/core/types';
import { clockTarget, configureTime, startCalendarBranch } from '../src/core/time';
import { runWorld, setRunning, createDirect } from '../src/core/engine';
import { createWorld, exportWorld, importWorld, saveGroupMembers } from '../src/data/worlds';
import { exportBackup, importBackup, validateBackup } from '../src/data/backup';
import { budgetedCompletion, dialogueContext, knownBackground } from '../src/ai/orchestrator';
import { MockProvider, type ChatInput } from '../src/ai/provider';
import { generateScene, validateScene } from '../src/ai/scenes';
import {
  defaultPrompts,
  getPrompts,
  savePrompt,
  PromptConfigSchema,
  composePrompt,
} from '../src/ai/prompts';
import { filterScenes, timelineMatches, mergeRoutine } from '../src/core/observation';
const now = Date.parse('2026-10-22T00:00:00Z');
let d: AquariumDB;
beforeEach(async () => {
  d = new AquariumDB('round2-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  vi.useRealTimers();
  await d.delete();
});
const fictional = (year: number) => ({ year, month: 12, day: 31, hour: 23, minute: 59 });
function sceneEvent(): ActivityEvent {
  return {
    id: 'shared',
    worldId: 'w-harbor',
    type: 'social',
    start: now,
    end: now + HOUR,
    participants: ['c-nagi', 'c-mio'],
    location: '白昼咖啡',
    description: '两人一起喝咖啡',
    phone: 0.08,
    status: 'completed',
  };
}
function sceneOutput(event: ActivityEvent) {
  const duration = (event.end - event.start) / 1000;
  return {
    title: '一起喝咖啡',
    phases: [
      {
        title: '入店',
        startOffset: 0,
        endOffset: duration / 2,
        participants: event.participants,
        entries: [
          { kind: 'activity', offset: 1, text: '找到了靠窗的位置。' },
          { kind: 'dialogue', offset: 2, speakerId: event.participants[0], text: '坐这里吧。' },
          { kind: 'dialogue', offset: 3, speakerId: event.participants[1], text: '好。' },
        ],
      },
      {
        title: '交谈',
        startOffset: duration / 2,
        endOffset: duration,
        participants: event.participants,
        entries: [
          { kind: 'activity', offset: duration / 2 + 1, text: '喝完饮品，准备离开。' },
          {
            kind: 'dialogue',
            offset: duration / 2 + 2,
            speakerId: event.participants[0],
            text: '风好像小了。',
          },
        ],
      },
    ],
  };
}
function provider() {
  const calls: ChatInput[] = [];
  return {
    calls,
    async complete(messages: ChatInput) {
      calls.push(messages);
      const context = JSON.parse(messages[1].content);
      const scene = messages[0].content.includes('【线下互动生成】');
      const speaker = messages[0].content.match(/"speakerId":"([^"]+)"/)?.[1];
      return {
        content: JSON.stringify(
          scene
            ? sceneOutput(context.input.event)
            : speaker
              ? { speakerId: speaker, messages: ['刚忙完。', '待会见。'], offsets: [0, 3] }
              : { description: '按计划活动。' },
        ),
        inputTokens: 10,
        outputTokens: 30,
        estimated: false,
      };
    },
  };
}
describe('integer fictional calendar', () => {
  it.each([30, 2026, 23456, 325, 999999])(
    'round trips year %i independently of browser Date',
    async (year) => {
      const date = fictional(year),
        old = (await d.worlds.get('w-harbor'))!;
      const id = 'year-' + year;
      await createWorld(
        {
          ...old,
          id,
          era: year === 325 ? '帝国历' : year === 999999 ? '星历' : 'AD',
          initialDate: date,
        },
        ['c-nagi'],
        [],
        [],
        [],
        d,
      );
      const w = (await d.worlds.get(id))!,
        cp = (await d.checkpoints.get(id))!;
      expect(worldTime(w, cp.simTime)).toEqual(date);
      expect(calendarTick(w, date)).toBe(cp.simTime);
      expect(formatWorldTime(w, cp.simTime)).toContain(String(year));
      expect(cp.simTime).toBeGreaterThan(now);
      validateBackup(await exportBackup(d));
    },
  );
  it('handles leap days, month/year transitions and bounds', () => {
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(addMinutes({ year: 30, month: 12, day: 31, hour: 23, minute: 59 }, 1)).toEqual({
      year: 31,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    });
    expect(addMinutes({ year: 23456, month: 2, day: 28, hour: 23, minute: 59 }, 1).day).toBe(29);
    expect(() =>
      WorldDateTimeSchema.parse({ year: 325, month: 2, day: 29, hour: 0, minute: 0 }),
    ).toThrow();
    expect(() => addMinutes(fictional(999999), 1)).toThrow();
    for (const year of [1, 30, 325, 1900, 2000, 23456, 999999]) {
      const date = { year, month: 6, day: 15, hour: 0, minute: 0 };
      expect(fromOrdinal(dayOrdinal(date))).toEqual(date);
    }
  });
  it('changes era without moving progress, and branches arbitrary dates without fabricated catchup', async () => {
    await d.worlds.update('w-harbor', { era: '帝国历' });
    expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(now);
    const oldCount = await d.events.count();
    const id = await startCalendarBranch(
      'w-harbor',
      { year: 30, month: 1, day: 1, hour: 12, minute: 30 },
      d,
    );
    const world = (await d.worlds.get(id))!,
      cp = (await d.checkpoints.get(id))!;
    expect(worldTime(world, cp.simTime).year).toBe(30);
    expect(cp.paused).toBe(true);
    expect(await d.events.where('worldId').equals(id).count()).toBe(0);
    expect(await d.events.count()).toBe(oldCount);
    expect(
      (await d.memberships.where('worldId').equals(id).toArray()).map((m) => m.characterId),
    ).toContain('c-nagi');
    validateBackup(await exportBackup(d));
  });
});
describe('pause, speed anchors and independent worlds', () => {
  it.each(['god', 'real'] as const)('never catches up paused time in %s mode', async (timeMode) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    await d.checkpoints.update('w-harbor', { timeMode, paused: false });
    await setRunning('w-harbor', false, 'demo', d);
    vi.setSystemTime(now + DAY);
    await runWorld('w-harbor', { now: now + DAY }, d);
    const frozen = (await d.checkpoints.get('w-harbor'))!;
    expect(clockTarget(frozen, now + DAY)).toBe(now);
    await setRunning('w-harbor', true, 'demo', d);
    expect(clockTarget((await d.checkpoints.get('w-harbor'))!, now + DAY)).toBe(now);
  });
  it('preserves elapsed old-rate work while changing only the chosen world', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const w = (await d.worlds.get('w-harbor'))!;
    await createWorld({ ...w, id: 'second' }, ['c-nagi'], [], [], [], d);
    await d.checkpoints.update('w-harbor', { paused: false, speed: 5 });
    vi.setSystemTime(now + HOUR);
    await configureTime('w-harbor', 'god', 60, d);
    expect((await d.checkpoints.get('w-harbor'))?.speed).toBe(60);
    expect((await d.checkpoints.get('second'))?.speed).toBe(30);
  });
  it('discards an in-flight response when paused, retaining the checkpoint', async () => {
    await d.checkpoints.update('w-harbor', { paused: false, mode: 'live' });
    await d.settings.update('app', { activity: 'lively', sceneDailyBudget: 0 });
    let started!: () => void;
    const waiting = new Promise<void>((r) => (started = r));
    let release!: (v: any) => void;
    const blocked = {
      async complete() {
        started();
        return new Promise<any>((r) => (release = r));
      },
    };
    const task = runWorld('w-harbor', { now: now + HOUR, provider: blocked }, d);
    await waiting;
    await setRunning('w-harbor', false, 'live', d);
    release({
      content: '{"speakerId":"c-nagi","messages":["迟来的内容"]}',
      inputTokens: 1,
      outputTokens: 1,
      estimated: false,
    });
    await task.catch(() => {});
    expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(now);
    expect((await d.messages.toArray()).some((m) => m.text === '迟来的内容')).toBe(false);
  });
});
describe('gender, background identities and knowledge access', () => {
  it.each(['男性', 'nonbinary', '星族第三性', ''])(
    'preserves free gender %s in saves and prompts',
    async (gender) => {
      const c = CharacterSchema.parse({ ...(await d.characters.get('c-nagi')), gender });
      await d.characters.put(c);
      expect(
        (await dialogueContext(d, (await d.conversations.get('conv-cafe'))!, 'c-nagi', now))
          .character.gender,
      ).toBe(gender);
      const backup = validateBackup(await exportBackup(d));
      expect(backup.characters.find((c) => c.id === 'c-nagi')?.gender).toBe(gender);
    },
  );
  it('excludes background entities from simulation and restores the same ID on upgrade', async () => {
    await d.characters.update('c-nagi', { entityMode: 'background' });
    await d.backgroundKnowledge.put({
      id: 'k',
      worldId: 'w-harbor',
      entityId: 'c-nagi',
      characterId: 'c-mio',
      level: 'partial',
      items: [{ kind: 'falseRumor', content: '听说要退团', source: '朋友转述' }],
    });
    expect(await knownBackground(d, 'w-harbor', 'c-toru')).toEqual([]);
    expect((await knownBackground(d, 'w-harbor', 'c-mio'))[0].information[0].kind).toBe('rumor');
    await expect(createDirect('w-harbor', 'c-nagi', 'c-mio', d)).rejects.toThrow('背景');
    await d.checkpoints.update('w-harbor', { paused: false });
    await runWorld('w-harbor', { now: now + DAY }, d);
    expect(
      (await d.events.where('worldId').equals('w-harbor').toArray())
        .filter((e) => e.start >= now)
        .every((e) => !e.participants.includes('c-nagi')),
    ).toBe(true);
    await d.characters.update('c-nagi', { entityMode: 'interactive' });
    expect(await d.backgroundKnowledge.get('k')).toBeDefined();
    expect(await d.characters.get('c-nagi')).toBeDefined();
    const pkg = await exportWorld('w-harbor', d);
    const id = (await importWorld(pkg, d))!;
    expect(await d.backgroundKnowledge.where('worldId').equals(id).count()).toBe(1);
  });
  it('background groups need no members and create no chat', async () => {
    await saveGroupMembers(
      {
        id: 'rumor-group',
        name: '传闻乐队',
        description: '世界背景',
        worldIds: ['w-harbor'],
        color: '#d9ef69',
        entityMode: 'background',
      },
      'w-harbor',
      [],
      [],
      [],
      [],
      d,
    );
    expect(await d.conversations.where('groupId').equals('rumor-group').count()).toBe(0);
  });
});
describe('in-person generation and archives', () => {
  it('creates phases with independent dialogue limits and references the shared fact', async () => {
    const event = sceneEvent();
    await d.events.add(event);
    const p = provider(),
      snapshot = defaultPrompts();
    const scene = await generateScene(d, event, snapshot, p, true);
    expect(scene.phases).toHaveLength(2);
    expect(
      scene.phases.flatMap((p) => p.entries).filter((e) => e.kind === 'dialogue'),
    ).toHaveLength(3);
    expect(p.calls[0][0].content).toContain('离线时间补全');
    expect(p.calls[0][0].content).toContain('线下互动生成');
    await d.scenes.put(scene);
    validateBackup(await exportBackup(d));
    await importBackup(await exportBackup(d), d);
    expect((await d.scenes.get(scene.id))?.phases).toHaveLength(2);
  });
  it('rejects illegal speakers, time ranges, markdown, excessive length and duplicated phases', async () => {
    const event = sceneEvent(),
      scene = await generateScene(d, event, defaultPrompts(), provider());
    const mutate = (fn: (s: InPersonScene) => void) => {
      const copy = structuredClone(scene);
      fn(copy);
      expect(() => validateScene(copy, event)).toThrow();
    };
    mutate((s) => {
      s.phases[0].entries[1].speakerId = 'outsider';
    });
    mutate((s) => {
      s.phases[0].entries[1].at = event.end + 1;
    });
    mutate((s) => {
      s.phases[0].entries[1].text = '**加粗**';
    });
    mutate((s) => {
      s.phases[0].entries[1].text = '*斜体*';
    });
    mutate((s) => {
      s.phases[0].entries[1].text = '希望对你有所帮助';
    });
    mutate((s) => {
      s.phases[0].entries[1].text = '长'.repeat(301);
    });
    mutate((s) => {
      s.phases.push(s.phases[0]);
    });
  });
  it('filters any/all characters, worlds, groups, time ranges and locations', async () => {
    const scene = await generateScene(d, sceneEvent(), defaultPrompts(), provider());
    const other = {
      ...scene,
      id: 'other',
      worldId: 'other-world',
      participants: ['c-nagi', 'c-toru'],
      start: now + DAY,
      end: now + DAY + HOUR,
    };
    expect(
      filterScenes([scene, other], { participants: ['c-nagi', 'c-mio'], match: 'all' }),
    ).toHaveLength(1);
    expect(
      filterScenes([scene, other], { participants: ['c-nagi', 'c-mio'], match: 'any' })[0].id,
    ).toBe('other');
    expect(
      filterScenes([scene, other], {
        worldId: 'w-harbor',
        from: now,
        to: now + HOUR,
        groupMembers: ['c-mio'],
        location: scene.location,
        type: 'social',
      }),
    ).toHaveLength(1);
    expect(filterScenes([scene], { from: now + DAY })).toHaveLength(0);
    expect(filterScenes([scene], { groupMembers: [] })).toHaveLength(0);
  });
  it('keeps shared events, scene and memory aligned in the real engine', async () => {
    await d.settings.update('app', {
      activity: 'lively',
      unlimitedUsage: true,
      sceneFrequency: 1,
      sceneDailyBudget: 3,
    });
    await d.checkpoints.update('w-harbor', { paused: false, mode: 'live' });
    await runWorld('w-harbor', { now: now + DAY, provider: provider() }, d);
    const scenes = await d.scenes.toArray();
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.length).toBeLessThanOrEqual(6);
    for (const scene of scenes) {
      const event = (await d.events.get(scene.eventId))!;
      validateScene(scene, event);
      const memory = await d.memories.get(`memory:${event.id}`);
      expect(memory?.owners).toEqual(scene.participants);
    }
    validateBackup(await exportBackup(d));
  }, 15000);
});
describe('observation noise and app usage limits', () => {
  it('hides routine states without deleting them and merges contiguous background intervals', () => {
    const routine = {
      ...sceneEvent(),
      id: 'sleep',
      type: 'sleep' as const,
      participants: ['c-nagi'],
      description: '普通睡眠',
    };
    expect(timelineMatches(routine, 'featured')).toBe(false);
    expect(timelineMatches(routine, 'all')).toBe(true);
    expect(timelineMatches(routine, 'featured', true)).toBe(true);
    expect(timelineMatches({ ...routine, description: '失眠后联系朋友' }, 'featured')).toBe(true);
    const merged = mergeRoutine([
      routine,
      { ...routine, id: 'later', start: routine.end, end: routine.end + HOUR },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].end).toBe(routine.end + HOUR);
    expect(routine.end).toBe(now + HOUR);
  });
  it('unlimited mode bypasses app totals immediately and restores the retained limit when off', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await d.settings.update('app', { dailyRequests: 1, dailyTokens: 1000 });
    await d.usage.put({
      id: day,
      day,
      requests: 100,
      inputTokens: 10000,
      outputTokens: 10000,
      messages: 200,
      estimated: false,
    });
    const p = new MockProvider({ ok: true }),
      snap = defaultPrompts(),
      messages = composePrompt('profile', snap, { input: '测试' }, '返回 JSON');
    await expect(
      budgetedCompletion(d, p, messages, 'w-harbor', 'profile', snap),
    ).rejects.toMatchObject({ code: 'budget' });
    await d.settings.update('app', { unlimitedUsage: true });
    await budgetedCompletion(d, p, messages, 'w-harbor', 'profile', snap);
    await d.settings.update('app', { unlimitedUsage: false });
    await expect(
      budgetedCompletion(d, p, messages, 'w-harbor', 'profile', snap),
    ).rejects.toMatchObject({ code: 'budget' });
    expect((await d.settings.get('app'))?.dailyRequests).toBe(1);
    expect((await d.usage.get(day))?.requests).toBe(101);
    await d.settings.update('app', { unlimitedUsage: true });
    await expect(
      budgetedCompletion(d, new MockProvider({}, 'rate'), messages, 'w-harbor', 'profile', snap),
    ).rejects.toMatchObject({ code: 'rate' });
  });
  it('adds the scene prompt without replacing custom old entries', async () => {
    const snap = defaultPrompts();
    snap.entries = snap.entries.filter((e) => e.key !== 'inPerson');
    snap.entries[0].content = '用户专属规范';
    snap.entries[0].customized = true;
    await d.promptConfigs.put(snap);
    const migrated = await getPrompts(d);
    expect(migrated.entries).toHaveLength(10);
    expect(migrated.entries[0].content).toBe('用户专属规范');
    expect(PromptConfigSchema.parse(snap).entries).toHaveLength(10);
    await savePrompt(d, 'inPerson', '新的线下规范', true);
    expect((await getPrompts(d)).entries.find((e) => e.key === 'inPerson')?.content).toBe(
      '新的线下规范',
    );
  });
  it('preserves the user avatar through backup while identities remain distinct', async () => {
    const avatar = 'data:image/webp;base64,VGVzdA==';
    await d.settings.update('app', { userAvatar: avatar });
    const saved = await exportBackup(d);
    await importBackup(saved, d);
    expect((await d.settings.get('app'))?.userAvatar).toBe(avatar);
    expect((await d.characters.get('c-nagi'))?.avatar).not.toBe(avatar);
  });
  it('upgrades a version 5 database without losing histories or existing custom prompts', async () => {
    const name = 'legacy-' + crypto.randomUUID();
    const legacy = new Dexie(name);
    const stores = Object.fromEntries(
      d.tables
        .filter((t) => !['scenes', 'backgroundKnowledge'].includes(t.name))
        .map((t) => [
          t.name,
          [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(','),
        ]),
    );
    legacy.version(5).stores(stores);
    await legacy.open();
    const backup = await exportBackup(d);
    for (const table of ['characters', 'worlds', 'checkpoints', 'settings', 'messages'] as const) {
      const rows = structuredClone(backup[table]);
      if (table === 'worlds')
        for (const w of rows as any[]) {
          delete w.calendarAnchor;
          delete w.era;
          delete w.initialDate;
        }
      await legacy.table(table).bulkAdd(rows);
    }
    legacy.close();
    const migrated = new AquariumDB(name);
    try {
      await migrated.open();
      expect(await migrated.messages.count()).toBe(backup.messages.length);
      expect((await migrated.worlds.get('w-harbor'))?.era).toBe('AD');
      expect((await migrated.checkpoints.get('w-harbor'))?.simTime).toBe(now);
      expect((await migrated.characters.get('c-nagi'))?.gender).toBe('');
      expect((await migrated.settings.get('app'))?.unlimitedUsage).toBe(false);
    } finally {
      await migrated.delete();
    }
  });
});

describe('bounded concurrency and scoped rumor propagation', () => {
  it('copies only spoken knowledge to actual listeners and records its source', async () => {
    const { recordHeardInformation } = await import('../src/data/knowledge');
    await d.backgroundKnowledge.put({
      id: 'known',
      worldId: 'w-harbor',
      entityId: 'c-toru',
      characterId: 'c-nagi',
      level: 'partial',
      items: [
        { kind: 'rumor', content: '可能将离开书店', source: '朋友转述' },
        { kind: 'fact', content: '私下的住址是秘密', source: '本人' },
      ],
    });
    await recordHeardInformation(
      d,
      'w-harbor',
      'c-nagi',
      '白石 透可能将离开书店',
      ['c-mio'],
      '私聊中已读的消息 123',
    );
    const heard = await d.backgroundKnowledge.where('characterId').equals('c-mio').first();
    expect(heard?.items).toEqual([
      { kind: 'rumor', content: '可能将离开书店', source: '私聊中已读的消息 123' },
    ]);
    expect(await d.backgroundKnowledge.where('characterId').equals('c-yuna').count()).toBe(0);
    await recordHeardInformation(
      d,
      'w-harbor',
      'c-nagi',
      '白石 透可能将离开书店',
      ['c-mio'],
      '另一条相同消息',
    );
    expect((await d.backgroundKnowledge.get(heard!.id))?.items).toHaveLength(1);
  });
  it('keeps at most two provider calls active and removes cancelled queue entries', async () => {
    const { withAISlot } = await import('../src/ai/concurrency');
    let running = 0,
      maximum = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const job = async () => {
      running++;
      maximum = Math.max(maximum, running);
      await barrier;
      running--;
      return true;
    };
    const first = withAISlot(job),
      second = withAISlot(job),
      controller = new AbortController();
    const third = withAISlot(job, controller.signal);
    const rejected = expect(third).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await rejected;
    release();
    await Promise.all([first, second]);
    expect(maximum).toBe(2);
    expect(await withAISlot(async () => 42)).toBe(42);
  });
});

it('stops safely at the maximum calendar date instead of crashing or rolling into year 1000000', async () => {
  const { calendarLimit } = await import('../src/core/calendar');
  const world = (await d.worlds.get('w-harbor'))!;
  await createWorld(
    {
      ...world,
      id: 'last-year',
      initialDate: { year: 999999, month: 12, day: 31, hour: 23, minute: 58 },
    },
    ['c-nagi'],
    [],
    [],
    [],
    d,
  );
  const w = (await d.worlds.get('last-year'))!,
    cp = (await d.checkpoints.get('last-year'))!;
  await d.checkpoints.update('last-year', { paused: false });
  await runWorld('last-year', { now: cp.realTime + HOUR }, d);
  const stopped = (await d.checkpoints.get('last-year'))!;
  expect(stopped.simTime).toBe(calendarLimit(w));
  expect(stopped.paused).toBe(true);
  expect(worldTime(w, stopped.simTime)).toEqual({
    year: 999999,
    month: 12,
    day: 31,
    hour: 23,
    minute: 59,
  });
});
it('isolates scene memories by owner and omits future private information', async () => {
  const event = sceneEvent();
  await d.memories.put({
    id: 'private-scene-test',
    worldId: 'w-harbor',
    owners: ['c-nagi'],
    content: '只有夏生知道的约定',
    keywords: [],
    importance: 1,
    at: now - 1,
    kind: 'episode',
  });
  await d.memories.put({
    id: 'future-scene-test',
    worldId: 'w-harbor',
    owners: ['c-mio'],
    content: '未来才发生的事',
    keywords: [],
    importance: 1,
    at: now + DAY,
    kind: 'episode',
  });
  const p = provider();
  await generateScene(d, event, defaultPrompts(), p);
  const context = JSON.parse(p.calls[0][1].content);
  const actors = context.input.actors;
  expect(
    actors
      .find((a: any) => a.id === 'c-nagi')
      .privateMemories.some((m: any) => m.content === '只有夏生知道的约定'),
  ).toBe(true);
  expect(
    actors
      .find((a: any) => a.id === 'c-mio')
      .privateMemories.some((m: any) => m.content === '只有夏生知道的约定'),
  ).toBe(false);
  expect(p.calls[0][1].content).not.toContain('未来才发生的事');
});
