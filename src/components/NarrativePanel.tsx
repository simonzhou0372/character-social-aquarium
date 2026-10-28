import { MajorEventDetail } from '../pages/MajorEvents';
import { CharacterEditor } from '../pages/Characters';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { applyNarrativeConsequences } from '../core/narrative';
import { lifeNames, groupStateNames, type NarrativeProposal } from '../core/narrative-types';
import { formatWorldTime } from '../core/calendar';
import { Field, Input, Textarea, Select, Button, Confirm, Status } from './ui';
export function NarrativePanel({ worldId }: { worldId: string }) {
  const data = useLiveQuery(
    async () => ({
      world: await db.worlds.get(worldId),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      chars: await db.characters.toArray(),
      groups: await db.groups.filter((g) => g.worldIds.includes(worldId) && !g.deletedAt).toArray(),
      groupMembers: await db.groupMembers.where('worldId').equals(worldId).toArray(),
      changes: await db.narrativeChanges.where('worldId').equals(worldId).sortBy('at'),
      organizations: await db.organizationStates.where('worldId').equals(worldId).toArray(),
      events: (
        await db.majorEvents
          .where('worldId')
          .equals(worldId)
          .and((e) => e.status === 'occurred')
          .sortBy('timestamp')
      )
        .reverse()
        .slice(0, 50),
    }),
    [worldId],
  );
  const [openEvent, setOpenEvent] = useState(''),
    [openCharacter, setOpenCharacter] = useState('');
  const [spirit, setSpirit] = useState(false),
    [kind, setKind] = useState<'character' | 'group'>('character'),
    [entity, setEntity] = useState(''),
    [to, setTo] = useState('missing'),
    [source, setSource] = useState(''),
    [reason, setReason] = useState(''),
    [evidence, setEvidence] = useState(''),
    [ruleQuote, setRule] = useState(''),
    [leaving, setLeaving] = useState<string[]>([]),
    [joining, setJoining] = useState<string[]>([]),
    [newName, setNewName] = useState(''),
    [successors, setSuccessors] = useState<string[]>([]),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState('');
  if (!data?.world) return null;
  const name = (id: string) =>
    data.chars.find((c) => c.id === id)?.name ?? data.groups.find((g) => g.id === id)?.name ?? id;
  const members = data.groupMembers.filter((m) => m.groupId === entity);
  const toggle = (values: string[], id: string) =>
    values.includes(id) ? values.filter((v) => v !== id) : [...values, id];
  return (
    <section className="panel narrative-panel">
      <h3>人物生死与团体历史</h3>
      <p>
        状态按世界隔离；死亡与解散保留原ID和全部历史。只有存活人物参与普通模拟，亡灵交流不能借此绕过生命状态。
      </p>
      <div className="narrative-state-list">
        {data.members
          .filter((m) => m.life)
          .map((m) => (
            <p key={m.id}>
              {name(m.characterId)}：{lifeNames[m.life!.status]} · 肉体
              {m.life!.body === 'dead' ? '死亡' : m.life!.body === 'living' ? '存活' : '未知'} ·
              意识{m.life!.consciousness === 'present' ? '存在' : '未知/无'} · 来源{' '}
              {m.life!.eventId}
            </p>
          ))}
        {data.organizations.map((s) => (
          <p key={s.id}>
            {name(s.groupId)}：{groupStateNames[s.status]} · 来源 {s.eventId}
          </p>
        ))}
      </div>
      <details>
        <summary>按已发生的重大事件确认状态变化</summary>
        <p>
          请先暂停世界，选择真实事件并引用其中的原文。世界规则和状态转换仍会校验；有条件复活须在这里由用户确认，模型不能自行宣布条件满足。
        </p>
        <Field label="变化对象类型">
          <Select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as typeof kind;
              setKind(k);
              setEntity('');
              setTo(k === 'character' ? 'missing' : 'tension');
              setLeaving([]);
              setJoining([]);
            }}
          >
            <option value="character">人物</option>
            <option value="group">团体</option>
          </Select>
        </Field>
        <Field label="状态变化对象">
          <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">请选择</option>
            {(kind === 'character'
              ? data.members.map((m) => ({ id: m.characterId }))
              : data.groups
            ).map((c) => (
              <option key={c.id} value={c.id}>
                {name(c.id)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="目标状态">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            {Object.entries(kind === 'character' ? lifeNames : groupStateNames).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </Select>
        </Field>
        <Field label="变化来源重大事件">
          <Select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">请选择已发生事件</option>
            {data.events.map((e) => (
              <option key={e.id} value={e.eventId}>
                {e.title}
              </option>
            ))}
          </Select>
        </Field>
        {source && (
          <blockquote>{data.events.find((e) => e.eventId === source)?.description}</blockquote>
        )}
        <Field label="事件原文依据（至少4字）">
          <Textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
        <Field label="变化原因">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {kind === 'character' && ['resurrecting', 'resurrected'].includes(to) && (
          <Field label="适用的复活规则原文">
            <Textarea value={ruleQuote} onChange={(e) => setRule(e.target.value)} />
          </Field>
        )}
        {kind === 'group' && (
          <>
            <h4>成员退出与重新加入</h4>
            {members.map((m) => (
              <div className="toolbar" key={m.id}>
                <span>
                  {name(m.characterId)}
                  {m.departedAt ? '（已离团）' : ''}
                </span>
                <label>
                  <input
                    type="checkbox"
                    checked={leaving.includes(m.characterId)}
                    onChange={() => setLeaving(toggle(leaving, m.characterId))}
                  />
                  本次退出
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={joining.includes(m.characterId)}
                    onChange={() => setJoining(toggle(joining, m.characterId))}
                  />
                  本次归队
                </label>
              </div>
            ))}
            <Field label="分裂后新团体名称（可选，原团体继续保留）">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
            </Field>
            {newName &&
              members.map((m) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    checked={successors.includes(m.characterId)}
                    onChange={() => setSuccessors(toggle(successors, m.characterId))}
                  />
                  加入新团体：{name(m.characterId)}
                </label>
              ))}
          </>
        )}
        {kind === 'character' && to === 'dead' && (
          <label>
            <input type="checkbox" checked={spirit} onChange={(e) => setSpirit(e.target.checked)} />
            死亡后意识作为亡灵存在，并按世界规则参与特殊交流
          </label>
        )}
        <Button
          disabled={!source || !entity || evidence.trim().length < 4 || !reason.trim()}
          onClick={() => setConfirm(true)}
        >
          预览并确认变化
        </Button>
      </details>
      <details>
        <summary>变化记录（{data.changes.length}）</summary>
        {[...data.changes].reverse().map((r) => (
          <article key={r.id}>
            <strong>
              {name(r.entityId)} · {r.from} → {r.to}
            </strong>
            <p>
              {formatWorldTime(data.world!, r.at)} · {r.reason}
            </p>
            <blockquote>{r.evidence}</blockquote>
            <small>来源主事件：{r.eventId}</small>
            <Button
              onClick={() => {
                void db.majorEvents
                  .where('eventId')
                  .equals(r.eventId)
                  .first()
                  .then((e) => setOpenEvent(e?.id ?? ''));
              }}
            >
              查看来源事件
            </Button>
            {r.entityKind === 'character' && (
              <Button onClick={() => setOpenCharacter(r.entityId)}>人物资料</Button>
            )}
            {r.successorGroupIds.map((id) => (
              <p key={id}>继承组织：{name(id)}</p>
            ))}
          </article>
        ))}
      </details>
      {openEvent && <MajorEventDetail eventId={openEvent} onClose={() => setOpenEvent('')} />}
      {openCharacter && (
        <CharacterEditor
          character={data.chars.find((c) => c.id === openCharacter)}
          worldId={worldId}
          onClose={() => setOpenCharacter('')}
        />
      )}
      {error && <Status error>{error}</Status>}
      {confirm && (
        <Confirm
          title="确认记录具有长期后果的变化"
          confirmLabel="确认记录变化"
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            const proposal: NarrativeProposal = {
              entityKind: kind,
              spirit,
              entityId: entity,
              to,
              reason,
              evidence,
              ruleQuote,
              memberChanges: [
                ...leaving.map((characterId) => ({ characterId, action: 'leave' as const })),
                ...joining.map((characterId) => ({ characterId, action: 'rejoin' as const })),
              ],
              successors: newName
                ? [{ name: newName, description: reason, memberIds: successors }]
                : [],
            };
            void applyNarrativeConsequences(worldId, source, [proposal], db, true)
              .then(() => {
                setConfirm(false);
                setError('');
              })
              .catch((e) => {
                setError(String(e));
                setConfirm(false);
              });
          }}
        >
          <p>
            {name(entity)}：{to}。{reason}
          </p>
          <p>
            此操作会影响后续生活、聊天与团体活动。死亡记录不能通过删除角色消除；复活仍需满足世界规则。
          </p>
        </Confirm>
      )}
    </section>
  );
}
