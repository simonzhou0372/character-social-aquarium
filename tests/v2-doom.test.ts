import { it, expect } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { DAY, HOUR, type ActivityEvent, type Membership } from '../src/core/types';
import { NovelSchema } from '../src/core/novel-types';
import { LifeRulesSchema } from '../src/core/narrative-types';
import {
  defaultMajorSettings,
  nextMajorScheduleFor,
  planMajorBatch,
} from '../src/core/major-events';
import { crisisAt, crisisIntervalFactor, eventLevelFor } from '../src/core/crisis';
import { applyNarrativeConsequences, canLiveAt, lethalCandidates } from '../src/core/narrative';
import { computeCoverage, invalidateCoverage } from '../src/core/coverage';
import { runWorld } from '../src/core/engine';
import { defaultPrompts } from '../src/ai/prompts';
import { exportBackup, validateBackup } from '../src/data/backup';
import { applyMajor } from '../src/ai/major-events';
const NOW = Date.parse('2026-10-28T00:00:00Z'),
  W = 'w-harbor';
const settings = {
  ...defaultMajorSettings,
  enabled: true,
  intervalMinutes: 240,
  maxPerDay: 8,
  allowChainEvents: true,
  maxChainDepth: 2,
};
async function fixture() {
  const d = new AquariumDB('v2-doom-' + crypto.randomUUID());
  await seed(d, NOW);
  await d.worlds.update(W, {
    majorEventSettings: settings,
    crisis: { enabled: true, startedAt: NOW, durationDays: 7 },
    novel: NovelSchema.parse({
      enabled: true,
      startedAt: NOW,
      goal: '七天后世界终结，人物在此之前经历极端压力',
      allowGroupChanges: true,
      lifeRules: LifeRulesSchema.parse({ allowDeath: true, risk: 'high' }),
    }),
    rules: '末日灾难与秩序崩溃中求生，允许死亡与团体变化',
  });
  await d.memberships.toCollection().modify({ allowAutomaticDeath: true });
  await d.checkpoints.update(W, { simTime: NOW, paused: false, mode: 'live' });
  return d;
}
function personal(d: AquariumDB, at: number): ActivityEvent[] {
  return [
    {
      id: 'p1',
      worldId: W,
      type: 'rest',
      start: at,
      end: at + HOUR,
      participants: ['c-nagi'],
      location: '家',
      description: '凪 夏生 · 休息中',
      phone: 0.95,
      status: 'completed',
    },
    {
      id: 'p2',
      worldId: W,
      type: 'work',
      start: at,
      end: at + HOUR,
      participants: ['c-mio'],
      location: '白昼咖啡',
      description: '森川 澪 · 忙碌中',
      phone: 0.12,
      status: 'completed',
    },
  ];
}
it('supports sub-day cadence and produces more than one major event inside a single virtual day', async () => {
  const d = await fixture();
  try {
    const world = (await d.worlds.get(W))!;
    const members = await d.memberships.where('worldId').equals(W).toArray();
    const groups = await d.groups.filter((g) => g.worldIds.includes(W)).toArray();
    const gm = await d.groupMembers.where('worldId').equals(W).toArray();
    const groupsCtx = groups.map((g) => ({
      id: g.id,
      name: g.name,
      memberIds: gm.filter((m) => m.groupId === g.id).map((m) => m.characterId),
    }));
    let schedule = nextMajorScheduleFor(W, NOW, world.majorEventSettings!, 0, '');
    const starts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const end = schedule.plannedAt + 5 * 60000;
      const batch = planMajorBatch(world, schedule, personal(d, schedule.plannedAt), end, members, {
        groups: groupsCtx,
        from: schedule.plannedAt,
        locations: world.locations,
      })!;
      expect(batch.plans.length).toBeGreaterThan(0);
      starts.push(...batch.plans.map((p) => p.event.start));
      schedule = batch.schedule;
    }
    const day1 = starts.filter((s) => s < NOW + DAY);
    expect(day1.length).toBeGreaterThan(1);
    expect(new Set(starts.map((s) => Math.floor(s / HOUR))).size).toBeGreaterThan(1);
    // Interval is a target, not a mechanical clock.
    expect(starts.every((s, i) => i === 0 || s > starts[i - 1])).toBe(true);
  } finally {
    await d.delete();
  }
});
function planStart(batch: { plans: { event: ActivityEvent }[] }) {
  return Math.min(...batch.plans.map((p) => p.event.start));
}
it('ordinary worlds never inherit apocalypse copy or forbidden relationship/group changes', async () => {
  const d = new AquariumDB('ordinary-major-' + crypto.randomUUID());
  try {
    await seed(d, NOW);
    await d.worlds.update(W, {
      majorEventSettings: {
        ...defaultMajorSettings,
        enabled: true,
        intervalMinutes: 240,
        maxPerDay: 12,
        allowRelationshipChanges: false,
        allowChainEvents: false,
      },
    });
    const world = (await d.worlds.get(W))!;
    const members = await d.memberships.where('worldId').equals(W).toArray();
    const groups = await d.groups.filter((g) => g.worldIds.includes(W)).toArray();
    const gm = await d.groupMembers.where('worldId').equals(W).toArray();
    const groupsCtx = groups.map((g) => ({
      id: g.id,
      name: g.name,
      memberIds: gm.filter((m) => m.groupId === g.id).map((m) => m.characterId),
    }));
    let schedule = nextMajorScheduleFor(W, NOW, world.majorEventSettings!, 0, '');
    const copy: string[] = [];
    for (let i = 0; i < 10; i++) {
      const end = schedule.plannedAt + 5 * 60000;
      const batch = planMajorBatch(world, schedule, personal(d, schedule.plannedAt), end, members, {
        groups: groupsCtx,
        from: schedule.plannedAt,
        locations: world.locations,
      })!;
      for (const plan of batch.plans)
        copy.push(plan.event.description, plan.major.title, plan.major.consequences[0].description);
      schedule = batch.schedule;
    }
    const text = copy.join('\n');
    expect(text).not.toMatch(/文明末期|末日|终焉|最后24小时|全球灾难/);
    expect(text).not.toMatch(/永久关系变化|去留|死亡|致命/);
  } finally {
    await d.delete();
  }
});
it('mixes local, group and world levels and derives one causal follow-up with a persistent parent link', async () => {
  const d = await fixture();
  try {
    const world = (await d.worlds.get(W))!;
    const members = await d.memberships.where('worldId').equals(W).toArray();
    const groups = await d.groups.filter((g) => g.worldIds.includes(W)).toArray();
    const gm = await d.groupMembers.where('worldId').equals(W).toArray();
    const groupsCtx = groups.map((g) => ({
      id: g.id,
      name: g.name,
      memberIds: gm.filter((m) => m.groupId === g.id).map((m) => m.characterId),
    }));
    let schedule = nextMajorScheduleFor(W, NOW, world.majorEventSettings!, 0, '');
    const levels = new Set<string>();
    const chains: { parent?: string; depth?: number }[] = [];
    let deferred = 0;
    for (let i = 0; i < 10; i++) {
      const end = schedule.plannedAt + 5 * 60000;
      const batch = planMajorBatch(world, schedule, personal(d, schedule.plannedAt), end, members, {
        groups: groupsCtx,
        from: schedule.plannedAt,
        locations: world.locations,
      })!;
      for (const plan of batch.plans) {
        levels.add(plan.event.majorLevel!);
        chains.push({ parent: plan.event.parentEventId, depth: plan.event.chainDepth });
        expect(plan.event.participants.length).toBeGreaterThanOrEqual(2);
      }
      for (const chain of batch.deferredChains) {
        deferred++;
        chains.push({ parent: chain.parentEventId, depth: chain.depth });
        expect(chain.participantIds.length).toBeGreaterThanOrEqual(2);
        expect(chain.dueAt).toBeGreaterThan(planStart(batch));
      }
      schedule = batch.schedule;
    }
    expect(levels.has('local')).toBe(true);
    expect([...levels].some((l) => l === 'group' || l === 'world')).toBe(true);
    expect(deferred + chains.filter((c) => c.depth === 1).length).toBeGreaterThan(0);
    expect(chains.every((c) => (c.depth ?? 0) <= 2)).toBe(true);
  } finally {
    await d.delete();
  }
});
it('raises pressure and shortens cadence as the world approaches the final day', async () => {
  const d = await fixture();
  try {
    const world = (await d.worlds.get(W))!;
    const early = crisisAt(world, NOW + 2 * HOUR);
    const late = crisisAt(world, NOW + 6 * DAY + 12 * HOUR);
    expect(late.pressure).toBeGreaterThan(early.pressure);
    expect(late.infrastructure).toBeLessThan(early.infrastructure);
    expect(late.violence).toBeGreaterThan(early.violence);
    expect(crisisIntervalFactor(7)).toBeLessThan(crisisIntervalFactor(1));
    expect(crisisAt(world, NOW + 7 * DAY + HOUR).band).toBe('final');
    const levels = new Set(
      [1, 3, 5, 7].map((day) => eventLevelFor(day, 2, world.majorEventSettings)),
    );
    expect(levels.size).toBeGreaterThan(1);
  } finally {
    await d.delete();
  }
});
it('kills only plausible candidates, then blocks life, dialogue and pending content for the dead', async () => {
  const d = await fixture();
  try {
    const world = (await d.worlds.get(W))!;
    const members = await d.memberships.where('worldId').equals(W).toArray();
    const event: ActivityEvent = {
      id: 'fatal-world',
      worldId: W,
      type: 'major',
      start: NOW + 5 * DAY,
      end: NOW + 5 * DAY + 3 * HOUR,
      participants: members.map((m) => m.characterId).slice(0, 5),
      location: '全球',
      description: '城市电网崩溃引发踩踏与火灾，现场出现致命伤情。',
      phone: 0.6,
      status: 'completed',
      majorLevel: 'world',
      importance: 0.97,
    };
    await d.events.put(event);
    await d.majorEvents.put({
      id: event.id,
      eventId: event.id,
      worldId: W,
      title: '城市电网崩溃',
      timestamp: event.start,
      participantIds: event.participants,
      groupIds: [],
      importance: 0.97,
      status: 'occurred',
      type: 'world-crisis',
      level: 'world',
      description: event.description,
      consequences: [],
    });
    for (const id of event.participants)
      await d.states.put({
        id: W + ':' + id,
        worldId: W,
        characterId: id,
        eventId: event.id,
        activity: '世界级危机',
        location: '全球',
        phone: 0.6,
        mood: 0,
        lastAction: 0,
        lastPhone: 0,
      });
    await d.checkpoints.update(W, { paused: true, simTime: event.end + HOUR });
    const candidates = lethalCandidates(world, event, members, 99, { day: 5, pressure: 0.7 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(8);
    expect(candidates.every((id) => event.participants.includes(id))).toBe(true);
    const victim = candidates[0];
    const membership = members.find((m) => m.characterId === victim)! as Membership;
    // A future chat job for the victim must not survive as if they were still alive.
    const conv = (await d.conversations.where('worldId').equals(W).toArray())[0];
    await d.contentJobs.put({
      id: 'dead-chat',
      worldId: W,
      kind: 'chat',
      speakerId: victim,
      conversation: { ...conv, participants: [victim, conv.participants[0]] },
      event,
      at: event.end + HOUR,
      snapshot: defaultPrompts(NOW),
      recovery: false,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
    });
    await applyNarrativeConsequences(
      W,
      event.id,
      [
        {
          entityKind: 'character',
          entityId: victim,
          to: 'dead',
          reason: '在电网崩溃的踩踏中受致命伤，抢救无效。',
          evidence: event.description,
          memberChanges: [],
          successors: [],
        },
      ],
      d,
      true,
    );
    expect(await canLiveAt(W, victim, event.end + 1, d)).toBe(false);
    const after = await d.memberships.get(membership.id);
    expect(after?.life?.status).toBe('dead');
    const job = await d.contentJobs.get('dead-chat');
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('死亡');
    // The world remains consistent for export.
    expect(validateBackup(await exportBackup(d))).toBeTruthy();
  } finally {
    await d.delete();
  }
});
it('counts per-character coverage and feeds the chronicle scheduler without inventing history', async () => {
  const d = await fixture();
  try {
    invalidateCoverage();
    const baseline = await computeCoverage(W, d, NOW + HOUR, true);
    expect(baseline.totals.characters).toBe(5);
    const beforeMio = baseline.byId.get('c-mio')!.messages;
    const conv = (await d.conversations.where('worldId').equals(W).toArray())[0];
    await d.messages.add({
      id: 'm1',
      conversationId: conv.id,
      senderId: 'c-mio',
      text: '海上现在怎么样？',
      simAt: NOW + HOUR,
      realAt: NOW,
      seq: 99,
      source: 'ai',
    });
    invalidateCoverage();
    const after = await computeCoverage(W, d, NOW + 2 * HOUR, true);
    expect(after.byId.get('c-mio')?.messages).toBe(beforeMio + 1);
    expect(after.totals.withStory).toBeGreaterThanOrEqual(baseline.totals.withStory);
  } finally {
    await d.delete();
  }
});
it('runs several planned majors in one simulated day at high activity with default content barrier', async () => {
  const d = await fixture();
  try {
    await d.worlds.update(W, {
      majorEventSettings: { ...settings, intervalMinutes: 120 },
    });
    await d.majorSchedules.put(nextMajorScheduleFor(W, NOW, settings, 0, '', undefined, 0));
    await d.settings.update('app', { activity: 'carnival', unlimitedUsage: true });
    await d.characters.toCollection().modify({
      initiative: 0.9,
      replyChance: 0.9,
      phoneHabit: 1,
      wake: 0,
      sleep: 23,
      busyStart: 0,
      busyEnd: 0,
    });
    const provider = {
      async complete() {
        return {
          content: JSON.stringify({ description: '按既定日程活动。' }),
          inputTokens: 1,
          outputTokens: 1,
          estimated: false,
        };
      },
    };
    await runWorld(
      W,
      { now: NOW + DAY, provider: provider as never, deferContent: true, dispatchContent: false },
      d,
    );
    const majors = await d.majorEvents.where('worldId').equals(W).toArray();
    const dayOne = majors.filter((m) => m.timestamp < NOW + DAY);
    expect(dayOne.length).toBeGreaterThanOrEqual(2);
    expect(dayOne.every((m) => m.level)).toBe(true);
    const jobs = await d.contentJobs.where('worldId').equals(W).toArray();
    expect(jobs.filter((j) => j.kind === 'major').length).toBeGreaterThanOrEqual(2);
    expect(await d.majorSchedules.get(W)).toBeDefined();
  } finally {
    await d.delete();
  }
}, 120000);

it('creates a relationship that did not exist when a major event produces a new tie', async () => {
  const d = await fixture();
  try {
    const at = NOW + HOUR;
    const members = await d.memberships.where('worldId').equals(W).toArray();
    const rows = await d.relationships.where('worldId').equals(W).toArray();
    const has = new Set(rows.map((r) => r.from + '>' + r.to));
    let a = '',
      b = '';
    for (const x of members)
      for (const y of members)
        if (
          x.characterId !== y.characterId &&
          !has.has(x.characterId + '>' + y.characterId) &&
          !a
        ) {
          a = x.characterId;
          b = y.characterId;
        }
    expect(a && b).toBeTruthy();
    const event: ActivityEvent = {
      id: 'major:rel',
      worldId: W,
      type: 'major',
      start: at,
      end: at + HOUR,
      participants: [a, b],
      location: '车站',
      description: '两人在车站共同处理一场踩踏，彼此第一次真正信任对方。',
      phone: 0.35,
      status: 'completed',
      importance: 0.9,
      majorLevel: 'local',
      lethalCandidateIds: [],
    };
    await d.events.put(event);
    await d.majorEvents.put({
      id: 'major:rel',
      eventId: 'major:rel',
      worldId: W,
      title: '车站',
      timestamp: at,
      participantIds: [a, b],
      groupIds: [],
      importance: 0.9,
      status: 'contentPending',
      type: 'local-incident',
      level: 'local',
      description: event.description,
      consequences: [],
    });
    await d.worlds.update(W, {
      majorEventSettings: { ...settings, allowRelationshipChanges: true },
    });
    const before = await d.relationships.where('worldId').equals(W).count();
    const job: any = { id: 'j-rel', worldId: W, event };
    await applyMajor(d, job, {
      usageRequestId: 'req',
      title: '车站',
      description: event.description,
      followUp: '两人保持联系。',
      narrative: [],
      relationshipChanges: [{ from: a, to: b, delta: 9, trustDelta: 4, reason: '共同救人' }],
    });
    const row = await d.relationships.where('[worldId+from+to]').equals([W, a, b]).first();
    expect(await d.relationships.where('worldId').equals(W).count()).toBe(before + 1);
    expect(row?.trust).toBeGreaterThan(18);
    expect(row?.history).toContain('共同救人');
  } finally {
    await d.delete();
  }
});
