import type { AquariumDB } from './db';
import { uid, type BackgroundKnowledge } from '../core/types';
/** Propagate only words actually heard/read, never the speaker's whole private dossier. */
export async function recordHeardInformation(
  d: AquariumDB,
  worldId: string,
  speakerId: string,
  text: string,
  listeners: string[],
  source: string,
) {
  if (speakerId === 'user' || !listeners.length) return;
  await d.transaction('rw', [d.backgroundKnowledge, d.characters, d.groups], async () => {
    const records = await d.backgroundKnowledge.where('worldId').equals(worldId).toArray();
    for (const knowledge of records.filter(
      (k) => k.characterId === speakerId && k.level !== 'unknown',
    )) {
      const entity =
        (await d.characters.get(knowledge.entityId)) ?? (await d.groups.get(knowledge.entityId));
      if (!entity || !text.includes(entity.name)) continue;
      const spoken =
        knowledge.level === 'name'
          ? []
          : knowledge.items.filter((item) => item.content && text.includes(item.content));
      for (const characterId of [...new Set(listeners)].filter((id) => id !== speakerId)) {
        const old = records.find(
          (k) => k.entityId === knowledge.entityId && k.characterId === characterId,
        );
        const items = [...(old?.items ?? [])];
        for (const item of spoken)
          if (!items.some((i) => i.kind === item.kind && i.content === item.content))
            items.push({ ...item, source });
        const record: BackgroundKnowledge = {
          id: old?.id ?? uid('knowledge'),
          worldId,
          entityId: knowledge.entityId,
          characterId,
          level: !old || old.level === 'unknown' ? (spoken.length ? 'partial' : 'name') : old.level,
          items,
        };
        await d.backgroundKnowledge.put(record);
        if (old) Object.assign(old, record);
        else records.push(record);
      }
    }
  });
}
