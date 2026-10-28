import type { UsageLedger } from '../core/usage-types';

/** Only complete, consistent provider counters qualify. Missing is never zero. */
export function measuredCache(row: Partial<UsageLedger>) {
  const values = [row.inputTokens, row.cacheHitTokens, row.cacheMissTokens];
  return (
    !row.estimated &&
    values.every((n) => Number.isSafeInteger(n) && n! >= 0) &&
    row.cacheHitTokens! + row.cacheMissTokens! === row.inputTokens
  );
}
export function cacheSummary(rows: Partial<UsageLedger>[]) {
  const measured = rows.filter(measuredCache);
  const sum = (key: 'inputTokens' | 'cacheHitTokens' | 'cacheMissTokens') =>
    measured.reduce((n, r) => n + r[key]!, 0);
  const inputTokens = sum('inputTokens');
  let inputCostCny = 0,
    totalCostCny = 0,
    pricedRequests = 0,
    inputPricedRequests = 0;
  for (const r of measured) {
    const p = r.pricing;
    if (!p || p.cachedInput === undefined) continue;
    const rate = p.period === 'offPeak' && p.offPeak ? p.offPeak : p;
    const fx = p.currency === 'CNY' ? 1 : p.cnyPerUnit;
    if (fx === undefined) continue;
    const input =
      ((r.cacheHitTokens! * rate.cachedInput! + r.cacheMissTokens! * rate.input) * fx) / 1e6;
    inputCostCny += input;
    inputPricedRequests++;
    if (!Number.isSafeInteger(r.outputTokens) || r.outputTokens! < 0) continue;
    totalCostCny += input + (r.outputTokens! * rate.output * fx) / 1e6;
    pricedRequests++;
  }
  return {
    requests: rows.length,
    measuredRequests: measured.length,
    missingOrInvalidRequests: rows.length - measured.length,
    inputTokens,
    cacheHitTokens: sum('cacheHitTokens'),
    cacheMissTokens: sum('cacheMissTokens'),
    measuredHitRate: inputTokens ? sum('cacheHitTokens') / inputTokens : null,
    // Do not label the measured subset as the overall result.
    overallHitRate:
      measured.length === rows.length && inputTokens ? sum('cacheHitTokens') / inputTokens : null,
    pricedRequests,
    inputPricedRequests,
    inputCostCny: inputPricedRequests === rows.length && rows.length ? inputCostCny : null,
    totalCostCny: pricedRequests === rows.length && rows.length ? totalCostCny : null,
    costBasis: 'provider token counters × per-request configured prices; not an invoice',
  };
}
export function cacheStatistics(rows: Partial<UsageLedger>[]) {
  const group = (key: 'worldId' | 'task') =>
    Object.fromEntries(
      [...new Set(rows.map((r) => r[key] ?? 'unknown'))]
        .sort()
        .map((value) => [value, cacheSummary(rows.filter((r) => (r[key] ?? 'unknown') === value))]),
    );
  return { global: cacheSummary(rows), worlds: group('worldId'), tasks: group('task') };
}
export function compareCacheRuns(before: Partial<UsageLedger>[], after: Partial<UsageLedger>[]) {
  const a = cacheStatistics(before),
    b = cacheStatistics(after);
  const reduction = (old: number | null, next: number | null) =>
    old !== null && old > 0 && next !== null ? 1 - next / old : null;
  return {
    before: a,
    after: b,
    inputCostReduction: reduction(a.global.inputCostCny, b.global.inputCostCny),
    totalCostReduction: reduction(a.global.totalCostCny, b.global.totalCostCny),
    note: 'Only compare identical world/task workloads and pricing. Missing counters or prices yield null, never an estimated hit rate.',
  };
}
