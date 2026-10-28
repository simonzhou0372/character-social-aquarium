import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { evolutionFields } from '../core/focus-types';
import { revertEvolution } from '../core/evolution';
import { formatWorldTime } from '../core/calendar';
import { Button, Status, Confirm } from './ui';
const labels = {
  initiative: '社交主动倾向',
  personality: '长期性格倾向',
  style: '说话习惯',
  habits: '生活习惯',
  values: '核心价值观',
  goal: '人生目标',
  fear: '最大恐惧',
};
export function EvolutionPanel({ worldId, characterId }: { worldId: string; characterId: string }) {
  const data = useLiveQuery(
    async () => ({
      world: await db.worlds.get(worldId),
      member: await db.memberships
        .where('[worldId+characterId]')
        .equals([worldId, characterId])
        .first(),
      records: await db.evolutionRecords
        .where('worldId')
        .equals(worldId)
        .and((r) => r.characterId === characterId)
        .reverse()
        .sortBy('at'),
    }),
    [worldId, characterId],
  );
  const [allowed, setAllowed] = useState<string[]>([]);
  useEffect(() => {
    setAllowed(data?.member?.evolutionFields ?? []);
  }, [data?.member?.id, JSON.stringify(data?.member?.evolutionFields)]);
  const [error, setError] = useState(''),
    [undo, setUndo] = useState('');
  if (!data?.member) return null;
  return (
    <details className="panel">
      <summary>人物变化记录与设定锁定 · 当前世界</summary>
      <p>
        {data.world?.evolutionSettings?.enabled
          ? '本世界允许有依据的缓慢演化'
          : '本世界关闭长期演化；临时情绪和事件记忆仍正常变化。'}{' '}
        姓名、性别、核心身份和简介始终锁定。下列选项即时保存，只影响当前世界。
      </p>
      {evolutionFields.map((field) => (
        <label className="focus-option" key={field}>
          <input
            type="checkbox"
            checked={allowed.includes(field)}
            onChange={(e) => {
              const next = e.target.checked
                ? [...new Set([...allowed, field])]
                : allowed.filter((f) => f !== field);
              setAllowed(next);
              void db.memberships
                .update(data.member!.id, {
                  evolutionFields: next as typeof data.member.evolutionFields,
                })
                .catch((e) => setError(String(e)));
            }}
          />
          允许自然演化：{labels[field]}
        </label>
      ))}
      {Object.entries(data.member.evolved ?? {}).map(([field, value]) => (
        <p key={field}>
          当前动态{labels[field as keyof typeof labels]}：{value}
        </p>
      ))}
      {data.records.map((r) => (
        <article key={r.id} className="panel">
          <strong>
            {labels[r.field]} · {r.status === 'applied' ? '已应用' : '已撤销'}
          </strong>
          <p>{data.world && formatWorldTime(data.world, r.at)}</p>
          <p>
            {r.previousValue} → {r.newValue}
          </p>
          <p>{r.reason}</p>
          <small>依据事件：{r.sourceEventIds.join('、')}</small>
          {r.status === 'applied' && <Button onClick={() => setUndo(r.id)}>撤销此次变化</Button>}
        </article>
      ))}
      {!data.records.length && <p>尚无有充分依据的长期变化。</p>}
      {error && <Status error>{error}</Status>}
      {undo && (
        <Confirm
          title="撤销人物变化"
          confirmLabel="确认撤销"
          onClose={() => setUndo('')}
          onConfirm={async () => {
            try {
              await revertEvolution(undo, true);
              setUndo('');
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <p>
            同时撤销依赖此结果的后续同字段变化，保留所有事件与原始记录。用户后来手动修改的动态值不会被直接覆盖。
          </p>
        </Confirm>
      )}
    </details>
  );
}
