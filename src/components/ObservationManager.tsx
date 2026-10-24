import { MultiSelect } from './MultiSelect';
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import {
  resolveObservation,
  saveObservation,
  fullObservation,
  pairKey,
} from '../core/selective-observation';
import { setBackfillPaused } from '../core/backfill';
import { formatWorldTime } from '../core/calendar';
import type { ObservationConfig } from '../core/focus-types';
import { Button, Field, Input, Select, Status } from './ui';
export function useObservation(worldId: string) {
  return useLiveQuery(
    async () => ({
      ...(await resolveObservation(worldId)),
      jobs: await db.backfillJobs
        .where('worldId')
        .equals(worldId)
        .and((j) => j.status !== 'complete')
        .toArray(),
    }),
    [worldId],
  );
}
export function ObservationSummary({ worldId, onEdit }: { worldId: string; onEdit?: () => void }) {
  const data = useObservation(worldId),
    latest = useLiveQuery(
      () =>
        db.worldReports
          .where('worldId')
          .equals(worldId)
          .and((r) => r.status === 'ready')
          .last(),
      [worldId],
    );
  if (!data) return null;
  return (
    <section className="observation-summary panel">
      <strong>
        {data.config.mode === 'full' ? '全量观察' : '选择性观察'} · 正在观察 {data.activeIds.size}{' '}
        名角色、
        {data.config.mode === 'full'
          ? new Set(data.gm.map((m) => m.groupId)).size
          : data.config.groupIds.length}{' '}
        个团体
      </strong>
      <span>
        静默 {Math.max(0, data.members.length - data.activeIds.size)} 名角色、
        {data.config.mode === 'full'
          ? 0
          : Math.max(0, new Set(data.gm.map((m) => m.groupId)).size - data.config.groupIds.length)}
        个团体 · 不沿关系网扩张
      </span>
      {data.jobs.length > 0 && <span>历史补全未完成：{data.jobs.length} 项</span>}
      {latest && <span>最新世界报告已归档</span>}
      {onEdit && <Button onClick={onEdit}>观察管理</Button>}
    </section>
  );
}
export function ObservationManager({ worldId }: { worldId: string }) {
  const data = useLiveQuery(
    async () => ({
      scope: await resolveObservation(worldId),
      chars: await db.characters.filter((entity) => !entity.deletedAt).toArray(),
      groups: await db.groups.filter((g) => g.worldIds.includes(worldId)).toArray(),
      jobs: await db.backfillJobs.where('worldId').equals(worldId).toArray(),
      world: await db.worlds.get(worldId),
      cp: await db.checkpoints.get(worldId),
    }),
    [worldId],
  );
  const [draft, setDraft] = useState<ObservationConfig>(fullObservation(worldId)),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [first, setFirst] = useState(''),
    [second, setSecond] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setDraft(data.scope.config);
  }, [data?.scope.config.updatedAt, worldId]);
  if (!data) return null;
  const chars = data.chars.filter(
    (c) => data.scope.members.some((m) => m.characterId === c.id) && c.entityMode !== 'background',
  );
  const active = (id: string) =>
    draft.mode === 'full' ||
    draft.characterIds.includes(id) ||
    draft.pairs.some((p) => p.includes(id)) ||
    data.scope.gm.some((m) => m.characterId === id && draft.groupIds.includes(m.groupId));
  return (
    <div className="observation-manager">
      <h2>观察管理</h2>
      <p>
        角色观察包含个人社交；团体只开放团体会话和共同事务；CP只开放双方互动。其他人物只会低频临时参与重要事件，不会递归激活朋友。
      </p>
      <Field label="观察模式">
        <Select
          value={draft.mode}
          onChange={(e) =>
            setDraft({ ...draft, mode: e.target.value as ObservationConfig['mode'] })
          }
        >
          <option value="full">全量观察 · 保留原有模拟</option>
          <option value="selective">选择性观察 · 大型世界推荐</option>
        </Select>
      </Field>
      <div className="toolbar">
        <Input
          aria-label="搜索观察对象"
          placeholder="搜索角色或团体"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label="观察状态筛选"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">全部</option>
          <option value="active">已观察</option>
          <option value="dormant">静默</option>
        </Select>
      </div>
      <div className="toolbar">
        <Button
          onClick={() =>
            setDraft({ ...draft, mode: 'selective', characterIds: chars.map((c) => c.id) })
          }
        >
          勾选全部角色
        </Button>
        <Button
          onClick={() =>
            setDraft({ ...draft, mode: 'selective', characterIds: [], groupIds: [], pairs: [] })
          }
        >
          清空观察选择
        </Button>
      </div>
      <h3>角色 · 个人完整观察</h3>
      <MultiSelect
        label="观察角色"
        options={chars
          .filter(
            (c) =>
              c.name.includes(search) &&
              (filter === 'all' || active(c.id) === (filter === 'active')),
          )
          .map((c) => ({ ...c, character: c, detail: active(c.id) ? '正在观察' : '静默' }))}
        value={draft.characterIds}
        onChange={(characterIds) => setDraft({ ...draft, mode: 'selective', characterIds })}
      />
      <h3>团体 · 不扩张成员的私人社交网络</h3>
      <MultiSelect
        label="观察团体"
        options={data.groups.filter((g) => !g.deletedAt && g.name.includes(search))}
        value={draft.groupIds}
        onChange={(groupIds) => setDraft({ ...draft, mode: 'selective', groupIds })}
      />
      <h3>双人关系 / CP</h3>
      <div className="toolbar">
        <Select aria-label="CP第一位" value={first} onChange={(e) => setFirst(e.target.value)}>
          <option value="">选择角色</option>
          {chars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select aria-label="CP第二位" value={second} onChange={(e) => setSecond(e.target.value)}>
          <option value="">选择另一位</option>
          {chars
            .filter((c) => c.id !== first)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </Select>
        <Button
          disabled={!first || !second || first === second}
          onClick={() => {
            if (!draft.pairs.some((p) => pairKey(p) === pairKey([first, second])))
              setDraft({ ...draft, mode: 'selective', pairs: [...draft.pairs, [first, second]] });
          }}
        >
          观察这对关系
        </Button>
      </div>
      {draft.pairs.map((p) => (
        <p key={pairKey(p)}>
          {p.map((id) => chars.find((c) => c.id === id)?.name).join(' ↔ ')}{' '}
          <Button
            onClick={() =>
              setDraft({ ...draft, pairs: draft.pairs.filter((v) => pairKey(v) !== pairKey(p)) })
            }
          >
            取消此对观察
          </Button>
        </p>
      ))}
      <Status>
        范围预览：{chars.filter((c) => active(c.id)).length}名活跃角色 /{' '}
        {chars.filter((c) => !active(c.id)).length}
        名静默角色。新观察对象会回溯最近72个虚拟小时，世界开始不足三天时按实际历史处理。
        {data.cp?.paused ? '世界当前已暂停，回溯任务会等待继续运行。' : ''}
      </Status>
      <Button
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const job = await saveObservation({ ...draft, updatedAt: Date.now() });
            setNotice(
              job ? '已保存，历史补全已排队。' : '观察范围已保存，已覆盖的历史不会重复补全。',
            );
          } catch (e) {
            setNotice(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        保存观察范围
      </Button>
      {notice && <Status>{notice}</Status>}
      <h3>正在打听他们最近的生活……</h3>
      {data.jobs
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
        .map((j) => (
          <article className="panel" key={j.id}>
            <strong>
              {j.status === 'complete'
                ? '历史补全完成'
                : j.status === 'paused'
                  ? '历史补全已取消，可继续'
                  : j.status === 'waiting'
                    ? '历史补全未完成 · 等待AI内容'
                    : '历史补全中'}
            </strong>
            <p>
              {data.world && formatWorldTime(data.world, j.start)} —{' '}
              {data.world && formatWorldTime(data.world, j.end)}
            </p>
            <progress max={Math.max(1, j.end - j.start)} value={j.checkpoint - j.start} />
            <p>
              范围检查 {Math.round((100 * (j.checkpoint - j.start)) / Math.max(1, j.end - j.start))}
              % · {j.completedIntervals.length}段日期已检查 · {j.eventCount}个事件 ·{' '}
              {j.messageCount}条消息
            </p>
            <details>
              <summary>已检查的日期范围</summary>
              {j.completedIntervals.map(([a, b]) => (
                <p key={a}>
                  {data.world && formatWorldTime(data.world, a)} —{' '}
                  {data.world && formatWorldTime(data.world, b)}
                </p>
              ))}
            </details>
            {j.error && <Status error>{j.error}</Status>}
            {j.status !== 'complete' && (
              <Button onClick={() => void setBackfillPaused(j.id, j.status !== 'paused')}>
                {j.status === 'paused' ? '继续历史补全' : '取消，保留已完成内容'}
              </Button>
            )}
            {j.notes.at(-1) && <small>{j.notes.at(-1)}</small>}
          </article>
        ))}
    </div>
  );
}
