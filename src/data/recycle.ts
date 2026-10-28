import { db, type AquariumDB } from './db';
import { cancelWorld } from '../core/tasks';
export type RecycleKind = 'worlds' | 'groups' | 'characters';
export const recycleNames = { worlds: '世界', groups: '团体', characters: '角色' };

async function affectedWorlds(kind: RecycleKind, id: string, d: AquariumDB) {
  return kind === 'worlds'
    ? [id]
    : kind === 'groups'
      ? ((await d.groups.get(id))?.worldIds ?? [])
      : (await d.memberships.where('characterId').equals(id).toArray()).map((m) => m.worldId);
}
async function selectAvailableWorld(d: AquariumDB) {
  const settings = await d.settings.get('app');
  if (
    settings &&
    !(await d.worlds.get(settings.worldId))?.deletedAt &&
    (await d.worlds.get(settings.worldId))
  )
    return;
  const next = await d.worlds.filter((w) => !w.deletedAt).first();
  if (settings) await d.settings.update('app', { worldId: next?.id ?? '' });
}
export async function recycleEntity(
  kind: RecycleKind,
  id: string,
  restore = false,
  d: AquariumDB = db,
) {
  const worldIds = await affectedWorlds(kind, id, d);
  for (const worldId of worldIds) {
    cancelWorld(worldId);
    cancelWorld('content:' + worldId);
  }
  await d.transaction('rw', d.tables, async () => {
    const entity = await d.table(kind).get(id);
    if (!entity) throw new Error('对象不存在');
    await d.table(kind).update(id, { deletedAt: restore ? undefined : Date.now() });
    for (const worldId of worldIds) {
      const cp = await d.checkpoints.get(worldId);
      if (cp)
        await d.checkpoints.update(worldId, {
          controlVersion: (cp.controlVersion ?? 0) + 1,
          ...(kind === 'worlds'
            ? {
                paused: true,
                realTime: Date.now(),
                clockAnchor: { simTime: cp.simTime, realTime: Date.now() },
                recoveryTarget: undefined,
                recoveryStart: undefined,
                recoveryRealTarget: undefined,
              }
            : {}),
        });
    }
    if (restore) {
      for (const j of await d.backfillJobs.toArray())
        if (j.error?.startsWith('对象已移入回收站'))
          await d.backfillJobs.update(j.id, { status: 'pending', error: undefined });
      for (const j of await d.contentJobs.toArray())
        if (j.error?.startsWith('对象已移入回收站'))
          await d.contentJobs.update(j.id, {
            status: 'pending',
            attempts: 0,
            nextAttemptAt: 0,
            error: undefined,
          });
    }
    await selectAvailableWorld(d);
  });
}

