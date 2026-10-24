import { RelationshipGraph } from '../components/RelationshipGraph';
import { RelationshipAssistant } from '../components/RelationshipAssistant';
import { PresetDetails } from '../components/PresetDetails';
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, ArrowRight, Lock, Network } from 'lucide-react';
import { db } from '../data/db';
import { type Relationship, type Character, RelationshipSchema, uid } from '../core/types';
import {
  Avatar,
  Button,
  Modal,
  Field,
  Input,
  Textarea,
  Select,
  Toggle,
  Status,
  Empty,
} from '../components/ui';
import { CharacterEditor } from './Characters';
export function Relationships({ worldId }: { worldId: string }) {
  const data = useLiveQuery(
    async () => ({
      chars: await db.characters.filter((entity) => !entity.deletedAt).toArray(),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      relations: await db.relationships.where('worldId').equals(worldId).toArray(),
      groups: await db.groups.filter((entity) => !entity.deletedAt).toArray(),
      gm: await db.groupMembers.where('worldId').equals(worldId).toArray(),
    }),
    [worldId],
  );
  const [edit, setEdit] = useState<Relationship>(),
    [focus, setFocus] = useState(''),
    [group, setGroup] = useState(''),
    [character, setCharacter] = useState<Character>(),
    [error, setError] = useState('');
  useEffect(() => {
    setGroup('');
    setFocus('');
    setEdit(undefined);
    setCharacter(undefined);
  }, [worldId]);
  const chars =
    data?.chars.filter(
      (c) =>
        data.members.some((m) => !m.inactive && m.characterId === c.id) &&
        (!group || data.gm.some((m) => m.groupId === group && m.characterId === c.id)),
    ) ?? [];
  const relations =
    data?.relations.filter(
      (r) => chars.some((c) => c.id === r.from) && chars.some((c) => c.id === r.to),
    ) ?? [];
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONNECTIONS / 关系网络</span>
          <h1>
            人与人之间，有看不见的线<span>↔</span>
          </h1>
          <p>每条线都有方向，每种在意也不必相同。</p>
        </div>
        <Button
          variant="primary"
          disabled={chars.length < 2}
          onClick={() => {
            setError('');
            setEdit({
              id: uid('relation'),
              worldId,
              from: chars[0].id,
              to: chars[1].id,
              label: '朋友',
              closeness: 50,
              trust: 50,
              familiarity: 50,
              stage: '相识',
              nickname: '',
              attitude: '',
              history: '',
              locked: true,
              boundaries: '尊重个人边界',
            });
          }}
        >
          <Plus size={16} />
          添加关系
        </Button>
      </div>
      <RelationshipAssistant worldId={worldId} />
      <div className="toolbar">
        <Select aria-label="关系团体筛选" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">全部团体</option>
          {data?.groups
            .filter((g) => g.worldIds.includes(worldId))
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </Select>
        <Select
          aria-label="高亮角色社交网络"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        >
          <option value="">高亮某人的社交网络</option>
          {chars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      {chars.length > 30 && (
        <p className="muted">
          大型世界可先按团体筛选，再高亮某位角色；点击关系可查看有向事实与出处。原设资料中的数值仅用于调度，不是原作好感度。
        </p>
      )}
      {chars.length ? (
        <RelationshipGraph
          characters={chars}
          relations={relations}
          focus={focus}
          onCharacter={setCharacter}
          onRelation={setEdit}
          groups={
            new Map(
              chars.flatMap((c) => {
                const member = data?.gm.find((m) => m.characterId === c.id);
                const group = data?.groups.find((g) => g.id === member?.groupId);
                return group ? [[c.id, group.name] as [string, string]] : [];
              }),
            )
          }
        />
      ) : (
        <Empty title="还没有角色" description="先创建角色，再连接他们的故事。" />
      )}
      <div className="relation-list">
        {relations.map((r) => (
          <button
            className="relation-row"
            key={r.id}
            onClick={() => {
              setError('');
              setEdit(r);
            }}
          >
            <Avatar character={chars.find((c) => c.id === r.from)} size={34} />
            <strong>{chars.find((c) => c.id === r.from)?.name}</strong>
            <ArrowRight size={16} />
            <strong>{chars.find((c) => c.id === r.to)?.name}</strong>
            <span className="tag">{r.label}</span>
            <span>
              {r.provenance ? '调度权重（非原设数值）' : '亲近'} {r.closeness}
            </span>
            {r.locked && <Lock size={14} />}
          </button>
        ))}
      </div>
      {edit && (
        <Modal title="编辑有向关系" onClose={() => setEdit(undefined)}>
          <PresetDetails provenance={edit.provenance} />
          <RelationshipAssistant worldId={worldId} focusIds={[edit.from, edit.to]} />
          <div className="form-grid">
            {(['from', 'to'] as const).map((k, i) => (
              <Field key={k} label={i ? '对方' : '出发角色'}>
                <Select value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}>
                  {chars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
          <Field label="关系标签">
            <Input
              list="relationship-labels"
              value={edit.label}
              onChange={(e) => setEdit({ ...edit, label: e.target.value })}
            />
            <datalist id="relationship-labels">
              {[
                '好友',
                '陌生人',
                '同学',
                '同事',
                '家人',
                '队友',
                '恋人',
                '暧昧对象',
                '竞争对手',
                '敌对',
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </datalist>
          </Field>
          {(['closeness', 'trust', 'familiarity'] as const).map((k, i) => (
            <Field key={k} label={`${['亲近', '信任', '熟悉'][i]} · ${edit[k]}`}>
              <input
                type="range"
                min={0}
                max={100}
                value={edit[k]}
                onChange={(e) => setEdit({ ...edit, [k]: Number(e.target.value) })}
              />
            </Field>
          ))}
          <details className="settings-section">
            <summary>竞争、调侃与主动联系 · 模拟参数</summary>
            {(['competition', 'banter', 'initiativeScale'] as const).map((key) => (
              <Field
                key={key}
                label={
                  {
                    competition: '竞争倾向',
                    banter: '调侃倾向',
                    initiativeScale: '对该角色主动联系倍率',
                  }[key]
                }
              >
                <Input
                  type="number"
                  min={key === 'initiativeScale' ? 0.1 : 0}
                  max={key === 'initiativeScale' ? 2 : 1}
                  step={0.1}
                  value={edit.behavior?.[key] ?? (key === 'initiativeScale' ? 1 : 0.15)}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      behavior: {
                        competition: 0.15,
                        banter: 0.15,
                        initiativeScale: 1,
                        ...edit.behavior,
                        [key]: Number(e.target.value),
                      },
                    })
                  }
                />
              </Field>
            ))}
          </details>
          <Field label="对对方的昵称">
            <Input
              value={edit.nickname}
              onChange={(e) => setEdit({ ...edit, nickname: e.target.value })}
            />
          </Field>
          <Field label="关系阶段">
            <Input
              value={edit.stage}
              onChange={(e) => setEdit({ ...edit, stage: e.target.value })}
            />
          </Field>
          <Field label="态度与共享经历">
            <Textarea
              value={edit.history}
              onChange={(e) => setEdit({ ...edit, history: e.target.value })}
            />
          </Field>
          <Field label="不可跨越的边界">
            <Textarea
              value={edit.boundaries}
              onChange={(e) => setEdit({ ...edit, boundaries: e.target.value })}
            />
          </Field>
          <Toggle
            label="锁定关系，禁止模拟器自动重写"
            checked={edit.locked}
            onChange={(v) => setEdit({ ...edit, locked: v })}
          />
          {error && <Status error>{error}</Status>}
          <Button
            variant="primary"
            onClick={async () => {
              if (edit.from === edit.to) {
                setError('关系两端需要是不同角色');
                return;
              }
              try {
                await db.relationships.put(RelationshipSchema.parse(edit));
                setEdit(undefined);
              } catch {
                setError('请检查关系字段');
              }
            }}
          >
            保存这一方向的关系
          </Button>
        </Modal>
      )}
      {character && (
        <CharacterEditor
          worldId={worldId}
          character={character}
          onClose={() => setCharacter(undefined)}
        />
      )}
    </div>
  );
}
