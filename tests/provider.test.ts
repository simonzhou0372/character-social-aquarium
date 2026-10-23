import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompatibleProvider, validateEndpoint } from '../src/ai/provider';
import type { ApiProfile } from '../src/core/types';
const profile: ApiProfile = {
  id: 'api',
  provider: 'fixture',
  baseUrl: 'https://fixture.invalid/v1',
  model: 'fixture',
  persistKey: false,
  status: 'untested',
};
const client = () => new CompatibleProvider(profile, 'fixture-not-a-secret');
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('compatible provider HTTP boundary', () => {
  it.each([
    [401, 'invalid'],
    [403, 'permission'],
    [429, 'rate'],
    [503, 'server'],
  ])('classifies HTTP %s', async (status, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"fixture"}', { status: Number(status) })),
    );
    await expect(client().complete([])).rejects.toMatchObject({ code });
  });
  it('classifies network/CORS rejection without exposing credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(client().complete([])).rejects.toMatchObject({ code: 'network' });
  });
  it('rejects invalid response JSON and missing text choices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not JSON', { status: 200 })),
    );
    await expect(client().complete([])).rejects.toMatchObject({ code: 'json' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    await expect(client().complete([])).rejects.toMatchObject({ code: 'json' });
  });
  it('aborts once at timeout, without automatic retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = expect(client().complete([])).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(35001);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('sends credentials only in the selected endpoint Authorization header', async () => {
    const mock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{}' } }],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
          }),
        ),
    );
    vi.stubGlobal('fetch', mock);
    const result = await client().complete([{ role: 'user', content: 'hello' }]);
    expect(mock.mock.calls).toHaveLength(1);
    const [url, options] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fixture.invalid/v1/chat/completions');
    expect(url).not.toContain('fixture-not-a-secret');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer fixture-not-a-secret',
    );
    expect(options.redirect).toBe('error');
    expect(options.credentials).toBe('omit');
    expect(result.inputTokens).toBe(2);
  });
  it.each([
    'http://untrusted.invalid/v1',
    'https://a.invalid/v1?api_key=x',
    'https://user:pass@a.invalid/v1',
  ])('rejects unsafe endpoint %s', (url) => expect(() => validateEndpoint(url)).toThrow());
});

describe('routine DeepSeek generation', () => {
  it('disables optional thinking for known routine DeepSeek models and keeps length metadata', async () => {
    const mock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'length',
                message: { content: null, reasoning_content: 'not forwarded' },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 2048 },
          }),
        ),
    );
    vi.stubGlobal('fetch', mock);
    const result = await new CompatibleProvider(
      { ...profile, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
      'fixture',
    ).complete([{ role: 'system', content: '输出契约：返回 JSON' }], undefined, {
      maxOutputTokens: 2048,
    });
    const args = mock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(args[1].body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(2048);
    expect(result.finishReason).toBe('length');
    expect(result.content).toBe('');
    expect(result.outputTokens).toBe(2048);
  });
});
it('uses compatible JSON text by default on unknown hosts and honors explicit structured output modes', async () => {
  const mock = vi.fn(
    async (_url: unknown, _options: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }),
  );
  vi.stubGlobal('fetch', mock);
  const messages = [{ role: 'system' as const, content: '输出契约：仅返回 JSON' }];
  await new CompatibleProvider(profile, 'fixture').complete(messages);
  expect(JSON.parse(mock.mock.calls[0][1]!.body as string).response_format).toBeUndefined();
  await new CompatibleProvider({ ...profile, structuredOutputMode: 'json' }, 'fixture').complete(
    messages,
  );
  expect(JSON.parse(mock.mock.calls[1][1]!.body as string).response_format).toEqual({
    type: 'json_object',
  });
  await new CompatibleProvider(
    { ...profile, baseUrl: 'https://api.openai.com/v1', structuredOutputMode: 'off' },
    'fixture',
  ).complete(messages);
  expect(JSON.parse(mock.mock.calls[2][1]!.body as string).response_format).toBeUndefined();
});
it('reports unsupported JSON response formats separately from schema and field errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('response_format json_object is unsupported', { status: 400 })),
  );
  await expect(
    new CompatibleProvider({ ...profile, structuredOutputMode: 'json' }, 'fixture').complete([
      { role: 'system', content: '输出契约：JSON' },
    ]),
  ).rejects.toMatchObject({ code: 'unsupported-format' });
});