/** Physical removal is available only for tombstoned entities, after the UI's second confirmation. */
export async function purgeEntity(kind: RecycleKind, id: string, d: AquariumDB = db) {
  const worldIds = await affectedWorlds(kind, id, d);
  for (const w of worldIds) {
    cancelWorld(w);
    cancelWorld('content:' + w);
  }
  await d.transaction('rw', d.tables, async () => {
    if (!(await d.table(kind).get(id))?.deletedAt) throw new Error('请先将对象移入回收站');
    const rows: Record<string, any[]> = {};
    for (const t of d.tables) rows[t.name] = await t.toArray();
    const removed = new Map<string, Set<string>>();
    const mark = (table: string, predicate: (row: any) => boolean) => {
      const ids = removed.get(table) ?? new Set<string>();
      for (const row of rows[table]) if (predicate(row)) ids.add(row.id);
      removed.set(table, ids);
    };
    const gone = (table: string, key: string | undefined) =>
      !!key && !!removed.get(table)?.has(key);
    mark(kind, (r) => r.id === id);
    for (const table of d.tables.map((t) => t.name))
      if (
        kind === 'worlds' &&
        ![
          'worlds',
          'groups',
          'characters',
          'settings',
          'profiles',
          'resources',
          'usage',
          'promptConfigs',
        ].includes(table)
      )
        mark(
          table,
          (r) =>
            r.worldId === id ||
            ([
              'checkpoints',
              'taskSnapshots',
              'observationConfigs',
              'majorSchedules',
              'evolutionCursors',
            ].includes(table) &&
              r.id === id),
        );
    if (kind === 'characters') {
      mark('memberships', (r) => r.characterId === id);
      mark('groupMembers', (r) => r.characterId === id);
      mark('relationships', (r) => r.from === id || r.to === id);
      mark('events', (r) => r.participants.includes(id));
      mark('conversations', (r) => r.participants.includes(id));
      mark('backgroundKnowledge', (r) => r.characterId === id || r.entityId === id);
      mark('backfillJobs', (r) => r.characterIds.includes(id));
    }
    if (kind === 'groups') {
      mark('groupMembers', (r) => r.groupId === id);
      mark('conversations', (r) => r.groupId === id);
      mark('backgroundKnowledge', (r) => r.entityId === id);
      mark('backfillJobs', (r) => r.groupIds.includes(id));
    }
    for (let i = 0; i < rows.events.length; i++) {
      const before = removed.get('events')?.size ?? 0;
      mark('events', (r) => gone('events', r.dependsOn));
      if ((removed.get('events')?.size ?? 0) === before) break;
    }
    mark('scenes', (r) => gone('events', r.eventId));
    mark('states', (r) => gone('events', r.eventId));
    mark('messages', (r) => gone('conversations', r.conversationId) || gone('events', r.eventId));
    mark('cursors', (r) => gone('conversations', r.conversationId));
    mark(
      'memories',
      (r) =>
        gone('conversations', r.conversationId) ||
        gone('events', r.eventId) ||
        (kind === 'characters' && (r.owners.includes(id) || r.knownBy?.includes(id))),
    );
    mark(
      'contentJobs',
      (r) =>
        gone('events', r.event.id) ||
        gone('conversations', r.conversation?.id) ||
        (kind === 'groups' && r.conversation?.groupId === id),
    );
    mark(
      'narrativeChanges',
      (r) =>
        gone('events', r.eventId) ||
        (r.entityKind === 'character' && gone('characters', r.entityId)) ||
        (r.entityKind === 'group' && gone('groups', r.entityId)),
    );
    mark('organizationStates', (r) => gone('events', r.eventId) || gone('groups', r.groupId));
    for (const member of rows.memberships)
      if (member.life && gone('events', member.life.eventId) && !gone('memberships', member.id))
        await d.memberships.update(member.id, { life: undefined });
    mark('majorEvents', (r) => gone('events', r.eventId));
    mark('notifications', (r) => gone('majorEvents', r.eventId));
    mark('readStates', (r) => gone('messages', r.messageId));
    mark('reactions', (r) => gone('messages', r.messageId));
    mark(
      'gifAssets',
      (r) =>
        r.scopeId === id &&
        r.scopeType === { worlds: 'world', characters: 'character', groups: 'group' }[kind],
    );
    // An evidence deletion invalidates its dependent evolution chain as well.
    for (let i = 0; i <= rows.evolutionRecords.length; i++) {
      const before = removed.get('evolutionRecords')?.size ?? 0;
      mark(
        'evolutionRecords',
        (r) =>
          (kind === 'characters' && r.characterId === id) ||
          r.sourceEventIds.some((e: string) => gone('events', e)) ||
          gone('evolutionRecords', r.dependsOn),
      );
      if ((removed.get('evolutionRecords')?.size ?? 0) === before) break;
    }
    for (const m of rows.memberships) {
      if (gone('memberships', m.id)) continue;
      const records = rows.evolutionRecords
        .filter(
          (r) =>
            gone('evolutionRecords', r.id) &&
            r.characterId === m.characterId &&
            r.worldId === m.worldId &&
            r.status === 'applied',
        )
        .sort((a, b) => a.at - b.at);
      const evolved = { ...m.evolved };
      for (const field of [...new Set(records.map((r) => r.field))]) {
        const chain = records.filter((r) => r.field === field);
        if (evolved[field] === chain.at(-1)?.newValue) evolved[field] = chain[0].previousValue;
      }
      if (records.length) await d.memberships.update(m.id, { evolved });
    }
    const sourceTables: Record<string, string> = {
      event: 'events',
      message: 'messages',
      scene: 'scenes',
      memory: 'memories',
      evolution: 'evolutionRecords',
    };
    mark('worldReports', (r) => r.sources.some((s: any) => gone(sourceTables[s.type], s.id)));
    // Purging source facts invalidates their narrative evidence, never leaves a completed ending with missing proof.
    for (const world of rows.worlds) {
      if (gone('worlds', world.id) || !world.novel) continue;
      const n = world.novel;
      if (
        n.milestones.some((m: any) => gone('events', m.eventId)) ||
        n.conditions.some((c: any) => c.evidence.some((e: any) => gone('events', e.eventId)))
      )
        await d.worlds.update(world.id, {
          novel: {
            ...n,
            milestones: n.milestones.filter((m: any) => !gone('events', m.eventId)),
            conditions: n.conditions.map((c: any) => ({
              ...c,
              evidence: c.evidence.filter((e: any) => !gone('events', e.eventId)),
            })),
            ending: undefined,
            stage: n.stage === 'completed' ? 'finale' : n.stage,
          },
        });
    }
    for (const r of rows.messages)
      if (!gone('messages', r.id)) {
        const { replyToMessageId, gifAssetId } = r;
        await d.messages.update(r.id, {
          replyToMessageId: gone('messages', replyToMessageId) ? undefined : replyToMessageId,
          gifAssetId: gone('gifAssets', gifAssetId) ? undefined : gifAssetId,
        });
      }
    for (const g of rows.groups)
      if (!gone('groups', g.id) && kind === 'worlds')
        await d.groups.update(g.id, { worldIds: g.worldIds.filter((w: string) => w !== id) });
    for (const m of rows.majorEvents)
      if (!gone('majorEvents', m.id) && kind === 'groups')
        await d.majorEvents.update(m.id, { groupIds: m.groupIds.filter((g: string) => g !== id) });
    for (const c of rows.observationConfigs)
      if (!gone('observationConfigs', c.id))
        await d.observationConfigs.update(c.id, {
          characterIds: c.characterIds.filter((v: string) => !gone('characters', v)),
          groupIds: c.groupIds.filter((v: string) => !gone('groups', v)),
          pairs: c.pairs.filter((p: string[]) => !p.some((v) => gone('characters', v))),
          updatedAt: Date.now(),
        });
    for (const j of rows.backfillJobs)
      if (!gone('backfillJobs', j.id))
        await d.backfillJobs.update(j.id, {
          contentJobIds: j.contentJobIds.filter((v: string) => !gone('contentJobs', v)),
        });
    for (const [table, ids] of removed) if (ids.size) await d.table(table).bulkDelete([...ids]);
    for (const w of worldIds) {
      const cp = await d.checkpoints.get(w);
      if (cp) await d.checkpoints.update(w, { controlVersion: (cp.controlVersion ?? 0) + 1 });
    }
    await selectAvailableWorld(d);
  });
}
