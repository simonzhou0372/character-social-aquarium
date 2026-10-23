import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { availableGifs, uploadGif, removeGif } from '../data/gifs';
import type { Conversation } from '../core/types';
import { GifImage } from './GifImage';
import { Modal, Button, Input, Field, Select, Status, Toggle } from './ui';
export function GifLibrary({
  conversation: c,
  identity,
  onSend,
  onClose,
}: {
  conversation: Conversation;
  identity: string;
  onSend: (id: string) => void;
  onClose: () => void;
}) {
  const data = useLiveQuery(
    async () => ({
      assets: await availableGifs(c, identity === 'observer' ? 'user' : identity),
      settings: await db.settings.get('app'),
      characters: await db.characters.where('id').anyOf(c.participants).toArray(),
    }),
    [c.id, identity],
  );
  const [search, setSearch] = useState(''),
    [tag, setTag] = useState(''),
    [name, setName] = useState(''),
    [tags, setTags] = useState(''),
    [description, setDescription] = useState(''),
    [scope, setScope] = useState('world:' + c.worldId),
    [error, setError] = useState(''),
    [autoplay, setAutoplay] = useState(true);
  useEffect(() => {
    setAutoplay(data?.settings?.gifAutoplay ?? true);
  }, [data?.settings?.gifAutoplay]);
  return (
    <Modal title="GIF 表情图库" onClose={onClose} wide>
      <Field label="搜索表情">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      <Select aria-label="表情分类" value={tag} onChange={(e) => setTag(e.target.value)}>
        <option value="">全部分类</option>
        {[...new Set(data?.assets.flatMap((a) => a.tags))].map((t) => (
          <option key={t}>{t}</option>
        ))}
      </Select>
      <Toggle
        label="GIF 自动播放"
        checked={autoplay}
        onChange={(gifAutoplay) => {
          setAutoplay(gifAutoplay);
          void db.settings.update('app', { gifAutoplay });
        }}
      />
      <div className="sticker-grid">
        {data?.assets
          .filter(
            (a) =>
              (a.name.includes(search) || a.description.includes(search)) &&
              (!tag || a.tags.includes(tag)),
          )
          .map((a) => (
            <article key={a.id}>
              <button
                aria-label={`发送表情 ${a.name}`}
                disabled={identity === 'observer'}
                onClick={() => onSend(a.id)}
              >
                <GifImage assetId={a.id} autoplay={data.settings?.gifAutoplay} />
                <span>{a.name}</span>
              </button>
              <Button onClick={() => void db.gifAssets.update(a.id, { favorite: !a.favorite })}>
                {a.favorite ? '取消收藏' : '收藏'}
              </Button>
              <Button onClick={() => void removeGif(a.id)}>从图库移除</Button>
              <Input
                aria-label="表情名称"
                defaultValue={a.name}
                onBlur={(e) => {
                  if (e.target.value.trim())
                    void db.gifAssets.update(a.id, { name: e.target.value.slice(0, 80) });
                }}
              />
            </article>
          ))}
      </div>
      <details>
        <summary>上传 GIF / 配置继承范围</summary>
        <Field label="新表情名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="分类标签（逗号分隔）">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="使用场景描述">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Select aria-label="表情所属范围" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value={'world:' + c.worldId}>世界共享</option>
          {c.groupId && <option value={'group:' + c.groupId}>当前团体共享</option>}
          {data?.characters.map((ch) => (
            <option key={ch.id} value={'character:' + ch.id}>
              {ch.name} · 角色专属
            </option>
          ))}
        </Select>
        <input
          aria-label="上传GIF"
          type="file"
          accept="image/gif"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const split = scope.indexOf(':');
              await uploadGif(file, {
                name: name.trim() || file.name.slice(0, 80),
                tags: tags
                  .split(/[,，]/)
                  .map((t) => t.trim())
                  .filter(Boolean),
                description,
                scopeType: scope.slice(0, split) as 'world' | 'group' | 'character',
                scopeId: scope.slice(split + 1),
              });
              setError('');
            } catch (e) {
              setError(String(e));
            }
          }}
        />
        <p className="muted">
          角色专属优先于当前团体和世界的同名资源；当前会话不会读取其他团体的私有图库。移除后，历史消息仍可显示。
        </p>
      </details>
      {error && <Status error>{error}</Status>}
    </Modal>
  );
}
