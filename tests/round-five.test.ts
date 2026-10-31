import { beforeEach, afterEach, it, expect } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import {
  createExpansion,
  runExpansion,
  acceptExpansion,
  possibleMatches,
} from '../src/ai/expansion';
import { MockProvider } from '../src/ai/provider';
import { defaultPrompts, composePrompt, savePrompt } from '../src/ai/prompts';
import { NovelSchema } from '../src/core/novel-types';
import { saveManagedWorld, applyStory } from '../src/core/novel';
import { DAY } from '../src/core/types';
import { importMembers, removeMember } from '../src/data/world-members';
import { resolveObservation, evolvedCharacter } from '../src/core/selective-observation';
import {
  buildTouhouPreset,
  ensureTouhouPresets,
  TOUHOU_WORLD_ID,
} from '../src/data/presets/touhou';
import {
  previewTouhouUpgrade,
  applyTouhouUpgrade,
  resetTouhouWorld,
} from '../src/data/presets/touhou-upgrade';
import { selectionChange } from '../src/components/MultiSelect';
import { exportBackup, validateBackup, importBackup } from '../src/data/backup';
import { generateMajor, applyMajor } from '../src/ai/major-events';
import { socialWeight } from '../src/core/simulation';
const now = Date.parse('2026-10-24T01:00:00Z'),
  w = 'w-harbor';
