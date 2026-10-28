import { db, type AquariumDB } from '../data/db';
import {
  DAY,
  HOUR,
  type ActivityEvent,
  type World,
  type MajorSchedule,
  type MajorEvent,
  type Membership,
  type Relationship,
  type MajorChain,
  uid,
  type RuntimeState,
} from './types';
import { clockTarget } from './time';
import { foregroundStart } from './clock-presence';
import { crisisAt, crisisDay, crisisIntervalFactor, eventLevelFor } from './crisis';
import { ordinaryLife } from './narrative';
import type { CoverageRow } from './coverage';
export const defaultMajorSettings = {
  enabled: false,
  maximumIntervalDays: 7,
  tendency: '重要计划、机会与关系变化，保持世界日常的因果连续性',
  allowRelationshipChanges: false,
  allowMultipleGroups: false,
};
export type MajorLevel = 'local' | 'group' | 'world';
export interface MajorGroupContext {
  id: string;
  name: string;
  memberIds: string[];
  location?: string;
}
export interface MajorPlanContext {
  groups?: MajorGroupContext[];
  relationships?: Relationship[];
  coverage?: Iterable<CoverageRow>;
  locations?: string[];
  from?: number;
}
export interface PlannedMajor {
  event: ActivityEvent;
  major: MajorEvent;
}
export interface MajorBatch {
  events: ActivityEvent[];
  states: Partial<RuntimeState>[];
  plans: PlannedMajor[];
  schedule: MajorSchedule;
  /** Follow-ups whose time is beyond this planning window. Persisted, never silently dropped. */
  deferredChains: MajorChain[];
}
export function majorIntervalMs(settings: NonNullable<World['majorEventSettings']>) {
  if (settings.intervalMinutes) return settings.intervalMinutes * 60000;
  return settings.maximumIntervalDays * DAY;
}
export function scheduleDayKey(at: number) {
  return new Date(at).toISOString().slice(0, 10);
}
export function nextMajorSchedule(
  worldId: string,
  last: number,
  days: number,
  sequence = 0,
  lastType = '',
): MajorSchedule {
  return nextMajorScheduleFor(
    worldId,
    last,
    { ...defaultMajorSettings, enabled: true, maximumIntervalDays: days },
    sequence,
    lastType,
  );
}
/** Jittered deadline. A missed deadline is never silently skipped; it is planned late. */
export function nextMajorScheduleFor(
  worldId: string,
  last: number,
  settings: NonNullable<World['majorEventSettings']>,
  sequence = 0,
  lastType = '',
  intervalMs?: number,
  countToday = 0,
  dayKey = scheduleDayKey(last),
  lastLevel?: MajorLevel,
): MajorSchedule {
  const base = intervalMs ?? majorIntervalMs(settings);
  const interval = Math.max(15 * 60000, Math.round(base));
  const jitter = 0.84 + ((sequence * 37) % 15) / 100;
  return {
    id: worldId,
    lastOccurredAt: last,
    nextDueAt: last + interval,
    plannedAt: last + Math.max(10 * 60000, Math.round(interval * jitter)),
    sequence,
    lastType,
    dayKey,
    countToday,
    lastLevel,
  };
}
export async function configureMajor(
  worldId: string,
  settings: NonNullable<World['majorEventSettings']>,
  d: AquariumDB = db,
) {
  if (
    !Number.isFinite(settings.maximumIntervalDays) ||
    settings.maximumIntervalDays <= 0 ||
    settings.maximumIntervalDays > 36500
  )
    throw new Error('大型事件间隔须为大于0且不超过36500虚拟日');
  if (
    settings.intervalMinutes !== undefined &&
    (!Number.isFinite(settings.intervalMinutes) ||
      settings.intervalMinutes < 15 ||
      settings.intervalMinutes > 525600)
  )
    throw new Error('大型事件小时级间隔须为15分钟～365虚拟日');
  return d.transaction('rw', d.worlds, d.majorSchedules, d.checkpoints, async () => {
    const w = await d.worlds.get(worldId),
      cp = await d.checkpoints.get(worldId);
    if (!w || !cp) throw new Error('世界不存在');
    if (w.novel?.enabled && !settings.enabled) throw new Error('小说模式必须启用重大事件');
    await d.worlds.update(worldId, { majorEventSettings: settings });
    const schedule = await d.majorSchedules.get(worldId);
    if (
      !schedule ||
      !w.majorEventSettings?.enabled ||
      w.majorEventSettings.maximumIntervalDays !== settings.maximumIntervalDays ||
      w.majorEventSettings.intervalMinutes !== settings.intervalMinutes
    )
      await d.majorSchedules.put(
        nextMajorScheduleFor(
          worldId,
          clockTarget(cp, Date.now(), foregroundStart()),
          settings,
          schedule?.sequence ?? 0,
          schedule?.lastType ?? '',
          undefined,
          0,
          scheduleDayKey(clockTarget(cp, Date.now(), foregroundStart())),
        ),
      );
  });
}
function hash(id: string, seed: number) {
  let h = seed >>> 0;
  for (const c of id) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h / 4294967296;
}
function pick<T>(list: T[], seed: number) {
  if (!list.length) return undefined;
  return list[Math.floor(hash('pick', seed) * list.length) % list.length];
}
function activeIds(members: Membership[]) {
  return members.filter((m) => !m.inactive && ordinaryLife(m.life?.status)).map((m) => m.characterId);
}
function coverageMap(rows?: Iterable<CoverageRow>) {
  const map = new Map<string, CoverageRow>();
  if (rows) for (const row of rows) map.set(row.id, row);
  return map;
}
function leastCovered(ids: string[], cov: Map<string, CoverageRow>, seed: number, count: number, exclude = new Set<string>()) {
  const ranked = ids
    .filter((id) => !exclude.has(id))
    .map((id) => ({
      id,
      score: cov.get(id)?.score ?? 0,
      lastAt: cov.get(id)?.lastAt ?? 0,
      tie: hash(id, seed),
    }))
    .sort((a, b) => a.score - b.score || a.lastAt - b.lastAt || a.tie - b.tie);
  return ranked.slice(0, count).map((x) => x.id);
}
function localParticipants(
  ids: string[],
  cov: Map<string, CoverageRow>,
  relationships: Relationship[],
  seed: number,
) {
  const first = leastCovered(ids, cov, seed, 1)[0];
  if (!first) return [];
  const related = relationships
    .filter((r) => r.from === first && ids.includes(r.to))
    .sort((a, b) => b.closeness + b.trust - (a.closeness + a.trust))
    .map((r) => r.to);
  const extras = [
    ...related.slice(0, 2),
    ...leastCovered(ids, cov, seed + 11, 3, new Set([first, ...related.slice(0, 2)])),
  ];
  return [...new Set([first, ...extras])].slice(0, 2 + (seed % 4));
}
function groupParticipants(
  group: MajorGroupContext,
  cov: Map<string, CoverageRow>,
  seed: number,
) {
  const members = group.memberIds;
  const low = leastCovered(members, cov, seed, 6);
  return [...new Set(low)].slice(0, 3 + (seed % 4));
}
function worldParticipants(
  groups: MajorGroupContext[],
  ids: string[],
  cov: Map<string, CoverageRow>,
  seed: number,
) {
  const chosen = new Set<string>(leastCovered(ids, cov, seed, 4));
  const usable = groups.filter((g) => g.memberIds.length >= 2).slice(0, 8);
  for (const group of usable) {
    const one = leastCovered(group.memberIds, cov, seed + group.id.length, 1)[0];
    if (one) chosen.add(one);
    if (chosen.size >= 13) break;
  }
  for (const id of leastCovered(ids, cov, seed + 17, 14, chosen)) {
    chosen.add(id);
    if (chosen.size >= 12) break;
  }
  return [...chosen].slice(0, 14);
}
function seedDescription(level: MajorLevel, day: number, pressure: number, groupName?: string) {
  const band = day <= 1 ? '真相公布后的' : day <= 2 ? '信任崩塌中的' : day <= 4 ? '秩序失控中的' : day <= 6 ? '文明末期的' : '最后24小时的';
  if (level === 'world')
    return `全球或区域级灾难：${band}基础设施与政治秩序同时恶化，多个团体和大量人物被卷入一次不可忽视的重大危机，现场可能出现致命后果。`;
  if (level === 'group')
    return `团体「${groupName ?? '临时组织'}」内部重大事件：${band}压力下，成员之间围绕资源、责任或去留发生冲突或被迫合作，可能造成永久关系变化。`;
  return `局部重大事件：${band}一次险情/事故/冲突影响数名彼此认识的人，当事人必须在有限时间内作出会改变后续生活的选择，现场存在受伤或死亡风险。`;
}
function seedTitle(level: MajorLevel, day: number, groupName?: string) {
  if (level === 'world') return `第${day}日 · 区域级危机`;
  if (level === 'group') return `第${day}日 · ${groupName ?? '团体'}的裂痕`;
  return `第${day}日 · 一场没有准备的险情`;
}
function overlaps(a: ActivityEvent, b: ActivityEvent) {
  return a.start < b.end && b.start < a.end;
}
/**
 * Plans one primary event plus at most one causal follow-up. The schedule deadline is
 * independent of whether the model later succeeds; a failed content job must not
 * silently consume the cadence.
 */
