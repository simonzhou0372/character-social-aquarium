import { restartNovel } from './novel-types';
import { historicalCharacter } from './selective-observation';
import { nextMajorSchedule } from './major-events';
import { foregroundStart } from './clock-presence';
import { formatWorldTime, WorldDateTimeSchema } from './calendar';
import { cancelWorld } from './tasks';
import { db, withWorldLock, type AquariumDB } from '../data/db';
import { type Checkpoint, type RuntimeState, uid, HOUR } from './types';
export const timeSpeeds = [1, 5, 30, 60, 300, 1440, 3600];
export function clockTarget(cp: Checkpoint, now: number, foregroundSince?: number) {
  if (cp.paused) return cp.clockAnchor?.simTime ?? cp.simTime;
  if (cp.clockAnchor)
    cp = { ...cp, simTime: cp.clockAnchor.simTime, realTime: cp.clockAnchor.realTime };
  const elapsed = Math.max(0, now - cp.realTime);
  const foreground =
    foregroundSince === undefined ? 0 : Math.max(0, now - Math.max(cp.realTime, foregroundSince));
  const speed = cp.timeMode === 'real' ? 1 : cp.speed;
  return cp.simTime + elapsed + foreground * (speed - 1);
}
export function worldDate(at: number, timezone: string) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const v = (k: string) => p.find((x) => x.type === k)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}
export function dateStart(date: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('请选择有效日期');
  const wanted = Date.parse(date + 'T00:00:00Z');
  let at = wanted;
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const v = (k: string) => parts.find((x) => x.type === k)!.value;
    const rendered = Date.parse(
      `${v('year')}-${v('month')}-${v('day')}T${v('hour')}:${v('minute')}:${v('second')}Z`,
    );
    const delta = wanted - rendered;
    at += delta;
    if (!delta) break;
  }
  if (!Number.isFinite(at) || at < 0 || worldDate(at, timezone) !== date)
    throw new Error('这个日期无效');
  return at;
}
export async function configureTime(
  worldId: string,
  mode: 'god' | 'real',
  speed: number,
  d: AquariumDB = db,
) {
  const now = Date.now();
  const foregroundSince = typeof document === 'undefined' ? now : foregroundStart();
  if (!timeSpeeds.includes(speed)) throw new Error('不支持的时间倍率');
  cancelWorld(worldId);
  await d.transaction('rw', d.checkpoints, async () => {
    const cp = await d.checkpoints.get(worldId);
    if (!cp) throw new Error('世界不存在');
    const target = clockTarget(cp, now, foregroundSince);
    const pending = !cp.paused && target > cp.simTime;
    await d.checkpoints.put({
      ...cp,
      controlVersion: (cp.controlVersion ?? 0) + 1,
      clockAnchor: { simTime: target, realTime: now },
      timeMode: mode,
      speed: mode === 'real' ? 1 : speed,
      realTime: cp.paused ? now : cp.realTime,
      ...(pending
        ? {
            recoveryTarget: target,
            recoveryStart: cp.recoveryStart ?? cp.simTime,
            recoveryRealTarget: cp.recoveryRealTarget ?? now,
            recoveryKind: cp.recoveryKind ?? ('foreground' as const),
          }
        : { realTime: now }),
    });
  });
}
/** Rewind creates an independent timeline; the original world and its records are preserved. */
export async function rewindWorld(worldId: string, at: number, d: AquariumDB = db) {
  return withWorldLock(
    worldId,
    () =>
      d.transaction('rw', d.tables, async () => {
        const world = await d.worlds.get(worldId),
          cp = await d.checkpoints.get(worldId);
        if (!world || !cp) throw new Error('世界不存在');
        if (cp.timeMode === 'real') throw new Error('真实世界模式不能回退时间');
        if (!cp.paused) throw new Error('请先暂停世界，再回到过去');
        if (!Number.isFinite(at) || at < 0 || at >= cp.simTime)
          throw new Error('请选择早于当前世界时间的日期');
        const id = uid('timeline'),
          now = Date.now(),
          date = formatWorldTime(world, at);
        await d.worlds.add({
          ...world,
          novel: restartNovel(world.novel, at),
          novelHistory: undefined,
          id,
          name: `${world.name.slice(0, 50)} · ${date}`,
        });
        const memberships = await d.memberships.where('worldId').equals(worldId).toArray();
        for (const m of memberships) {
          const c = await d.characters.get(m.characterId),
            historical = c ? await historicalCharacter(d, c, m, worldId, at) : undefined;
          const evolved =
            m.evolved && historical
              ? Object.fromEntries(
                  Object.keys(m.evolved).map((field) => [
                    field,
                    historical[field as keyof typeof m.evolved],
                  ]),
                )
              : m.evolved;
          await d.memberships.add({ ...m, id: uid('member'), worldId: id, evolved });
        }
        const focus = await d.observationConfigs.get(worldId);
        if (focus) await d.observationConfigs.put({ ...focus, id, updatedAt: now });
        for (const coverage of await d.observationCoverage
          .where('worldId')
          .equals(worldId)
          .toArray())
          await d.observationCoverage.put({
            ...coverage,
            id: id + ':' + coverage.target,
            worldId: id,
            intervals: coverage.intervals
              .filter(([a]) => a < at)
              .map(([a, b]) => [a, Math.min(b, at)]),
          });
        const groups = await d.groups.filter((g) => g.worldIds.includes(worldId)).toArray();
        for (const g of groups) await d.groups.update(g.id, { worldIds: [...g.worldIds, id] });
        const gm = await d.groupMembers.where('worldId').equals(worldId).toArray();
        await d.groupMembers.bulkAdd(gm.map((m) => ({ ...m, id: uid('gm'), worldId: id })));
        const relations = await d.relationships.where('worldId').equals(worldId).toArray();
        await d.relationships.bulkAdd(
          relations.map((r) => ({ ...r, id: uid('relation'), worldId: id })),
        );
        const events = (await d.events.where('worldId').equals(worldId).toArray()).filter(
          (e) => e.start < at && e.status !== 'cancelled',
        );
        const eventIds = new Map(events.map((e) => [e.id, uid('event')]));
        await d.events.bulkAdd(
          events.map((e) => ({
            ...e,
            id: eventIds.get(e.id)!,
            worldId: id,
            end: Math.min(at, e.end),
            status: 'completed' as const,
            dependsOn: e.dependsOn ? eventIds.get(e.dependsOn) : undefined,
          })),
        );
        const gifIds = new Map<string, string>();
        for (const asset of await d.gifAssets.where('scopeId').equals(worldId).toArray()) {
          if (asset.scopeType !== 'world') continue;
          const assetId = uid('gif');
          gifIds.set(asset.id, assetId);
          await d.gifAssets.add({ ...asset, id: assetId, scopeId: id });
        }
        const messageIds = new Map<string, string>();
        const evolution = (
          await d.evolutionRecords.where('worldId').equals(worldId).toArray()
        ).filter((r) => r.at <= at && r.sourceEventIds.every((e) => eventIds.has(e)));
        const evolutionIds = new Map(evolution.map((r) => [r.id, uid('evolution')]));
        for (const r of evolution)
          await d.evolutionRecords.add({
            ...r,
            id: evolutionIds.get(r.id)!,
            worldId: id,
            sourceEventIds: r.sourceEventIds.map((e) => eventIds.get(e)!),
            dependsOn: r.dependsOn ? evolutionIds.get(r.dependsOn) : undefined,
          });
        const conversations = await d.conversations.where('worldId').equals(worldId).toArray();
        const convIds = new Map(conversations.map((c) => [c.id, uid('conv')]));
        for (const c of conversations) {
          const messages = (
            await d.messages.where('conversationId').equals(c.id).sortBy('seq')
          ).filter((m) => m.simAt <= at && (!m.eventId || eventIds.has(m.eventId)));
          for (const m of messages) messageIds.set(m.id, uid('msg'));
          await d.conversations.add({
            ...c,
            id: convIds.get(c.id)!,
            worldId: id,
            createdAt: Math.min(c.createdAt, at),
            lastAt: messages.reduce((latest, m) => Math.max(latest, m.simAt), 0),
            controlledId: undefined,
          });
          await d.messages.bulkAdd(
            messages.map((m, i) => ({
              ...m,
              id: messageIds.get(m.id)!,
              replyToMessageId: m.replyToMessageId ? messageIds.get(m.replyToMessageId) : undefined,
              gifAssetId: m.gifAssetId ? (gifIds.get(m.gifAssetId) ?? m.gifAssetId) : undefined,
              conversationId: convIds.get(c.id)!,
              seq: i + 1,
              eventId: m.eventId ? eventIds.get(m.eventId) : undefined,
            })),
          );
        }
        for (const r of await d.reactions.toArray())
          if (messageIds.has(r.messageId) && r.reactedAt <= at)
            await d.reactions.add({
              ...r,
              id: uid('reaction'),
              messageId: messageIds.get(r.messageId)!,
            });
        for (const r of await d.readStates.toArray())
          if (messageIds.has(r.messageId) && (r.kind === 'observer' || r.readAt <= at))
            await d.readStates.add({
              ...r,
              id:
                r.kind === 'observer'
                  ? `observer:${messageIds.get(r.messageId)!}`
                  : `character:${messageIds.get(r.messageId)!}:${r.readerId}`,
              messageId: messageIds.get(r.messageId)!,
            });
        const majors = (await d.majorEvents.where('worldId').equals(worldId).toArray()).filter(
          (e) => e.timestamp <= at && eventIds.has(e.eventId),
        );
        for (const major of majors) {
          const majorId = uid('major');
          await d.majorEvents.add({
            ...major,
            id: majorId,
            eventId: eventIds.get(major.eventId)!,
            worldId: id,
          });
          for (const n of await d.notifications.where('eventId').equals(major.id).toArray())
            await d.notifications.add({ ...n, id: uid('notice'), eventId: majorId, worldId: id });
        }
        if (world.majorEventSettings?.enabled) {
          const latest = majors.sort((a, b) => b.timestamp - a.timestamp)[0];
          await d.majorSchedules.put(
            nextMajorSchedule(
              id,
              latest?.timestamp ?? at,
              world.majorEventSettings.maximumIntervalDays,
              majors.length,
              latest?.type ?? '',
            ),
          );
        }
        for (const job of await d.contentJobs.where('worldId').equals(worldId).toArray()) {
          if (job.status === 'complete' || job.at > at || !eventIds.has(job.event.id)) continue;
          const event = await d.events.get(eventIds.get(job.event.id)!);
          if (!event) continue;
          const conversation = job.conversation
            ? await d.conversations.get(convIds.get(job.conversation.id)!)
            : undefined;
          await d.contentJobs.add({
            ...job,
            id: uid('job'),
            worldId: id,
            event,
            conversation,
            state: job.state
              ? {
                  ...job.state,
                  id: `${id}:${job.state.characterId}`,
                  worldId: id,
                  eventId: event.id,
                }
              : undefined,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: 0,
            error: undefined,
          });
        }
        const memories = await d.memories.where('worldId').equals(worldId).toArray();
        await d.memories.bulkAdd(
          memories
            .filter((m) => m.at <= at && (!m.eventId || eventIds.has(m.eventId)))
            .map((m) => ({
              ...m,
              id: uid('memory'),
              worldId: id,
              eventId: m.eventId ? eventIds.get(m.eventId) : undefined,
              conversationId: m.conversationId ? convIds.get(m.conversationId) : undefined,
            })),
        );
        const scenes = await d.scenes.where('worldId').equals(worldId).toArray();
        await d.scenes.bulkAdd(
          scenes
            .filter((s) => s.end <= at && eventIds.has(s.eventId))
            .map((s) => ({
              ...s,
              id: `scene:${eventIds.get(s.eventId)!}`,
              worldId: id,
              eventId: eventIds.get(s.eventId)!,
              phases: s.phases.map((p) => ({ ...p, id: uid('phase') })),
            })),
        );
        const knowledge = await d.backgroundKnowledge.where('worldId').equals(worldId).toArray();
        await d.backgroundKnowledge.bulkAdd(
          knowledge
            .filter((k) => (k.knownAt ?? 0) <= at)
            .map((k) => ({
              ...k,
              items: k.items.filter((item) => (item.learnedAt ?? 0) <= at),
              id: uid('knowledge'),
              worldId: id,
            })),
        );
        const states: RuntimeState[] = [];
        for (const m of memberships) {
          const e = events
            .filter((e) => e.participants.includes(m.characterId))
            .sort((a, b) => b.end - a.end)[0];
          if (e)
            states.push({
              id: `${id}:${m.characterId}`,
              worldId: id,
              characterId: m.characterId,
              eventId: eventIds.get(e.id)!,
              activity: '回到过去，等待生活继续',
              location: e.location,
              phone: e.phone,
              mood: 0,
              lastPhone: 0,
              lastAction: 0,
              lastTopicAt: at,
            });
        }
        await d.states.bulkAdd(states);
        await d.checkpoints.add({
          ...cp,
          id,
          clockAnchor: { simTime: at, realTime: now },
          simTime: at,
          realTime: now,
          lastEventAt: at,
          nextAt: at + 300000,
          paused: true,
          recoveryTarget: undefined,
          recoveryStart: undefined,
          recoveryRealTarget: undefined,
          recoveryKind: undefined,
          recoveryRequests: 0,
        });
        await d.settings.update('app', { worldId: id });
        return id;
      }),
    true,
  );
}

