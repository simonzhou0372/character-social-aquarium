import { db, type AquariumDB } from '../data/db';
import {
  DAY,
  HOUR,
  type ActivityEvent,
  type World,
  type MajorSchedule,
  type MajorEvent,
} from './types';
import { clockTarget } from './time';
import { foregroundStart } from './clock-presence';
export const defaultMajorSettings = {
  enabled: false,
  maximumIntervalDays: 7,
  tendency: '重要计划、机会与关系变化，保持世界日常的因果连续性',
  allowRelationshipChanges: false,
  allowMultipleGroups: false,
};
export function nextMajorSchedule(
  worldId: string,
  last: number,
  days: number,
  sequence = 0,
  lastType = '',
): MajorSchedule {
  const interval = days * DAY;
  return {
    id: worldId,
    lastOccurredAt: last,
    nextDueAt: last + interval,
    plannedAt: last + interval * (0.72 + ((sequence * 37) % 20) / 100),
    sequence,
    lastType,
  };
}
export async function configureMajor(
  worldId: string,
  settings: NonNullable<World['majorEventSettings']>,
  d: AquariumDB = db,
) {
  if (
    !Number.isFinite(settings.maximumIntervalDays) ||
    settings.maximumIntervalDays < 1 ||
    settings.maximumIntervalDays > 36500
  )
    throw new Error('大型事件间隔须为1～36500虚拟日');
  return d.transaction('rw', d.worlds, d.majorSchedules, d.checkpoints, async () => {
    const w = await d.worlds.get(worldId),
      cp = await d.checkpoints.get(worldId);
    if (!w || !cp) throw new Error('世界不存在');
    if(w.novel?.enabled && !settings.enabled) throw new Error('小说模式必须启用重大事件');
    await d.worlds.update(worldId, { majorEventSettings: settings });
    const schedule = await d.majorSchedules.get(worldId);
    if (
      !schedule ||
      !w.majorEventSettings?.enabled ||
      w.majorEventSettings.maximumIntervalDays !== settings.maximumIntervalDays
    )
      await d.majorSchedules.put(
        nextMajorSchedule(
          worldId,
          clockTarget(cp, Date.now(), foregroundStart()),
          settings.maximumIntervalDays,
          schedule?.sequence ?? 0,
          schedule?.lastType ?? '',
        ),
      );
  });
}
/** The deadline is deterministic and persistent; probability cannot skip a cycle. */
export function planMajor(
  world: World,
  schedule: MajorSchedule,
  events: ActivityEvent[],
  end: number,
) {
  if (!world.majorEventSettings?.enabled || end < schedule.plannedAt || !events.length) return;
  const candidates = events.filter((e) => e.phone > 0.3 && e.end > schedule.plannedAt);
  if (!candidates.length && end < schedule.nextDueAt) return;
  const base = (candidates.find((e) => e.participants.length > 1) ??
    candidates[0] ??
    events.at(-1))!;
  const timestamp =
    schedule.plannedAt >= base.start && schedule.plannedAt < base.end
      ? schedule.plannedAt
      : base.start;
  const sequence = schedule.sequence + 1,
    id = `major:${world.id}:${sequence}`;
  const types = ['opportunity', 'decision', 'project', 'reconnection'];
  let kind = types[(sequence - 1) % types.length];
  if (kind === schedule.lastType) kind = types[sequence % types.length];
  if (kind === 'reconnection' && base.participants.length === 1)
    kind = schedule.lastType === 'decision' ? 'opportunity' : 'decision';
  const awake = base.phone > 0.3;
  const descriptions: Record<string, string> = {
    opportunity: awake
      ? '收到一项需要认真考虑的重要邀请，并决定安排后续沟通。'
      : '一项重要邀请已经送达，等待当事人醒后处理。',
    decision: '重新审视长期计划，作出会影响后续安排的重要决定。',
    project: '一项长期计划进入关键节点，需要明确下一阶段的行动。',
    reconnection: '一段既有关系出现重新沟通的契机，需要后续认真面对。',
  };
  const event: ActivityEvent = {
    ...base,
    id,
    worldId: world.id,
    type: 'major',
    start: timestamp,
    end: base.end,
    importance: 0.9,
    description: descriptions[kind],
    sceneType: base.sceneType ?? 'other',
  };
  // Replace occupied intervals, keeping a single primary fact and all original participants.
  const updated = events.flatMap((e) =>
    e.id !== base.id ? [e] : e.start < timestamp ? [{ ...e, end: timestamp }, event] : [event],
  );
  const major: MajorEvent = {
    id,
    eventId: id,
    worldId: world.id,
    title: ['新的重要机会', '一次重要决定', '计划的关键节点', '重新沟通的契机'][
      types.indexOf(kind)
    ],
    timestamp,
    participantIds: event.participants,
    groupIds: [],
    importance: 0.9,
    status: 'contentPending',
    type: kind,
    description: event.description,
    consequences: [
      {
        kind: 'followUp',
        description: awake
          ? '当事人需要在后续互动中处理此事。'
          : '当事人尚未读到相关信息，醒后才可处理。',
      },
    ],
  };
  return {
    events: updated,
    event,
    major,
    schedule: nextMajorSchedule(
      world.id,
      timestamp,
      world.majorEventSettings.maximumIntervalDays,
      sequence,
      kind,
    ),
    replacedId: base.id,
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
        consequences: [],
      });
      if (!schedule || e.start >= schedule.lastOccurredAt)
        await d.majorSchedules.put(
          nextMajorSchedule(
            e.worldId,
            e.start,
            w.majorEventSettings.maximumIntervalDays,
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
