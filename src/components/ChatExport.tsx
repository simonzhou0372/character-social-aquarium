import { formatWorldTime } from '../core/calendar';
import Dexie, { type Table } from 'dexie';
import { useEffect, useRef, useState } from 'react';
import { db } from '../data/db';
import { messageKey, messagePage, type MessageKey } from '../data/chat-history';
import type { Conversation, Message } from '../core/types';
import { Button, Modal } from './ui';
const temp = new Dexie('aquarium-chat-export');
temp.version(1).stores({ pages: 'id,job,createdAt' });
const pages = temp.table('pages') as Table<{
  id: string;
  job: string;
  blob: Blob;
  thumbnail?: Blob;
  createdAt: number;
}>;
export type ChatSelection = {
  ids: Set<string>;
  range?: {
    from: number;
    to: number;
    fromId?: string;
    toId?: string;
    fromSeq?: number;
    toSeq?: number;
  };
  excluded: Set<string>;
};
export const isSelected = (m: Message, s: ChatSelection) =>
  !s.excluded.has(m.id) &&
  (s.ids.has(m.id) ||
    (!!s.range &&
      m.simAt >= s.range.from &&
      m.simAt <= s.range.to &&
      (m.simAt !== s.range.from ||
        (s.range.fromSeq !== undefined
          ? m.seq >= s.range.fromSeq
          : !s.range.fromId || m.id >= s.range.fromId)) &&
      (m.simAt !== s.range.to ||
        (s.range.toSeq !== undefined
          ? m.seq <= s.range.toSeq
          : !s.range.toId || m.id <= s.range.toId))));
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function loadImage(src: string) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      img.src = '';
      reject(new Error('图片读取超时'));
    }, 10000);
    img.onload = () => {
      clearTimeout(timeout);
      resolve();
    };
    img.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('图片无法读取'));
    };
    img.src = src;
  });
  return img;
}
function ExportThumbnail({
  id,
  onClick,
  number,
}: {
  id: string;
  onClick: () => void;
  number: number;
}) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true,
      url = '';
    void pages.get(id).then((p) => {
      if (active && p) {
        url = URL.createObjectURL(p.thumbnail ?? p.blob);
        setSrc(url);
      }
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return (
    <button onClick={onClick} aria-label={`预览第 ${number} 张`}>
      <img
        src={src || undefined}
        alt={`第 ${number} 张缩略图`}
        style={{ width: 72, height: 120, objectFit: 'contain' }}
      />
    </button>
  );
}
/** Dedicated local renderer, never screenshots the live chat tree. One canvas at a time. */
export function ChatExport({
  conversation,
  selection,
  onClose,
}: {
  conversation: Conversation;
  selection: ChatSelection;
  onClose: () => void;
}) {
  const [keys, setKeys] = useState<string[]>([]),
    [progress, setProgress] = useState(0),
    [done, setDone] = useState(false),
    [error, setError] = useState(''),
    [index, setIndex] = useState(0),
    [url, setUrl] = useState('');
  const cancel = useRef(false),
    job = useRef(crypto.randomUUID());
  const filename = `${conversation.name.replace(/[\\/:*?"<>|]/g, '_')}-${new Date().toLocaleDateString('sv-SE')}`;
  useEffect(() => {
    let active = true;
    const jobId = job.current;
    async function run() {
      await pages
        .where('createdAt')
        .below(Date.now() - 86400000)
        .delete();
      const chars = await db.characters.bulkGet(conversation.participants),
        settings = await db.settings.get('app'),
        world = await db.worlds.get(conversation.worldId);
      const canvas = document.createElement('canvas');
      canvas.width = 1440;
      canvas.height = 2400;
      const ctx = canvas.getContext('2d')!;
      let y = 60,
        count = 0,
        page = 0;
      function reset() {
        ctx.fillStyle = '#f5f6f8';
        ctx.fillRect(0, 0, 1440, 2400);
        ctx.font = '28px sans-serif';
        ctx.fillStyle = '#202630';
        ctx.fillText(conversation.name, 48, 40);
        y = 80;
      }
      async function flush() {
        if (y <= 80 || cancel.current) return;
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片生成失败'))), 'image/png'),
        );
        const id = `${jobId}:${page++}`;
        const thumb = document.createElement('canvas');
        thumb.width = 180;
        thumb.height = 300;
        thumb.getContext('2d')!.drawImage(canvas, 0, 0, 180, 300);
        const thumbnail = await new Promise<Blob | null>((resolve) =>
          thumb.toBlob(resolve, 'image/png'),
        );
        thumb.width = thumb.height = 0;
        await pages.put({
          id,
          job: jobId,
          blob,
          thumbnail: thumbnail ?? undefined,
          createdAt: Date.now(),
        });
        if (active) setKeys((old) => [...old, id]);
        reset();
      }
      reset();
      let cursor: MessageKey | undefined = selection.range
        ? [conversation.id, selection.range.from, '']
        : undefined;
      const selectedKeys: { id: string; at: number }[] = [];
      {
        const ids = [...selection.ids].filter((id) => !selection.excluded.has(id));
        for (let i = 0; i < ids.length && !cancel.current; i += 40) {
          const batch = await db.messages.bulkGet(ids.slice(i, i + 40));
          for (const m of batch)
            if (m?.conversationId === conversation.id) selectedKeys.push({ id: m.id, at: m.simAt });
        }
        selectedKeys.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
      const minAt = Math.min(selection.range?.from ?? Infinity, selectedKeys[0]?.at ?? Infinity);
      const maxAt = Math.max(
        selection.range?.to ?? -Infinity,
        selectedKeys.at(-1)?.at ?? -Infinity,
      );
      if (selection.range) cursor = [conversation.id, minAt, ''];
      let selectedOffset = 0;
      try {
        while (!cancel.current) {
          const batch = selection.range
            ? await messagePage(conversation.id, 'after', cursor, 40)
            : (
                await db.messages.bulkGet(
                  selectedKeys.slice(selectedOffset, selectedOffset + 40).map((m) => m.id),
                )
              ).filter((m): m is Message => !!m);
          selectedOffset += 40;
          if (!batch.length || (selection.range && batch[0].simAt > maxAt)) break;
          const reactions = await db.reactions
            .where('messageId')
            .anyOf(batch.map((m) => m.id))
            .toArray();
          const reactionsByMessage = new Map<string, typeof reactions>();
          for (const reaction of reactions) {
            const list = reactionsByMessage.get(reaction.messageId) ?? [];
            list.push(reaction);
            reactionsByMessage.set(reaction.messageId, list);
          }
          const reactionName = (id: string) =>
            id === 'user'
              ? (settings?.nickname ?? '用户')
              : (chars.find((c) => c?.id === id)?.name ?? '已移除成员');
          for (const m of batch) {
            if (cancel.current) break;
            if (!isSelected(m, selection)) continue;
            const char = chars.find((c) => c?.id === m.senderId);
            const name = char?.name ?? settings?.nickname ?? '用户';
            const header = async () => {
              if (y > 2100) await flush();
              ctx.fillStyle = '#4b5563';
              ctx.font = '24px sans-serif';
              ctx.fillText(
                `${name} · ${world && conversation.kind !== 'notes' ? formatWorldTime(world, m.simAt) : new Date(m.realAt).toLocaleString()}`,
                120,
                y + 30,
              );
              ctx.fillStyle = '#d8e4ed';
              ctx.fillRect(48, y, 54, 54);
              ctx.fillStyle = '#263749';
              ctx.fillText(Array.from(name)[0] ?? '?', 60, y + 36);
              const avatar =
                char?.avatar ?? (m.senderId === 'user' ? settings?.userAvatar : undefined);
              if (avatar)
                try {
                  const img = await loadImage(avatar);
                  ctx.drawImage(img, 48, y, 54, 54);
                  img.src = '';
                } catch {
                  /* Missing avatars do not discard messages. */
                }
              y += 64;
            };
            await header();
            ctx.font = '30px sans-serif';
            let line = '';
            const drawLine = async () => {
              if (y > 2300) {
                await flush();
                await header();
                ctx.font = '30px sans-serif';
              }
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(112, y - 28, 1260, 44);
              ctx.fillStyle = '#202630';
              ctx.fillText(line, 128, y + 5);
              y += 44;
              line = '';
            };
            for (const ch of Array.from(m.gifAssetId ? '[GIF]' : m.text)) {
              if (ch === '\n' || ctx.measureText(line + ch).width > 1210) await drawLine();
              if (ch !== '\n') line += ch;
            }
            if (line) await drawLine();
            if (m.gifAssetId) {
              const asset = await db.gifAssets.get(m.gifAssetId),
                resource = asset && (await db.resources.get(asset.resourceId));
              if (resource) {
                const src = URL.createObjectURL(resource.blob);
                try {
                  const img = await loadImage(src);
                  const scale = Math.min(400 / img.naturalHeight, 400 / img.naturalWidth),
                    h = img.naturalHeight * scale;
                  if (y + h > 2300) {
                    await flush();
                    await header();
                  }
                  ctx.drawImage(img, 128, y, img.naturalWidth * scale, h);
                  y += h;
                  img.src = '';
                } finally {
                  URL.revokeObjectURL(src);
                }
              }
            }
            const reactionsForMessage = (reactionsByMessage.get(m.id) ?? []).sort(
              (a, b) => a.reactedAt - b.reactedAt,
            );
            if (reactionsForMessage.length) {
              const byEmoji = new Map<string, string[]>();
              for (const reaction of reactionsForMessage) {
                const names = byEmoji.get(reaction.emoji) ?? [];
                names.push(reactionName(reaction.actorId));
                byEmoji.set(reaction.emoji, names);
              }
              const reactionText = [...byEmoji]
                .map(([emoji, names]) => `${emoji} ${[...new Set(names)].join('、')}`)
                .join('   ');
              ctx.font = '20px sans-serif';
              ctx.fillStyle = '#6b7280';
              let line = '';
              const drawReactionLine = async () => {
                if (y > 2300) {
                  await flush();
                  await header();
                  ctx.font = '20px sans-serif';
                  ctx.fillStyle = '#6b7280';
                }
                ctx.fillText(line, 128, y);
                y += 30;
                line = '';
              };
              for (const ch of Array.from(reactionText)) {
                if (ctx.measureText(line + ch).width > 1150) await drawReactionLine();
                line += ch;
              }
              if (line) await drawReactionLine();
            }
            y += 30;
            count++;
            if (active) setProgress(count);
          }
          cursor = messageKey(batch.at(-1)!);
          await new Promise((r) => setTimeout(r, 0));
        }
        await flush();
        if (active) setDone(true);
      } finally {
        canvas.width = canvas.height = 0;
      }
    }
    cancel.current = false;
    void run()
      .catch((e) => active && setError(String(e)))
      .finally(() => {
        if (!active) void pages.where('job').equals(jobId).delete();
      });
    return () => {
      active = false;
      cancel.current = true;
      void pages.where('job').equals(jobId).delete();
    };
  }, []);
  useEffect(() => {
    let active = true,
      next = '';
    setUrl('');
    if (keys[index])
      void pages.get(keys[index]).then((p) => {
        if (active && p) {
          next = URL.createObjectURL(p.blob);
          setUrl(next);
        }
      });
    return () => {
      active = false;
      if (next) URL.revokeObjectURL(next);
    };
  }, [keys[index]]);
  async function download(all: boolean, zipMode = false) {
    try {
      const { default: JSZip } = await import('jszip');
      let zip = new JSZip(),
        bytes = 0,
        part = 1;
      const flushZip = async () => {
        if (!bytes) return;
        save(
          await zip.generateAsync({ type: 'blob', compression: 'STORE' }),
          `${filename}-${part++}.zip`,
        );
        zip = new JSZip();
        bytes = 0;
      };
      for (const [i, key] of keys.entries()) {
        if (!all && i !== index) continue;
        const p = await pages.get(key);
        if (!p) continue;
        if (zipMode) {
          if (bytes + p.blob.size > 32 * 1024 * 1024) await flushZip();
          zip.file(`${i + 1}.png`, p.blob);
          bytes += p.blob.size;
        } else save(p.blob, `${filename}-${i + 1}.png`);
      }
      if (zipMode) await flushZip();
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <Modal title="聊天图片导出结果" onClose={onClose} wide>
      <p>
        {done ? '已完成' : '正在生成'} · {progress} 条消息 · {keys.length} 张图片
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="chat-tools">
        <Button
          onClick={() => {
            cancel.current = true;
            setDone(true);
          }}
        >
          取消生成
        </Button>
        <Button onClick={onClose}>删除临时结果并关闭</Button>
      </div>
      <div className="chat-tools">
        <Button disabled={!keys.length} onClick={() => void download(false)}>
          保存当前图片
        </Button>
        <Button disabled={!done} onClick={() => void download(true)}>
          批量下载
        </Button>
        <Button disabled={!done} onClick={() => void download(true, true)}>
          下载 ZIP
        </Button>
        <Button
          onClick={async () => {
            try {
              const p = await pages.get(keys[index]);
              if (!p) return;
              const files = [
                new File([p.blob], `${filename}-${index + 1}.png`, { type: 'image/png' }),
              ];
              if (navigator.canShare?.({ files })) await navigator.share({ files });
              else setError('当前浏览器不支持文件分享，请保存图片。');
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          系统分享
        </Button>
      </div>
      <p>大批导出按 32 MB 拆分 ZIP，预览只保留当前图片。</p>
      <label>
        第{' '}
        <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
          {keys.map((k, i) => (
            <option key={k} value={i}>
              {i + 1}
            </option>
          ))}
        </select>{' '}
        张 / {keys.length}
      </label>
      <div className="chat-tools">
        {keys.slice(Math.floor(index / 8) * 8, Math.floor(index / 8) * 8 + 8).map((key, i) => {
          const n = Math.floor(index / 8) * 8 + i;
          return <ExportThumbnail key={key} id={key} number={n + 1} onClick={() => setIndex(n)} />;
        })}
      </div>
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={`聊天导出第 ${index + 1} 页，点击放大`} style={{ width: '100%' }} />
        </a>
      )}
    </Modal>
  );
}
