import type { AquariumDB } from '../data/db';
import { evolvedCharacter } from '../core/selective-observation';
/** Bounded world-specific facts for ending suggestions; no unrelated world or full history. */
export async function novelGoalFacts(d: AquariumDB, worldId: string) {
  const members = await d.memberships
    .where('worldId')
    .equals(worldId)
    .and((m) => !m.inactive)
    .toArray();
  const characters = (await d.characters.bulkGet(members.map((m) => m.characterId)))
    .filter((c) => c && !c.deletedAt)
    .slice(0, 20);
  const ids = new Set(characters.map((c) => c!.id));
  const groups = await d.groups
    .filter((g) => !g.deletedAt && g.worldIds.includes(worldId))
    .limit(8)
    .toArray();
  const relations = await d.relationships
    .where('worldId')
    .equals(worldId)
    .and((r) => ids.has(r.from) && ids.has(r.to))
    .limit(20)
    .toArray();
  const recent = (
    await d.majorEvents
      .where('worldId')
      .equals(worldId)
      .and((e) => e.status === 'occurred')
      .sortBy('timestamp')
  ).slice(-8);
  return {
    characters: characters.map((c) => {
      const m = members.find((m) => m.characterId === c!.id),
        effective = evolvedCharacter(c!, m);
      return {
        id: c!.id,
        name: c!.name,
        identity: m?.identity,
        bio: (m?.bioOverride || c!.bio).slice(0, 180),
        personality: effective.personality.slice(0, 120),
      };
    }),
    groups: groups.map((g) => ({ name: g.name, description: g.description.slice(0, 160) })),
    relationships: relations.map((r) => ({
      from: r.from,
      to: r.to,
      label: r.label,
      attitude: r.attitude.slice(0, 120),
    })),
    recent: recent.map((e) => ({ title: e.title, description: e.description.slice(0, 300) })),
  };
}
