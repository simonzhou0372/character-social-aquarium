import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { Toggle } from './ui';
export function GenerationPerformance({ worldId }: { worldId: string }) {
  const data = useLiveQuery(async () => {
    const ranges = ['pending', 'running', 'failed'].map((status) =>
      db.contentJobs
        .where('[worldId+status+at]')
        .between([worldId, status, Dexie.minKey], [worldId, status, Dexie.maxKey]),
    );
    const count = (await Promise.all(ranges.map((r) => r.clone().count()))).reduce(
      (a, b) => a + b,
      0,
    );
    const oldest = (await Promise.all(ranges.map((r) => r.clone().first())))
      .filter(Boolean)
      .sort((a, b) => a!.at - b!.at);
    const logs = await db.taskLogs
      .where('[worldId+task+at]')
      .between(
        [worldId, 'adaptive-metric', Dexie.minKey],
        [worldId, 'adaptive-metric', Dexie.maxKey],
      )
      .reverse()
      .limit(100)
      .toArray();
    const metrics = logs.flatMap((l) => {
      try {
        return [JSON.parse(l.detail ?? '{}')];
      } catch {
        return [];
      }
    });
    return {
      count,
      oldest: oldest[0]?.at,
      metrics,
      cp: await db.checkpoints.get(worldId),
      s: await db.settings.get('app'),
      usage: await db.usage.get(new Date().toISOString().slice(0, 10)),
      profile: await db.profiles.get('api'),
    };
  }, [worldId]);
  if (!data) return null;
  const m = data.metrics,
    avg = (key: string) =>
      m.length ? Math.round(m.reduce((n, v) => n + (v[key] ?? 0), 0) / m.length) : 0;
  const waitP95 =
    m.map((v) => v.waitMs ?? 0).sort((a, b) => a - b)[
      Math.max(0, Math.ceil(m.length * 0.95) - 1)
    ] ?? 0;
  const peak = Math.max(data.count, ...m.map((v) => v.queueLength ?? 0));
  const u = data.usage,
    price = data.profile;
  return (
    <details className="panel">
      <summary>AI 生成性能 · 高级诊断</summary>
      <Toggle
        checked={data.s?.adaptiveBatching !== false}
        onChange={(adaptiveBatching) => void db.settings.update('app', { adaptiveBatching })}
        label="自动优化高倍速生成"
      />
      <p>
        {data.s?.adaptiveBatching === false
          ? '独立请求'
          : (data.cp?.speed ?? 1) >= 300
            ? '高倍速自适应批处理'
            : '常速独立生成'}{' '}
        · 待处理 {data.count} 项 · 平均每批{' '}
        {m.length ? (m.reduce((n, v) => n + (v.tasks ?? 0), 0) / m.length).toFixed(1) : '—'}{' '}
        个子任务
      </p>
      <p>
        近期请求平均耗时 {avg('latencyMs')} ms · 平均等待 {avg('waitMs')} ms · 批次完整返回率{' '}
        {m.length
          ? Math.round((m.filter((v) => v.returned === v.tasks).length / m.length) * 100)
          : 0}
        % · P95 等待 {Math.round(waitP95)} ms · 近期队列峰值 {peak} 项
      </p>
      <p>
        当前世界内容落后约{' '}
        {data.oldest === undefined
          ? 0
          : Math.max(
              0,
              Math.round(
                ((data.cp?.clockAnchor?.simTime ?? data.cp?.simTime ?? 0) - data.oldest) / 60000,
              ),
            )}{' '}
        个虚拟分钟；吞吐不足时保留计划，等待恢复。
      </p>
      <p>
        今日全部世界合计：请求 {u?.requests ?? 0} 次 · 输入 {Math.round(u?.inputTokens ?? 0)} / 输出{' '}
        {Math.round(u?.outputTokens ?? 0)} Token
        {price?.inputPrice !== undefined && price?.outputPrice !== undefined
          ? ` · 依配置单价估算费用 ${(((u?.inputTokens ?? 0) * price.inputPrice + (u?.outputTokens ?? 0) * price.outputPrice) / 1e6).toFixed(4)}`
          : ''}
      </p>
      <p className="muted">
        诊断统计最近100个请求批次。返回完整仍需通过逐项内容校验；请求减少不代表输出 Token
        按比例减少。
      </p>
    </details>
  );
}
