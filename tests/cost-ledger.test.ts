import { compactChatRequest, expandCompactChat } from '../src/ai/compact-protocol';
import { it, expect, vi, afterEach } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { CompatibleProvider, MockProvider, ProviderError } from '../src/ai/provider';
import { budgetedCompletion } from '../src/ai/orchestrator';
import { defaultPrompts, composePrompt } from '../src/ai/prompts';
import { modelPolicy, cachedMessages } from '../src/ai/model-policy';
import { requestCost } from '../src/ai/usage-ledger';
import type { ApiProfile } from '../src/core/types';
import { exportBackup, validateBackup, importBackup } from '../src/data/backup';
const profile: ApiProfile = {
  id: 'api',
  provider: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  persistKey: false,
  status: 'connected',
};
const price = {
  model: 'deepseek-flash',
  currency: 'CNY' as const,
  input: 2,
  cachedInput: 0.04,
  output: 8,
  period: 'conservativePeak' as const,
  confirmedAt: Date.now(),
  source: 'user-confirmed test',
};
afterEach(() => vi.restoreAllMocks());
it('selects routine nonthinking, low-complexity thinking and story quality without changing the model', () => {
  expect(modelPolicy(profile, 'chat')).toMatchObject({ model: 'deepseek-flash', thinking: 'off' });
  expect(modelPolicy(profile, 'evolution')).toMatchObject({ thinking: 'on', effort: 'low' });
  expect(modelPolicy(profile, 'novel')).toMatchObject({ thinking: 'on', effort: 'high' });
  expect(
    modelPolicy({ ...profile, baseUrl: 'https://other.invalid', thinkingMode: 'off' }, 'chat'),
  ).toMatchObject({ thinking: 'unknown', deepSeek: false });
  expect(
    modelPolicy({ ...profile, reasoningPolicy: 'user', thinkingMode: 'on' }, 'chat'),
  ).toMatchObject({ thinking: 'on', effort: 'high' });
  expect(modelPolicy({ ...profile, model: 'unknown-new-model' }, 'chat').deepSeek).toBe(false);
});
it('passes only known provider parameters and reads zero, cached and reasoning usage without storing thoughts', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: '{}', reasoning_content: 'private hidden text' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      }),
      { status: 200 },
    ),
  );
  const result = await new CompatibleProvider(profile, 'test-placeholder').complete(
    [{ role: 'user', content: 'JSON' }],
    undefined,
    { task: 'chat' },
  );
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    thinking: { type: 'disabled' },
  });
  expect(result.accounting).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 12,
    cacheHitTokens: 80,
    cacheMissTokens: 20,
  });
  expect(JSON.stringify(result)).not.toContain('private hidden text');
  fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    ),
  );
  expect(
    await new CompatibleProvider(
      { ...profile, baseUrl: 'https://other.invalid', thinkingMode: 'off' },
      'test-placeholder',
    ).complete([{ role: 'user', content: 'x' }]),
  ).toMatchObject({ inputTokens: 0, outputTokens: 0, estimated: false });
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).not.toHaveProperty('thinking');
});
it('prices cache categories and includes reasoning only once, keeping unknown cache explicitly incomplete', () => {
  expect(
    requestCost(
      {
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 12,
        cacheHitTokens: 80,
        cacheMissTokens: 20,
      },
      price,
    ).costCny,
  ).toBeCloseTo(0.0002032);
  expect(requestCost({ inputTokens: 100, outputTokens: 20 }, price)).toMatchObject({
    costCny: 0.00036,
    costQuality: 'incomplete',
  });
  expect(requestCost({ inputTokens: 100 }, price)).toEqual({});
  expect(
    requestCost({ inputTokens: 100, outputTokens: 20 }, { ...price, currency: 'USD' }).costCny,
  ).toBeUndefined();
});
it('stabilizes shared prefixes without changing history order or duplicating world facts', () => {
  const first = composePrompt(
    'chat',
    defaultPrompts(),
    {
      world: { id: 'w', rules: '固定世界规则', name: '世界' },
      character: { name: '甲', id: 'a' },
      history: [
        { id: 'z', text: '先说' },
        { id: 'a', text: '后说' },
      ],
      state: { at: 1 },
    },
    '返回 JSON 一条消息',
  );
  const second = structuredClone(first);
  const ctx = JSON.parse(second[1].content);
  ctx.state.at = 2;
  second[1].content = JSON.stringify(ctx);
  const a = cachedMessages(first),
    b = cachedMessages(second);
  expect(a[0]).toEqual(b[0]);
  expect(a[1].content.split('context')[0]).toEqual(b[1].content.split('context')[0]);
  expect(a[1].content.match(/固定世界规则/g)).toHaveLength(1);
  expect(JSON.parse(a[1].content).context.history.map((m: any) => m.text)).toEqual([
    '先说',
    '后说',
  ]);
});
it('records successful, retry and failed requests and restores the ledger through backups', async () => {
  const d = new AquariumDB('ledger-' + crypto.randomUUID());
  await seed(d);
  try {
    await d.profiles.put(profile);
    await d.settings.update('app', { unlimitedUsage: true, costControls: { prices: [price] } });
    const provider = new MockProvider({ description: '活动' });
    const r = await budgetedCompletion(
      d,
      provider,
      [{ role: 'user', content: 'JSON' }],
      'w-harbor',
      'life',
      defaultPrompts(),
    );
    await budgetedCompletion(
      d,
      provider,
      [{ role: 'user', content: 'JSON' }],
      'w-harbor',
      'life',
      defaultPrompts(),
      undefined,
      { retryOf: r.requestId, attempt: 1 },
    );
    await expect(
      budgetedCompletion(
        d,
        new MockProvider({}, 'network'),
        [{ role: 'user', content: 'x' }],
        'w-harbor',
        'chat',
        defaultPrompts(),
      ),
    ).rejects.toThrow();
    const rows = await d.usageLedger.toArray();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'failed')[0].inputTokens).toBeUndefined();
    expect(
      rows.some((r) => r.retryOf === rows.find((x) => x.id === r.retryOf)?.id && r.attempt === 1),
    ).toBe(true);
    const backup = validateBackup(await exportBackup(d));
    await importBackup(backup, d);
    expect(await d.usageLedger.count()).toBe(3);
    expect(JSON.stringify(rows)).not.toContain('test-placeholder');
  } finally {
    await d.delete();
  }
});
it('reserves monetary budgets atomically and recovers when the user removes the limit', async () => {
  const d = new AquariumDB('ledger-budget-' + crypto.randomUUID());
  await seed(d);
  try {
    await d.profiles.put(profile);
    await d.settings.update('app', {
      unlimitedUsage: true,
      costControls: {
        prices: [price],
        budget: { period: 'virtualDay', cny: 0.00001, warnRatio: 0.8 },
      },
    });
    const p = new MockProvider();
    await expect(
      budgetedCompletion(
        d,
        p,
        [{ role: 'user', content: 'hello' }],
        'w-harbor',
        'chat',
        defaultPrompts(),
      ),
    ).rejects.toThrow('预算');
    expect(p.calls).toHaveLength(0);
    await d.settings.update('app', {
      costControls: {
        prices: [price],
        budget: { period: 'unlimited', cny: 0.00001, warnRatio: 0.8 },
      },
    });
    await budgetedCompletion(
      d,
      p,
      [{ role: 'user', content: 'hello' }],
      'w-harbor',
      'chat',
      defaultPrompts(),
    );
    expect(p.calls).toHaveLength(1);
  } finally {
    await d.delete();
  }
});

