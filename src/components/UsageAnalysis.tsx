import { cacheStatistics } from '../ai/cache-statistics';
import { dayOrdinal, worldTime, fromOrdinal } from '../core/calendar';
import { clockTarget } from '../core/time';
import { foregroundStart } from '../core/clock-presence';
import { modelPolicy } from '../ai/model-policy';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { DAY } from '../core/types';
import { ModelPricingSchema, type ModelPricing } from '../core/usage-types';
import { downloadJson } from '../data/backup';
import { Button, Field, Input, Select, Toggle, Status, Confirm } from './ui';
const source = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const priceSnapshot = {
  'deepseek-flash': {
    input: 2,
    cachedInput: 0.04,
    output: 8,
    offPeak: { input: 1, cachedInput: 0.02, output: 4 },
  },
  'deepseek-v4-pro': {
    input: 9,
    cachedInput: 0.3,
    output: 27,
    offPeak: { input: 4.5, cachedInput: 0.15, output: 13.5 },
  },
};
export function UsageAnalysis({ onObserve }: { onObserve?: () => void } = {}) {
  const [worldId, setWorld] = useState(''),
    [model, setModel] = useState(''),
    [task, setTask] = useState(''),
    [range, setRange] = useState('all'),
    [error, setError] = useState(''),
    [confirmPrice, setConfirmPrice] = useState(false);
  const [price, setPrice] = useState<ModelPricing>({
    model: '',
    currency: 'CNY',
    input: 0,
    cachedInput: 0,
    output: 0,
    period: 'conservativePeak',
    confirmedAt: Date.now(),
    source: '用户确认定价',
  });
  const data = useLiveQuery(
    async () => ({
      worlds: await db.worlds.filter((w) => !w.deletedAt).toArray(),
      rows: await db.usageLedger.toArray(),
      settings: await db.settings.get('app'),
      profile: await db.profiles.get('api'),
      checkpoints: await db.checkpoints.toArray(),
      observation: await db.observationConfigs.toArray(),
    }),
    [],
  );
  if (!data?.settings) return null;
  const settings = data.settings,
    controls = settings.costControls ?? { prices: [] },
    p = data.profile;
  const currentDays = new Map(
    data.worlds.map((w) => {
      const cp = data.checkpoints.find((c) => c.id === w.id);
      return [
        w.id,
        cp ? dayOrdinal(worldTime(w, clockTarget(cp, Date.now(), foregroundStart()))) : undefined,
      ];
    }),
  );
  const rows = data.rows.filter(
    (r) =>
      (!worldId || r.worldId === worldId) &&
      (!model || r.model === model) &&
      (!task || r.task === task) &&
      (range === 'all' ||
        (range === 'realToday'
          ? r.startedAt >= Math.floor(Date.now() / DAY) * DAY
          : r.virtualDay !== undefined &&
            currentDays.get(r.worldId) !== undefined &&
            r.virtualDay <= currentDays.get(r.worldId)! &&
            r.virtualDay >= currentDays.get(r.worldId)! - (range === 'virtualWeek' ? 6 : 0))),
  );
  const sum = (
    key:
      | 'costCny'
      | 'inputTokens'
      | 'outputTokens'
      | 'reasoningTokens'
      | 'cacheHitTokens'
      | 'cacheMissTokens'
      | 'messages'
      | 'dialogue',
    list = rows,
  ) => list.reduce((n, r) => n + (r[key] ?? 0), 0);
  const fee = sum('costCny'),
    known = rows.filter((r) => r.costCny !== undefined).length,
    today = rows.filter((r) => r.startedAt >= Math.floor(Date.now() / DAY) * DAY);
  const days = new Set(
    rows
      .filter((r) => r.virtualAt !== undefined)
      .map((r) => `${r.worldId}:${r.virtualDay ?? Math.floor(r.virtualAt! / DAY)}`),
  );
  const cacheReport = cacheStatistics(rows);
  const online = rows.filter((r) => ['chat', 'recoveryChat'].includes(r.task)),
    scenes = rows.filter((r) => ['inPerson', 'offlineScene'].includes(r.task));
  const tasks = [...new Set(rows.map((r) => r.task))];
  const update = (value: Partial<typeof controls>) =>
    db.transaction('rw', db.settings, db.contentJobs, async () => {
      await db.settings.update('app', { costControls: { ...controls, ...value } });
      if (value.budget || value.localDescriptions)
        await db.contentJobs
          .where('status')
          .equals('failed')
          .and((j) => j.errorCode === 'budget')
          .modify({ status: 'pending', attempts: 0, nextAttemptAt: 0 });
    });
  const budget = controls.budget ?? { period: 'unlimited' as const, cny: 10, warnRatio: 0.8 };
  const bw = data.worlds.find((w) => w.id === (worldId || settings.worldId)),
    bc = data.checkpoints.find((cp) => cp.id === bw?.id);
  const currentDay =
    bw && bc
      ? dayOrdinal(worldTime(bw, clockTarget(bc, Date.now(), foregroundStart())))
      : undefined;
  const budgetRows = data.rows.filter((r) =>
    budget.period === 'realDay'
      ? r.startedAt >= Math.floor(Date.now() / DAY) * DAY
      : r.worldId === bw?.id &&
        r.budgetVirtualDay !== undefined &&
        currentDay !== undefined &&
        r.budgetVirtualDay >= currentDay - (budget.period === 'virtualWeek' ? 6 : 0) &&
        r.budgetVirtualDay <= currentDay,
  );
  const budgetUsed = budgetRows.reduce(
    (n, r) =>
      n + (r.status === 'running' ? (r.reservedCny ?? 0) : (r.costCny ?? r.reservedCny ?? 0)),
    0,
  );
  return (
    <div className="usage-analysis">
      <section className="panel">
        <h2>AI 用量分析</h2>
        <p>
          账本仅记录升级后的新请求。旧版 ¥15
          无法可靠拆分，未补造历史。所有费用都是按确认单价计算的估算，不代表服务商账单。
        </p>
        <div className="form-grid">
          <Field label="账本世界筛选">
            <Select value={worldId} onChange={(e) => setWorld(e.target.value)}>
              <option value="">全部世界</option>
              {data.worlds.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="账本模型筛选">
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">全部模型</option>
              {[...new Set(data.rows.map((r) => r.model))].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="账本时间范围">
            <Select value={range} onChange={(e) => setRange(e.target.value)}>
              <option value="all">全部记录</option>
              <option value="realToday">今日请求（UTC）</option>
              <option value="virtualToday">当前虚拟日内容</option>
              <option value="virtualWeek">最近7个虚拟日内容</option>
            </Select>
          </Field>
          <Field label="账本任务筛选">
            <Select value={task} onChange={(e) => setTask(e.target.value)}>
              <option value="">全部任务</option>
              {[...new Set(data.rows.map((r) => r.task))].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
        </div>
        <p>
          已知用量估算合计 ¥{fee.toFixed(4)} · 今日（UTC）¥{sum('costCny', today).toFixed(4)} ·
          有定价记录 {known}/{rows.length}
        </p>
        <p>
          已知部分每虚拟日平均 ¥{days.size ? (fee / days.size).toFixed(4) : '—'} · 每100条线上消息 ¥
          {online.some((r) => r.costCny === undefined)
            ? '用量或价格不完整'
            : sum('messages', online)
              ? ((sum('costCny', online) * 100) / sum('messages', online)).toFixed(4)
              : '—'}{' '}
          · 每1000条线下对白 ¥
          {scenes.some((r) => r.costCny === undefined)
            ? '用量或价格不完整'
            : sum('dialogue', scenes)
              ? ((sum('costCny', scenes) * 1000) / sum('dialogue', scenes)).toFixed(4)
              : '—'}
        </p>
        <p>
          输入 {sum('inputTokens')} · 输出 {sum('outputTokens')}（其中思考已知{' '}
          {sum('reasoningTokens')}，不重复收费）· 缓存命中率{' '}
          {cacheReport.global.overallHitRate === null
            ? '数据不完整'
            : (100 * cacheReport.global.overallHitRate).toFixed(1) + '%'}{' '}
          · 有效缓存记录 {cacheReport.global.measuredRequests}/{rows.length} · 已测部分{' '}
          {cacheReport.global.measuredHitRate === null
            ? '—'
            : (100 * cacheReport.global.measuredHitRate).toFixed(1) + '%'}{' '}
          · 输入成本 ¥{cacheReport.global.inputCostCny?.toFixed(4) ?? '未知'}
          <Button onClick={() => downloadJson(cacheReport, 'cache-statistics.json')}>
            导出各世界/任务缓存统计
          </Button>
        </p>
        <p>
          已知Token占比：输入{' '}
          {sum('inputTokens') + sum('outputTokens')
            ? ((100 * sum('inputTokens')) / (sum('inputTokens') + sum('outputTokens'))).toFixed(1)
            : '—'}
          %；输出包含思考，思考数据缺失时不推算占比。
        </p>
        <p>
          缺少思考明细 {rows.filter((r) => r.reasoningTokens === undefined).length} 项 ·
          用量缺失/估算 {rows.filter((r) => r.inputTokens === undefined || r.estimated).length} 项 ·
          关联重试/续写费用 ¥
          {sum(
            'costCny',
            rows.filter((r) => !!r.retryOf || r.attempt > 0),
          ).toFixed(4)}{' '}
          · 涉及失败或部分返回的请求费用（含保留部分） ¥
          {sum(
            'costCny',
            rows.filter(
              (r) =>
                r.status === 'failed' ||
                r.status === 'truncated' ||
                r.validationStatus === 'rejected' ||
                r.validationStatus === 'partial',
            ),
          ).toFixed(4)}
        </p>
        <div className="ledger-scroll">
          <table>
            <thead>
              <tr>
                <th>任务</th>
                <th>请求</th>
                <th>估算费用</th>
                <th>占已知费用</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const list = rows.filter((r) => r.task === t),
                  cost = sum('costCny', list);
                return (
                  <tr key={t}>
                    <td>{t}</td>
                    <td>{list.length}</td>
                    <td>¥{cost.toFixed(4)}</td>
                    <td>{fee ? ((cost / fee) * 100).toFixed(1) : '—'}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p>
          当前世界已知费用 ¥
          {sum(
            'costCny',
            data.rows.filter((r) => r.worldId === settings.worldId),
          ).toFixed(4)}
          （{data.worlds.find((w) => w.id === settings.worldId)?.name}）
        </p>
        <h3>最近7个虚拟日费用</h3>
        {[...new Set(rows.map((r) => r.worldId))].map((id) => {
          const current =
            currentDays.get(id) ??
            Math.max(
              ...rows
                .filter((r) => r.worldId === id && r.virtualDay !== undefined)
                .map((r) => r.virtualDay!),
            );
          if (!Number.isFinite(current)) return null;
          return (
            <div key={id}>
              <strong>{data.worlds.find((w) => w.id === id)?.name ?? id}</strong>
              {Array.from({ length: 7 }, (_, i) => current - 6 + i).map((day) => {
                const cost = sum(
                  'costCny',
                  rows.filter(
                    (r) =>
                      r.worldId === id &&
                      r.virtualAt !== undefined &&
                      (r.virtualDay ?? Math.floor(r.virtualAt / DAY)) === day,
                  ),
                );
                return (
                  <p key={day}>
                    {(() => {
                      const date = fromOrdinal(day);
                      return `${data.worlds.find((w) => w.id === id)?.era ?? 'AD'} ${date.year}/${date.month}/${date.day}`;
                    })()}
                    ：¥{cost.toFixed(4)}
                  </p>
                );
              })}
            </div>
          );
        })}
        <details>
          <summary>最近50条请求明细</summary>
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间/任务</th>
                  <th>模型/推理</th>
                  <th>Token 输入/输出/思考</th>
                  <th>缓存 命中/未命中</th>
                  <th>状态/校验</th>
                  <th>费用</th>
                </tr>
              </thead>
              <tbody>
                {[...rows]
                  .sort((a, b) => b.startedAt - a.startedAt)
                  .slice(0, 50)
                  .map((r) => (
                    <tr key={r.id}>
                      <td>
                        {new Date(r.startedAt).toLocaleString()}
                        <br />
                        {r.task}
                        <small>{r.id}</small>
                      </td>
                      <td>
                        {r.model}
                        <br />
                        {r.thinking} / {r.effort ?? '未提供'}
                      </td>
                      <td>
                        {r.inputTokens ?? '未知'} / {r.outputTokens ?? '未知'} /{' '}
                        {r.reasoningTokens ?? '未知'}
                      </td>
                      <td>
                        {r.cacheHitTokens ?? '未知'} / {r.cacheMissTokens ?? '未知'}
                      </td>
                      <td>
                        {r.status} / {r.validationStatus ?? '未确认'}
                        {r.retryOf && <small>重试自 {r.retryOf}</small>}
                      </td>
                      <td>
                        {r.costCny === undefined ? '未知' : `约¥${r.costCny.toFixed(6)}`}
                        <small>{r.costQuality}</small>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
        <Button
          onClick={() =>
            downloadJson(
              { format: 'aquarium-usage-ledger', exportedAt: Date.now(), rows },
              'ai-usage-ledger.json',
            )
          }
        >
          导出筛选后的账本（不含密钥及Prompt）
        </Button>
      </section>
      {p && (
        <section className="panel">
          <h3>推理策略与稳定前缀</h3>
          <Field label="AI推理策略">
            <Select
              value={p.reasoningPolicy ?? 'auto'}
              onChange={(e) =>
                void db.profiles.update('api', {
                  reasoningPolicy: e.target.value as 'auto' | 'user' | 'advanced',
                })
              }
            >
              <option value="auto">自动优化（推荐）</option>
              <option value="user">始终使用用户指定模式</option>
              <option value="advanced">高级任务模型分配</option>
            </Select>
          </Field>
          <p>
            普通社交默认非思考，复杂演化低强度，小说主线高强度。自动模式沿用你配置的模型，不擅自切换到其他收费模型。不支持的接口保持原生参数，未知模式如实标注。
          </p>
          <Toggle
            label="启用稳定公共前缀（仅适用已确认的DeepSeek协议）"
            checked={p.stablePrefix !== false}
            onChange={(stablePrefix) => void db.profiles.update('api', { stablePrefix })}
          />
          <Toggle
            label="紧凑聊天协议（保留全部消息、@、引用与表情）"
            checked={p.compactProtocol ?? modelPolicy(p, 'chat').deepSeek}
            onChange={(compactProtocol) => void db.profiles.update('api', { compactProtocol })}
          />
          <Toggle
            label="此兼容代理明确支持DeepSeek参数（仅手动确认后使用）"
            checked={p.deepSeekCompatible === true}
            onChange={(deepSeekCompatible) =>
              void db.profiles.update('api', { deepSeekCompatible })
            }
          />
          {p.reasoningPolicy === 'advanced' &&
            (['routine', 'complex', 'story'] as const).map((kind) => (
              <div className="form-grid" key={kind}>
                <Field label={`${kind} 模型（空白沿用主模型）`}>
                  <Input
                    value={p.taskRoutes?.[kind]?.model ?? ''}
                    onChange={(e) =>
                      void db.profiles.update('api', {
                        taskRoutes: {
                          ...p.taskRoutes,
                          [kind]: { ...p.taskRoutes?.[kind], model: e.target.value },
                        },
                      })
                    }
                  />
                </Field>
                <Field label={`${kind} 思考`}>
                  <Select
                    value={p.taskRoutes?.[kind]?.thinking ?? (kind === 'routine' ? 'off' : 'on')}
                    onChange={(e) =>
                      void db.profiles.update('api', {
                        taskRoutes: {
                          ...p.taskRoutes,
                          [kind]: {
                            ...p.taskRoutes?.[kind],
                            thinking: e.target.value as 'on' | 'off' | 'default',
                          },
                        },
                      })
                    }
                  >
                    <option value="off">关闭</option>
                    <option value="on">开启</option>
                    <option value="default">服务商默认</option>
                  </Select>
                </Field>
                <Field label={`${kind} 推理强度`}>
                  <Select
                    value={p.taskRoutes?.[kind]?.effort ?? (kind === 'complex' ? 'low' : 'high')}
                    onChange={(e) =>
                      void db.profiles.update('api', {
                        taskRoutes: {
                          ...p.taskRoutes,
                          [kind]: {
                            ...p.taskRoutes?.[kind],
                            effort: e.target.value as 'low' | 'high' | 'max',
                          },
                        },
                      })
                    }
                  >
                    <option value="low">低</option>
                    <option value="high">高</option>
                    <option value="max">最高</option>
                  </Select>
                </Field>
              </div>
            ))}
        </section>
      )}
      <section className="panel">
        <h3>确认模型定价</h3>
        <p>
          <a href={source} target="_blank" rel="noreferrer">
            DeepSeek官方价格
          </a>{' '}
          · 内置参考核对日期
          2026-10-28，使用前请核对；不会自动覆写已确认定价。默认用高峰价保守估算，不猜测法定节假日。
        </p>
        <div className="form-grid">
          <Field label="定价模型">
            <Input
              value={price.model}
              onChange={(e) => setPrice({ ...price, model: e.target.value })}
            />
          </Field>
          <Field label="单价币种">
            <Select
              value={price.currency}
              onChange={(e) => setPrice({ ...price, currency: e.target.value as 'CNY' | 'USD' })}
            >
              <option>CNY</option>
              <option>USD</option>
            </Select>
          </Field>
          {(['input', 'cachedInput', 'output'] as const).map((k) => (
            <Field
              key={k}
              label={
                {
                  input: '未命中输入/百万Token',
                  cachedInput: '缓存命中输入/百万Token',
                  output: '输出/百万Token',
                }[k]
              }
            >
              <Input
                type="number"
                min="0"
                step="0.001"
                value={price[k] ?? ''}
                onChange={(e) => setPrice({ ...price, [k]: Number(e.target.value) })}
              />
            </Field>
          ))}
          <Field label="定价适用时段">
            <Select
              value={price.period}
              onChange={(e) =>
                setPrice({ ...price, period: e.target.value as ModelPricing['period'] })
              }
            >
              <option value="conservativePeak">高峰保守估算</option>
              <option value="peak">确认高峰</option>
              <option value="offPeak">确认空闲（未配置空闲表时使用所填单价）</option>
            </Select>
          </Field>
          {price.currency === 'USD' && (
            <Field label="用户确认美元人民币汇率">
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={price.cnyPerUnit ?? ''}
                onChange={(e) => setPrice({ ...price, cnyPerUnit: Number(e.target.value) })}
              />
            </Field>
          )}
        </div>
        <Button
          onClick={() => {
            const model = p?.model ?? 'deepseek-flash';
            const reference = priceSnapshot[model as keyof typeof priceSnapshot];
            if (!reference) {
              setError('此模型没有当前参考价格，请手动填写并确认。');
              return;
            }
            setPrice({
              ...reference,
              model,
              currency: 'CNY',
              period: 'conservativePeak',
              confirmedAt: Date.now(),
              source: source + '（2026-10-28核对）',
            });
          }}
        >
          预填当前官方模型参考价
        </Button>
        <Button
          onClick={() => {
            try {
              ModelPricingSchema.parse(price);
              setConfirmPrice(true);
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          保存定价前确认
        </Button>
        {controls.prices.map((price) => (
          <p key={price.model}>
            {price.model} · {price.currency} · 输入/命中/输出 {price.input}/
            {price.cachedInput ?? '—'}/{price.output} · {price.source}
            <Button onClick={() => setPrice(price)}>编辑</Button>
          </p>
        ))}
      </section>
      <section className="panel">
        <h3>运行成本控制</h3>
        {budget.period !== 'unlimited' && (
          <p role={budgetUsed >= budget.cny * budget.warnRatio ? 'status' : undefined}>
            本周期已计入及保守预留约 ¥{budgetUsed.toFixed(4)} / ¥{budget.cny}。
            {budgetUsed >= budget.cny * budget.warnRatio
              ? '接近或达到预算上限，后续付费任务可能等待。'
              : ''}
          </p>
        )}
        <p>
          按已记录样本线性外推，7个虚拟日已知费用约 ¥
          {days.size ? ((fee / days.size) * 7).toFixed(4) : '—'}
          ；缺失的账本或单价不计入，不能作为实际账单保证。
        </p>
        <Field label="人民币预算周期">
          <Select
            value={budget.period}
            onChange={(e) =>
              void update({ budget: { ...budget, period: e.target.value as typeof budget.period } })
            }
          >
            <option value="unlimited">不限制金额</option>
            <option value="realDay">每现实日（UTC，所有世界）</option>
            <option value="virtualDay">每虚拟日（每世界）</option>
            <option value="virtualWeek">最近7个虚拟日（每世界）</option>
          </Select>
        </Field>
        <Field label="人民币预算上限">
          <Input
            type="number"
            min="0.01"
            step="0.01"
            value={budget.cny}
            onChange={(e) => {
              if (Number(e.target.value) > 0)
                void update({ budget: { ...budget, cny: Number(e.target.value) } });
            }}
          />
        </Field>
        <p>
          付费任务按输入与最大输出保守预留；预算不足持久化等待，不删除计划。金额预算独立于原有Token与请求限制；虚拟日预算按执行时HUD世界日期续期，账本趋势仍按原事件日期归档。价格未知时暂停付费生成。服务商未返回用量的请求继续占用保守预留，直到账期续期或用户调整预算。
        </p>
        <Toggle
          label="复用已确定的普通活动描述（本地事实，不冒充AI新内容）"
          checked={controls.localDescriptions === true}
          onChange={(localDescriptions) => void update({ localDescriptions })}
        />
        <Toggle
          label="经济模拟（需要手动选择观察范围）"
          checked={controls.economy === true}
          onChange={(economy) => void update({ economy })}
        />
        <p>
          {controls.economy
            ? '请到观察管理明确选择角色/团体/CP；未观察者减少细粒度内容。不会自动替你静默人物，此模式须与等量优化分开统计。'
            : '等量优化：保持计划消息、线下对白和重大事件数量；优化请求与输入，不改变活跃度。'}
        </p>
        {controls.economy && (
          <>
            <p>
              {data.observation.find((o) => o.id === settings.worldId)?.mode === 'selective'
                ? '当前世界已使用选择性观察；节省来自真实的静默调度。'
                : '当前世界仍为全量观察：经济模式尚未减少内容，请先明确选择观察对象。'}
            </p>
            <Button onClick={onObserve}>配置经济观察范围</Button>
          </>
        )}
      </section>
      {error && <Status error>{error}</Status>}
      {confirmPrice && (
        <Confirm
          title="确认当前模型计费配置"
          onClose={() => setConfirmPrice(false)}
          confirmLabel="确认保存定价"
          onConfirm={() => {
            void update({
              prices: [
                ...controls.prices.filter((p) => p.model !== price.model),
                { ...price, confirmedAt: Date.now() },
              ],
            });
            setConfirmPrice(false);
          }}
        >
          <p>
            {price.model}：每百万Token输入 {price.input}、缓存命中 {price.cachedInput ?? '未知'}
            、输出 {price.output} {price.currency}
            。此配置只用于后续请求的费用估算，已有记录保留原价格快照。
          </p>
        </Confirm>
      )}
    </div>
  );
}
