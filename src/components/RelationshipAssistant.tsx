import { useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { relationshipDrafts, acceptRelationships } from '../ai/relationships';
import type { Relationship } from '../core/types';
import { Button, Field, Input, Textarea, Select, Status } from './ui';
export function RelationshipAssistant({
  worldId,
  focusIds = [],
}: {
  worldId: string;
  focusIds?: string[];
}) {
  const data = useLiveQuery(
    async () => ({
      chars: await db.characters.filter((entity) => !entity.deletedAt).toArray(),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      groups: await db.groups.filter((g) => g.worldIds.includes(worldId)).toArray(),
      gm: await db.groupMembers.where('worldId').equals(worldId).toArray(),
    }),
    [worldId],
  );
  const [open, setOpen] = useState(false),
    [selection, setSelection] = useState(focusIds),
    [group, setGroup] = useState(''),
    [constraints, setConstraints] = useState(''),
    [drafts, setDrafts] = useState<Relationship[]>([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const abort = useRef<AbortController>();
  const chars = data?.chars.filter((c) => data.members.some((m) => m.characterId === c.id)) ?? [];
  async function generate(
    ids = selection.length ? selection : chars.map((c) => c.id),
    replacePair = false,
  ) {
    setBusy(true);
    setNotice('');
    abort.current = new AbortController();
    try {
      const generated = await relationshipDrafts(
        worldId,
        ids,
        constraints,
        db,
        undefined,
        abort.current.signal,
      );
      if (generated.warnings.length)
        setNotice(
          `保留 ${generated.length} 条有效建议，跳过 ${generated.warnings.length} 条端点不明确的建议。`,
        );
      setDrafts((old) =>
        replacePair
          ? [...old.filter((r) => !(ids.includes(r.from) && ids.includes(r.to))), ...generated]
          : generated,
      );
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <Button onClick={() => setOpen(!open)}>AI 生成关系</Button>
      {open && (
        <>
          <Field label="关系生成范围">
            <Select
              value={group}
              onChange={(e) => {
                setGroup(e.target.value);
                setSelection(
                  data?.gm.filter((m) => m.groupId === e.target.value).map((m) => m.characterId) ??
                    [],
                );
              }}
            >
              <option value="">选择角色 / 整个世界</option>
              {data?.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} · 团体内部
                </option>
              ))}
            </Select>
          </Field>
          <div className="check-list">
            {chars.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={selection.includes(c.id)}
                  onChange={(e) =>
                    setSelection(
                      e.target.checked
                        ? [...selection, c.id]
                        : selection.filter((id) => id !== c.id),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
          <Field label="关系补充要求">
            <Textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} />
          </Field>
          <Button disabled={busy} onClick={() => void generate()}>
            {busy ? '分批生成关系草稿…' : '生成关系预览'}
          </Button>
          {busy && <Button onClick={() => abort.current?.abort()}>停止</Button>}
          <p className="muted">
            未选角色时生成整个世界；单选角色会参考全世界。双向关系分别生成，锁定关系不会覆盖。
          </p>
          {drafts.map((r, i) => (
            <article className="panel" key={r.id}>
              <strong>
                {chars.find((c) => c.id === r.from)?.name} →{' '}
                {chars.find((c) => c.id === r.to)?.name}
              </strong>
              <Field label="建议关系类型">
                <Input
                  value={r.label}
                  onChange={(e) =>
                    setDrafts((ds) =>
                      ds.map((d, j) => (i === j ? { ...d, label: e.target.value } : d)),
                    )
                  }
                />
              </Field>
              {(['closeness', 'trust', 'familiarity'] as const).map((k) => (
                <Field
                  key={k}
                  label={{ closeness: '亲近程度', trust: '信任程度', familiarity: '熟悉程度' }[k]}
                >
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={r[k]}
                    onChange={(e) =>
                      setDrafts((ds) =>
                        ds.map((d, j) => (i === j ? { ...d, [k]: Number(e.target.value) } : d)),
                      )
                    }
                  />
                </Field>
              ))}
              <Textarea
                value={r.history}
                onChange={(e) =>
                  setDrafts((ds) =>
                    ds.map((d, j) => (i === j ? { ...d, history: e.target.value } : d)),
                  )
                }
              />
              <Button
                onClick={async () => {
                  try {
                    setNotice(`已接受 ${await acceptRelationships([r])} 条，锁定关系保持原值`);
                    setDrafts((ds) => ds.filter((d) => d.id !== r.id));
                  } catch (e) {
                    setNotice(String(e));
                  }
                }}
              >
                接受此条
              </Button>
              <Button onClick={() => setDrafts((ds) => ds.filter((d) => d.id !== r.id))}>
                删除建议
              </Button>
              <Button disabled={busy} onClick={() => void generate([r.from, r.to], true)}>
                重新生成这对关系
              </Button>
            </article>
          ))}
          {!!drafts.length && (
            <Button
              onClick={async () => {
                try {
                  setNotice(`已接受 ${await acceptRelationships(drafts)} 条关系`);
                  setDrafts([]);
                } catch (e) {
                  setNotice(String(e));
                }
              }}
            >
              接受全部建议
            </Button>
          )}
          {notice && <Status>{notice}</Status>}
        </>
      )}
    </section>
  );
}
