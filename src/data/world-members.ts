import { db, type AquariumDB } from './db';
import { uid } from '../core/types';
export async function importMembers(worldId: string, ids: string[], d: AquariumDB = db) {
  return d.transaction('rw', d.worlds, d.characters, d.memberships, async () => {
    const w = await d.worlds.get(worldId);
    if (!w || w.deletedAt) throw new Error('世界不可用');
    const chars = await d.characters.bulkGet([...new Set(ids)]);
    if (chars.some((c) => !c || c.deletedAt)) throw new Error('角色不可用');
    for (const c of chars)
      if (c) {
        const old = await d.memberships
          .where('[worldId+characterId]')
          .equals([worldId, c.id])
          .first();
        if (old) await d.memberships.update(old.id, { inactive: false });
        else
          await d.memberships.add({
            id: uid('member'),
            worldId,
            characterId: c.id,
            identity: '',
            bioOverride: '',
            styleOverride: '',
          });
      }
  });
}
// Archive the association rather than break historical references.
export async function removeMember(worldId: string, characterId: string, d: AquariumDB = db) {
  return d.transaction('rw', d.memberships, d.checkpoints, async () => {
    const m = await d.memberships
      .where('[worldId+characterId]')
      .equals([worldId, characterId])
      .first();
    if (m) await d.memberships.update(m.id, { inactive: true });
    const cp = await d.checkpoints.get(worldId);
    if (cp) await d.checkpoints.update(worldId, { controlVersion: (cp.controlVersion ?? 0) + 1 });
  });
}
