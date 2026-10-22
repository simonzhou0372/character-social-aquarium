import type { ApiProfile } from '../core/types';
import type { PromptConfig } from './prompts';
export type ChatInput = { role: 'system' | 'user' | 'assistant'; content: string }[];
export interface Completion {
  content: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  finishReason?: string;
}
export interface Provider {
  complete(
    messages: ChatInput,
    signal?: AbortSignal,
    options?: { maxOutputTokens?: number },
  ): Promise<Completion>;
}
export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
let sessionKey = '';
export function setSessionKey(value: string) {
  sessionKey = value;
}
export function getKey(p: ApiProfile) {
  return sessionKey || p.key || '';
}
export function validateEndpoint(baseUrl: string) {
  const u = new URL(baseUrl);
  if (u.username || u.password || u.search || u.hash)
    throw new ProviderError('url', '接口地址不能包含账号、查询参数或片段。');
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  )
    throw new ProviderError('url', '接口需要 HTTPS，本地回环地址可使用 HTTP。');
  return u.toString().replace(/\/$/, '');
}
export function apiError(status: number, body = ''): ProviderError {
  if (status === 401) return new ProviderError('invalid', '密钥无效或已失效，请检查 API 设置。');
  if (status === 403) return new ProviderError('permission', '当前密钥没有访问该模型的权限。');
  if (status === 429)
    return /quota|credit|balance|billing|余额/i.test(body)
      ? new ProviderError('quota', '服务商余额或额度不足，请检查账户。')
      : new ProviderError('rate', '请求过于频繁，请稍后重试。');
  if (status >= 500) return new ProviderError('server', '模型服务暂时不可用，请稍后重试。');
  return new ProviderError('request', `模型请求失败（HTTP ${status}），请检查模型名称与接口地址。`);
}
export class CompatibleProvider implements Provider {
  constructor(
    private profile: ApiProfile,
    private key = getKey(profile),
  ) {}
  async request(path: string, method: string, payload?: unknown, signal?: AbortSignal) {
    if (!this.key) throw new ProviderError('missing', '请先填写 API Key。');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 35000);
    try {
      const r = await fetch(`${validateEndpoint(this.profile.baseUrl)}/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!r.ok) throw apiError(r.status, (await r.text()).slice(0, 2000));
      return await r.json();
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (controller.signal.aborted)
        throw new ProviderError(
          signal?.aborted ? 'cancelled' : 'timeout',
          signal?.aborted ? '操作已取消。' : '连接超时，请检查网络或稍后重试。',
        );
      if (e instanceof SyntaxError) throw new ProviderError('json', '服务商返回了无法解析的数据。');
      throw new ProviderError(
        'network',
        '无法连接 API。可能是网络或浏览器跨域（CORS）限制；请使用支持浏览器直连的接口，或受信任的本地代理。',
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
  async complete(
    messages: ChatInput,
    signal?: AbortSignal,
    options?: { maxOutputTokens?: number },
  ): Promise<Completion> {
    const routineDeepSeek =
      this.profile.thinkingMode === 'off' ||
      (this.profile.thinkingMode !== 'on' &&
        new URL(this.profile.baseUrl).hostname === 'api.deepseek.com' &&
        /^deepseek-(flash|v4)/.test(this.profile.model));
    const data = await this.request(
      'chat/completions',
      'POST',
      {
        model: this.profile.model,
        ...(routineDeepSeek ? { thinking: { type: 'disabled' } } : {}),
        messages,
        temperature: 0.65,
        max_tokens: options?.maxOutputTokens ?? 1400,
        ...(messages[0]?.content.includes('输出契约')
          ? { response_format: { type: 'json_object' } }
          : {}),
      },
      signal,
    );
    const content =
      data?.choices?.[0]?.message?.content ??
      (data?.choices?.[0]?.finish_reason === 'length' ? '' : undefined);
    if (typeof content !== 'string') throw new ProviderError('json', '模型未返回文本消息。');
    return {
      finishReason: data?.choices?.[0]?.finish_reason,
      content,
      inputTokens:
        Number(data.usage?.prompt_tokens) || Math.ceil(JSON.stringify(messages).length / 2),
      outputTokens: Number(data.usage?.completion_tokens) || Math.ceil(content.length / 2),
      estimated: !data.usage,
    };
  }
  async models() {
    const data = await this.request('models', 'GET');
    return (Array.isArray(data.data) ? data.data : [])
      .map((x: { id?: unknown }) => x.id)
      .filter((x: unknown): x is string => typeof x === 'string')
      .slice(0, 300);
  }
}
// Tests only. Never selected by a live-world API request.
export class MockProvider implements Provider {
  calls: ChatInput[] = [];
  constructor(
    private output: unknown = {
      speakerId: 'c-nagi',
      messages: ['海风有点凉。', '要不要带件外套？'],
    },
    private failure?: string,
  ) {}
  async complete(messages: ChatInput): Promise<Completion> {
    this.calls.push(structuredClone(messages));
    if (this.failure) throw new ProviderError(this.failure, `模拟故障：${this.failure}`);
    return {
      content: typeof this.output === 'string' ? this.output : JSON.stringify(this.output),
      inputTokens: 30,
      outputTokens: 20,
      estimated: false,
    };
  }
}
export function dialogueContract(speakerId: string, snapshot: PromptConfig) {
  return `只返回 JSON 对象 {"speakerId":"${speakerId}","messages":["短消息"],"offsets":[0]}。messages 是字符串数组，不按换行或列表拆分。每批最多 ${snapshot.rules.allowConsecutive ? snapshot.rules.maxMessages : 1} 条，每条最多 ${snapshot.rules.hardLimit} 个 Unicode 字符。${snapshot.rules.allowSilence ? '允许 messages=[] 表示沉默。' : `非空时至少 ${snapshot.rules.allowConsecutive ? snapshot.rules.minMessages : 1} 条。`} offsets 为相同长度的非负秒偏移，递增且不超过 60。不得生成其他角色的消息，不得修改事实或关系。`;
}
