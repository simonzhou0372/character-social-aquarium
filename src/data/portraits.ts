import { db, type AquariumDB } from './db';
import {
  PORTRAIT_PACK,
  touhouPortraits,
  type PortraitEntry,
  type PortraitCandidate,
} from './presets/touhou-portraits';
const MAX_BYTES = 1024 * 1024;
export type PortraitProgress = {
  completed: number;
  total: number;
  installed: number;
  skipped: number;
  failed: number;
  current?: string;
  errors: string[];
};
export function portraitMime(bytes: Uint8Array) {
  if (bytes.length < 16 || bytes.length > MAX_BYTES) throw new Error('图片为空、损坏或超过 1 MB');
  const head = Array.from(bytes.slice(0, 12));
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => head[i] === x)) return 'image/png';
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg';
  const text = String.fromCharCode(...head);
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'image/gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  throw new Error('下载结果不是支持的图片（可能是防盗链或错误页面）');
}
export async function portraitDigest(avatar: string) {
  const bytes = new TextEncoder().encode(avatar);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
function allowedImage(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['upload.thwiki.cc', 'upload.thbwiki.cc'].includes(u.hostname))
    throw new Error('素材来源不在已核对的下载站点中');
}
async function imageData(
  candidate: PortraitCandidate,
  fetcher: typeof fetch,
  signal: AbortSignal,
  decode?: (data: string) => Promise<void>,
) {
  allowedImage(candidate.url);
  const response = await fetcher(candidate.url, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  if (response.url) allowedImage(response.url);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('图片超过 1 MB');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('下载响应没有图片数据');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new Error('图片超过 1 MB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const mime = portraitMime(bytes);
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.slice(i, i + 8192));
  const data = `data:${mime};base64,${btoa(raw)}`;
  if (decode) await decode(data);
  else {
    const image = new Image();
    image.src = data;
    await image.decode();
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 16000000)
      throw new Error('图片尺寸无效或过大');
  }
  return data;
}
export async function downloadPortraits(
  ids: string[],
  options: {
    database?: AquariumDB;
    catalog?: PortraitEntry[];
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    replaceDownloaded?: boolean;
    onProgress?: (progress: PortraitProgress) => void;
    decode?: (data: string) => Promise<void>;
  } = {},
) {
  const d = options.database ?? db,
    entries = options.catalog ?? touhouPortraits;
  const progress: PortraitProgress = {
    completed: 0,
    total: new Set(ids).size,
    installed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  const report = () => options.onProgress?.({ ...progress, errors: [...progress.errors] });
  const pending = [...new Set(ids)];
  let cursor = 0;
  report();
  const worker = async () => {
    while (cursor < pending.length && !options.signal?.aborted) {
      const id = pending[cursor++],
        entry = entries.find((e) => e.characterId === id);
      progress.current = entry?.name ?? id;
      report();
      try {
        const character = await d.characters.get(id);
        if (!character || character.deletedAt || !entry?.candidates.length) {
          progress.skipped++;
          continue;
        }
        const managed =
          character.avatarSource?.pack === PORTRAIT_PACK &&
          character.avatarSource.digest === (await portraitDigest(character.avatar));
        if (character.avatar && !(options.replaceDownloaded && managed)) {
          progress.skipped++;
          continue;
        }
        let data = '',
          chosen: PortraitCandidate | undefined;
        const errors: string[] = [];
        for (const candidate of entry.candidates.slice(0, 3)) {
          if (options.signal?.aborted) break;
          const timeout = new AbortController(),
            timer = setTimeout(() => timeout.abort(), 20000);
          const abort = () => timeout.abort();
          options.signal?.addEventListener('abort', abort, { once: true });
          try {
            data = await imageData(
              candidate,
              options.fetcher ?? fetch,
              timeout.signal,
              options.decode,
            );
            chosen = candidate;
            break;
          } catch (e) {
            errors.push(String(e));
          } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
          }
        }
        if (options.signal?.aborted) break;
        if (!chosen) throw new Error(errors.join('；') || '没有可下载的立绘');
        const digest = await portraitDigest(data),
          source = chosen;
        const saved = await d.transaction('rw', d.characters, async () => {
          const current = await d.characters.get(id);
          // Never overwrite an upload or a deletion made while the network request was running.
          if (!current || current.deletedAt || current.avatar !== character.avatar) return false;
          await d.characters.update(id, {
            avatar: data,
            avatarSource: {
              pack: PORTRAIT_PACK,
              assetId: source.id,
              kind: source.kind,
              artist: source.artist,
              work: source.work,
              sourcePage: source.sourcePage,
              digest,
              downloadedAt: Date.now(),
            },
          });
          return true;
        });
        if (saved) progress.installed++;
        else progress.skipped++;
      } catch (e) {
        progress.failed++;
        progress.errors.push(`${entry?.name ?? id}：${String(e)}`);
      } finally {
        progress.completed++;
        report();
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return progress;
}
export async function removePortraits(d: AquariumDB = db) {
  let count = 0;
  const characters = await d.characters
    .filter((c) => c.avatarSource?.pack === PORTRAIT_PACK)
    .toArray();
  for (const c of characters) {
    const unchanged = c.avatarSource!.digest === (await portraitDigest(c.avatar));
    await d.transaction('rw', d.characters, async () => {
      const current = await d.characters.get(c.id);
      if (!current || current.avatar !== c.avatar) return;
      await d.characters.update(c.id, {
        ...(unchanged ? { avatar: '' } : {}),
        avatarSource: undefined,
      });
      if (unchanged) count++;
    });
  }
  return count;
}
