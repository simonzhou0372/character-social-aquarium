import { expect, it } from 'vitest';
import { canonical, cachedMessages } from '../src/ai/model-policy';
import { composePrompt, defaultPrompts, type TaskKind } from '../src/ai/prompts';
import { dialogueContract } from '../src/ai/provider';
import { compactChatRequest } from '../src/ai/compact-protocol';
import { cacheStatistics, compareCacheRuns } from '../src/ai/cache-statistics';

const prompts = defaultPrompts();
const make = (day: number, id = 'a', task: TaskKind = 'chat') =>
  composePrompt(
    task,
    prompts,
    {
      world: { rules: '不能读心', name: '世界', id: 'w', updatedAt: day },
      character: { id, style: '简洁', updatedAt: day },
      relationships: [{ id: 'r', from: id, to: 'b', boundaries: '不得透露私信' }],
      history: [{ text: '仅此角色可知', at: day }],
      input: { simTime: day, speakerId: id },
    },
    dialogueContract(id, prompts),
  );

it('keeps rules and protocol before dynamic state; changing character does not change system prefix', () => {
  const a = cachedMessages(make(1)),
    b = cachedMessages(make(2)),
    c = cachedMessages(make(2, 'c'));
  expect(a[0]).toEqual(b[0]);
  expect(a[0]).toEqual(c[0]);
  expect(a[0].content).toContain('【消息生成规则】');
  expect(a[1].content.split('context')[0]).toBe(b[1].content.split('context')[0]);
  expect(JSON.parse(a[1].content).context.character.updatedAt).toBe(1);
  expect(JSON.parse(a[1].content).context.relationships[0].boundaries).toBe('不得透露私信');
  expect(JSON.parse(a[1].content).context.history).toEqual([{ at: 1, text: '仅此角色可知' }]);
  const changed = structuredClone(prompts);
  changed.version++;
  changed.entries.find((e) => e.key === 'report')!.content += '报表编辑';
  const context = JSON.parse(make(1)[1].content);
  expect(
    cachedMessages(composePrompt('chat', changed, context, dialogueContract('a', changed))),
  ).toEqual(a);
});
it('compact protocol binds a legacy speaker explicitly without putting its ID in the protocol', () => {
  const a = compactChatRequest(make(1, 'a'), 'chat')!;
  const b = compactChatRequest(make(2, 'b'), 'chat')!;
  expect(a.messages[0]).toEqual(b.messages[0]);
  expect(JSON.parse(a.messages[1].content).input.speakerId).toBe('a');
});
it('canonicalizes unordered entities deterministically but preserves chronological arrays', () => {
  expect(canonical({ relationships: [{ id: 'b' }, { id: 'a' }] })).toEqual({
    relationships: [{ id: 'a' }, { id: 'b' }],
  });
  expect(canonical({ history: [{ id: 'b' }, { id: 'a' }] })).toEqual({
    history: [{ id: 'b' }, { id: 'a' }],
  });
});
it('checks 100 actors across seven days and every task without estimating cache hits', () => {
  const tasks: TaskKind[] = [
    'chat',
    'life',
    'recovery',
    'recoveryChat',
    'inPerson',
    'offlineScene',
    'major',
    'novel',
    'memory',
    'report',
    'evolution',
    'profile',
    'worldDraft',
    'groupDraft',
    'expansion',
    'connection',
  ];
  for (const task of tasks) {
    for (let actor = 0; actor < 100; actor++) {
      const first = cachedMessages(make(0, String(actor), task));
      for (let day = 1; day < 7; day++) {
        const next = cachedMessages(make(day, String(actor), task));
        expect(next[0]).toEqual(first[0]);
        expect(next[1].content.split('context')[0]).toBe(first[1].content.split('context')[0]);
      }
    }
  }
});
it('uses weighted real counters, rejects missing/inconsistent/estimated usage, prices per row', () => {
  const pricing = {
    model: 'fixture',
    currency: 'CNY' as const,
    input: 2,
    cachedInput: 0.2,
    output: 8,
    period: 'peak' as const,
    confirmedAt: 0,
    source: 'test',
  };
  const rows = [
    {
      worldId: 'w',
      task: 'chat',
      inputTokens: 100,
      cacheHitTokens: 90,
      cacheMissTokens: 10,
      outputTokens: 10,
      pricing,
    },
    {
      worldId: 'x',
      task: 'life',
      inputTokens: 900,
      cacheHitTokens: 0,
      cacheMissTokens: 900,
      outputTokens: 10,
      pricing,
    },
  ];
  const report = cacheStatistics(rows);
  expect(report.global.overallHitRate).toBe(0.09);
  expect(report.worlds.w.overallHitRate).toBe(0.9);
  expect(report.tasks.life.overallHitRate).toBe(0);
  expect(report.global.inputCostCny).toBeCloseTo(1838 / 1e6);
  for (const invalid of [
    { inputTokens: 10 },
    { inputTokens: 10, cacheHitTokens: 9, cacheMissTokens: 2 },
    { ...rows[0], estimated: true },
  ]) {
    const partial = cacheStatistics([...rows, invalid]);
    expect(partial.global.overallHitRate).toBeNull();
    expect(partial.global.measuredHitRate).toBe(0.09);
    expect(partial.global.totalCostCny).toBeNull();
  }
  expect(compareCacheRuns([], rows).inputCostReduction).toBeNull();
  expect(compareCacheRuns(rows, rows).totalCostReduction).toBe(0);
});
it('retains exact planned message quotas and offsets in the compact path', () => {
  const request = make(1);
  request[0].content +=
    ' 必须正好生成 2 条新消息，不能用表情回应替代，不重复 alreadyGenerated；偏移须不早于 12 秒。';
  const packed = compactChatRequest(request, 'chat')!;
  expect(JSON.parse(packed.messages[1].content).input.plannedConstraints).toContain(
    '正好生成 2 条',
  );
  expect(JSON.parse(packed.messages[1].content).input.plannedConstraints).toContain('12 秒');
});
it('keeps volatile scene contracts after world and actor facts without rewriting placeholder speakers', () => {
  const a = make(1, 'a', 'inPerson'),
    b = make(2, 'a', 'inPerson');
  a[0].content += '当前阶段一';
  b[0].content += '当前阶段二';
  const x = cachedMessages(a),
    y = cachedMessages(b);
  expect(x[0]).toEqual(y[0]);
  expect(x[1].content.split('contract')[0]).toBe(y[1].content.split('contract')[0]);
});
it('batch IDs stay outside system prefixes and privacy groups never merge', async () => {
  const { AquariumDB } = await import('../src/data/db');
  const { seed } = await import('../src/data/seed');
  const { requestUnits } = await import('../src/ai/batch-request');
  const d = new AquariumDB('cache-batch-' + crypto.randomUUID());
  await seed(d);
  await d.settings.update('app', { unlimitedUsage: true, adaptiveBatching: true });
  await d.checkpoints.update('w-harbor', { speed: 1000 });
  const wires: ReturnType<typeof cachedMessages>[] = [];
  const provider = {
    async complete(messages: ReturnType<typeof make>) {
      wires.push(cachedMessages(messages));
      const context = JSON.parse(messages[1].content);
      return {
        content: JSON.stringify({
          batchId: context.batchId,
          results: context.tasks.map((t: any) => ({ taskId: t.taskId, result: {} })),
        }),
        inputTokens: 0,
        outputTokens: 0,
        estimated: true,
      };
    },
  };
  const units = (day: number) =>
    ['one', 'two', 'private'].map((id, i) => ({
      id,
      privacy: i === 2 ? 'secret' : 'public',
      request: make(day),
      outputTokens: 10,
      at: day,
      createdAt: 0,
    }));
  try {
    for (const day of [1, 2]) {
      const result = await requestUnits(d, 'w-harbor', 'chat', prompts, units(day), provider);
      expect(result.selected.map((u) => u.id)).toEqual(['one', 'two']);
      expect(result.values.size).toBe(2);
    }
    expect(wires[0][0]).toEqual(wires[1][0]);
    expect(wires[0][0].content).not.toContain('batch_');
    expect(JSON.parse(wires[0][1].content).stableWorld.rules).toBe('不能读心');
    expect(wires[0][1].content.split('context')[0]).toBe(wires[1][1].content.split('context')[0]);
  } finally {
    d.close();
    await d.delete();
  }
});
it('keeps full profiles and relationship facts identical across packing tiers and retains commitments', async () => {
  const { compressContext } = await import('../src/ai/context');
  const context = {
    character: { personality: '人物设定。'.repeat(400), style: '表达习惯。'.repeat(200) },
    relationships: [{ id: 'r', history: '共同经历。'.repeat(400) }],
    memories: Array.from({ length: 8 }, (_, i) => ({ content: `必须履行约定${i}` })),
  };
  for (const tier of ['balanced', 'tight'] as const) {
    const packed = compressContext(context, tier).context;
    expect(packed.character).toEqual(context.character);
    expect(packed.relationships).toEqual(context.relationships);
    expect(packed.memories).toEqual(context.memories);
  }
});
it('optimizes the common first two messages of repairs and preserves all follow-up instructions', () => {
  const original = make(1);
  const repair = { role: 'user' as const, content: '仅修复结构，不添加事实' };
  const wire = cachedMessages([...original, repair]);
  expect(wire.slice(0, 2)).toEqual(cachedMessages(original));
  expect(wire[2]).toEqual(repair);
});
