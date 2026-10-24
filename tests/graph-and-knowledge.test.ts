import { expect, it } from 'vitest';
import { layoutGraph } from '../src/core/graph-layout';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { saveBackgroundKnowledge } from '../src/data/background-knowledge';
import { buildTouhouPreset, TOUHOU_WORLD_ID } from '../src/data/presets/touhou';
import { previewTouhouUpgrade, applyTouhouUpgrade } from '../src/data/presets/touhou-upgrade';
import { exportBackup, importBackup } from '../src/data/backup';
for (const mode of ['compact', 'readable'] as const)
  it(`keeps 500 nodes, long labels and isolated characters inside nonoverlapping ${mode} bounds`, () => {
    const nodes = Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      name: i % 7 === 0 ? '很长的角色名和不同语言🌟'.repeat(3) : '角色' + i,
    }));
    const edges = [
        { from: '1', to: '2' },
        { from: '2', to: '3' },
      ],
      groups = new Map(
        nodes.filter((_, i) => i % 3 === 0).map((n) => [n.id, '团体' + (Number(n.id) % 10)]),
      );
    const graph = layoutGraph(nodes, edges, mode, groups);
    expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(500);
    for (const a of graph.nodes) {
      expect(
        a.x >= 0 && a.y >= 0 && a.x + a.width <= graph.width && a.y + a.height <= graph.height,
      ).toBe(true);
      for (const b of graph.nodes) {
        if (a.id >= b.id) continue;
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
        ).toBe(true);
      }
    }
    expect(layoutGraph(nodes, edges, mode, groups)).toEqual(graph);
  });
it('keeps empty graphs finite and handles one node and absent endpoints', () => {
  for (const mode of ['compact', 'readable'] as const) {
    const g = layoutGraph([], [], mode);
    expect(g.width > 0 && g.height > 0).toBe(true);
    expect(
      layoutGraph([{ id: 'a', name: '甲' }], [{ from: 'a', to: 'missing' }], mode).nodes,
    ).toHaveLength(1);
  }
});
it('expands canonical links with asymmetric parameters and preserves the previous version for safe diffing', async () => {
  const next = buildTouhouPreset(false, 0),
    old = buildTouhouPreset(false, 0, 2),
    legacy = buildTouhouPreset(true, 0);
  console.log('Touhou preset coverage', {
    characters: next.characters.length + legacy.characters.length,
    relationships: next.relationships.length + legacy.relationships.length,
  });
  expect(next.relationships.length).toBeGreaterThan(old.relationships.length + 100);
  const edge = (a: string, b: string) =>
    next.relationships.find((r) => r.from === 'th:' + a && r.to === 'th:' + b)!;
  expect(edge('kaguya', 'mokou').familiarity).toBeGreaterThan(95);
  expect(edge('kaguya', 'mokou').trust).toBeLessThan(10);
  expect(edge('hisami', 'zanmu').closeness).toBeGreaterThan(edge('zanmu', 'hisami').closeness + 40);
  expect(
    next.relationships.every((r) => ![r.closeness, r.trust, r.familiarity].every((n) => n === 50)),
  ).toBe(true);
  expect(
    new Set(next.relationships.map((r) => [r.closeness, r.trust, r.familiarity].join())).size,
  ).toBeGreaterThan(65);
  expect(next.characters.find((c) => c.id === 'th:marisa')?.style).toContain('较劲');
  const d = new AquariumDB('upgrade-v3-' + crypto.randomUUID());
  try {
    await seed(d);
    await d.worlds.put(old.world);
    await d.characters.bulkPut(old.characters);
    await d.memberships.bulkPut(old.memberships);
    await d.relationships.bulkPut(old.relationships);
    const rows = await previewTouhouUpgrade(TOUHOU_WORLD_ID, d);
    const missing = rows.filter((r) => r.field === 'missing');
    expect(missing.length).toBeGreaterThan(100);
    await applyTouhouUpgrade(
      TOUHOU_WORLD_ID,
      rows.map((r) => `${r.id}:${r.field}`),
      true,
      d,
    );
    expect(await d.relationships.where('worldId').equals(TOUHOU_WORLD_ID).count()).toBe(
      next.relationships.length,
    );
    for (const r of old.relationships) expect(await d.relationships.get(r.id)).toEqual(r);
  } finally {
    await d.delete();
  }
});
it('edits existing knowledge in place, preserves timestamps and other actors, and supports upgraded entities', async () => {
  const d = new AquariumDB('knowledge-edit-' + crypto.randomUUID());
  try {
    await seed(d);
    await d.characters.update('c-toru', { entityMode: 'background' });
    const item = { kind: 'rumor' as const, content: '听说要办读书会', source: '澪转述' };
    const first = await saveBackgroundKnowledge(
      'w-harbor',
      'c-toru',
      'c-nagi',
      'partial',
      item,
      undefined,
      d,
    );
    await saveBackgroundKnowledge('w-harbor', 'c-toru', 'c-mio', 'name', undefined, undefined, d);
    const at = first.items[0].learnedAt;
    await d.checkpoints.update('w-harbor', { simTime: at! + 3600000 });
    const edited = await saveBackgroundKnowledge(
      'w-harbor',
      'c-toru',
      'c-nagi',
      'familiar',
      { ...item, kind: 'fact', content: '已经约好周末读书会' },
      0,
      d,
    );
    expect(edited.id).toBe(first.id);
    expect(edited.items).toHaveLength(1);
    expect(edited.items[0].learnedAt).toBe(at);
    expect(edited.knownAt).toBe(first.knownAt);
    await d.characters.update('c-toru', { entityMode: 'interactive' });
    await saveBackgroundKnowledge(
      'w-harbor',
      'c-toru',
      'c-nagi',
      'personal',
      undefined,
      undefined,
      d,
    );
    expect(await d.backgroundKnowledge.count()).toBe(2);
    await importBackup(await exportBackup(d), d);
    expect((await d.backgroundKnowledge.get(first.id))?.items[0].content).toBe(
      '已经约好周末读书会',
    );
    await expect(
      saveBackgroundKnowledge('other-world', 'c-toru', 'c-nagi', 'name', undefined, undefined, d),
    ).rejects.toThrow('当前世界');
  } finally {
    await d.delete();
  }
});
