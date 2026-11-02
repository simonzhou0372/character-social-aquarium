import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { copyWorld } from '../src/data/worlds';

const NOW = Date.parse('2026-10-22T10:00:00Z');
let d: AquariumDB;

beforeEach(async () => {
  d = new AquariumDB('world-copy-' + crypto.randomUUID());
  await seed(d, NOW);
});
afterEach(async () => {
  await d.delete();
});

describe('copy world', () => {
  it('creates an independent world without copying chat or life history', async () => {
    const before = {
      characters: await d.characters.count(),
      memberships: await d.memberships.count(),
      groups: await d.groups.count(),
      groupMembers: await d.groupMembers.count(),
      relationships: await d.relationships.count(),
      messages: await d.messages.count(),
      events: await d.events.count(),
    };

    const id = await copyWorld('w-harbor', d);
    expect(id).not.toBe('w-harbor');
    const world = await d.worlds.get(id);
    expect(world?.name).toBe('海盐市 · 平行日常（副本）');
    expect((await d.settings.get('app'))?.worldId).toBe(id);
    expect((await d.checkpoints.get(id))?.paused).toBe(true);

    // Structure is duplicated; history is not.
    expect(await d.characters.count()).toBe(before.characters * 2);
    expect(await d.memberships.count()).toBe(before.memberships * 2);
    expect(await d.groups.count()).toBe(before.groups * 2);
    expect(await d.groupMembers.count()).toBe(before.groupMembers * 2);
    expect(await d.relationships.count()).toBe(before.relationships * 2);
    expect(await d.messages.count()).toBe(before.messages);
    expect(await d.events.count()).toBe(before.events);

    const memberships = await d.memberships.where('worldId').equals(id).toArray();
    expect(memberships).toHaveLength(before.characters);
    // References must point at the copy's own characters/groups.
    const relationships = await d.relationships.where('worldId').equals(id).toArray();
    expect(relationships).toHaveLength(before.relationships);
    for (const relation of relationships) {
      expect(await d.characters.get(relation.from)).toBeTruthy();
      expect(await d.characters.get(relation.to)).toBeTruthy();
    }
    const groups = await d.groups.filter((g) => g.worldIds.includes(id)).toArray();
    expect(groups).toHaveLength(before.groups);
    for (const group of groups)
      expect(await d.groupMembers.where('groupId').equals(group.id).count()).toBeGreaterThan(0);

    // The source world is untouched and can be copied again under a new name.
    expect((await d.worlds.get('w-harbor'))?.name).toBe('海盐市 · 平行日常');
    expect(await d.memberships.where('worldId').equals('w-harbor').count()).toBe(
      before.memberships,
    );
    const second = await copyWorld('w-harbor', d);
    expect((await d.worlds.get(second))?.name).toBe('海盐市 · 平行日常（副本 2）');
  });

  it("restarts a copied novel world at the story's starting point", async () => {
    await d.worlds.update('w-harbor', {
      novel: {
        enabled: true,
        goal: '一起完成夏日祭的演出',
        stage: 'finale',
        conditions: [],
        milestones: [],
        unresolved: ['演出能否成功'],
        startedAt: NOW,
      },
    });
    const id = await copyWorld('w-harbor', d);
    const world = await d.worlds.get(id);
    expect(world?.novel?.enabled).toBe(true);
    expect(world?.novel?.goal).toBe('一起完成夏日祭的演出');
    expect(world?.novel?.stage).toBe('foundation');
    expect(world?.novel?.conditions).toEqual([]);
    expect(world?.novel?.milestones).toEqual([]);
    expect(world?.novelHistory).toBeUndefined();
  });
});
