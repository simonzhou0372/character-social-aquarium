import { it, expect } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { requestUnits, type BatchUnit } from '../src/ai/batch-request';
import { defaultPrompts, composePrompt, estimateTokens } from '../src/ai/prompts';
import type { Provider } from '../src/ai/provider';
it('1x and 1440x amortize eight equal local outputs without increasing estimated token cost', async () => {
  const results: object[] = [];
  for (const speed of [1, 1440]) {
    const totals: { requests: number; tokens: number; outputs: number }[] = [];
    for (const adaptiveBatching of [false, true]) {
      const d = new AquariumDB('microbatch-' + crypto.randomUUID());
      try {
        await seed(d, Date.parse('2026-10-29T00:00:00Z'));
        await d.settings.update('app', { unlimitedUsage: true, adaptiveBatching });
        await d.checkpoints.update('w-harbor', { speed, paused: false });
        await d.profiles.put({
          id: 'api',
          provider: 'mock',
          model: 'mock',
          baseUrl: 'https://mock.invalid',
          persistKey: false,
          status: 'connected',
          outputBudgetTokens: 8192,
          contextBudgetTokens: 32000,
        });
        const config = defaultPrompts();
        let units: BatchUnit[] = Array.from({ length: 8 }, (_, i) => ({
          id: `task-${i}`,
          privacy: 'same-public-facts',
          request: composePrompt(
            'life',
            config,
            {
              world: { name: '测试世界', description: '稳定且一致的公共背景。'.repeat(120) },
              state: { description: `活动${i}` },
            },
            '仅返回 JSON {"description":"一句客观活动描述"}。',
          ),
          outputTokens: 240,
          at: i * 60000,
          createdAt: Date.now() - 10000,
        }));
        const total = { requests: 0, tokens: 0, outputs: 0 };
        const provider: Provider = {
          async complete(input) {
            const p = JSON.parse(input[1].content);
            const value = p.batchId
              ? {
                  batchId: p.batchId,
                  results: p.tasks.map((t: any) => ({
                    taskId: t.taskId,
                    result: {
                      description:
                        t.context.state?.description ?? p.sharedContext.state?.description,
                    },
                  })),
                }
              : { description: p.state.description };
            const content = JSON.stringify(value),
              inputTokens = input.reduce((n, m) => n + estimateTokens(m.content), 0),
              outputTokens = estimateTokens(content);
            total.requests++;
            total.tokens += inputTokens + outputTokens;
            return { content, inputTokens, outputTokens, estimated: true };
          },
        };
        while (units.length) {
          const batch = await requestUnits(d, 'w-harbor', 'life', config, units, provider);
          expect(batch.error).toBeUndefined();
          expect(batch.values.size).toBe(batch.selected.length);
          for (const u of batch.selected)
            expect(batch.values.get(u.id)).toEqual({ description: `活动${u.id.split('-')[1]}` });
          total.outputs += batch.values.size;
          const ids = new Set(batch.selected.map((u) => u.id));
          units = units.filter((u) => !ids.has(u.id));
        }
        totals.push(total);
      } finally {
        await d.delete();
      }
    }
    expect(totals[1].outputs).toBe(8);
    expect(totals[1].requests).toBeLessThan(totals[0].requests);
    expect(totals[1].tokens).toBeLessThanOrEqual(totals[0].tokens);
    results.push({ speed, serial: totals[0], adaptive: totals[1] });
  }
  console.log('OFFLINE MOCK ESTIMATES', JSON.stringify(results));
});
