import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { Button, Field, Select, Textarea, Status } from './ui';
import { BackgroundKnowledgeSchema, uid, type BackgroundKnowledge } from '../core/types';
export function BackgroundKnowledgeEditor({ worldId }: { worldId: string }) {
  const data = useLiveQuery(
    async () => ({
      chars: await db.characters.toArray(),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      groups: await db.groups.filter((g) => g.worldIds.includes(worldId)).toArray(),
      knowledge: await db.backgroundKnowledge.where('worldId').equals(worldId).toArray(),
    }),
    [worldId],
  );
  const [entity, setEntity] = useState(''),
    [actor, setActor] = useState(''),
    [level, setLevel] = useState<BackgroundKnowledge['level']>('name'),
    [kind, setKind] = useState<'fact' | 'rumor' | 'falseRumor' | 'opinion'>('fact'),
    [content, setContent] = useState(''),
    [source, setSource] = useState(''),
    [notice, setNotice] = useState('');
  const members = data?.chars.filter((c) => data.members.some((m) => m.characterId === c.id)) ?? [];
  const entities = [
    ...members.filter((c) => c.entityMode === 'background'),
    ...(data?.groups.filter((g) => g.entityMode === 'background') ?? []),
  ];
  return (
    <details className="panel">
      <summary>背景实体与认知范围 · {entities.length} 位 / 组</summary>
      <p className="muted">
        背景实体不参与模拟。名气不会自动赋予知识；每位角色只获得自己的认知记录。升级为可互动模式后保留编号与认知。
      </p>
      <Field label="背景对象">
        <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">选择人物或团体</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="谁知道">
        <Select value={actor} onChange={(e) => setActor(e.target.value)}>
          <option value="">选择角色</option>
          {members
            .filter((c) => c.entityMode !== 'background')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="认知程度">
        <Select
          value={level}
          onChange={(e) => setLevel(e.target.value as BackgroundKnowledge['level'])}
        >
          {['unknown', 'name', 'partial', 'familiar', 'personal'].map((v, i) => (
            <option key={v} value={v}>
              {['完全不知道', '听过名字', '了解部分信息', '比较熟悉', '亲自认识'][i]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="信息性质">
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {['fact', 'rumor', 'falseRumor', 'opinion'].map((v, i) => (
            <option key={v} value={v}>
              {['已确认事实', '未证实传闻', '错误传闻（角色只知传闻）', '个人看法'][i]}
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
      <Button
        disabled={!entity || !actor}
        onClick={async () => {
          try {
            const old = data?.knowledge.find(
              (k) => k.entityId === entity && k.characterId === actor,
            );
            await db.backgroundKnowledge.put(
              BackgroundKnowledgeSchema.parse({
                id: old?.id ?? uid('knowledge'),
                worldId,
                entityId: entity,
                characterId: actor,
                level,
                items: content.trim()
                  ? [...(old?.items ?? []), { kind, content, source }]
                  : (old?.items ?? []),
              }),
            );
            setNotice('认知已保存');
            setContent('');
          } catch (e) {
            setNotice(String(e));
          }
        }}
      >
        保存认知 / 添加信息
      </Button>
      {notice && <Status>{notice}</Status>}
      <div>
        {data?.knowledge.map((k) => (
          <p key={k.id}>
            {members.find((c) => c.id === k.characterId)?.name} →{' '}
            {entities.find((e) => e.id === k.entityId)?.name ?? k.entityId} · {k.level} ·{' '}
            {k.items
              .map((i) => `[${i.kind}] ${i.content}（${i.source || '来源未注明'}）`)
              .join('；')}{' '}
            <Button onClick={() => void db.backgroundKnowledge.delete(k.id)}>移除此认知</Button>
          </p>
        ))}
      </div>
    </details>
  );
}
