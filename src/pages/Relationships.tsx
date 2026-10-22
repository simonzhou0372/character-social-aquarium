import { useState } from 'react';
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
      chars: await db.characters.toArray(),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      relations: await db.relationships.where('worldId').equals(worldId).toArray(),
      groups: await db.groups.toArray(),
      gm: await db.groupMembers.where('worldId').equals(worldId).toArray(),
    }),
    [worldId],
  );
  const [edit, setEdit] = useState<Relationship>(),
    [focus, setFocus] = useState(''),
    [group, setGroup] = useState(''),
    [character, setCharacter] = useState<Character>(),
    [error, setError] = useState('');
  const chars =
    data?.chars.filter(
      (c) =>
        data.members.some((m) => m.characterId === c.id) &&
        (!group || data.gm.some((m) => m.groupId === group && m.characterId === c.id)),
    ) ?? [];
  const relations =
    data?.relations.filter(
      (r) => chars.some((c) => c.id === r.from) && chars.some((c) => c.id === r.to),
    ) ?? [];
  const pos = (id: string) => {
    const index = chars.findIndex((c) => c.id === id);
    const angle = (index * 2 * Math.PI) / Math.max(chars.length, 1) - Math.PI / 2;
    return { x: 400 + Math.cos(angle) * 270, y: 275 + Math.sin(angle) * 185 };
  };
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
      <div className="network-panel">
        <span className="network-caption">SOCIAL CONSTELLATION · 点击人物或连线</span>
        {chars.length ? (
          <svg viewBox="0 0 800 550" className="network" role="img" aria-label="有向人物关系图">
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10" fill="#758767" />
              </marker>
            </defs>
            {relations.map((r, i) => {
              const a = pos(r.from),
                b = pos(r.to),
                mx = (a.x + b.x) / 2,
                my = (a.y + b.y) / 2;
              return (
                <g
                  key={r.id}
                  onClick={() => setEdit(r)}
                  className={`network-edge ${focus && r.from !== focus && r.to !== focus ? 'dim' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${r.label} ${r.from} 到 ${r.to}`}
                  onKeyDown={(e) => e.key === 'Enter' && setEdit(r)}
                >
                  <path
                    d={`M${a.x} ${a.y}Q${mx + (i % 2 ? 30 : -30)} ${my - 25} ${b.x} ${b.y}`}
                    stroke="transparent"
                    strokeWidth={28}
                    fill="none"
                  />
                  <path
                    d={`M${a.x} ${a.y}Q${mx + (i % 2 ? 30 : -30)} ${my - 25} ${b.x} ${b.y}`}
                    stroke="#93a17c"
                    strokeWidth={2}
                    fill="none"
                    markerEnd="url(#arrow)"
                  />
                  <rect
                    x={mx - 32}
                    y={my - 23 - (i % 2) * 15}
                    width={64}
                    height={24}
                    rx={5}
                    fill="#f8f8f1"
                  />
                  <text x={mx} y={my - 7 - (i % 2) * 15} textAnchor="middle">
                    {r.label} →
                  </text>
                </g>
              );
            })}
            {chars.map((c) => {
              const p = pos(c.id);
              return (
                <g
                  key={c.id}
                  className="network-node"
                  onClick={() => setCharacter(c)}
                  role="button"
                  tabIndex={0}
                  aria-label={c.name}
                  onKeyDown={(e) => e.key === 'Enter' && setCharacter(c)}
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={44}
                    fill={c.color}
                    stroke="#2b322b"
                    strokeWidth={2}
                  />
                  <text x={p.x} y={p.y + 8} textAnchor="middle" fontSize={25} fontWeight="800">
                    {c.name.replaceAll(' ', '').slice(-2)}
                  </text>
                  <rect x={p.x - 52} y={p.y + 51} width={104} height={28} rx={6} fill="#f8f8f1" />
                  <text x={p.x} y={p.y + 70} textAnchor="middle" fontWeight="700">
                    {c.name}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : (
          <Empty title="还没有角色" description="先创建角色，再连接他们的故事。" />
        )}
      </div>
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
            <span>亲近 {r.closeness}</span>
            {r.locked && <Lock size={14} />}
          </button>
        ))}
      </div>
      {edit && (
        <Modal title="编辑有向关系" onClose={() => setEdit(undefined)}>
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
