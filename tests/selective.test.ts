import { it, expect, beforeEach, afterEach } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed, newCharacter } from '../src/data/seed';
import { DAY, HOUR, uid, type ActivityEvent } from '../src/core/types';
import {
  resolveObservation,
  saveObservation,
  fullObservation,
  observationKeys,
} from '../src/core/selective-observation';
import { runWorld } from '../src/core/engine';
import { processBackfill, setBackfillPaused } from '../src/core/backfill';
import { applyEvolution, revertEvolution, evaluateEvolution } from '../src/core/evolution';
import {
  reportPeriod,
  archiveReports,
  generateReport,
  configureReports,
} from '../src/core/reports';
import { emptyReports } from '../src/core/focus-types';
import { calendarTick } from '../src/core/calendar';
import { dialogueContext } from '../src/ai/orchestrator';
import { MockProvider } from '../src/ai/provider';
import { exportBackup, validateBackup, importBackup } from '../src/data/backup';
import { getPrompts, savePrompt, composePrompt } from '../src/ai/prompts';
import { dormantInfluence } from '../src/core/dormant-influence';
import { planSegment } from '../src/core/simulation';
let d: AquariumDB;
const now = Date.parse('2026-10-22T10:00:00Z'),
  worldId = 'w-harbor';
beforeEach(async () => {
  d = new AquariumDB('selective-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  await d.delete();
});
const config = (
  characterIds: string[] = [],
  groupIds: string[] = [],
  pairs: [string, string][] = [],
) =>
  (() => ({
    ...fullObservation(worldId),
    mode: 'selective' as const,
    characterIds,
    groupIds,
    pairs,
    updatedAt: Date.now(),
  }))();
it('old worlds remain full observation with evolution and all reports disabled', async () => {
  const scope = await resolveObservation(worldId, d),
    world = (await d.worlds.get(worldId))!;
  expect(scope.config.mode).toBe('full');
  expect(scope.activeIds.size).toBe(5);
  expect(world.evolutionSettings?.enabled ?? false).toBe(false);
  expect(Object.values(world.reportSettings ?? emptyReports).some(Boolean)).toBe(false);
  validateBackup(await exportBackup(d));
});
it('deduplicates overlapping roles / group / CP and does not activate private social networks', async () => {
  await saveObservation(config(['c-nagi'], ['g-band'], [['c-mio', 'c-ritsu']]), d);
  const s = await resolveObservation(worldId, d);
  expect(s.activeIds.size).toBe(new Set([...s.activeIds]).size);
  expect(s.allowsConversation({ kind: 'direct', participants: ['c-mio', 'c-ritsu'] } as any)).toBe(
    true,
  );
  expect(s.allowsConversation({ kind: 'direct', participants: ['c-mio', 'c-toru'] } as any)).toBe(
    false,
  );
  expect(
    s.allowsConversation({
      kind: 'group',
      groupId: 'g-band',
      participants: ['c-mio', 'c-toru'],
    } as any),
  ).toBe(true);
});
it('does not cascade activation through A-B-C-D relations', async () => {
  await saveObservation(config(['c-nagi']), d);
  const s = await resolveObservation(worldId, d);
  expect([...s.activeIds]).toEqual(['c-nagi']);
  await d.checkpoints.update(worldId, { paused: false });
  await runWorld(worldId, { now: now + HOUR, maxSegments: 100 }, d);
  expect(
    (await d.events.where('worldId').equals(worldId).toArray())
      .filter((e) => e.start >= now)
      .every((e) => e.participants.includes('c-nagi')),
  ).toBe(true);
  expect((await resolveObservation(worldId, d)).activeIds.size).toBe(1);
});
it('backfills a full 72 virtual hours, persists chunk progress, pauses and never duplicates on re-observation', async () => {
  await saveObservation(config([]), d);
  await d.checkpoints.update(worldId, { simTime: now + 5 * DAY, paused: false });
  const id = await saveObservation(config(['c-nagi']), d);
  expect(id).toBeTruthy();
  let job = (await d.backfillJobs.get(id!))!;
  expect(job.end - job.start).toBe(3 * DAY);
  await processBackfill(worldId, d);
  job = (await d.backfillJobs.get(id!))!;
  expect(job.checkpoint).toBe(job.start + DAY);
  expect(job.status).not.toBe('complete');
  await setBackfillPaused(id!, true, d);
  await processBackfill(worldId, d);
  expect((await d.backfillJobs.get(id!))?.checkpoint).toBe(job.checkpoint);
  await setBackfillPaused(id!, false, d);
  await processBackfill(worldId, d);
  await processBackfill(worldId, d);
  expect((await d.backfillJobs.get(id!))?.status).toBe('complete');
  const count = await d.events.count();
  await saveObservation(config([]), d);
  await saveObservation(config(['c-nagi']), d);
  await processBackfill(worldId, d);
  expect(await d.events.count()).toBe(count);
  validateBackup(await exportBackup(d));
});
it('does not backfill before story creation and respects previously occupied locations and intervals', async () => {
  await saveObservation(config([]), d);
  await d.checkpoints.update(worldId, { simTime: now + DAY, paused: false });
  const occupied: ActivityEvent = {
    id: 'existing-shared',
    worldId,
    type: 'social',
    start: now,
    end: now + DAY,
    participants: ['c-nagi', 'c-mio'],
    location: '唯一已确认地点',
    description: '已有共同活动',
    phone: 0.1,
    status: 'completed',
  };
  await d.events.put(occupied);
  const id = await saveObservation(config(['c-nagi']), d);
  expect((await d.backfillJobs.get(id!))?.start).toBe(now);
  await processBackfill(worldId, d);
  const all = await d.events.where('worldId').equals(worldId).toArray();
  expect(all.filter((e) => e.origin === 'backfill')).toHaveLength(0);
  expect((await d.events.get(occupied.id))?.description).toBe(occupied.description);
  expect((await d.backfillJobs.get(id!))?.status).toBe('complete');
});
it('keeps failed AI backfill content visibly incomplete even after all calendar intervals were checked', async () => {
  await saveObservation(config([]), d);
  await d.checkpoints.update(worldId, { simTime: now + 3 * DAY, paused: false, mode: 'live' });
  const id = await saveObservation(config(['c-nagi']), d);
  for (let i = 0; i < 3; i++) await processBackfill(worldId, d);
  const job = (await d.backfillJobs.get(id!))!;
  expect(job.checkpoint).toBe(job.end);
  expect(job.status).toBe('waiting');
  expect(job.contentJobIds.length).toBeGreaterThan(0);
  await d.contentJobs.bulkPut(
    (await d.contentJobs.toArray()).map((j) => ({ ...j, status: 'failed', error: '测试限额不足' })),
  );
  await processBackfill(worldId, d);
  expect((await d.backfillJobs.get(id!))?.status).toBe('waiting');
});
async function evidence(characterId = 'c-nagi') {
  const events: ActivityEvent[] = Array.from({ length: 3 }, (_, i) => ({
    id: 'evidence-' + i,
    worldId,
    type: 'social',
    start: now + i * DAY,
    end: now + i * DAY + HOUR,
    participants: [characterId, 'c-mio'],
    location: '活动室',
    description: '持续合作完成重要任务',
    phone: 0.1,
    status: 'completed',
    importance: 0.8,
  }));
  await d.events.bulkPut(events);
  await d.checkpoints.update(worldId, { simTime: now + 8 * DAY });
  return events;
}
it('evolves only world-local allowed fields and leaves the global profile and other worlds intact', async () => {
  const events = await evidence(),
    m = (await d.memberships.where('[worldId+characterId]').equals([worldId, 'c-nagi']).first())!,
    c = (await d.characters.get('c-nagi'))!;
  const other = { ...(await d.worlds.get(worldId))!, id: 'other-world' };
  await d.worlds.put(other);
  await d.memberships.put({ ...m, id: 'other-member', worldId: other.id });
  await d.worlds.update(worldId, { evolutionSettings: { enabled: true, rules: '缓慢变化' } });
  await d.memberships.update(m.id, { evolutionFields: ['initiative'] });
  await applyEvolution(
    worldId,
    {
      characterId: c.id,
      field: 'initiative',
      newValue: c.initiative + 0.03,
      sourceEventIds: events.map((e) => e.id),
      reason: '长期合作',
    },
    d,
  );
  expect((await d.memberships.get(m.id))?.evolved?.initiative).toBeCloseTo(c.initiative + 0.03);
  expect((await d.memberships.get('other-member'))?.evolved).toBeUndefined();
  expect(await d.characters.get(c.id)).toEqual(c);
  validateBackup(await exportBackup(d));
});
it('rejects locked / core / disabled / excessive evolution and cancades dependent undo safely', async () => {
  const events = await evidence(),
    m = (await d.memberships.where('[worldId+characterId]').equals([worldId, 'c-nagi']).first())!,
    c = (await d.characters.get('c-nagi'))!;
  const proposal = {
    characterId: c.id,
    field: 'initiative',
    newValue: c.initiative + 0.03,
    sourceEventIds: events.map((e) => e.id),
    reason: '合作经历',
  };
  await expect(applyEvolution(worldId, proposal, d)).rejects.toThrow('关闭');
  await d.worlds.update(worldId, { evolutionSettings: { enabled: true, rules: '' } });
  await expect(applyEvolution(worldId, proposal, d)).rejects.toThrow('锁定');
  await d.memberships.update(m.id, { evolutionFields: ['initiative'] });
  await expect(
    applyEvolution(worldId, { ...proposal, field: 'name', newValue: '改名' }, d),
  ).rejects.toThrow();
  await expect(
    applyEvolution(worldId, { ...proposal, newValue: c.initiative + 0.2 }, d),
  ).rejects.toThrow('0.05');
  const first = await applyEvolution(worldId, proposal, d);
  const secondEvent = {
    ...events[0],
    id: 'later-major',
    start: now + 4 * DAY,
    end: now + 4 * DAY + HOUR,
    importance: 0.95,
  };
  await d.events.put(secondEvent);
  await applyEvolution(
    worldId,
    { ...proposal, newValue: c.initiative + 0.05, sourceEventIds: [secondEvent.id] },
    d,
  );
  await expect(revertEvolution(first!, false, d)).rejects.toThrow('依赖');
  await revertEvolution(first!, true, d);
  expect((await d.memberships.get(m.id))?.evolved?.initiative).toBe(c.initiative);
  expect((await d.evolutionRecords.toArray()).every((r) => r.status === 'reverted')).toBe(true);
});
it('performs evidence-driven low-frequency evolution and keeps emotional state separate', async () => {
  await evidence();
  const m = (await d.memberships
    .where('[worldId+characterId]')
    .equals([worldId, 'c-nagi'])
    .first())!;
  await d.memberships.update(m.id, { evolutionFields: ['initiative'] });
  await d.worlds.update(worldId, { evolutionSettings: { enabled: true, rules: '' } });
  await d.checkpoints.update(worldId, { paused: false, simTime: now + 8 * DAY });
  await evaluateEvolution(worldId, d);
  expect(await d.evolutionRecords.count()).toBe(1);
  await evaluateEvolution(worldId, d);
  expect(await d.evolutionRecords.count()).toBe(1);
});
it.each([30, 2026, 23456, 999999])(
  'calculates fictional report boundaries in year %s without browser Date parsing',
  async (year) => {
    const world = {
      ...(await d.worlds.get(worldId))!,
      calendarAnchor: { tick: now, date: { year, month: 12, day: 31, hour: 0, minute: 0 } },
    };
    for (const type of ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const) {
      const p = reportPeriod(world, type, now);
      expect(p.start).toBeLessThanOrEqual(now);
      expect(p.end).toBeGreaterThan(now);
      expect(Number.isSafeInteger(p.end)).toBe(true);
    }
  },
);
it('archives leap-day / month / quarter / year boundaries exactly once and respects pause', async () => {
  const world = (await d.worlds.get(worldId))!;
  world.calendarAnchor = {
    tick: now,
    date: { year: 23456, month: 12, day: 30, hour: 0, minute: 0 },
  };
  await d.worlds.put(world);
  await d.worlds.update(worldId, {
    reportSettings: { daily: true, weekly: true, monthly: true, quarterly: true, yearly: true },
  });
  await d.checkpoints.update(worldId, { paused: false, simTime: now + 4 * DAY, speed: 20 });
  await archiveReports(worldId, d);
  const reports = await d.worldReports.toArray();
  expect(reports.filter((r) => r.type === 'daily')).toHaveLength(4);
  expect(reports.some((r) => r.type === 'yearly')).toBe(true);
  await archiveReports(worldId, d);
  expect(await d.worldReports.count()).toBe(reports.length);
  await d.checkpoints.update(worldId, { paused: true, simTime: now + 40 * DAY });
  await archiveReports(worldId, d);
  expect(await d.worldReports.count()).toBe(reports.length);
  const leap = {
    ...world,
    calendarAnchor: { tick: now, date: { year: 2024, month: 2, day: 28, hour: 0, minute: 0 } },
  };
  expect(reportPeriod(leap, 'monthly', now).end - now).toBe(2 * DAY);
});
it('report queues are lazy, reference only actual facts and do not generate new life events', async () => {
  const events = await evidence();
  await d.worlds.update(worldId, { reportSettings: { ...emptyReports, weekly: true } });
  await d.checkpoints.update(worldId, { paused: false, simTime: now + 15 * DAY });
  await archiveReports(worldId, d);
  const report = (await d.worldReports.toArray())[0];
  const count = await d.events.count();
  await generateReport(report.id, d);
  const ready = (await d.worldReports.get(report.id))!;
  expect(ready.status).toBe('ready');
  expect(
    ready.sources.filter((s) => s.type === 'event').every((s) => events.some((e) => e.id === s.id)),
  ).toBe(true);
  expect(await d.events.count()).toBe(count);
  await expect(
    generateReport(
      report.id,
      d,
      new MockProvider({ sections: [{ heading: '重要事件', sourceIds: ['invented'] }] }),
    ),
  ).rejects.toThrow('不存在');
  expect(await d.events.count()).toBe(count);
});
it('adds report prompt without replacing custom chat rules and excludes dialogue Markdown bans from reports', async () => {
  await savePrompt(d, 'behavior', '不允许Markdown，私人约定不能泄露', true);
  const prompts = await getPrompts(d);
  expect(prompts.entries.some((e) => e.key === 'report')).toBe(true);
  const system = composePrompt('report', prompts, {}, '仅选择事实ID')[0].content;
  expect(system).toContain('观察记录员');
  expect(system).not.toContain('私人约定不能泄露');
  expect((await getPrompts(d)).entries.find((e) => e.key === 'behavior')?.content).toContain(
    '私人约定',
  );
});
it('hundreds of dormant entities do not add detailed events or social scheduling work', async () => {
  const chars = Array.from({ length: 100 }, (_, i) => ({
    ...newCharacter('测试人物' + i),
    id: 'large-' + i,
  }));
  await d.characters.bulkPut(chars);
  await d.memberships.bulkPut(
    chars.map((c) => ({
      id: 'm-' + c.id,
      worldId,
      characterId: c.id,
      identity: '',
      bioOverride: '',
      styleOverride: '',
    })),
  );
  for (let i = 0; i < 10; i++) {
    await d.groups.put({
      id: 'large-group-' + i,
      name: '测试团体' + i,
      description: '',
      color: '#abcdef',
      worldIds: [worldId],
    });
    await d.groupMembers.bulkPut(
      chars.slice(i * 10, (i + 1) * 10).map((c) => ({
        id: 'gm-' + c.id,
        worldId,
        groupId: 'large-group-' + i,
        characterId: c.id,
        nickname: '',
        role: '成员',
      })),
    );
  }
  await saveObservation(
    config(
      chars.slice(0, 5).map((c) => c.id),
      ['large-group-0'],
    ),
    d,
  );
  await d.checkpoints.update(worldId, { paused: false });
  await runWorld(worldId, { now: now + 6 * HOUR, maxSegments: 100 }, d);
  const events = await d.events
    .where('worldId')
    .equals(worldId)
    .and((e) => e.start >= now)
    .toArray();
  expect(events.length).toBeLessThan(200);
  expect(
    events.every((e) => e.participants.every((id) => chars.slice(0, 10).some((c) => c.id === id))),
  ).toBe(true);
  const focusedCount = events.length;
  await d.events
    .where('worldId')
    .equals(worldId)
    .and((e) => e.start >= now)
    .delete();
  await d.checkpoints.update(worldId, {
    simTime: now,
    realTime: now,
    clockAnchor: { simTime: now, realTime: now },
    seed: 42,
  });
  await saveObservation({ ...fullObservation(worldId), updatedAt: Date.now() }, d);
  await runWorld(worldId, { now: now + 6 * HOUR, maxSegments: 100 }, d);
  expect(
    await d.events
      .where('worldId')
      .equals(worldId)
      .and((e) => e.start >= now)
      .count(),
  ).toBeGreaterThan(focusedCount * 5);
}, 60000);
it('all new configurations and archives survive complete backup round-trip', async () => {
  await saveObservation(config(['c-nagi']), d);
  await d.worlds.update(worldId, { reportSettings: { ...emptyReports, daily: true } });
  await d.checkpoints.update(worldId, { simTime: now + DAY, paused: false });
  await archiveReports(worldId, d);
  const backup = await exportBackup(d);
  validateBackup(backup);
  await importBackup(backup, d);
  expect((await resolveObservation(worldId, d)).config.mode).toBe('selective');
  expect(await d.worldReports.count()).toBeGreaterThan(0);
  expect((await d.checkpoints.get(worldId))?.paused).toBe(true);
});
it('samples a necessary first-hop dormant influence without promoting the dormant character or its friends', async () => {
  await saveObservation(config(['c-nagi']), d);
  await d.events.clear();
  const world = (await d.worlds.get(worldId))!;
  let day = 20;
  const { dayOrdinal } = await import('../src/core/calendar');
  while (dayOrdinal({ year: 2026, month: 10, day }) % 4 !== 0) day++;
  world.calendarAnchor = { tick: now, date: { year: 2026, month: 10, day, hour: 17, minute: 45 } };
  await d.worlds.put(world);
  const cp = (await d.checkpoints.get(worldId))!,
    scope = await resolveObservation(worldId, d),
    actor = (await d.characters.get('c-nagi'))!,
    relations = await d.relationships.where('worldId').equals(worldId).toArray();
  const plan = planSegment(world, [actor], [], cp, now + 15 * 60000);
  const result = await dormantInfluence(d, world, now, now + 15 * 60000, scope, relations, plan);
  expect(result).toBeDefined();
  expect(result!.event.participants).toContain('c-nagi');
  expect(scope.activeIds.has(result!.character.id)).toBe(false);
  await d.events.put(result!.event);
  await d.memories.put({
    id: 'macro-remember',
    worldId,
    owners: result!.event.participants,
    content: result!.event.description,
    keywords: ['重要消息'],
    importance: 0.8,
    at: result!.event.end,
    eventId: result!.event.id,
    kind: 'episode',
  });
  const conversation = {
    id: 'macro-conv',
    worldId,
    kind: 'direct' as const,
    participants: result!.event.participants,
    name: '临时交流',
    createdAt: now,
    lastAt: 0,
  };
  const context = await dialogueContext(d, conversation, 'c-nagi', now + HOUR);
  expect(context.memories.some((m) => m.eventId === result!.event.id)).toBe(true);
  expect((await resolveObservation(worldId, d)).activeIds.size).toBe(1);
});
it('selective observation reduces actual queued AI work in the same 100-person world', async () => {
  const { withWorldLock } = await import('../src/data/db'),
    { ProviderError } = await import('../src/ai/provider');
  const provider = {
    async complete() {
      throw new ProviderError('quota', '测试用量限制');
    },
  };
  const chars = Array.from({ length: 100 }, (_, i) => ({
    ...newCharacter('任务角色' + i),
    id: 'ai-large-' + i,
    phoneHabit: 1,
    wake: 0,
    sleep: 23,
    busyStart: 0,
    busyEnd: 0,
  }));
  await d.characters.bulkPut(chars);
  await d.memberships.bulkPut(
    chars.map((c) => ({
      id: 'ai-member-' + c.id,
      worldId,
      characterId: c.id,
      identity: '',
      bioOverride: '',
      styleOverride: '',
    })),
  );
  for (let i = 0; i < 10; i++) {
    await d.groups.put({
      id: 'ai-group-' + i,
      name: '任务团体' + i,
      description: '',
      color: '#abcdef',
      worldIds: [worldId],
    });
    await d.groupMembers.bulkPut(
      chars.slice(i * 10, (i + 1) * 10).map((c) => ({
        id: 'ai-gm-' + c.id,
        worldId,
        groupId: 'ai-group-' + i,
        characterId: c.id,
        nickname: '',
        role: '成员',
      })),
    );
  }
  await d.settings.update('app', {
    unlimitedUsage: true,
    activity: 'standard',
    sceneDailyBudget: 0,
  });
  await d.checkpoints.update(worldId, { paused: false, mode: 'live', seed: 42 });
  await runWorld(
    worldId,
    { now: now + 8 * HOUR, deferContent: true, provider, maxSegments: 100 },
    d,
  );
  await withWorldLock('content:' + worldId, async () => {}, true);
  const full = await d.contentJobs.where('worldId').equals(worldId).count();
  await d.contentJobs.clear();
  await d.events
    .where('worldId')
    .equals(worldId)
    .and((e) => e.start >= now)
    .delete();
  await d.messages.where('simAt').aboveOrEqual(now).delete();
  await d.states.clear();
  await d.conversations.toCollection().modify({ lastAt: 0 });
  await d.checkpoints.update(worldId, {
    simTime: now,
    realTime: now,
    clockAnchor: { simTime: now, realTime: now },
    seed: 42,
    paused: false,
    recoveryTarget: undefined,
    recoveryStart: undefined,
    recoveryRealTarget: undefined,
  });
  await saveObservation(
    config(
      chars.slice(0, 5).map((c) => c.id),
      ['ai-group-0'],
    ),
    d,
  );
  await runWorld(
    worldId,
    { now: now + 8 * HOUR, deferContent: true, provider, maxSegments: 100 },
    d,
  );
  await withWorldLock('content:' + worldId, async () => {}, true);
  const selective = await d.contentJobs.where('worldId').equals(worldId).count();
  expect(full).toBeGreaterThan(5);
  expect(selective).toBeLessThan(full * 0.8);
  console.log('100-person AI task comparison', JSON.stringify({ full, selective }));
}, 60000);
it('historical requests cannot see future evolution or background knowledge', async () => {
  const events = await evidence(),
    c = (await d.characters.get('c-nagi'))!,
    m = (await d.memberships.where('[worldId+characterId]').equals([worldId, c.id]).first())!;
  await d.worlds.update(worldId, { evolutionSettings: { enabled: true, rules: '' } });
  await d.memberships.update(m.id, { evolutionFields: ['initiative'] });
  await applyEvolution(
    worldId,
    {
      characterId: c.id,
      field: 'initiative',
      newValue: c.initiative + 0.03,
      sourceEventIds: events.map((e) => e.id),
      reason: '后来的合作经历',
    },
    d,
  );
  await d.backgroundKnowledge.put({
    id: 'future-known',
    worldId,
    entityId: 'c-toru',
    characterId: c.id,
    level: 'partial',
    knownAt: now + 2 * DAY,
    items: [
      { kind: 'fact', content: '后来才知道的消息', source: '会话传播', learnedAt: now + 2 * DAY },
    ],
  });
  const conversation = (await d.conversations.get('conv-cafe'))!,
    old = await dialogueContext(d, conversation, c.id, now + HOUR),
    current = await dialogueContext(d, conversation, c.id, now + 4 * DAY);
  expect(old.character.initiative).toBe(c.initiative);
  expect(current.character.initiative).toBeCloseTo(c.initiative + 0.03);
  expect(old.input.backgroundKnowledge.some((k) => k.entityId === 'c-toru')).toBe(false);
  expect(current.input.backgroundKnowledge.some((k) => k.entityId === 'c-toru')).toBe(true);
  await d.worlds.update(worldId, { evolutionSettings: { enabled: false, rules: '' } });
  expect(
    (await dialogueContext(d, conversation, c.id, now + 4 * DAY)).character.initiative,
  ).toBeCloseTo(c.initiative + 0.03);
});
it('version-nine data migrates without activating reports, dormancy or evolution', async () => {
  const { default: Dexie } = await import('dexie');
  const name = 'old-nine-' + crypto.randomUUID(),
    old = new Dexie(name),
    added = new Set([
      'observationConfigs',
      'observationCoverage',
      'backfillJobs',
      'evolutionRecords',
      'evolutionCursors',
      'worldReports',
      'reportCursors',
    ]);
  const tables = d.tables.filter((t) => !added.has(t.name));
  old
    .version(9)
    .stores(
      Object.fromEntries(
        tables.map((t) => [
          t.name,
          [
            t.schema.primKey.src,
            ...t.schema.indexes
              .filter(
                (i) =>
                  !['[worldId+end]', '[worldId+start]'].includes(i.name) ||
                  (t.name === 'events' && i.name === '[worldId+start]'),
              )
              .map((i) => i.src),
          ].join(','),
        ]),
      ),
    );
  for (const table of tables) await old.table(table.name).bulkPut(await table.toArray());
  const messages = await old.table('messages').toArray(),
    profiles = await old.table('profiles').toArray();
  old.close();
  const upgraded = new AquariumDB(name);
  try {
    await upgraded.open();
    expect((await resolveObservation(worldId, upgraded)).config.mode).toBe('full');
    expect(await upgraded.worldReports.count()).toBe(0);
    expect((await upgraded.worlds.get(worldId))?.evolutionSettings?.enabled ?? false).toBe(false);
    expect(await upgraded.messages.toArray()).toEqual(messages);
    expect(await upgraded.profiles.toArray()).toEqual(profiles);
  } finally {
    await upgraded.delete();
  }
});
it('new observation settings survive world package export / import with remapped IDs', async () => {
  const { exportWorld, importWorld } = await import('../src/data/worlds');
  await saveObservation(config(['c-nagi'], [], [['c-mio', 'c-ritsu']]), d);
  const p = await exportWorld(worldId, d);
  const imported = await importWorld(p, d),
    scope = await resolveObservation(imported, d);
  expect(scope.config.mode).toBe('selective');
  expect(scope.config.characterIds).not.toContain('c-nagi');
  expect(scope.config.pairs[0]).not.toContain('c-mio');
  validateBackup(await exportBackup(d));
});
it('five hundred dormant identities retain bounded detailed scheduling work', async () => {
  const chars = Array.from({ length: 500 }, (_, i) => ({
    ...newCharacter('静默背景' + i),
    id: 'dormant-' + i,
  }));
  await d.characters.bulkPut(chars);
  await d.memberships.bulkPut(
    chars.map((c) => ({
      id: 'dormant-member-' + c.id,
      worldId,
      characterId: c.id,
      identity: '',
      bioOverride: '',
      styleOverride: '',
    })),
  );
  await saveObservation(config(['c-nagi']), d);
  await d.checkpoints.update(worldId, { paused: false });
  await runWorld(worldId, { now: now + 3 * HOUR, maxSegments: 30 }, d);
  expect(
    await d.states
      .where('characterId')
      .anyOf(chars.map((c) => c.id))
      .count(),
  ).toBe(0);
  expect(await d.states.where('worldId').equals(worldId).count()).toBeLessThanOrEqual(7);
  expect(
    await d.events
      .where('worldId')
      .equals(worldId)
      .and((e) => e.start >= now)
      .count(),
  ).toBeLessThan(30);
}, 15000);
it('switching observation off suspends unfinished AI work and re-observing resumes the missing content', async () => {
  await saveObservation(config([]), d);
  await d.checkpoints.update(worldId, { simTime: now + 5 * DAY, paused: false, mode: 'live' });
  const id = await saveObservation(config(['c-nagi']), d);
  await processBackfill(worldId, d);
  const before = await d.contentJobs.toArray();
  expect(before.length).toBeGreaterThan(0);
  await saveObservation(config([]), d);
  expect((await d.backfillJobs.get(id!))?.status).toBe('paused');
  expect(
    (await d.contentJobs.toArray()).every((j) => j.status === 'failed' && j.attempts === 3),
  ).toBe(true);
  await saveObservation(config(['c-nagi']), d);
  expect(
    (await d.contentJobs.toArray()).some((j) => j.status === 'pending' && j.attempts === 0),
  ).toBe(true);
  await processBackfill(worldId, d);
  const events = await d.events
    .where('worldId')
    .equals(worldId)
    .and((e) => e.origin === 'backfill')
    .toArray();
  expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  expect((await d.events.get(before[0].event.id))?.participants).toEqual(
    before[0].event.participants,
  );
});
it('removing one backfill target does not leave the remaining target waiting for dormant AI work', async () => {
  await saveObservation(config([]), d);
  await d.checkpoints.update(worldId, { simTime: now + 5 * DAY, paused: false, mode: 'live' });
  const id = await saveObservation(config(['c-nagi', 'c-mio']), d);
  await processBackfill(worldId, d);
  await saveObservation(config(['c-nagi']), d);
  for (let day = 0; day < 3; day++) await processBackfill(worldId, d);
  const scope = await resolveObservation(worldId, d);
  for (const j of await d.contentJobs.toArray()) {
    const relevant =
      j.kind === 'chat' && j.conversation
        ? scope.allowsConversation(j.conversation)
        : scope.allowsEvent(j.event);
    if (relevant) await d.contentJobs.update(j.id, { status: 'complete' });
  }
  expect((await d.contentJobs.toArray()).some((j) => j.status === 'failed')).toBe(true);
  await processBackfill(worldId, d);
  expect((await d.backfillJobs.get(id!))?.status).toBe('complete');
});
it('a fresh calendar branch rebases inherited knowledge to its new initial clock', async () => {
  const { startCalendarBranch } = await import('../src/core/time');
  await d.backgroundKnowledge.put({
    id: 'branch-knowledge',
    worldId,
    entityId: 'c-toru',
    characterId: 'c-nagi',
    level: 'partial',
    knownAt: now + 100 * DAY,
    items: [
      { kind: 'fact', content: '已确认的背景', source: '初始设定', learnedAt: now + 100 * DAY },
    ],
  });
  await d.checkpoints.update(worldId, { paused: true, timeMode: 'god' });
  const branch = await startCalendarBranch(
    worldId,
    { year: 30, month: 1, day: 1, hour: 9, minute: 0 },
    d,
  );
  const cp = (await d.checkpoints.get(branch))!;
  const knowledge = (await d.backgroundKnowledge.where('worldId').equals(branch).toArray())[0];
  expect(knowledge.knownAt).toBe(cp.simTime);
  expect(knowledge.items[0].learnedAt).toBe(cp.simTime);
  expect((await d.backgroundKnowledge.get('branch-knowledge'))?.knownAt).toBe(now + 100 * DAY);
});
