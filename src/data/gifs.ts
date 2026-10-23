import { db, type AquariumDB } from './db';
import { uid, type GifAsset, type Conversation } from '../core/types';
export function validateGif(bytes: Uint8Array) {
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  if (
    !['GIF87a', 'GIF89a'].includes(signature) ||
    bytes.length < 14 ||
    bytes.length > 5 * 1024 * 1024
  )
    throw new Error('请选择5 MB以内的有效GIF');
  const w = bytes[6] + 256 * bytes[7],
    h = bytes[8] + 256 * bytes[9];
  if (!w || !h || w * h > 16000000) throw new Error('GIF尺寸无效或过大');
  let at = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0),
    frames = 0;
  const blocks = () => {
    while (at < bytes.length) {
      const n = bytes[at++];
      if (!n) return;
      at += n;
      if (at > bytes.length) throw new Error('GIF数据不完整');
    }
    throw new Error('GIF数据不完整');
  };
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x3b) {
      if (!frames) throw new Error('GIF没有图像帧');
      return { width: w, height: h, frames };
    }
    if (marker === 0x21) {
      at++;
      blocks();
    } else if (marker === 0x2c) {
      if (at + 9 > bytes.length) throw new Error('GIF图像数据不完整');
      const packed = bytes[at + 8];
      at += 9;
      if (packed & 128) at += 3 * (1 << ((packed & 7) + 1));
      at++;
      blocks();
      frames++;
    } else throw new Error('GIF文件内容无效');
  }
  throw new Error('GIF缺少结束标记');
}
export async function uploadGif(
  file: Blob,
  meta: Pick<GifAsset, 'name' | 'scopeType' | 'scopeId' | 'tags' | 'description'>,
  d: AquariumDB = db,
) {
  if (file.type !== 'image/gif') throw new Error('文件类型必须为GIF');
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateGif(bytes);
  if (typeof createImageBitmap === 'function') {
    try {
      const decoded = await createImageBitmap(file);
      decoded.close();
    } catch {
      throw new Error('GIF图像无法解码，请选择完整可播放的文件');
    }
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return d.transaction(
    'rw',
    d.resources,
    d.gifAssets,
    d.worlds,
    d.groups,
    d.characters,
    async () => {
      const exists =
        meta.scopeType === 'world'
          ? await d.worlds.get(meta.scopeId)
          : meta.scopeType === 'group'
            ? await d.groups.get(meta.scopeId)
            : await d.characters.get(meta.scopeId);
      if (!exists) throw new Error('图库所属对象不存在');
      const resource = await d.resources.where('digest').equals(digest).first();
      const resourceId = resource?.id ?? uid('resource');
      if (!resource)
        await d.resources.put({
          id: resourceId,
          mime: 'image/gif',
          size: bytes.length,
          digest,
          blob: new Blob([bytes], { type: 'image/gif' }),
        });
      const asset: GifAsset = {
        ...meta,
        id: uid('gif'),
        resourceId,
        favorite: false,
        createdAt: Date.now(),
      };
      await d.gifAssets.add(asset);
      return asset;
    },
  );
}
export async function availableGifs(c: Conversation, actorId: string, d: AquariumDB = db) {
  const assets = await d.gifAssets.toArray();
  if (actorId !== 'user' && !c.participants.includes(actorId)) return [];
  const membership =
    actorId === 'user'
      ? true
      : !!(await d.memberships.where('[worldId+characterId]').equals([c.worldId, actorId]).first());
  if (!membership) return [];
  const groupWorld = c.groupId ? await d.groups.get(c.groupId) : undefined;
  const groupAllowed =
    !!c.groupId &&
    !!groupWorld?.worldIds.includes(c.worldId) &&
    (actorId === 'user' ||
      !!(await d.groupMembers
        .where('worldId')
        .equals(c.worldId)
        .and((m) => m.groupId === c.groupId && m.characterId === actorId)
        .first()));
  const allowed = assets.filter(
    (a) =>
      !a.removed &&
      ((a.scopeType === 'world' && a.scopeId === c.worldId) ||
        (a.scopeType === 'group' && groupAllowed && a.scopeId === c.groupId) ||
        (a.scopeType === 'character' && a.scopeId === actorId)),
  );
  const rank = { world: 0, group: 1, character: 2 };
  const resolved = new Map<string, GifAsset>();
  for (const a of allowed.sort((a, b) => rank[a.scopeType] - rank[b.scopeType]))
    resolved.set(a.name, a);
  return [...resolved.values()].sort(
    (a, b) => Number(b.favorite) - Number(a.favorite) || b.createdAt - a.createdAt,
  );
}
export async function removeGif(id: string, d: AquariumDB = db) {
  await d.gifAssets.update(id, { removed: true });
} // Resources stay available to archived messages.
