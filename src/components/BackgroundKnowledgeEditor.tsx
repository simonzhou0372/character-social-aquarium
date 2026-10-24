import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { saveBackgroundKnowledge } from '../data/background-knowledge';
import { Button, Field, Select, Textarea, Status, Confirm } from './ui';
import type { BackgroundKnowledge } from '../core/types';
const levels = {
  unknown: '完全不知道',
  name: '听过名字',
  partial: '了解部分信息',
  familiar: '比较熟悉',
  personal: '亲自认识',
};
const kinds = {
  fact: '已确认事实',
  rumor: '未证实传闻',
  falseRumor: '错误传闻（角色只知传闻）',
  opinion: '个人看法',
};
export function BackgroundKnowledgeEditor({ worldId }: { worldId: string }) {
  const data = useLiveQuery(
    async () => ({
      chars: await db.characters.filter((e) => !e.deletedAt).toArray(),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      groups: await db.groups.filter((g) => !g.deletedAt && g.worldIds.includes(worldId)).toArray(),
      knowledge: await db.backgroundKnowledge.where('worldId').equals(worldId).toArray(),
    }),
    [worldId],
  );
  const [entity, setEntity] = useState(''),
    [actor, setActor] = useState(''),
    [level, setLevel] = useState<BackgroundKnowledge['level']>('name'),
    [kind, setKind] = useState<keyof typeof kinds>('fact'),
    [content, setContent] = useState(''),
    [source, setSource] = useState(''),
    [notice, setNotice] = useState(''),
    [editing, setEditing] = useState<number>(),
    [removing, setRemoving] = useState<string>();
  const members =
    data?.chars.filter((c) => data.members.some((m) => !m.inactive && m.characterId === c.id)) ??
    [];
  const entities = [...members, ...(data?.groups ?? [])].filter(
    (e) => e.entityMode === 'background' || data?.knowledge.some((k) => k.entityId === e.id),
  );
  const selected = entities.find((e) => e.id === entity);
  const existing = data?.knowledge.find((k) => k.entityId === entity && k.characterId === actor);
  useEffect(() => {
    setEntity('');
    setActor('');
    setNotice('');
  }, [worldId]);
  useEffect(() => {
    if (editing !== undefined && existing?.items[editing]) return;
    setLevel(existing?.level ?? 'name');
    setEditing(undefined);
    setContent('');
    setSource('');
    setKind('fact');
  }, [entity, actor, existing?.id, existing?.level]);
  const records =
    data?.knowledge.filter(
      (k) => (!entity || k.entityId === entity) && (!actor || k.characterId === actor),
    ) ?? [];
  return (
    <details className="panel" data-testid="background-knowledge">
      <summary>背景实体与认知范围 · {entities.length} 位 / 组</summary>
      <p className="muted">
        选择对象可查看已有资料，选择知情角色可载入其认知。背景实体不参与模拟，名气不会自动赋予知识。转为可互动后仍保留已有认知。
      </p>
      <Field label="背景对象">
        <Select
          value={entity}
          onChange={(e) => {
            setEditing(undefined);
            setEntity(e.target.value);
            setActor('');
          }}
        >
          <option value="">全部人物与团体</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      </Field>
      {selected && (
        <article className="panel" aria-label="背景对象已有资料">
          <h4>{selected.name}</h4>
          <p style={{ whiteSpace: 'pre-wrap' }}>
            {'bio' in selected ? selected.bio : selected.description}
          </p>
          {'personality' in selected && <p>{selected.personality}</p>}
        </article>
      )}
      <Field label="谁知道">
        <Select
          value={actor}
          onChange={(e) => {
            setEditing(undefined);
            setActor(e.target.value);
          }}
        >
          <option value="">全部知情角色</option>
          {members
            .filter((c) => c.entityMode !== 'background')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </Select>
      </Field>
      <section aria-label="已有认知记录">
        <h4>已有认知 · {records.length} 条</h4>
        {!records.length && <p>当前范围暂无认知记录。背景资料不代表所有角色都知道。</p>}
        {records.map((k) => (
          <article className="panel" key={k.id}>
            <strong>
              {members.find((c) => c.id === k.characterId)?.name ?? k.characterId} →{' '}
              {entities.find((e) => e.id === k.entityId)?.name ?? k.entityId}
            </strong>
            <p>{levels[k.level]}</p>
            {k.items.map((item, i) => (
              <div key={i}>
                <p style={{ whiteSpace: 'pre-wrap' }}>
                  <b>{kinds[item.kind]}</b>：{item.content}
                </p>
                <p>来源：{item.source || '未注明'}</p>
                <Button
                  onClick={() => {
                    setEntity(k.entityId);
                    setActor(k.characterId);
                    setLevel(k.level);
                    setEditing(i);
                    setKind(item.kind);
                    setContent(item.content);
                    setSource(item.source);
                  }}
                >
                  编辑此信息
                </Button>
              </div>
            ))}
            <Button
              onClick={() => {
                setEntity(k.entityId);
                setActor(k.characterId);
                setLevel(k.level);
                setEditing(undefined);
                setContent('');
                setSource('');
              }}
            >
              查看 / 编辑认知程度
            </Button>
            <Button onClick={() => setRemoving(k.id)}>移除此认知</Button>
          </article>
        ))}
      </section>
      <Field label="认知程度">
        <Select value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
          {Object.entries(levels).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="信息性质">
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {Object.entries(kinds).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="信息内容">
        <Textarea value={content} onChange={(e) => setContent(e.target.value)} />
      </Field>
      <Field label="来源">
        <Textarea value={source} onChange={(e) => setSource(e.target.value)} />
      </Field>
      <p>
        {editing === undefined
          ? existing
            ? '已载入已有认知；填写信息将追加一条，留空仅更新程度。'
            : '为选中的角色建立认知记录。'
          : `正在编辑第 ${editing + 1} 条信息，保存会更新原条目。`}
      </p>
      <Button
        disabled={!entity || !actor || (editing !== undefined && !content.trim())}
        onClick={async () => {
          try {
            await saveBackgroundKnowledge(
              worldId,
              entity,
              actor,
              level,
              content.trim() ? { kind, content: content.trim(), source } : undefined,
              editing,
            );
            setEditing(undefined);
            setContent('');
            setSource('');
            setNotice('认知已保存');
          } catch (e) {
            setNotice(String(e));
          }
        }}
      >
        {editing === undefined ? '保存认知 / 添加信息' : '保存信息修改'}
      </Button>
      {editing !== undefined && (
        <Button
          onClick={() => {
            setEditing(undefined);
            setContent('');
            setSource('');
          }}
        >
          取消编辑
        </Button>
      )}
      {notice && <Status>{notice}</Status>}
      {removing && (
        <Confirm
          title="移除此认知？"
          confirmLabel="确认移除认知"
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await db.backgroundKnowledge.delete(removing);
            setRemoving(undefined);
          }}
        >
          将移除此角色对该对象的认知记录，背景对象和其他角色的认知保留。
        </Confirm>
      )}
    </details>
  );
}