let d: AquariumDB;
beforeEach(async () => {
  d = new AquariumDB('five-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  await d.delete();
});
it('100-person selection preserves hidden choices and respects current-result inversion', () => {
  const all = Array.from({ length: 100 }, (_, i) => String(i));
  let ids = selectionChange(['99'], all.slice(0, 10), 'all');
  expect(ids).toHaveLength(11);
  ids = selectionChange(ids, all.slice(0, 5), 'invert');
  expect(ids).toHaveLength(6);
  expect(ids).toContain('99');
  expect(selectionChange(ids, all, 'none')).toEqual([]);
});
it('recognizes translated and Japanese aliases but requires confirmation to resolve them', () => {
  expect(possibleMatches('Reimu Hakurei', [], [{ id: 'a', name: '博丽灵梦' }])).toHaveLength(1);
  expect(
    possibleMatches('Alice Margatroid', [], [{ id: 'b', name: '爱丽丝·玛格特洛依德' }]),
  ).toHaveLength(1);
});
it('generates twenty additions in four bounded batches with a persistent prompt snapshot', async () => {
  let i = 0;
  const p = new MockProvider();
  p.complete = async (messages) => {
    p.calls.push(messages);
    const rows = Array.from({ length: 5 }, () => ({ name: '新成员' + ++i }));
    return {
      content: JSON.stringify({ characters: rows, groups: [] }),
      inputTokens: 20,
      outputTokens: 20,
      estimated: false,
    };
  };
  const j = await createExpansion(w, '增加20名原创学生', 20, d);
  await savePrompt(d, 'expansion', '后续新任务的新提示词', true);
  await runExpansion(j.id, d, p);
  expect(p.calls).toHaveLength(4);
  expect(p.calls.every((c) => c[0].content.includes('严格读取已有结构'))).toBe(true);
  expect((await d.expansionJobs.get(j.id))?.characters).toHaveLength(20);
  const cp = await d.checkpoints.get(w),
    messageCount = await d.messages.count();
  expect(await d.characters.count()).toBe(5);
  await acceptExpansion(j.id, d);
  expect(await d.characters.count()).toBe(25);
  expect(await d.checkpoints.get(w)).toEqual(cp);
  expect(await d.messages.count()).toBe(messageCount);
  await expect(acceptExpansion(j.id, d)).rejects.toThrow();
});
it('retains successful batches on failure, restores through backup, and resumes the remaining count', async () => {
  let call = 0;
  const p = new MockProvider();
  p.complete = async () => {
    if (++call === 2) throw new Error('网络断开');
    return {
      content: JSON.stringify({
        characters: Array.from({ length: 5 }, (_, i) => ({ name: '一期' + i })),
        groups: [],
      }),
      inputTokens: 10,
      outputTokens: 20,
      estimated: false,
    };
  };
  const j = await createExpansion(w, '添加10名学生', 10, d);
  await runExpansion(j.id, d, p);
  expect((await d.expansionJobs.get(j.id))?.characters).toHaveLength(5);
  const backup = validateBackup(await exportBackup(d));
  await importBackup(backup, d);
  await runExpansion(
    j.id,
    d,
    new MockProvider({
      characters: Array.from({ length: 5 }, (_, i) => ({ name: '二期' + i })),
      groups: [],
    }),
  );
  expect((await d.expansionJobs.get(j.id))?.characters).toHaveLength(10);
});
it('validates duplicate decisions and rolls back the whole expansion for illegal group references', async () => {
  const j = await createExpansion(w, '增加', 1, d);
  await d.expansionJobs.update(j.id, {
    characters: [
      {
        name: '凪 夏生',
        source: '原创',
        bio: '',
        style: '',
        personality: '',
        habits: '',
        aliases: [],
      },
    ],
    groups: [],
  });
  await expect(acceptExpansion(j.id, d)).rejects.toThrow('可能重复');
  await d.expansionJobs.update(j.id, {
    decisions: { '0': { action: 'use', characterId: 'c-nagi' } },
    groups: [{ name: '新团体', description: '', memberNames: ['凪 夏生', '无此人'] }],
  });
  await expect(acceptExpansion(j.id, d)).rejects.toThrow('未确认成员');
  expect(await d.characters.count()).toBe(5);
  expect((await d.expansionJobs.get(j.id))?.status).not.toBe('applied');
});
it('same global ID can join two worlds and archive from one without cascading', async () => {
  const world = (await d.worlds.get(w))!;
  await d.worlds.add({ ...world, id: 'w2' });
  await importMembers('w2', ['c-nagi', 'c-nagi'], d);
  await removeMember('w2', 'c-nagi', d);
  expect((await resolveObservation('w2', d)).activeIds.has('c-nagi')).toBe(false);
  expect((await resolveObservation(w, d)).activeIds.has('c-nagi')).toBe(true);
  expect(await d.characters.get('c-nagi')).toBeDefined();
  await importMembers('w2', ['c-nagi'], d);
  expect((await resolveObservation('w2', d)).activeIds.has('c-nagi')).toBe(true);
});
it('novel goal is mandatory and forces dependencies; disabling restores old choices', async () => {
  expect(NovelSchema.safeParse({ enabled: true, goal: '   ' }).success).toBe(false);
  const world = (await d.worlds.get(w))!;
  await saveManagedWorld(
    { ...world, novel: NovelSchema.parse({ enabled: true, goal: '让乐队重返舞台' }) },
    d,
  );
  let next = (await d.worlds.get(w))!;
  expect(next.evolutionSettings?.enabled).toBe(true);
  expect(next.majorEventSettings?.enabled).toBe(true);
  expect(await d.majorSchedules.get(w)).toBeDefined();
  await saveManagedWorld({ ...next, novel: { ...next.novel!, enabled: false } }, d);
  next = (await d.worlds.get(w))!;
  expect(next.evolutionSettings).toEqual(world.evolutionSettings);
  expect(next.majorEventSettings).toEqual(world.majorEventSettings);
});
it('director cannot skip phases, accept fabricated evidence, or end at the first event', async () => {
  const world = (await d.worlds.get(w))!;
  await saveManagedWorld(
    { ...world, novel: NovelSchema.parse({ enabled: true, goal: '重返舞台' }) },
    d,
  );
  await d.majorEvents.add({
    id: 'm1',
    eventId: 'e1',
    worldId: w,
    title: '排练',
    timestamp: now,
    participantIds: ['c-nagi'],
    groupIds: [],
    importance: 0.9,
    status: 'occurred',
    type: 'project',
    description: '决定先进行合奏练习',
    consequences: [],
  });
  const proposal = {
    stage: 'completed' as const,
    conditions: [
      {
        id: 'one',
        description: '已共同练习',
        evidence: [{ eventId: 'fake', quote: '凭空完成的演出' }],
      },
      { id: 'two', description: '已登台', evidence: [] },
    ],
    unresolved: ['舞台尚未准备'],
    milestone: '决定练习',
    ending: '突然成功',
  };
  await applyStory(w, 'e1', proposal, d);
  const n = (await d.worlds.get(w))?.novel;
  expect(n?.stage).toBe('development');
  expect(n?.ending).toBeUndefined();
  expect(n?.conditions[0].evidence).toEqual([]);
  await applyStory(w, 'e1', proposal, d);
  expect((await d.worlds.get(w))?.novel?.milestones).toHaveLength(1);
});
it('actual major generation invokes only the director task and commits a fact-backed story node', async () => {
  const world = (await d.worlds.get(w))!;
  await saveManagedWorld(
    { ...world, novel: NovelSchema.parse({ enabled: true, goal: '完成合奏' }) },
    d,
  );
  const event = {
    id: 'ev',
    worldId: w,
    start: now,
    end: now + 60000,
    type: 'major' as const,
    status: 'completed' as const,
    location: '练习室',
    participants: ['c-nagi'],
    phone: 0.9,
    description: '计划',
    importance: 0.9,
  };
  await d.events.add(event);
  await d.checkpoints.update(w, { simTime: now + 60000 });
  await d.majorEvents.add({
    id: 'ev',
    eventId: 'ev',
    worldId: w,
    title: '计划',
    description: '计划',
    timestamp: now,
    participantIds: ['c-nagi'],
    groupIds: [],
    importance: 0.9,
    status: 'contentPending',
    type: 'project',
    consequences: [],
  });
  const provider = new MockProvider({
    title: '新的练习',
    description: '约定明天开始合奏练习',
    followUp: '明天确认乐谱',
    story: {
      stage: 'development',
      conditions: [
        { id: 'a', description: '完成练习', evidence: [] },
        { id: 'b', description: '正式演出', evidence: [] },
      ],
      unresolved: ['未练习'],
      milestone: '约定了练习',
    },
  });
  const job: any = { id: 'j', worldId: w, event, snapshot: defaultPrompts(now) };
  const result = await generateMajor(d, job, provider);
  await applyMajor(d, job, result!);
  expect((await d.worlds.get(w))?.novel?.milestones[0].eventId).toBe('ev');
  expect(provider.calls[0][0].content).toContain('小说剧情导演');
  expect(provider.calls[0][0].content).not.toContain('角色行为与语言规范');
});
it('calibration differentiates all five requested pairs and preserves known facts', () => {
  const p = buildTouhouPreset(false, now);
  const edge = (from: string, to: string) =>
    p.relationships.find((r) => r.from === 'th:' + from && r.to === 'th:' + to)!;
  expect(edge('reimu', 'marisa').familiarity).toBeGreaterThan(90);
  expect(edge('remilia', 'sakuya').trust).toBeGreaterThan(85);
  expect(edge('remilia', 'patchouli').attitude).toContain('不是');
  expect(edge('marisa', 'alice').behavior!.competition).toBeGreaterThan(0.5);
  const c = (key: string) => p.characters.find((c) => c.id === 'th:' + key)!;
  expect(c('cirno').initiative).toBeGreaterThan(c('luna').initiative);
  expect(new Set(p.relationships.map((r) => r.closeness)).size).toBeGreaterThan(4);
  expect(p.characters.every((c) => !!c.socialBehavior)).toBe(true);
  expect(c('kisume').topicIntervalMinutes).toBeGreaterThan(c('marisa').topicIntervalMinutes!);
});
it('preset field updates protect user overrides and locks, and apply only within one world', async () => {
  await ensureTouhouPresets(d, now);
  const baseline = buildTouhouPreset(false, now, 1);
  await d.characters.put(baseline.characters.find((c) => c.id === 'th:marisa')!);
  await d.characters.update('th:reimu', { style: '用户专属口吻' });
  await d.relationships.bulkPut(baseline.relationships);
  const rows = await previewTouhouUpgrade(TOUHOU_WORLD_ID, d);
  expect(
    rows.filter((r) => r.kind === 'relationship' && r.field !== 'missing').every((r) => r.blocked),
  ).toBe(true);
  expect(rows.find((r) => r.id === 'th:reimu' && r.field === 'style')?.blocked).toBe(true);
  await applyTouhouUpgrade(
    TOUHOU_WORLD_ID,
    rows.map((r) => `${r.id}:${r.field}`),
    false,
    d,
  );
  expect((await d.characters.get('th:marisa'))?.initiative).toBe(0.5);
  const m = await d.memberships
    .where('[worldId+characterId]')
    .equals([TOUHOU_WORLD_ID, 'th:marisa'])
    .first();
  expect(evolvedCharacter((await d.characters.get('th:marisa'))!, m).initiative).toBe(0.82);
});
it('explicit Touhou reset removes old history but preserves unrelated worlds and global identities', async () => {
  await ensureTouhouPresets(d, now);
  await importMembers(w, ['th:reimu'], d);
  await d.characters.update('th:reimu', { style: '其他世界使用的全局风格' });
  const count = await d.messages.count();
  const oldEvent = (await d.events.toArray())[0];
  await d.events.put({
    ...oldEvent,
    id: 'old-touhou-history',
    worldId: TOUHOU_WORLD_ID,
    participants: ['th:reimu'],
  });
  await resetTouhouWorld(TOUHOU_WORLD_ID, d, now + DAY);
  expect(await d.messages.count()).toBe(count);
  expect(await d.events.get('old-touhou-history')).toBeUndefined();
  expect(await d.events.get(oldEvent.id)).toBeDefined();
  expect((await d.worlds.get(TOUHOU_WORLD_ID))?.presetVersion).toBe(3);
  expect((await d.checkpoints.get(TOUHOU_WORLD_ID))?.paused).toBe(true);
  expect((await d.characters.get('th:reimu'))?.style).toBe('其他世界使用的全局风格');
  validateBackup(await exportBackup(d));
});
it('reaches a supported ending across four actual event nodes and archives progress when setting a new goal', async () => {
  const world = (await d.worlds.get(w))!;
  await saveManagedWorld(
    { ...world, novel: NovelSchema.parse({ enabled: true, goal: '完成共同演出' }) },
    d,
  );
  for (let i = 0; i < 4; i++) {
    const at = now + i * DAY,
      eventId = 'story-' + i,
      description =
        i === 0 ? '共同完成第一次排练' : i === 1 ? '共同完成第二次排练' : '一起完成了正式演出';
    await d.checkpoints.update(w, { simTime: at });
    await d.majorEvents.add({
      id: eventId,
      eventId,
      worldId: w,
      title: '推进',
      timestamp: at,
      participantIds: ['c-nagi'],
      groupIds: [],
      importance: 0.9,
      status: 'occurred',
      type: 'project',
      description,
      consequences: [],
    });
    const evidence = Array.from({ length: i + 1 }, (_, k) => ({
      eventId: 'story-' + k,
      quote: k === 0 ? '共同完成第一次排练' : k === 1 ? '共同完成第二次排练' : '一起完成了正式演出',
    }));
    await applyStory(
      w,
      eventId,
      {
        stage: 'completed',
        conditions: [
          {
            id: 'practice',
            description: '成员已有共同排练过程',
            evidence: evidence.filter((e) => e.eventId === 'story-0' || e.eventId === 'story-1'),
          },
          {
            id: 'stage',
            description: '成员完成共同演出',
            evidence: evidence.filter((e) => e.eventId === 'story-2' || e.eventId === 'story-3'),
          },
        ],
        unresolved: [],
        milestone: description,
        ending: '共同排练之后完成了演出。',
      },
      d,
    );
  }
  let latest = (await d.worlds.get(w))!;
  expect(latest.novel?.stage).toBe('completed');
  expect(latest.novel?.ending?.eventIds).toHaveLength(4);
  await saveManagedWorld({ ...latest, novel: { ...latest.novel!, goal: '准备下一场巡演' } }, d);
  latest = (await d.worlds.get(w))!;
  expect(latest.novel?.stage).toBe('foundation');
  expect(latest.novelHistory?.[0].ending?.text).toContain('完成了演出');
  expect(await d.majorEvents.count()).toBe(4);
});
it.each([
  ['reimu', 'marisa'],
  ['remilia', 'sakuya'],
  ['remilia', 'patchouli'],
  ['marisa', 'alice'],
  ['cirno', 'luna'],
])(
  'dialogue requests include calibrated personal behavior and directed relationships: %s → %s',
  async (from, to) => {
    await ensureTouhouPresets(d, now);
    const { generateDialogue } = await import('../src/ai/orchestrator');
    const c = {
      id: 'test-pair',
      worldId: TOUHOU_WORLD_ID,
      name: '对话验收',
      kind: 'direct' as const,
      participants: ['th:' + from, 'th:' + to],
      createdAt: now,
      lastAt: 0,
    };
    const provider = new MockProvider({
      speakerId: 'th:' + from,
      messages: ['先看看眼前的事情。'],
    });
    await generateDialogue(d, c, 'th:' + from, now, defaultPrompts(now), provider);
    const context = JSON.parse(provider.calls[0][1].content);
    expect(context.character.socialBehavior.familiar.length).toBeGreaterThan(0);
    if (from !== 'cirno') {
      expect(context.relationships[0].familiarity).toBeGreaterThan(80);
      expect(context.relationships[0].behavior).toBeDefined();
    }
    expect(provider.calls[0][0].content).toContain('熟悉度高时');
    expect(provider.calls[0][0].content).not.toContain('小说剧情导演');
  },
);
it('v11 migration preserves existing messages and leaves old worlds in ordinary mode', async () => {
  const { default: Dexie } = await import('dexie');
  const name = 'legacy-five-' + crypto.randomUUID(),
    legacy = new Dexie(name);
  const stores = Object.fromEntries(
    d.tables
      .filter((t) => t.name !== 'expansionJobs')
      .map((t) => [
        t.name,
        [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(','),
      ]),
  );
  legacy.version(11).stores(stores);
  await legacy.open();
  const world = (await d.worlds.get(w))!;
  await legacy.table('worlds').put(world);
  const message = (await d.messages.toArray())[0];
  const oldSettings = (await d.settings.get('app'))!;
  await legacy.table('messages').put(message);
  await legacy.table('settings').put({ ...oldSettings, activity: 'lively' });
  legacy.close();
  const upgraded = new AquariumDB(name);
  await upgraded.open();
  expect(upgraded.verno).toBe(17);
  expect((await upgraded.worlds.get(w))?.novel).toBeUndefined();
  expect(await upgraded.messages.get(message.id)).toEqual(message);
  expect((await upgraded.settings.get('app'))?.activity).toBe('lively');
  expect((await upgraded.settings.get('app'))?.uiMode).toBe('game');
  expect(await upgraded.expansionJobs.count()).toBe(0);
  await upgraded.delete();
});
it('a date branch starts narrative evidence fresh and leaves the original ending intact', async () => {
  const { startCalendarBranch } = await import('../src/core/time');
  const world = (await d.worlds.get(w))!;
  await saveManagedWorld(
    {
      ...world,
      novel: NovelSchema.parse({
        enabled: true,
        goal: '完成演出',
        stage: 'completed',
        conditions: [],
        milestones: [{ eventId: 'past', summary: '旧故事完成' }],
        ending: { text: '旧结尾', eventIds: ['past'], at: now },
      }),
    },
    d,
  );
  const id = await startCalendarBranch(w, { year: 325, month: 4, day: 12, hour: 10, minute: 0 }, d);
  expect((await d.worlds.get(id))?.novel?.milestones).toEqual([]);
  expect((await d.worlds.get(id))?.novel?.stage).toBe('foundation');
  expect((await d.worlds.get(w))?.novel?.ending?.text).toBe('旧结尾');
});

it('rejoining a removed world member through a group reactivates the same association after confirmation', async () => {
  const { saveGroupMembers } = await import('../src/data/worlds');
  const group = (await d.groups.toArray())[0];
  const members = await d.groupMembers.where('groupId').equals(group.id).toArray();
  const ids = members.filter((m) => m.worldId === w).map((m) => m.characterId);
  expect(ids.length).toBeGreaterThanOrEqual(2);
  const original = await d.memberships.where('[worldId+characterId]').equals([w, ids[0]]).first();
  await removeMember(w, ids[0], d);
  await expect(saveGroupMembers(group, w, ids, [], [], [], d)).rejects.toThrow('请确认');
  await saveGroupMembers(group, w, ids, [], [], [ids[0]], d);
  const restored = await d.memberships.where('[worldId+characterId]').equals([w, ids[0]]).toArray();
  expect(restored).toHaveLength(1);
  expect(restored[0].id).toBe(original!.id);
  expect(restored[0].inactive).toBe(false);
});
it('saving an already-open world editor preserves newer director progress', async () => {
  await saveManagedWorld(
    { ...(await d.worlds.get(w))!, novel: NovelSchema.parse({ enabled: true, goal: '完成演出' }) },
    d,
  );
  const editor = (await d.worlds.get(w))!;
  await d.worlds.update(w, {
    novel: {
      ...editor.novel!,
      stage: 'development',
      milestones: [{ eventId: 'latest', summary: '新节点' }],
    },
  });
  await saveManagedWorld({ ...editor, name: '新名称' }, d);
  expect((await d.worlds.get(w))?.novel?.milestones[0].eventId).toBe('latest');
  expect((await d.worlds.get(w))?.novel?.stage).toBe('development');
});

it('ending suggestions include bounded world groups, relations and effective character facts', async () => {
  const { novelGoalFacts } = await import('../src/ai/novel-context');
  const m = (await d.memberships.where('[worldId+characterId]').equals([w, 'c-nagi']).first())!;
  await d.memberships.update(m.id, {
    bioOverride: '当前世界的专属身份',
    evolved: { personality: '经历后的新倾向' },
  });
  await removeMember(w, 'c-ritsu', d);
  const facts = await novelGoalFacts(d, w);
  expect(facts.groups.length).toBeGreaterThan(0);
  expect(facts.relationships.length).toBeGreaterThan(0);
  expect(facts.characters.find((c) => c.id === 'c-nagi')).toMatchObject({
    bio: '当前世界的专属身份',
    personality: '经历后的新倾向',
  });
  expect(facts.characters.some((c) => c.id === 'c-ritsu')).toBe(false);
  expect(facts.relationships.some((r) => r.from === 'c-ritsu' || r.to === 'c-ritsu')).toBe(false);
});
