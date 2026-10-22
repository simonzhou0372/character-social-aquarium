import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AquariumDB } from '../src/data/db';
import {
  defaultPrompts,
  composePrompt,
  getPrompts,
  savePrompt,
  replacePrompts,
  migrateDefaults,
  defaultRules,
  saveRules,
} from '../src/ai/prompts';
import {
  parseDialogue,
  generateDialogue,
  generateProfile,
  consolidateMemory,
  describeEvent,
} from '../src/ai/orchestrator';
import { MockProvider } from '../src/ai/provider';
import { seed } from '../src/data/seed';
let d: AquariumDB;
beforeEach(async () => {
  d = new AquariumDB('test-' + crypto.randomUUID());
  await seed(d, Date.parse('2026-10-22T10:00:00Z'));
});
afterEach(async () => {
  await d.delete();
});
describe('global prompts', () => {
  it('persists edits and uses them immediately in a subsequent dialogue request', async () => {
    await savePrompt(d, 'behavior', '只能用日语回答。', true);
    const c = (await d.conversations.get('conv-nm'))!,
      p = new MockProvider({ speakerId: 'c-nagi', messages: ['こんばんは。'] });
    await generateDialogue(d, c, 'c-nagi', Date.now(), await getPrompts(d), p);
    expect(p.calls[0][0].content).toContain('只能用日语回答');
    d.close();
    await d.open();
    expect((await getPrompts(d)).entries[0].content).toBe('只能用日语回答。');
  });
  it.each([
    ['chat', ['behavior', 'social']],
    ['life', ['life']],
    ['recovery', ['recovery', 'life']],
    ['recoveryChat', ['behavior', 'life', 'recovery', 'social']],
    ['profile', ['profile']],
    ['memory', ['memory']],
  ] as const)('routes only the relevant policies for %s', (task, keys) => {
    const config = defaultPrompts();
    config.entries.forEach((e) => (e.content = 'UNIQUE_' + e.key));
    const result = composePrompt(task, config, {}, 'JSON only')[0].content;
    for (const entry of config.entries)
      expect(result.includes('UNIQUE_' + entry.key)).toBe(
        (keys as readonly string[]).includes(entry.key),
      );
  });
  it('makes behavior unavoidable for all dialogue sources', () => {
    for (const task of ['chat', 'recoveryChat'] as const) {
      const s = composePrompt(
        task,
        defaultPrompts(),
        { character: { style: '个人风格不应绕过规则' } },
        'JSON',
      )[0].content;
      expect(s).toContain('禁止 AI 服务式回复');
      expect(s).toContain('全局任务规范 > 角色个人');
    }
  });
  it('does not mutate a running batch snapshot when saved config changes', async () => {
    const snap = structuredClone(await getPrompts(d));
    await savePrompt(d, 'life', '新规则', true);
    expect(snap.entries.find((e) => e.key === 'life')?.content).not.toBe('新规则');
    expect((await getPrompts(d)).version).toBe(snap.version + 1);
  });
  it('preserves customized defaults through software upgrades', () => {
    const current = defaultPrompts(1),
      updated = defaultPrompts(2);
    current.entries[0].customized = true;
    current.entries[0].content = '我的规则';
    updated.entries.forEach((e) => {
      e.defaultVersion = 2;
      e.content = '新版默认';
    });
    const next = migrateDefaults(current, updated);
    expect(next.entries[0].content).toBe('我的规则');
    expect(next.entries[1].content).toBe('新版默认');
  });
  it('omits a disabled policy and versions imported config monotonically', async () => {
    await savePrompt(d, 'social', '不要出现这个字符串', false);
    const c = await getPrompts(d);
    expect(composePrompt('chat', c, {}, 'JSON')[0].content).not.toContain('不要出现这个字符串');
    await replacePrompts(d, defaultPrompts());
    expect((await getPrompts(d)).version).toBe(c.version + 1);
  });
  it('validates and persists visual rules', async () => {
    await saveRules(d, { ...defaultRules, hardLimit: 80 });
    expect((await getPrompts(d)).rules.hardLimit).toBe(80);
    await expect(saveRules(d, { ...defaultRules, hardLimit: 20 })).rejects.toThrow();
  });
  it('sends life/recovery policies and preserves event identity', async () => {
    const event = (await d.events.toArray())[0],
      p = new MockProvider({ description: '在家休息。' });
    const next = await describeEvent(d, event, await getPrompts(d), p, true);
    expect(next.id).toBe(event.id);
    expect(p.calls[0][0].content).toContain('离线时间');
    expect(p.calls[0][0].content).toContain('日常生活事件');
    expect(p.calls[0][0].content).not.toContain('禁止输出 Markdown');
  });
});
describe('structured dialogue validation', () => {
  const snapshot = defaultPrompts();
  it('accepts valid JSON arrays and returns distinct messages, never splitting newlines', () => {
    const output = parseDialogue(
      JSON.stringify({
        speakerId: 'a',
        messages: ['第一条\n还属于第一条', '第二条'],
        offsets: [0, 5],
      }),
      'a',
      snapshot,
    );
    expect(output.messages).toHaveLength(2);
    expect(output.messages[0]).toContain('\n');
  });
  it.each(['# 标题', '**加粗**', '- 列表', '[链接](https://example.com)', '`代码`', '*动作*'])(
    'rejects forbidden Markdown: %s',
    (text) =>
      expect(() =>
        parseDialogue(JSON.stringify({ speakerId: 'a', messages: [text] }), 'a', snapshot),
      ).toThrow(),
  );
  it('safely rejects overlong messages without truncating facts', () =>
    expect(() =>
      parseDialogue(
        JSON.stringify({ speakerId: 'a', messages: ['字'.repeat(151)] }),
        'a',
        snapshot,
      ),
    ).toThrow('长度'));
  it('counts Unicode code points and permits natural short expressions', () => {
    expect(
      parseDialogue(JSON.stringify({ speakerId: 'a', messages: ['嗯。'] }), 'a', snapshot).messages,
    ).toEqual(['嗯。']);
    expect(() =>
      parseDialogue(
        JSON.stringify({ speakerId: 'a', messages: ['🙂'.repeat(150)] }),
        'a',
        snapshot,
      ),
    ).not.toThrow();
  });
  it('rejects illegal speaker, message count, invalid JSON and offsets', () => {
    for (const output of [
      { speakerId: 'b', messages: ['嗯'] },
      { speakerId: 'a', messages: ['1', '2', '3', '4'] },
      { speakerId: 'a', messages: ['1', '2'], offsets: [10, 0] },
      { speakerId: 'a', messages: ['1'], offsets: [61] },
    ])
      expect(() => parseDialogue(JSON.stringify(output), 'a', snapshot)).toThrow();
    expect(() => parseDialogue('```json\n{}\n```', 'a', snapshot)).toThrow();
  });
  it('permits silence only when allowed', () => {
    expect(parseDialogue('{"speakerId":"a","messages":[]}', 'a', snapshot).messages).toEqual([]);
    expect(() =>
      parseDialogue('{"speakerId":"a","messages":[]}', 'a', {
        ...snapshot,
        rules: { ...snapshot.rules, allowSilence: false },
      }),
    ).toThrow();
  });
  it('can allow Markdown without relaxing hard limits', () => {
    const snap = {
      ...snapshot,
      rules: { ...snapshot.rules, allowMarkdown: true, allowActions: true },
    };
    expect(parseDialogue('{"speakerId":"a","messages":["**好**"]}', 'a', snap).messages).toEqual([
      '**好**',
    ]);
  });
});
describe('task integration', () => {
  it('profile assistance uses profile policy without dialogue bans', async () => {
    const p = new MockProvider({
      bio: '原作事实：未知',
      personality: '合理推测：慢热',
      style: '简短',
      habits: '原创补充：散步',
      uncertain: '待用户核对',
    });
    await generateProfile({ name: '新角色' }, d, p);
    expect(p.calls[0][0].content).toContain('角色资料 AI 帮写');
    expect(p.calls[0][0].content).not.toContain('禁止输出 Markdown');
    expect(p.calls[0][0].content).not.toContain('群聊不应');
  });
  it('memory consolidation applies memory policy and retains private owners', async () => {
    const p = new MockProvider({ content: '由奈邀请大家去看海，夏生准备带速写本。' });
    await consolidateMemory('conv-cafe', d, p);
    const saved = await d.memories.where('conversationId').equals('conv-cafe').first();
    expect(saved?.owners).toHaveLength(5);
    expect(p.calls[0][0].content).toContain('长期价值的角色记忆');
    expect(p.calls[0][0].content).not.toContain('禁止输出 Markdown');
  });
  it('applies character-specific tighter preferences without relaxing global bans', async () => {
    await d.characters.update('c-nagi', {
      messagePreferences: { maxMessages: 1, suggestedMax: 25 },
    });
    const p = new MockProvider({ speakerId: 'c-nagi', messages: ['一条', '两条'] });
    await expect(
      generateDialogue(
        d,
        (await d.conversations.get('conv-nm'))!,
        'c-nagi',
        Date.now(),
        await getPrompts(d),
        p,
      ),
    ).rejects.toThrow('数量');
    expect(p.calls[0][0].content).toContain('禁止输出 Markdown');
    expect(p.calls[0][0].content).toContain('"suggestedMax":25');
  });
});
