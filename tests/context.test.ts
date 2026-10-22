import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packRequest, compressContext, selectiveText } from '../src/ai/context';
import { parseStructuredJSON } from '../src/ai/structured';
import { defaultPrompts } from '../src/ai/prompts';
import { parseDialogue, generateDialogue } from '../src/ai/orchestrator';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import type { Completion, ChatInput } from '../src/ai/provider';
describe('selective context packing', () => {
  it('keeps world facts, locked boundaries, latest user-controlled text and exact system rules', () => {
    const world = {
        rules: '普通现代世界，不能使用魔法',
        description: '角色都在海盐市',
        timezone: 'Asia/Shanghai',
      },
      latest = { speakerId: 'a', source: 'user', text: '这次不要忘记明天的约定。', at: 100 };
    const context = {
      world,
      character: {
        id: 'a',
        bio: '店员',
        avatar: 'data:image/png;base64,' + 'x'.repeat(20000),
        style: '自然',
      },
      relationships: [{ locked: true, boundaries: '不得泄露秘密', history: '日常'.repeat(2000) }],
      history: [
        ...Array.from({ length: 80 }, (_, i) => ({
          speakerId: 'b',
          source: 'ai',
          text: `旧消息 ${i} 普通闲聊。`,
          at: i,
        })),
        latest,
      ],
      memories: Array.from({ length: 6 }, (_, i) => ({
        content: '普通生活细节。'.repeat(80),
        knownBy: ['a'],
        at: i,
      })),
      state: { phone: 0, location: '家' },
      input: { constraints: '必须保留此项' },
    };
    const request = [
      { role: 'system' as const, content: '全局禁用规则，不允许泄露秘密。' },
      { role: 'user' as const, content: JSON.stringify(context) },
    ];
    const packed = packRequest(request, 'chat', 2500);
    const result = JSON.parse(packed.messages[1].content);
    expect(packed.messages[0]).toEqual(request[0]);
    expect(result.world).toEqual(world);
    expect(result.relationships[0].boundaries).toBe('不得泄露秘密');
    expect(result.history.at(-1)).toEqual(latest);
    expect(result.state).toEqual(context.state);
    expect(result.input.constraints).toBe('必须保留此项');
    expect(JSON.stringify(result)).not.toContain('base64');
    expect(packed.report.afterTokens).toBeLessThan(packed.report.beforeTokens);
    expect(packed.report.removedHistory).toBeGreaterThan(60);
    expect(packed.report.removedMemories).toBeGreaterThan(0);
  });
  it('keeps the latest user message even when it is older than the last seven AI messages', () => {
    const user = { source: 'user', speakerId: 'a', text: '重要用户信息', at: 0 };
    const result = compressContext(
      { history: [user, ...Array.from({ length: 20 }, (_, i) => ({ text: `闲聊${i}` }))] },
      'tight',
    );
    expect(result.context.history).toContainEqual(user);
  });
  it('does not silently cut protected facts when the mandatory part exceeds the budget', () =>
    expect(() =>
      packRequest(
        [
          { role: 'system', content: '规则' },
          { role: 'user', content: JSON.stringify({ world: { rules: '不得'.repeat(3000) } }) },
        ],
        'chat',
        1000,
      ),
    ).toThrow('必要的世界事实'));
  it('preserves secrets and commitments in extractive text compression without adding facts', () => {
    const result = selectiveText('今天吃饭。'.repeat(100) + '禁止向 C 透露秘密。', 50);
    expect(result).toContain('禁止向 C 透露秘密。');
  });
  it('does not mutate the original context or model request', () => {
    const context = { history: Array.from({ length: 20 }, (_, i) => ({ text: String(i) })) };
    const original = structuredClone(context);
    compressContext(context, 'tight');
    expect(context).toEqual(original);
  });
});
describe('provider envelope compatibility', () => {
  it.each([
    '```json\n{"speakerId":"a","messages":["好。"]}\n```',
    '说明：{"speakerId":"a","messages":["好。"]} 结束。',
    '\uFEFF<think>hidden reasoning</think> {"speakerId":"a","messages":["好。"]}',
  ])('accepts one JSON object in a safe envelope', (raw) => {
    expect(parseDialogue(raw, 'a', defaultPrompts()).messages).toEqual(['好。']);
  });
  it('rejects ambiguous multiple objects and incomplete output', () => {
    expect(() => parseStructuredJSON('{"a":1} {"b":2}')).toThrow();
    expect(() => parseStructuredJSON('{"speakerId":"a","messages":["unfinished')).toThrow();
  });
  it('never splits plain text into invented messages', () =>
    expect(() => parseDialogue('好。\n下次见。', 'a', defaultPrompts())).toThrow());
});
describe('truncation recovery', () => {
  let d: AquariumDB;
  beforeEach(async () => {
    d = new AquariumDB('context-' + crypto.randomUUID());
    await seed(d);
  });
  afterEach(async () => {
    await d.delete();
  });
  it('records actual truncated usage and retries once with a separately reserved larger output budget', async () => {
    const calls: { messages: ChatInput; output?: number }[] = [];
    const provider = {
      async complete(
        messages: ChatInput,
        _signal?: AbortSignal,
        options?: { maxOutputTokens?: number },
      ): Promise<Completion> {
        calls.push({ messages, output: options?.maxOutputTokens });
        return calls.length === 1
          ? {
              content: '{"speakerId":',
              finishReason: 'length',
              inputTokens: 100,
              outputTokens: 2048,
              estimated: false,
            }
          : {
              content: '{"speakerId":"c-nagi","messages":["这次正常了。"]}',
              finishReason: 'stop',
              inputTokens: 90,
              outputTokens: 30,
              estimated: false,
            };
      },
    };
    const result = await generateDialogue(
      d,
      (await d.conversations.get('conv-nm'))!,
      'c-nagi',
      Date.now(),
      defaultPrompts(),
      provider,
    );
    expect(result.messages).toEqual(['这次正常了。']);
    expect(calls).toHaveLength(2);
    expect(calls[1].output!).toBeGreaterThan(calls[0].output!);
    expect(calls[1].messages.every((m) => m.role !== 'assistant')).toBe(true);
    const usage = (await d.usage.toArray())[0];
    expect(usage.requests).toBe(2);
    expect(usage.outputTokens).toBe(2078);
    const logs = await d.taskLogs.toArray();
    expect(logs.some((l) => l.finishReason === 'length' && l.status === 'truncated')).toBe(true);
    expect(logs.every((l) => l.context!.afterTokens <= 4000)).toBe(true);
  });
  it('does not retry forever or write partial messages when output repeatedly truncates', async () => {
    let calls = 0;
    const provider = {
      async complete() {
        calls++;
        return {
          content: '',
          finishReason: 'length',
          inputTokens: 5,
          outputTokens: 100,
          estimated: false,
        };
      },
    };
    const before = await d.messages.count();
    await expect(
      generateDialogue(
        d,
        (await d.conversations.get('conv-nm'))!,
        'c-nagi',
        Date.now(),
        defaultPrompts(),
        provider,
      ),
    ).rejects.toThrow('重试一次');
    expect(calls).toBe(2);
    expect(await d.messages.count()).toBe(before);
  });
});