/** A calendar jump outside recorded history starts a fresh branch, keeping the original archive. */
export async function startCalendarBranch(
  worldId: string,
  date: import('./calendar').WorldDateTime,
  d: AquariumDB = db,
) {
  WorldDateTimeSchema.parse(date);
  cancelWorld(worldId);
  return d.transaction('rw', d.tables, async () => {
    const world = await d.worlds.get(worldId),
      cp = await d.checkpoints.get(worldId);
    if (!world || !cp) throw new Error('世界不存在');
    if (!cp.paused || cp.timeMode === 'real') throw new Error('请在上帝模式暂停后创建日期分支');
    const id = uid('world'),
      now = Date.now();
    await d.worlds.add({
      ...world,
      novel: restartNovel(world.novel, now),
      novelHistory: undefined,
      id,
      name: `${world.name.slice(0, 40)} · 新故事`,
      initialDate: date,
      calendarAnchor: { tick: now, date },
    });
    const focus = await d.observationConfigs.get(worldId);
    if (focus) await d.observationConfigs.put({ ...focus, id, updatedAt: now });
    for (const m of await d.memberships.where('worldId').equals(worldId).toArray())
      await d.memberships.add({ ...m, id: uid('member'), worldId: id });
    for (const r of await d.relationships.where('worldId').equals(worldId).toArray())
      await d.relationships.add({ ...r, id: uid('relation'), worldId: id });
    for (const g of await d.groups.filter((g) => g.worldIds.includes(worldId)).toArray())
      await d.groups.update(g.id, { worldIds: [...g.worldIds, id] });
    for (const m of await d.groupMembers.where('worldId').equals(worldId).toArray())
      await d.groupMembers.add({ ...m, id: uid('gm'), worldId: id });
    for (const k of await d.backgroundKnowledge.where('worldId').equals(worldId).toArray())
      await d.backgroundKnowledge.add({
        ...k,
        id: uid('knowledge'),
        worldId: id,
        knownAt: now,
        items: k.items.map((item) => ({ ...item, learnedAt: now })),
      });
    const groups = await d.groups.toArray();
    for (const c of await d.conversations.where('worldId').equals(worldId).toArray())
      if (!c.groupId || groups.find((g) => g.id === c.groupId)?.entityMode !== 'background')
        await d.conversations.add({
          ...c,
          id: uid('conv'),
          worldId: id,
          createdAt: now,
          lastAt: 0,
          controlledId: undefined,
        });
    for (const asset of await d.gifAssets.where('scopeId').equals(worldId).toArray())
      if (asset.scopeType === 'world')
        await d.gifAssets.add({ ...asset, id: uid('gif'), scopeId: id });
    if (world.majorEventSettings?.enabled)
      await d.majorSchedules.put(
        nextMajorSchedule(id, now, world.majorEventSettings.maximumIntervalDays),
      );
    await d.checkpoints.add({
      ...cp,
      id,
      clockAnchor: { simTime: now, realTime: now },
      simTime: now,
      realTime: now,
      lastEventAt: now,
      nextAt: now + 300000,
      paused: true,
      recoveryTarget: undefined,
      recoveryStart: undefined,
      recoveryRealTarget: undefined,
      recoveryKind: undefined,
      recoveryRequests: 0,
    });
    await d.settings.update('app', { worldId: id });
    return id;
  });
}

export async function settleClocks(
  now: number,
  activeSince: number | undefined,
  d: AquariumDB = db,
) {
  await d.transaction('rw', d.checkpoints, async () => {
    for (const cp of await d.checkpoints.toArray())
      if (!cp.paused)
        await d.checkpoints.update(cp.id, {
          clockAnchor: { simTime: clockTarget(cp, now, activeSince), realTime: now },
        });
  });
}
