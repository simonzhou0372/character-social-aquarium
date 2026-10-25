import Dexie from 'dexie';
import type { AquariumDB } from '../data/db';
import { budgetedCompletion } from './orchestrator';
import { estimateTokens, type PromptConfig, type TaskKind } from './prompts';
import { parseStructuredJSON, completedField } from './structured';
import { ProviderError, type Provider, type ChatInput } from './provider';
import { adaptiveLimits, type BatchHealth } from '../core/adaptive-batching';
import { uid } from '../core/types';
export type BatchUnit = {
  id: string;
  privacy: string;
  request: ChatInput;
  outputTokens: number;
  at: number;
  createdAt: number;
  scale?: number;
};
export async function requestUnits(
  d: AquariumDB,
  worldId: string,
  kind: TaskKind,
  snapshot: PromptConfig,
  units: BatchUnit[],
  provider: Provider,
  signal?: AbortSignal,
) {
  const cp = await d.checkpoints.get(worldId),
    settings = await d.settings.get('app'),
    profile = await d.profiles.get('api');
  const previous = await d.taskLogs
    .where('[worldId+task+at]')
    .between([worldId, 'adaptive-metric', Dexie.minKey], [worldId, 'adaptive-metric', Dexie.maxKey])
    .reverse()
    .first();
  let health: BatchHealth = { scale: 1, latencyMs: 0, successes: 0, failures: 0 };
  try {
    if (previous?.detail) health = JSON.parse(previous.detail).health;
  } catch {}
  health.scale = Math.min(health.scale, ...units.map((u) => u.scale ?? 1));
  const limits = adaptiveLimits(
    cp?.speed ?? 1,
    settings?.adaptiveBatching !== false,
    profile?.outputBudgetTokens ?? 2048,
    health,
  );
  const first = units[0];
  const selected: BatchUnit[] = [];
  let output = 150;
  const batchId = uid('batch');
  function envelope(list: BatchUnit[]): ChatInput {
    const locals = list.map((u) => JSON.parse(u.request[1].content));
    const sharedContext: Record<string, any> = {};
    for (const key of Object.keys(locals[0])) {
      if (key === 'input') continue;
      if (locals.every((c) => JSON.stringify(c[key]) === JSON.stringify(locals[0][key]))) {
        sharedContext[key] = locals[0][key];
        locals.forEach((c) => delete c[key]);
      }
    }
    const input = locals[0].input;
    if (input && typeof input === 'object')
      for (const key of Object.keys(input)) {
        if (locals.every((c) => JSON.stringify(c.input?.[key]) === JSON.stringify(input[key]))) {
          (sharedContext.input ??= {})[key] = input[key];
          locals.forEach((c) => delete c.input[key]);
        }
      }
    return [
      {
        role: 'system',
        content:
          first.request[0].content.split('【不可覆盖的输出契约】')[0] +
          '\n【批量输出契约】本次每个任务的原输出契约放在局部 contract 中。只返回 JSON {"batchId":"' +
          batchId +
          '","results":[{"taskId":"原任务ID","result":原任务输出对象}]}。sharedContext 为本组合法共享事实，任务 context 为局部补充，其 input 与 sharedContext.input 合并使用。任务事实不可跨任务改写，按任务ID分别返回，不合并消息、不省略条目。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          batchId,
          sharedContext,
          tasks: list.map((u, i) => {
            const local = locals[i];
            return {
              taskId: u.id,
              contract: u.request[0].content.split('【不可覆盖的输出契约】')[1],
              context: local,
            };
          }),
        }),
      },
    ];
  }
  for (const u of units) {
    if (u.privacy !== first.privacy || selected.length >= limits.maxTasks) continue;
    if (selected.length && output + u.outputTokens > limits.outputTokens) break;
    const candidate = [...selected, u];
    if (
      candidate.length > 1 &&
      envelope(candidate).reduce((n, m) => n + estimateTokens(m.content), 0) >
        (profile?.contextBudgetTokens ?? 32000)
    )
      break;
    selected.push(u);
    output += u.outputTokens;
  }
  const batched = selected.length > 1,
    request = batched ? envelope(selected) : first.request;
  const queueLength = (
    await Promise.all(
      ['pending', 'running', 'failed'].map((status) =>
        d.contentJobs
          .where('[worldId+status+at]')
          .between([worldId, status, Dexie.minKey], [worldId, status, Dexie.maxKey])
          .count(),
      ),
    )
  ).reduce((a, b) => a + b, 0);
  const started = Date.now();
  let values = new Map<string, unknown>(),
    error: unknown;
  try {
    const r = await budgetedCompletion(d, provider, request, worldId, kind, snapshot, signal, {
      outputBudget: batched
        ? Math.min(profile?.outputBudgetTokens ?? 2048, Math.max(256, output))
        : (profile?.outputBudgetTokens ?? 2048),
      priority: -1,
    });
    if (batched) {
      let parsed: any;
      try {
        parsed = parseStructuredJSON(r.content);
      } catch {
        parsed = {
          batchId: completedField(r.content, 'batchId'),
          results: completedField(r.content, 'results'),
        };
      }
      if (parsed?.batchId !== batchId || !Array.isArray(parsed.results))
        throw new ProviderError('batch-schema', '批次编号或结果数组无效');
      const duplicates = new Set<string>();
      for (const row of parsed.results) {
        if (!row || !selected.some((u) => u.id === row.taskId)) continue;
        if (values.has(row.taskId)) duplicates.add(row.taskId);
        else values.set(row.taskId, row.result);
      }
      duplicates.forEach((id) => values.delete(id));
    } else {
      if (r.finishReason === 'length')
        throw new ProviderError('truncated', '当前子任务输出被截断，保留待恢复');
      values.set(first.id, parseStructuredJSON(r.content));
    }
  } catch (e) {
    error = e;
  }
  const good = values.size,
    success = good === selected.length && !error;
  health = {
    scale: success ? Math.min(1, health.scale + 0.1) : Math.max(0.25, health.scale / 2),
    latencyMs: health.latencyMs
      ? health.latencyMs * 0.7 + (Date.now() - started) * 0.3
      : Date.now() - started,
    successes: health.successes + Number(success),
    failures: health.failures + Number(!success),
  };
  await d.taskLogs.put({
    id: uid('batch-metric'),
    worldId,
    task: 'adaptive-metric',
    promptVersion: snapshot.version,
    at: Date.now(),
    status: success ? 'completed' : 'partial',
    detail: JSON.stringify({
      health,
      queueLength,
      tasks: selected.length,
      returned: good,
      latencyMs: Date.now() - started,
      waitMs: Math.max(0, started - Math.min(...selected.map((u) => u.createdAt))),
      oldestAt: Math.min(...selected.map((u) => u.at)),
      batched,
    }),
  });
  return { selected, values, error, scale: health.scale };
}