it('compact protocol retains every message and optional social action', () => {
  const original = {
    speakerId: 'actor',
    messages: ['@乙 一起去吗？', '行，我在门口。'],
    offsets: [0, 4],
    replyToMessageId: 'prior',
    mentionTargets: [{ messageIndex: 0, characterId: 'b' }],
    reactions: [{ messageId: 'prior', emoji: '😂' }],
    gifAssetId: 'authorized-gif',
  };
  const compact = {
    m: original.messages,
    o: original.offsets,
    r: original.replyToMessageId,
    a: [{ i: 0, c: 'b' }],
    e: [{ id: 'prior', v: '😂' }],
    g: 'authorized-gif',
  };
  expect(JSON.parse(expandCompactChat(JSON.stringify(compact), 'actor'))).toEqual(original);
  const request = composePrompt(
    'chat',
    defaultPrompts(),
    {},
    '返回JSON {"speakerId":"actor","messages":[]}',
  );
  expect(compactChatRequest(request, 'chat')?.speaker).toBe('actor');
  expect(compactChatRequest(request, 'novel')).toBeUndefined();
});
it('falls back once through separate ledger entries when a declared provider rejects thinking controls', async () => {
  const d = new AquariumDB('capability-' + crypto.randomUUID());
  await seed(d);
  const custom = { ...profile, baseUrl: 'https://fallback.invalid', deepSeekCompatible: true };
  try {
    await d.profiles.put(custom);
    await d.settings.update('app', { unlimitedUsage: true });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'thinking unsupported' }), { status: 400 }),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{}' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
        ),
      );
    const p = new CompatibleProvider(custom, 'test-only-key');
    const result = await budgetedCompletion(
      d,
      p,
      [{ role: 'user', content: 'JSON' }],
      'w-harbor',
      'chat',
      defaultPrompts(),
    );
    expect(result.content).toBe('{}');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toHaveProperty('thinking');
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).not.toHaveProperty('thinking');
    const rows = await d.usageLedger.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.status === 'success')?.retryOf).toBe(
      rows.find((r) => r.status === 'failed')?.id,
    );
    expect((await d.profiles.get('api'))?.unsupportedThinkingModels).toContain('deepseek-flash');
  } finally {
    await d.delete();
  }
});
it('concurrent requests cannot both spend the same monetary reservation', async () => {
  const d = new AquariumDB('reserve-' + crypto.randomUUID());
  await seed(d);
  try {
    await d.profiles.put(profile);
    await d.settings.update('app', {
      unlimitedUsage: true,
      costControls: {
        prices: [price],
        budget: { period: 'virtualDay', cny: 0.003, warnRatio: 0.8 },
      },
    });
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => (started = r));
    const provider = {
      complete: async () => {
        started();
        await new Promise<void>((r) => (release = r));
        return { content: '{}', inputTokens: 10, outputTokens: 10, estimated: false };
      },
    };
    const first = budgetedCompletion(
      d,
      provider,
      [{ role: 'user', content: 'x' }],
      'w-harbor',
      'chat',
      defaultPrompts(),
      undefined,
      { outputBudget: 256 },
    );
    await waiting;
    await expect(
      budgetedCompletion(
        d,
        provider,
        [{ role: 'user', content: 'x' }],
        'w-harbor',
        'chat',
        defaultPrompts(),
        undefined,
        { outputBudget: 256 },
      ),
    ).rejects.toThrow('预算不足');
    release();
    await first;
    expect(await d.usageLedger.count()).toBe(1);
  } finally {
    await d.delete();
  }
});
it('keeps reported usage for a paid response with missing text, instead of losing the charge', async () => {
  const d = new AquariumDB('paid-malformed-' + crypto.randomUUID());
  await seed(d);
  try {
    await d.profiles.put(profile);
    await d.settings.update('app', { unlimitedUsage: true, costControls: { prices: [price] } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: {} }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
          },
        }),
      ),
    );
    await expect(
      budgetedCompletion(
        d,
        new CompatibleProvider(profile, 'test-placeholder'),
        [{ role: 'user', content: 'JSON' }],
        'w-harbor',
        'life',
        defaultPrompts(),
      ),
    ).rejects.toThrow('未返回文本');
    const row = (await d.usageLedger.toArray())[0];
    expect(row).toMatchObject({
      status: 'failed',
      inputTokens: 100,
      outputTokens: 20,
      cacheHitTokens: 80,
    });
    expect(row.sentAt).toBeTypeOf('number');
    expect(row.costCny).toBeCloseTo(0.0002032);
    expect(row.reservedCny).toBeUndefined();
  } finally {
    await d.delete();
  }
});
it('retains the reservation when a successful provider does not report usage', async () => {
  const d = new AquariumDB('unknown-paid-' + crypto.randomUUID());
  await seed(d);
  try {
    await d.profiles.put(profile);
    await d.settings.update('app', {
      unlimitedUsage: true,
      costControls: {
        prices: [price],
        budget: { period: 'virtualDay', cny: 0.003, warnRatio: 0.8 },
      },
    });
    let calls = 0;
    const p = {
      complete: async () => {
        calls++;
        return { content: '{}', inputTokens: 10, outputTokens: 10, estimated: true };
      },
    };
    const call = () =>
      budgetedCompletion(
        d,
        p,
        [{ role: 'user', content: 'JSON' }],
        'w-harbor',
        'life',
        defaultPrompts(),
        undefined,
        { outputBudget: 256 },
      );
    await call();
    const row = (await d.usageLedger.toArray())[0];
    expect(row.status).toBe('success');
    expect(row.inputTokens).toBeUndefined();
    expect(row.costCny).toBeUndefined();
    expect(row.reservedCny).toBeGreaterThan(0.002);
    await expect(call()).rejects.toThrow('预算不足');
    expect(calls).toBe(1);
  } finally {
    await d.delete();
  }
});
it('preserves invalid compact fields for strict downstream validation without losing accounting', () => {
  expect(
    JSON.parse(expandCompactChat('{"m":["你好"],"speakerId":"intruder"}', 'actor')),
  ).toMatchObject({ speakerId: 'actor', _invalidCompactFields: ['speakerId'] });
  expect(JSON.parse(expandCompactChat('{"m":[],"a":[null]}', 'actor')).mentionTargets).toEqual([
    null,
  ]);
});
it('upgrades a real v14 database without rewriting old messages, budgets, protected roles or clocks', async () => {
  const { default: Dexie } = await import('dexie');
  const name = 'v14-upgrade-' + crypto.randomUUID();
  const layout = new AquariumDB(name);
  const added = new Set(['usageLedger', 'narrativeChanges', 'organizationStates']);
  const stores = Object.fromEntries(
    layout.tables
      .filter((t) => !added.has(t.name))
      .map((t) => [
        t.name,
        [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(','),
      ]),
  );
  const source = new AquariumDB(name + '-source');
  const old = new Dexie(name);
  const next = new AquariumDB(name);
  try {
    await seed(source, 1792886400000);
    old.version(14).stores(stores);
    await old.open();
    for (const table of source.tables.filter((t) => !added.has(t.name)))
      await old.table(table.name).bulkPut(await table.toArray());
    const messages = await old.table('messages').toArray();
    const clock = await old.table('checkpoints').get('w-harbor');
    const settings = await old.table('settings').get('app');
    old.close();
    await next.open();
    expect(next.verno).toBe(15);
    expect(await next.messages.toArray()).toEqual(messages);
    expect(await next.checkpoints.get('w-harbor')).toEqual(clock);
    expect(await next.settings.get('app')).toEqual(settings);
    expect(await next.usageLedger.count()).toBe(0);
    expect(await next.narrativeChanges.count()).toBe(0);
    expect(
      (await next.memberships.toArray()).every(
        (m) => m.life === undefined && m.allowAutomaticDeath !== true,
      ),
    ).toBe(true);
  } finally {
    old.close();
    await next.delete();
    await source.delete();
    layout.close();
  }
});