export function planMajorBatch(
  world: World,
  schedule: MajorSchedule,
  events: ActivityEvent[],
  end: number,
  members: Membership[] = [],
  ctx: MajorPlanContext = {},
): MajorBatch | undefined {
  const settings = world.majorEventSettings;
  if (!settings?.enabled) return;
  if (end < schedule.plannedAt) return;
  const from = ctx.from ?? schedule.lastOccurredAt;
  const due = Math.max(schedule.plannedAt, from + 60000);
  if (due >= end - 60000) return;
  const day = crisisDay(world, due);
  const pressure = crisisAt(world, due).pressure;
  const key = scheduleDayKey(due);
  const countToday = schedule.dayKey === key ? (schedule.countToday ?? 0) : 0;
  const maxPerDay = settings.maxPerDay ?? 12;
  const ids = activeIds(members);
  if (!ids.length) return;
  const interval = Math.max(
    20 * 60000,
    Math.round(majorIntervalMs(settings) * crisisIntervalFactor(day)),
  );
  if (countToday >= maxPerDay) {
    const nextDay = Math.floor(due / DAY) * DAY + DAY + 5 * 60000;
    return {
      events,
      states: [],
      plans: [],
      deferredChains: [],
      schedule: {
        ...nextMajorScheduleFor(world.id, due, settings, schedule.sequence, schedule.lastType, interval, 0, scheduleDayKey(nextDay)),
        plannedAt: nextDay,
        nextDueAt: nextDay,
      },
    };
  }
  const cov = coverageMap(ctx.coverage);
  // A group level event needs at least two living participants; otherwise the cadence
  // would stall forever waiting for a group that can no longer stage an event.
  const groups = (ctx.groups ?? []).filter(
    (g) => g.memberIds.filter((id) => ids.includes(id)).length >= 2,
  );
  const relationships = ctx.relationships ?? [];
  const sequence = schedule.sequence + 1;
  const level = eventLevelFor(day, sequence, settings);
  const group =
    level !== 'local' && groups.length
      ? groups[(sequence + day + schedule.sequence) % groups.length]
      : undefined;
  let participants =
    level === 'world'
      ? worldParticipants(groups, ids, cov, sequence * 7 + day)
      : level === 'group' && group
        ? groupParticipants(group, cov, sequence * 5 + day)
        : localParticipants(ids, cov, relationships, sequence * 3 + day);
  // A group roster may still list someone who died earlier; only living members may appear.
  participants = [...new Set(participants)].filter((id) => ids.includes(id));
  if (participants.length < 2)
    participants = localParticipants(ids, cov, relationships, sequence * 3 + day);
  if (participants.length < 2) {
    // Never leave the schedule parked in the past: skip this tick and keep the cadence moving.
    const skipped = due + interval;
    return {
      events,
      states: [],
      plans: [],
      deferredChains: [],
      schedule: {
        ...nextMajorScheduleFor(
          world.id,
          skipped,
          settings,
          schedule.sequence,
          schedule.lastType,
          interval,
          countToday,
          scheduleDayKey(skipped),
        ),
        plannedAt: skipped,
        nextDueAt: skipped,
      },
    };
  }
  const suffix = `${sequence}`;
  const id = `major:${world.id}:${suffix}`;
  const start = Math.min(end - 120000, due + (sequence % 3) * 60000);
  const location =
    level === 'world'
      ? '全球'
      : level === 'group'
        ? (group?.location ?? '线上协调')
        : (ctx.locations?.[sequence % Math.max(1, ctx.locations.length)] ?? '城市公共空间');
  const event: ActivityEvent = {
    id,
    worldId: world.id,
    type: 'major',
    start,
    end: Math.min(end, start + (level === 'world' ? 3 : 2) * HOUR),
    participants,
    location,
    description: seedDescription(level, day, pressure, group?.name),
    phone: level === 'world' ? 0.65 : 0.35,
    status: 'planned',
    importance: level === 'world' ? 0.97 : level === 'group' ? 0.88 : 0.78,
    sceneType: level === 'world' ? 'other' : 'gathering',
    majorLevel: level,
    rootEventId: id,
    chainDepth: 0,
  };
  const major: MajorEvent = {
    id,
    eventId: id,
    worldId: world.id,
    title: seedTitle(level, day, group?.name),
    timestamp: start,
    participantIds: participants,
    groupIds: group ? [group.id] : [],
    importance: event.importance ?? 0.8,
    status: 'contentPending',
    type: level === 'world' ? 'world-crisis' : level === 'group' ? 'group-conflict' : 'local-incident',
    level,
    rootEventId: id,
    chainDepth: 0,
    description: event.description,
    consequences: [
      {
        kind: 'followUp',
        description:
          level === 'world'
            ? '多个团体需要在下一次事件中回应基础设施、秩序与伤亡。'
            : level === 'group'
              ? '该团体需要处理成员去留、责任归属或领导权问题。'
              : '当事人需要在后续互动中处理这次事件留下的后果。',
      },
    ],
  };
  const plans: PlannedMajor[] = [{ event, major }];
  const deferred: MajorChain[] = [];
  // One causal follow-up per primary event, never a recursive generator.
  const maxDepth = Math.min(2, settings.maxChainDepth ?? 2);
  if (settings.allowChainEvents !== false && maxDepth > 0 && day >= 2 && sequence % 2 === 0) {
    const followLevel: MajorLevel = level === 'world' ? 'group' : 'local';
    const followGroup = followLevel === 'group' ? groups[(sequence + 1) % Math.max(1, groups.length)] : undefined;
    const followParticipants =
      followLevel === 'group' && followGroup
        ? groupParticipants(followGroup, cov, sequence * 17 + day)
        : localParticipants(ids, cov, relationships, sequence * 19 + day).filter((x) => !participants.includes(x));
    const fp = followParticipants.length >= 2 ? followParticipants : participants.slice(0, 2);
    if (fp.length >= 2) {
      const fid = `major:${world.id}:${suffix}:c1`;
      const fstart = event.end + (35 + (sequence % 4) * 20) * 60000;
      if (fstart >= end - 60000) {
        deferred.push({
          id: uid('chain'),
          worldId: world.id,
          parentEventId: id,
          rootEventId: id,
          depth: 1,
          dueAt: fstart,
          level: followLevel,
          groupId: followGroup?.id,
          participantIds: [...new Set(fp)],
          description: `连锁后果：${event.description.slice(0, 80)} 由此引发的${followLevel === 'group' ? '团体内部' : '局部'}冲突/事故，要求当事人在更短时间内作出选择，可能导致伤亡。`,
          location: followLevel === 'group' ? (followGroup?.location ?? '线上协调') : location,
          createdAt: start,
        });
      } else {
        const fevent: ActivityEvent = {
          ...event,
          id: fid,
          start: fstart,
          end: Math.min(end, fstart + 90 * 60000),
          participants: [...new Set(fp)],
          location: followLevel === 'group' ? (followGroup?.location ?? '线上协调') : location,
          description: `连锁后果：${event.description.slice(0, 80)} 由此引发的${followLevel === 'group' ? '团体内部' : '局部'}冲突/事故，要求当事人在更短时间内作出选择，可能导致伤亡。`,
          majorLevel: followLevel,
          parentEventId: id,
          rootEventId: id,
          chainDepth: 1,
        };
        plans.push({
          event: fevent,
          major: {
            ...major,
            id: fid,
            eventId: fid,
            title: `连锁 · ${seedTitle(followLevel, day, followGroup?.name)}`,
            timestamp: fstart,
            participantIds: fevent.participants,
            groupIds: followGroup ? [followGroup.id] : [],
            type: followLevel === 'group' ? 'chain-group' : 'chain-local',
            level: followLevel,
            parentEventId: id,
            rootEventId: id,
            chainDepth: 1,
            description: fevent.description,
          },
        });
      }
    }
  }
  // Replace overlapping personal events for every participant, preserving one factual activity.
  let updated = events;
  const states: Partial<RuntimeState>[] = [];
  for (const plan of plans) {
    updated = updated
      .filter(
        (e) =>
          e.id === plan.event.id ||
          !(overlaps(e, plan.event) && e.participants.some((p) => plan.event.participants.includes(p))),
      )
      .concat(plan.event);
    for (const id of plan.event.participants)
      states.push({
        id: `${world.id}:${id}`,
        worldId: world.id,
        characterId: id,
        eventId: plan.event.id,
        activity: plan.event.majorLevel === 'world' ? '世界级危机' : plan.event.majorLevel === 'group' ? '团体重大事件' : '局部重大事件',
        location: plan.event.location,
        phone: plan.event.phone,
      });
  }
  const next = nextMajorScheduleFor(
    world.id,
    start,
    settings,
    sequence,
    level,
    interval,
    countToday + plans.length,
    scheduleDayKey(start),
    level,
  );
  return { events: updated, states, plans, schedule: next, deferredChains: deferred };
}
/** Backwards-compatible single-event wrapper used by older callers/tests. */
export function planMajor(
  world: World,
  schedule: MajorSchedule,
  events: ActivityEvent[],
  end: number,
  members: Membership[] = [],
) {
  const batch = planMajorBatch(world, schedule, events, end, members, {
    from: schedule.lastOccurredAt,
    locations: world.locations,
  });
  if (!batch?.plans.length) return;
  const first = batch.plans[0];
  return {
    events: batch.events,
    event: first.event,
    major: first.major,
    schedule: batch.schedule,
    replacedIds: batch.plans.map((p) => p.event.id),
    replacedId: first.event.id,
  };
}
export async function promoteNaturalEvent(eventId: string, d: AquariumDB = db) {
  return d.transaction(
    'rw',
    d.events,
    d.majorEvents,
    d.majorSchedules,
    d.notifications,
    d.worlds,
    async () => {
      const e = await d.events.get(eventId);
      if (!e) throw new Error('事件不存在');
      const w = await d.worlds.get(e.worldId);
      if (!w?.majorEventSettings?.enabled) throw new Error('世界尚未开启大型事件');
      if ((e.importance ?? 0) < 0.8 || !/(重要|重大|关键|告白|冲突|演出|比赛)/.test(e.description))
        throw new Error('普通日常尚不符合大型事件条件');
      const old = await d.majorEvents.where('eventId').equals(e.id).first();
      if (old) return old.id;
      const schedule = await d.majorSchedules.get(e.worldId),
        id = `natural:${e.id}`;
      await d.majorEvents.put({
        id,
        eventId: e.id,
        worldId: e.worldId,
        title: e.description.slice(0, 100),
        description: e.description,
        timestamp: e.start,
        participantIds: e.participants,
        groupIds: [],
        importance: Math.max(0.85, e.importance ?? 0),
        status: 'occurred',
        type: 'natural',
        level: 'local',
        chainDepth: 0,
        consequences: [],
      });
      if (!schedule || e.start >= schedule.lastOccurredAt)
        await d.majorSchedules.put(
          nextMajorScheduleFor(
            e.worldId,
            e.start,
            w.majorEventSettings,
            (schedule?.sequence ?? 0) + 1,
            'natural',
          ),
        );
      await d.notifications.put({
        id: `notice:${id}`,
        eventId: id,
        worldId: e.worldId,
        createdAt: Date.now(),
        recovery: false,
      });
      return id;
    },
  );
}
/** Convert one persisted follow-up seed into a real event when its time arrives. */
export function materializeChain(
  world: World,
  chain: MajorChain,
  startAt: number,
  end: number,
  events: ActivityEvent[],
  members: Membership[] = [],
): { event: ActivityEvent; major: MajorEvent; events: ActivityEvent[] } | undefined {
  const alive = new Set(activeIds(members));
  const participants = chain.participantIds.filter((id) => alive.has(id));
  if (participants.length < 2) return undefined;
  const start = Math.max(chain.dueAt, startAt + 60000);
  if (start >= end - 60000) return undefined;
  const event: ActivityEvent = {
    id: `${chain.parentEventId}:c${chain.depth}`,
    worldId: world.id,
    type: 'major',
    start,
    end: Math.min(end, start + 90 * 60000),
    participants,
    location: chain.location,
    description: chain.description,
    phone: chain.level === 'world' ? 0.6 : 0.4,
    status: 'planned',
    importance: chain.level === 'world' ? 0.92 : chain.level === 'group' ? 0.85 : 0.8,
    sceneType: chain.level === 'world' ? 'other' : 'gathering',
    majorLevel: chain.level,
    parentEventId: chain.parentEventId,
    rootEventId: chain.rootEventId,
    chainDepth: chain.depth,
  };
  const major: MajorEvent = {
    id: event.id,
    eventId: event.id,
    worldId: world.id,
    title: `连锁 · ${chain.description.slice(0, 40)}`,
    timestamp: start,
    participantIds: participants,
    groupIds: chain.groupId ? [chain.groupId] : [],
    importance: event.importance ?? 0.85,
    status: 'contentPending',
    type: chain.level === 'group' ? 'chain-group' : 'chain-local',
    level: chain.level,
    parentEventId: chain.parentEventId,
    rootEventId: chain.rootEventId,
    chainDepth: chain.depth,
    description: chain.description,
    consequences: [{ kind: 'followUp', description: '上一事件的直接后果正在改变参与者与团体。' }],
  };
  let updated = events.filter(
    (e) =>
      !(
        e.start < event.end &&
        event.start < e.end &&
        e.participants.some((id) => participants.includes(id))
      ),
  );
  updated = updated.concat(event);
  return { event, major, events: updated };
}
