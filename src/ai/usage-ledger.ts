import { dayOrdinal, worldTime } from '../core/calendar';
import { clockTarget } from '../core/time';
import { foregroundStart } from '../core/clock-presence';
import type { AquariumDB } from '../data/db';
import { DAY } from '../core/types';
import type { ModelPricing, UsageLedger } from '../core/usage-types';
export function requestCost(usage: Partial<UsageLedger>, pricing?: ModelPricing) {
  if (!pricing || usage.inputTokens === undefined || usage.outputTokens === undefined) return {};
  const rate = pricing.period === 'offPeak' && pricing.offPeak ? pricing.offPeak : pricing;
  const completeCache =
    usage.cacheHitTokens !== undefined &&
    usage.cacheMissTokens !== undefined &&
    Math.abs(usage.cacheHitTokens + usage.cacheMissTokens - usage.inputTokens) <= 1;
  const hit = completeCache ? usage.cacheHitTokens! : 0,
    miss = completeCache ? usage.cacheMissTokens! : usage.inputTokens;
  // Provider completion_tokens includes reasoning_tokens: never add the latter a second time.
  const cost =
    (hit * (rate.cachedInput ?? rate.input) +
      miss * rate.input +
      usage.outputTokens * rate.output) /
    1e6;
  const cnyPerUnit = pricing.currency === 'CNY' ? 1 : pricing.cnyPerUnit;
  return {
    cost,
    costCny: cnyPerUnit === undefined ? undefined : cost * cnyPerUnit,
    costQuality:
      completeCache || pricing.cachedInput === undefined
        ? ('configured-estimate' as const)
        : ('incomplete' as const),
  };
}
export function costBudgetStart(period: string, virtualAt: number, now: number) {
  return period === 'realDay'
    ? Math.floor(now / DAY) * DAY
    : Math.floor(virtualAt / DAY) * DAY - (period === 'virtualWeek' ? 6 * DAY : 0);
}
export async function reserveCost(d: AquariumDB, row: UsageLedger, input: number, output: number) {
  const control = (await d.settings.get('app'))?.costControls,
    budget = control?.budget;
  if (!budget || budget.period === 'unlimited') return;
  const estimated = requestCost({ inputTokens: input, outputTokens: output }, row.pricing).costCny;
  if (estimated === undefined)
    throw new Error('人民币预算已开启，但缺少当前模型人民币定价或汇率；请先确认定价。');
  if (budget.period !== 'realDay' && row.budgetVirtualDay === undefined)
    throw new Error('虚拟日预算需要有效世界时间，当前任务未关联世界。');
  const start =
    budget.period === 'realDay'
      ? costBudgetStart(budget.period, 0, row.startedAt)
      : row.budgetVirtualDay! - (budget.period === 'virtualWeek' ? 6 : 0);
  const rows =
    budget.period === 'realDay'
      ? await d.usageLedger.where('startedAt').aboveOrEqual(start).toArray()
      : await d.usageLedger
          .where('[worldId+budgetVirtualDay]')
          .between([row.worldId, start], [row.worldId, row.budgetVirtualDay! + 1], true, false)
          .toArray();
  const used = rows.reduce(
    (n, r) =>
      n + (r.status === 'running' ? (r.reservedCny ?? 0) : (r.costCny ?? r.reservedCny ?? 0)),
    0,
  );
  if (used + estimated > budget.cny)
    throw new Error(
      `人民币预算不足：已计入约 ¥${used.toFixed(4)}，本次保守预留 ¥${estimated.toFixed(4)}，上限 ¥${budget.cny}。任务将保留待恢复。`,
    );
  row.reservedCny = estimated;
}
export async function recordOutcome(
  d: AquariumDB,
  requestId: string | undefined,
  taskId: string,
  counts: { events?: number; messages?: number; dialogue?: number },
) {
  if (!requestId) return;
  await d.transaction('rw', d.usageLedger, async () => {
    const row = await d.usageLedger.get(requestId);
    if (!row || row.completedTaskIds.includes(taskId)) return;
    await d.usageLedger.update(requestId, {
      validationStatus:
        row.validationStatus === 'rejected' || row.validationStatus === 'partial'
          ? 'partial'
          : 'accepted',
      completedTaskIds: [...row.completedTaskIds, taskId],
      events: row.events + (counts.events ?? 0),
      messages: row.messages + (counts.messages ?? 0),
      dialogue: row.dialogue + (counts.dialogue ?? 0),
    });
  });
}
/** ID-only metadata, no prompt bodies or credentials are stored. */
export function requestEntities(messages: import('./provider').ChatInput) {
  const ids = new Set<string>(),
    groups = new Set<string>();
  const visit = (v: any, key = '') => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      if (['participants', 'characterIds', 'participantIds', 'owners'].includes(key))
        v.forEach((x) => (typeof x === 'string' ? ids.add(x) : visit(x, 'characters')));
      else v.forEach((x) => visit(x, key));
      return;
    }
    if (typeof v.characterId === 'string') ids.add(v.characterId);
    if (typeof v.groupId === 'string') groups.add(v.groupId);
    if (
      (key === 'character' || key === 'actors' || key === 'characters') &&
      typeof v.id === 'string'
    )
      ids.add(v.id);
    Object.entries(v).forEach(([k, x]) => visit(x, k));
  };
  for (const m of messages)
    if (m.role === 'user')
      try {
        visit(JSON.parse(m.content));
      } catch {}
  return {
    characterIds: [...ids].sort().slice(0, 1000),
    groupIds: [...groups].sort().slice(0, 1000),
  };
}

export function requestVirtualAt(messages: import('./provider').ChatInput): number | undefined {
  for (const m of messages)
    if (m.role === 'user')
      try {
        const c = JSON.parse(m.content),
          i = c.input ?? {};
        for (const value of [
          i.simTime,
          i.phase?.start,
          i.event?.start,
          i.currentEvent?.start,
          c.state?.start,
        ])
          if (typeof value === 'number' && Number.isFinite(value)) return value;
      } catch {}
  return undefined;
}
export async function recordValidation(
  d: AquariumDB,
  id: string | undefined,
  status: 'accepted' | 'rejected' | 'partial',
  code?: string,
) {
  if (!id) return;
  await d.transaction('rw', d.usageLedger, async () => {
    const row = await d.usageLedger.get(id);
    if (!row) return;
    const previous = row.validationStatus;
    const mixed = previous === 'partial' || (previous && previous !== status);
    await d.usageLedger.update(id, {
      validationStatus: mixed ? 'partial' : status,
      validationCode: code ?? row.validationCode,
    });
  });
}

export async function budgetWorldDay(d: AquariumDB, worldId: string, now = Date.now()) {
  const cp = await d.checkpoints.get(worldId),
    world = await d.worlds.get(worldId);
  return cp && world
    ? dayOrdinal(worldTime(world, clockTarget(cp, now, foregroundStart())))
    : undefined;
}
