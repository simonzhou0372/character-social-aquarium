import { db, type AquariumDB } from './db';
export async function renameConversation(
  id: string,
  title: string | undefined,
  avatar?: string,
  d: AquariumDB = db,
) {
  return d.transaction('rw', d.conversations, d.characters, d.groups, async () => {
    const c = await d.conversations.get(id);
    if (!c) throw new Error('会话不存在');
    if (title !== undefined && (!title.trim() || title.length > 200))
      throw new Error('名称须为1～200字符');
    const names = await d.characters.where('id').anyOf(c.participants).toArray();
    const automatic = c.groupId
      ? ((await d.groups.get(c.groupId))?.name ?? c.autoTitle ?? c.name)
      : names.map((c) => c.name).join(' & ');
    await d.conversations.update(id, {
      name: title?.trim() ?? automatic,
      customTitle: title?.trim(),
      autoTitle: automatic,
      titleMode: title === undefined ? 'auto' : 'custom',
      ...(avatar !== undefined ? { avatar } : {}),
    });
  });
}
export async function renameScene(id: string, title: string | undefined, d: AquariumDB = db) {
  const s = await d.scenes.get(id);
  if (!s) throw new Error('场景不存在');
  if (title !== undefined && (!title.trim() || title.length > 200))
    throw new Error('名称须为1～200字符');
  await d.scenes.update(id, {
    title: title?.trim() ?? s.autoTitle ?? s.title,
    autoTitle: s.autoTitle ?? s.title,
    customTitle: title?.trim(),
    titleMode: title === undefined ? 'auto' : 'custom',
  });
}
