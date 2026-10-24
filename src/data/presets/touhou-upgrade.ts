import { db, type AquariumDB } from '../db';
import { buildTouhouPreset, TOUHOU_WORLD_ID, TOUHOU_LEGACY_ID } from './touhou';
import { recycleEntity, purgeEntity } from '../recycle';
import { TOUHOU_CATALOG } from './touhou-sources';
export type PresetDiff = {
  id: string;
  name: string;
  kind: 'character' | 'relationship';
  field: string;
  before: unknown;
  after: unknown;
  blocked: boolean;
  reason?: string;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export async function previewTouhouUpgrade(worldId: string, d: AquariumDB = db) {
  if (![TOUHOU_WORLD_ID, TOUHOU_LEGACY_ID].includes(worldId)) return [];
  const legacy = worldId === TOUHOU_LEGACY_ID,
    old = buildTouhouPreset(legacy, 0, 1),
    next = buildTouhouPreset(legacy, 0),
    rows: PresetDiff[] = [];
  for (const c of next.characters) {
    const current = await d.characters.get(c.id),
      baseline = old.characters.find((o) => o.id === c.id),
      m = await d.memberships.where('[worldId+characterId]').equals([worldId, c.id]).first();
    if (!current || !baseline || !m) continue;
    for (const field of [
      'style',
      'initiative',
      'topicIntervalMinutes',
      'replyChance',
      'socialBehavior',
    ] as const) {
      const effective = { ...current, ...m.behaviorOverride, ...m.evolved };
      const before = effective[field],
        after = c[field];
      if (!same(before, after))
        rows.push({
          id: c.id,
          name: c.name,
          kind: 'character',
          field,
          before,
          after,
          blocked: !same(before, baseline[field]) || (!!m.styleOverride && field === 'style'),
          reason: '此字段已修改，保留用户设定',
        });
    }
  }
  for (const r of next.relationships) {
    const current = await d.relationships
      .where('[worldId+from+to]')
      .equals([worldId, r.from, r.to])
      .first();
    if (!current) {
      rows.push({
        id: r.id,
        name: r.label,
        kind: 'relationship',
        field: 'missing',
        before: null,
        after: r,
        blocked: false,
      });
      continue;
    }
    const baseline = old.relationships.find((o) => o.from === r.from && o.to === r.to)!;
    for (const field of [
      'closeness',
      'trust',
      'familiarity',
      'attitude',
      'behavior',
      'stage',
    ] as const) {
      if (!same(current[field], r[field]))
        rows.push({
          id: current.id,
          name: `${r.from} → ${r.to}`,
          kind: 'relationship',
          field,
          before: current[field],
          after: r[field],
          blocked: current.locked || !same(current[field], baseline[field]),
          reason: current.locked ? '关系已锁定，需先手动解锁才能更新' : '此字段已修改',
        });
    }
  }
  return rows;
}
export async function applyTouhouUpgrade(
  worldId: string,
  selection: string[],
  missingOnly: boolean,
  d: AquariumDB = db,
) {
  return d.transaction('rw', d.tables, async () => {
    const rows = await previewTouhouUpgrade(worldId, d);
    let count = 0;
    for (const row of rows) {
      if (
        row.blocked ||
        !selection.includes(`${row.id}:${row.field}`) ||
        (missingOnly && row.field !== 'missing')
      )
        continue;
      if (row.kind === 'character') {
        const m = await d.memberships
          .where('[worldId+characterId]')
          .equals([worldId, row.id])
          .first();
        if (m)
          await d.memberships.update(m.id, {
            behaviorOverride: { ...m.behaviorOverride, [row.field]: row.after },
          });
      } else if (row.field === 'missing')
        await d.relationships.add(
          row.after as ReturnType<typeof buildTouhouPreset>['relationships'][number],
        );
      else
        await d.relationships.update(row.id, (r) => {
          Object.assign(r, { [row.field]: row.after });
        });
      count++;
    }
    await d.worlds.update(worldId, { presetVersion: 2 });
    return count;
  });
}
/** User-triggered replacement. Preserve characters and groups that other worlds reference. */
export async function resetTouhouWorld(worldId: string, d: AquariumDB = db, now = Date.now()) {
  if (![TOUHOU_WORLD_ID, TOUHOU_LEGACY_ID].includes(worldId))
    throw new Error('只能重建内置东方世界');
  await d.transaction('rw', d.tables, async () => {
    const selected = (await d.settings.get('app'))?.worldId === worldId;
    if (await d.worlds.get(worldId)) {
      await recycleEntity('worlds', worldId, false, d);
      await purgeEntity('worlds', worldId, d);
    }
    const p = buildTouhouPreset(worldId === TOUHOU_LEGACY_ID, now);
    await d.worlds.add(p.world);
    for (const c of p.characters) {
      const shared = await d.memberships.where('characterId').equals(c.id).count();
      if (!shared) await d.characters.put(c);
    }
    await d.memberships.bulkAdd(
      p.memberships.map((m) => {
        const c = p.characters.find((c) => c.id === m.characterId)!;
        return {
          ...m,
          behaviorOverride: {
            style: c.style,
            initiative: c.initiative,
            topicIntervalMinutes: c.topicIntervalMinutes,
            replyChance: c.replyChance,
            socialBehavior: c.socialBehavior,
          },
        };
      }),
    );
    for (const g of p.groups) {
      const old = await d.groups.get(g.id);
      await d.groups.put(
        old?.worldIds.length ? { ...old, worldIds: [...new Set([...old.worldIds, worldId])] } : g,
      );
    }
    await d.groupMembers.bulkAdd(p.groupMembers);
    await d.relationships.bulkAdd(p.relationships);
    await d.checkpoints.put({
      id: worldId,
      simTime: now,
      realTime: now,
      clockAnchor: { simTime: now, realTime: now },
      seed: 524287,
      lastEventAt: now,
      nextAt: now + 300000,
      paused: true,
      speed: 1,
      timeMode: 'god',
      mode: 'live',
      recoveryRequests: 0,
    });
    await d.observationConfigs.put({
      id: worldId,
      mode: 'selective',
      characterIds:
        worldId === TOUHOU_LEGACY_ID
          ? ['th:old-reimu', 'th:old-marisa']
          : ['th:reimu', 'th:marisa'],
      groupIds: [],
      pairs: [],
      updatedAt: now,
    });
    const settings = await d.settings.get('app');
    if (settings)
      await d.settings.update('app', {
        ...(selected ? { worldId } : {}),
        installedPresets: { ...settings.installedPresets, [TOUHOU_CATALOG]: 2 },
      });
  });
}