describe('observed DeepSeek array syntax compatibility', () => {
  it('repairs an extra closing bracket without changing any message string', () => {
    const raw = '{"speakerId":"a","messages":["第一条"],"第二条"],"offsets":[0,8]}';
    expect(parseDialogue(raw, 'a', defaultPrompts()).messages).toEqual(['第一条', '第二条']);
  });
  it('flattens only tokenized adjacent message arrays, never text lines', () => {
    const raw =
      '{"speakerId":"a","messages":["第一条"],["第二条\\n仍是第二条"],["第三条"],"offsets":[0,8,20]}';
    expect(parseDialogue(raw, 'a', defaultPrompts()).messages).toEqual([
      '第一条',
      '第二条\n仍是第二条',
      '第三条',
    ]);
  });
  it('still rejects another speaker, unknown fields and overlong strings after syntactic repair', () => {
    expect(() =>
      parseDialogue(
        '{"speakerId":"b","messages":["a"],"b"],"offsets":[0,1]}',
        'a',
        defaultPrompts(),
      ),
    ).toThrow();
    expect(() =>
      parseDialogue('{"speakerId":"a","messages":["a"],"evil":"x"}', 'a', defaultPrompts()),
    ).toThrow();
    expect(() =>
      parseDialogue(
        JSON.stringify({ speakerId: 'a', messages: ['字'.repeat(151)] }),
        'a',
        defaultPrompts(),
      ),
    ).toThrow();
  });
});
