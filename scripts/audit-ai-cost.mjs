// Read-only audit of a user-provided archived run. Never imports it into a live browser database.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] ?? 'LastSevenDays_Archive');
const output = resolve(process.argv[3] ?? 'docs/ROUND-SIX-COST-AUDIT.json');
const logs = resolve(process.argv[4] ?? 'experiments/logs/proxy-usage.jsonl');
const get = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const stats = get('data/statistics.json'),
  jobs = get('data/content-jobs.json'),
  app = get('data/usage.json');
const rows = readFileSync(logs, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const ok = rows.filter((r) => !r.error),
  counts = {};
for (const j of jobs) counts[j.kind] = (counts[j.kind] ?? 0) + 1;
const input = ok.reduce((n, r) => n + (r.input ?? 0), 0),
  tokensOut = ok.reduce((n, r) => n + (r.output ?? 0), 0);
const report = {
  auditedAt: new Date().toISOString(),
  source:
    'User-provided local LastSevenDays_Archive and proxy-usage.jsonl. Only numeric aggregates exported.',
  model: [...new Set(ok.map((r) => r.model))],
  virtualDays: 7,
  characters: stats.counts.characters,
  groups: stats.counts.groups,
  messages: stats.counts.messages,
  scenes: stats.counts.scenes,
  majorEvents: stats.counts.majorEvents,
  original: {
    successRequests: ok.length,
    failedTransportRecords: rows.length - ok.length,
    reportedInputTokens: input,
    reportedOutputTokens: tokensOut,
    recordedInputShare: input / (input + tokensOut),
    cacheHitTokens: null,
    cacheMissTokens: null,
    reasoningTokens: null,
    actualCny: null,
    reportedUserCnyApprox: 15,
    completedContentJobs: counts,
  },
  applicationAggregate: app,
  findings: [
    'Read-only inspection of the original transport found thinking:{type:"disabled"}. High thinking is not established as the cause of this run.',
    'Transport logs do not retain task IDs, cache categories or reasoning details. The proxy used the Anthropic endpoint and flattened usage. Recorded input totals must not be retrospectively labeled as cache-miss totals.',
    'Raw usage and application aggregate totals differ. Do not fabricate per-task currency allocations or overwrite old usage with a synthetic ledger.',
    'Daily scheduling, phone/reply decisions are local. Memory consolidation is manual and idempotent; evolution is event-gated and at most once per seven virtual days; automatic reports can be local.',
    '2532 successful calls versus 2348 final content jobs does not establish 184 retries: stage work, repair and maintenance calls cannot be uniquely separated without request IDs.',
  ],
  comparisons: [
    {
      case: 'A original',
      requests: ok.length,
      inputTokens: input,
      outputTokens: tokensOut,
      cacheHitTokens: null,
      thinkingTokens: null,
      cny: null,
      quality: 'archived real run; no new generation',
    },
    {
      case: 'B reasoning policy',
      requests: null,
      inputTokens: null,
      outputTokens: null,
      cny: null,
      reason:
        'Original run already disabled thinking. Do not claim savings from disabling it again.',
    },
    {
      case: 'C stable prefix',
      requests: null,
      cacheHitTokens: null,
      cny: null,
      reason:
        'Wire format has deterministic common prefixes; a paid provider comparison is still required to establish actual cache hits.',
    },
    {
      case: 'D local facts',
      avoidableLifeDescriptionJobs: counts.life ?? 0,
      remainingRequestsIfExactlyOneCallPerLifeJob: ok.length - (counts.life ?? 0),
      cny: null,
      reason:
        'Counterfactual request opportunity only; per-task billed tokens were not saved. Content remains the already determined event fact.',
    },
    {
      case: 'E compact protocol and existing batching',
      requests: null,
      cny: null,
      reason:
        'Lossless codec and partial recovery tested; archived response bodies and original tokenized wire requests are insufficient to recover actual token savings.',
    },
    {
      case: 'F all equal-content optimization',
      requests: null,
      cny: null,
      reason:
        'No unsupported 30%/50% savings claim. New ledger and optional transparent proxy permit an actual future controlled run.',
    },
  ],
  pricingReference: {
    checkedOn: '2026-10-28',
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    unit: 'CNY per million tokens',
    flashPeak: { hit: 0.04, miss: 2, output: 8 },
    flashOffPeak: { hit: 0.02, miss: 1, output: 4 },
    notAnInvoice: true,
  },
  economics: {
    outputOnlyReferenceIfRecordedOutputIsFullyBilled: {
      peak: (tokensOut * 8) / 1e6,
      offPeak: (tokensOut * 4) / 1e6,
    },
    note: 'These are rate scenarios using current documented prices, not measured charges or historical rates. Cache counters, applied discounts and complete billing scope are unavailable.',
  },
};
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    output,
    requests: ok.length,
    input,
    outputTokens: tokensOut,
    characters: report.characters,
    messages: report.messages,
  }),
);
