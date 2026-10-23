import { beforeEach, afterEach, it, expect } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import {
  buildTouhouPreset,
  ensureTouhouPresets,
  TOUHOU_WORLD_ID,
  TOUHOU_LEGACY_ID,
} from '../src/data/presets/touhou';
import { touhouSources, TOUHOU_CATALOG } from '../src/data/presets/touhou-sources';
import {
  CharacterSchema,
  WorldSchema,
  GroupSchema,
  RelationshipSchema,
  HOUR,
} from '../src/core/types';
import { exportBackup, validateBackup, importBackup } from '../src/data/backup';
import { planSegment } from '../src/core/simulation';
import { recycleEntity, purgeEntity } from '../src/data/recycle';
import { resolveObservation } from '../src/core/selective-observation';

// Added for the next authorized validation run; no network or AI provider is needed.
let d: AquariumDB;
const now = Date.parse('2026-10-24T01:00:00Z');
beforeEach(async () => {
  d = new AquariumDB('touhou-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  await d.delete();
});
it.each([false, true])(
  'canonical preset schema, source references and entity links are complete (legacy=%s)',
  (legacy) => {
    const preset = buildTouhouPreset(legacy, now);
    WorldSchema.parse(preset.world);
    const ids = new Set(preset.characters.map((c) => c.id));
    const groups = new Set(preset.groups.map((g) => g.id));
    expect(ids.size).toBe(preset.characters.length);
    expect(new Set(preset.relationships.map((r) => r.id)).size).toBe(preset.relationships.length);
    for (const c of preset.characters) {
      CharacterSchema.parse(c);
      expect(preset.world.locations).toContain(c.locationAccess?.home);
      for (const location of c.locationAccess?.usual ?? [])
        expect(preset.world.locations).toContain(location);
    }
    preset.groups.forEach((g) => GroupSchema.parse(g));
    for (const r of preset.relationships) {
      RelationshipSchema.parse(r);
      expect(ids.has(r.from) && ids.has(r.to) && r.from !== r.to && r.locked).toBe(true);
    }
    for (const m of preset.groupMembers)
      expect(ids.has(m.characterId) && groups.has(m.groupId)).toBe(true);
    for (const entity of [
      preset.world,
      ...preset.characters,
      ...preset.groups,
      ...preset.relationships,
    ])
      for (const id of entity.provenance?.sourceIds ?? []) expect(touhouSources[id]).toBeDefined();
  },
);
it('installs for existing users without replacing their world, histories or prompt settings', async () => {
  const before = await d.messages.toArray();
  await ensureTouhouPresets(d, now);
  expect(await d.characters.count()).toBe(181);
  expect(await d.worlds.count()).toBe(3);
  expect(await d.messages.toArray()).toEqual(before);
  expect((await d.settings.get('app'))?.worldId).toBe('w-harbor');
  expect((await d.checkpoints.get(TOUHOU_WORLD_ID))?.paused).toBe(true);
  expect((await resolveObservation(TOUHOU_WORLD_ID, d)).activeIds.size).toBe(2);
  await d.characters.update('th:reimu', { personality: '用户定制' });
  await ensureTouhouPresets(d, now + HOUR);
  expect((await d.characters.get('th:reimu'))?.personality).toBe('用户定制');
  validateBackup(await exportBackup(d));
});
it('keeps deletions and the install marker across backup restore instead of resurrecting presets', async () => {
  await ensureTouhouPresets(d, now);
  await recycleEntity('worlds', TOUHOU_LEGACY_ID, false, d);
  await purgeEntity('worlds', TOUHOU_LEGACY_ID, d);
  const backup = validateBackup(await exportBackup(d));
  await importBackup(backup, d);
  await ensureTouhouPresets(d, now + HOUR);
  expect(await d.worlds.get(TOUHOU_LEGACY_ID)).toBeUndefined();
  expect((await d.settings.get('app'))?.installedPresets?.[TOUHOU_CATALOG]).toBe(1);
});
it('does not teleport earth residents to lunar or other restricted locations during local planning', () => {
  const preset = buildTouhouPreset(false, now),
    characters = preset.characters.filter((c) =>
      ['th:reimu', 'th:marisa', 'th:toyohime'].includes(c.id),
    );
  const cp = {
    id: preset.world.id,
    simTime: now,
    realTime: now,
    seed: 42,
    lastEventAt: now,
    nextAt: now,
    paused: false,
    speed: 1,
    timeMode: 'god' as const,
    mode: 'demo' as const,
    recoveryRequests: 0,
  };
  for (let hour = 0; hour < 24; hour++) {
    const at = now + hour * HOUR;
    const plan = planSegment(
      preset.world,
      characters,
      preset.relationships,
      { ...cp, simTime: at, seed: hour + 1 },
      at + HOUR,
    );
    for (const event of plan.events)
      for (const id of event.participants)
        expect(characters.find((c) => c.id === id)?.locationAccess?.usual).toContain(
          event.location,
        );
  }
});
