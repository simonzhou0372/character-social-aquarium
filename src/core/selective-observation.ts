import { ordinaryLife, ordinaryGroup } from './narrative';
import { getPrompts } from '../ai/prompts';
import { db, withWorldLock, type AquariumDB } from '../data/db';
import { ObservationConfigSchema, type ObservationConfig, type BackfillJob } from './focus-types';
import {
  DAY,
  uid,
  type Membership,
  type Conversation,
  type ActivityEvent,
  type Character,
} from './types';
import { cancelWorld } from './tasks';
export const fullObservation = (worldId: string): ObservationConfig => ({
  id: worldId,
  mode: 'full',
  characterIds: [],
  groupIds: [],
  pairs: [],
  updatedAt: 0,
});
export const pairKey = (pair: string[]) => 'pair:' + JSON.stringify([...pair].sort());
export function observationKeys(c: ObservationConfig) {
  return c.mode === 'full'
    ? ['world']
    : [
        ...c.characterIds.map((id) => 'character:' + id),
        ...c.groupIds.map((id) => 'group:' + id),
        ...c.pairs.map(pairKey),
      ];
}
export async function resolveObservation(worldId: string, d: AquariumDB = db) {
  const narrativeVersion = (await d.worlds.get(worldId))?.narrativeVersion ?? 0;
  const config = (await d.observationConfigs.get(worldId)) ?? fullObservation(worldId);
  const deleted = new Set(
    (await d.characters.where('deletedAt').above(0).primaryKeys()).map(String),
  );
  const deletedGroups = new Set(
    (await d.groups.where('deletedAt').above(0).primaryKeys()).map(String),
  );
  const members = await d.memberships
    .where('worldId')
    .equals(worldId)
    .and((m) => !m.inactive && !deleted.has(m.characterId))
    .toArray();
  const memberIds = new Set(members.map((m) => m.characterId));
  const lifeBlocked = new Set(
    members.filter((m) => !ordinaryLife(m.life?.status)).map((m) => m.characterId),
  );
  const organizations = await d.organizationStates.where('worldId').equals(worldId).toArray();
  const inactiveGroups = new Set(
    organizations.filter((s) => !ordinaryGroup(s.status)).map((s) => s.groupId),
  );
  const gm = await d.groupMembers
    .where('worldId')
    .equals(worldId)
    .and(
      (m) =>
        !m.departedAt &&
        !lifeBlocked.has(m.characterId) &&
        !inactiveGroups.has(m.groupId) &&
        memberIds.has(m.characterId) &&
        !deleted.has(m.characterId) &&
        !deletedGroups.has(m.groupId),
    )
    .toArray();
  const fullIds = new Set(
      config.characterIds.filter((id) => memberIds.has(id) && !deleted.has(id)),
    ),
    groupSets = config.groupIds.map(
      (id) => new Set(gm.filter((m) => m.groupId === id).map((m) => m.characterId)),
    );
  const ids =
    config.mode === 'full'
      ? members.map((m) => m.characterId)
      : [...new Set([...fullIds, ...groupSets.flatMap((s) => [...s]), ...config.pairs.flat()])];
  const backgroundIds = new Set(
    (await d.characters.where('entityMode').equals('background').primaryKeys()).map(String),
  );
  const interactiveCount = members.filter((m) => !backgroundIds.has(m.characterId)).length;
  const activeIds = new Set(
    ids.filter(
      (id) =>
        !lifeBlocked.has(id) && memberIds.has(id) && !backgroundIds.has(id) && !deleted.has(id),
    ),
  );
  const allowsConversation = (c: Conversation) =>
    c.kind !== 'notes' &&
    c.participants.every((id) => memberIds.has(id) && !deleted.has(id)) &&
    (!c.groupId || !deletedGroups.has(c.groupId)) &&
    (config.mode === 'full' ||
      c.participants.some((id) => fullIds.has(id)) ||
      (!!c.groupId && config.groupIds.includes(c.groupId)) ||
      (c.kind === 'direct' &&
        config.pairs.some((pair) => pair.every((id) => c.participants.includes(id)))));
  const allowsEvent = (e: Pick<ActivityEvent, 'participants'>) =>
    config.mode === 'full' ||
    e.participants.some((id) => fullIds.has(id)) ||
    config.pairs.some((pair) => pair.every((id) => e.participants.includes(id))) ||
    groupSets.some((group) => e.participants.filter((id) => group.has(id)).length >= 2);
  return {
    config,
    narrativeVersion,
    members,
    gm,
    fullIds,
    activeIds,
    interactiveCount,
    groupSets,
    allowsConversation,
    canScheduleConversation: (c: Conversation) =>
      allowsConversation(c) &&
      (c.groupId
        ? !inactiveGroups.has(c.groupId) &&
          gm.filter((m) => m.groupId === c.groupId && c.participants.includes(m.characterId))
            .length >= 2
        : c.participants.every((id) => !lifeBlocked.has(id))),
    lifeBlocked,
    hasNarrativeChanges: members.some((m) => !!m.life) || organizations.length > 0,
    allowsEvent,
  };
}
export function mergeIntervals(intervals: [number, number][]) {
  const result: [number, number][] = [];
  for (const [a, b] of [...intervals].filter(([a, b]) => a < b).sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else result.push([a, b]);
  }
  return result;
}
export async function recordCoverage(
  worldId: string,
  targets: string[],
  start: number,
  end: number,
  d: AquariumDB = db,
) {
  if (end <= start) return;
  for (const target of targets) {
    const id = worldId + ':' + target,
      old = await d.observationCoverage.get(id);
    await d.observationCoverage.put({
      id,
      worldId,
      target,
      intervals: mergeIntervals([...(old?.intervals ?? []), [start, end]]).slice(-512),
    });
  }
}
export async function uncoveredStart(
  worldId: string,
  targets: string[],
  start: number,
  end: number,
  d: AquariumDB = db,
) {
  let first = end;
  const global = (await d.observationCoverage.get(worldId + ':world'))?.intervals ?? [];
  for (const target of targets) {
    const coverage = mergeIntervals([
      ...global,
      ...((await d.observationCoverage.get(worldId + ':' + target))?.intervals ?? []),
    ]);
    let cursor = start;
    for (const [a, b] of coverage) {
      if (a > cursor) break;
      if (b > cursor) cursor = b;
    }
    first = Math.min(first, Math.min(cursor, end));
  }
  return first;
}
export async function saveObservation(input: ObservationConfig, d: AquariumDB = db) {
  const config = ObservationConfigSchema.parse(input);
  cancelWorld(config.id);
  cancelWorld('content:' + config.id);
  return withWorldLock(
    config.id,
    () =>
      d.transaction('rw', d.tables, async () => {
        const cp = await d.checkpoints.get(config.id),
          world = await d.worlds.get(config.id);
        if (!cp || !world) throw new Error('世界不存在');
        const old = (await d.observationConfigs.get(config.id)) ?? fullObservation(config.id);
        const members = await d.memberships.where('worldId').equals(config.id).toArray();
        const exists = (id: string) => members.some((m) => m.characterId === id);
        if (
          config.characterIds.some((id) => !exists(id)) ||
          config.pairs.some((p) => p[0] === p[1] || p.some((id) => !exists(id)))
        )
          throw new Error('观察对象不属于当前世界');
        for (const id of config.groupIds)
          if (!(await d.groups.get(id))?.worldIds.includes(config.id))
            throw new Error('团体不属于当前世界');
        config.characterIds = [...new Set(config.characterIds)];
        config.groupIds = [...new Set(config.groupIds)];
        config.pairs = config.pairs.filter(
          (p, i, a) => a.findIndex((q) => pairKey(p) === pairKey(q)) === i,
        );
        const previous = new Set(observationKeys(old)),
          keys = observationKeys(config);
        const added = keys.filter((key) => !previous.has(key));
        // Leaving full observation does not retroactively make existing history missing.
        if (old.mode === 'full')
          await recordCoverage(
            config.id,
            ['world'],
            world.calendarAnchor?.tick ?? cp.simTime,
            cp.simTime,
            d,
          );
        await d.observationConfigs.put({
          ...config,
          updatedAt: Math.max(Date.now(), old.updatedAt + 1),
        });
        await d.checkpoints.update(cp.id, { controlVersion: (cp.controlVersion ?? 0) + 1 });
        // Already queued, unrelated fine-grained work must not wake dormant networks.
        const scope = await resolveObservation(config.id, d);
        for (const job of await d.contentJobs.where('worldId').equals(config.id).toArray()) {
          const relevant =
            job.kind === 'chat' && job.conversation
              ? scope.allowsConversation(job.conversation)
              : scope.allowsEvent(job.event);
          if (job.status !== 'complete' && !relevant)
            await d.contentJobs.update(job.id, {
              status: 'failed',
              attempts: 3,
              error: '观察范围变更，相关对象静默，任务已挂起',
            });
          else if (relevant && job.status === 'failed' && job.error?.startsWith('观察范围变更'))
            await d.contentJobs.update(job.id, {
              status: 'pending',
              attempts: 0,
              nextAttemptAt: 0,
              error: undefined,
            });
        }
        for (const job of await d.backfillJobs.where('worldId').equals(config.id).toArray()) {
          if (job.status === 'complete' || config.mode === 'full') continue;
          const remaining = job.targets.filter((t) => keys.includes(t));
          if (!remaining.length)
            await d.backfillJobs.update(job.id, {
              status: 'paused',
              error: '观察对象已取消，任务保留',
            });
          else if (remaining.length !== job.targets.length)
            await d.backfillJobs.update(job.id, {
              targets: remaining,
              characterIds: job.characterIds.filter((id) => scope.activeIds.has(id)),
              groupIds: job.groupIds.filter((id) => config.groupIds.includes(id)),
              pairs: job.pairs.filter((pair) =>
                config.pairs.some((p) => pairKey(pair) === pairKey(p)),
              ),
            });
        }
        if (!added.length) return undefined;
        const end = cp.simTime,
          start = Math.max(world.calendarAnchor?.tick ?? end, end - 3 * DAY);
        const actualStart = await uncoveredStart(config.id, added, start, end, d);
        if (actualStart >= end) return undefined;
        const characterIds =
          config.mode === 'full'
            ? members.map((m) => m.characterId)
            : [
                ...new Set([
                  ...config.characterIds.filter((id) => added.includes('character:' + id)),
                  ...config.pairs.filter((p) => added.includes(pairKey(p))).flat(),
                  ...scope.gm
                    .filter((m) => added.includes('group:' + m.groupId))
                    .map((m) => m.characterId),
                ]),
              ];
        const prior = await d.backfillJobs
          .where('worldId')
          .equals(config.id)
          .and(
            (j) =>
              j.status !== 'complete' &&
              j.targets.some((t) => added.includes(t)) &&
              j.end >= actualStart,
          )
          .first();
        if (prior) {
          await d.backfillJobs.update(prior.id, {
            targets: [...new Set([...prior.targets, ...added])],
            characterIds: [...new Set([...prior.characterIds, ...characterIds])],
            groupIds: config.groupIds,
            pairs: config.pairs,
            start: Math.min(prior.start, actualStart),
            checkpoint: Math.min(prior.checkpoint, actualStart),
            end,
            status: 'pending',
            error: undefined,
          });
          return prior.id;
        }
        const job: BackfillJob = {
          id: uid('backfill'),
          worldId: config.id,
          targets: added,
          characterIds,
          groupIds: config.groupIds.filter((id) => added.includes('group:' + id)),
          pairs: config.pairs.filter((p) => added.includes(pairKey(p))),
          start: actualStart,
          end,
          checkpoint: actualStart,
          completedIntervals: [],
          status: 'pending',
          eventCount: 0,
          messageCount: 0,
          contentJobIds: [],
          notes: [],
          createdAt: Date.now(),
          snapshot: await getPrompts(d),
        };
        await d.backfillJobs.add(job);
        return job.id;
      }),
    true,
  );
}
export function evolvedCharacter(
  c: Character,
  m?: Pick<Membership, 'evolved' | 'behaviorOverride'>,
  enabled = true,
): Character {
  return { ...c, ...m?.behaviorOverride, ...m?.evolved };
}
/** Recover the dynamic field values known at a historical request time; future growth is not past knowledge. */
export async function historicalCharacter(
  d: AquariumDB,
  c: Character,
  m: Parameters<typeof evolvedCharacter>[1],
  worldId: string,
  at: number,
) {
  let result = evolvedCharacter(c, m);
  const records = await d.evolutionRecords
    .where('characterId')
    .equals(c.id)
    .and((r) => r.worldId === worldId && r.status === 'applied')
    .sortBy('at');
  for (const field of ['initiative', 'personality', 'style', 'habits', 'goal', 'values', 'fear'] as const) {
    const chain = records.filter((r) => r.field === field),
      past = chain.filter((r) => r.at <= at).at(-1),
      future = chain.find((r) => r.at > at);
    if (past || future) result = { ...result, [field]: past?.newValue ?? future!.previousValue };
  }
  return result;
}
