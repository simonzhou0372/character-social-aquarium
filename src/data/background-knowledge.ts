import { db, type AquariumDB } from './db';
import { BackgroundKnowledgeSchema, uid, type BackgroundKnowledge } from '../core/types';
export async function saveBackgroundKnowledge(
  worldId: string,
  entityId: string,
  characterId: string,
  level: BackgroundKnowledge['level'],
  item?: BackgroundKnowledge['items'][number],
  itemIndex?: number,
  d: AquariumDB = db,
) {
  return d.transaction(
    'rw',
    [d.backgroundKnowledge, d.worlds, d.memberships, d.characters, d.groups, d.checkpoints],
    async () => {
      const member = await d.memberships
        .where('[worldId+characterId]')
        .equals([worldId, characterId])
        .first();
      const actor = await d.characters.get(characterId);
      const entity = await d.characters.get(entityId);
      const group = await d.groups.get(entityId);
      const associated = entity
        ? await d.memberships.where('[worldId+characterId]').equals([worldId, entityId]).first()
        : undefined;
      const world = await d.worlds.get(worldId);
      if (
        !world ||
        world.deletedAt ||
        !member ||
        member.inactive ||
        !actor ||
        actor.deletedAt ||
        !(
          (entity && !entity.deletedAt && associated && !associated.inactive) ||
          (group && !group.deletedAt && group.worldIds.includes(worldId))
        )
      )
        throw new Error('对象或知情角色不属于当前世界，或已被移除');
      const old = await d.backgroundKnowledge
        .where('worldId')
        .equals(worldId)
        .and((k) => k.entityId === entityId && k.characterId === characterId)
        .first();
      const at = (await d.checkpoints.get(worldId))?.simTime ?? world.calendarAnchor?.tick ?? 0;
      const items = [...(old?.items ?? [])];
      if (item) {
        if (itemIndex !== undefined) {
          if (!items[itemIndex]) throw new Error('此信息已不存在，请重新打开');
          items[itemIndex] = { ...item, learnedAt: items[itemIndex].learnedAt };
        } else items.push({ ...item, learnedAt: at });
      }
      const next = BackgroundKnowledgeSchema.parse({
        ...old,
        id: old?.id ?? uid('knowledge'),
        worldId,
        entityId,
        characterId,
        level,
        knownAt: old ? old.knownAt : at,
        items,
      });
      await d.backgroundKnowledge.put(next);
      return next;
    },
  );
}
