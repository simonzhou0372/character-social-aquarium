import { compactChatRequest, expandCompactChat } from './compact-protocol';
import { modelPolicy, cachedMessages, type RequestPolicy } from './model-policy';
import type { ApiProfile } from '../core/types';
import type { PromptConfig } from './prompts';
export type ChatInput = { role: 'system' | 'user' | 'assistant'; content: string }[];
export interface Completion {
  content: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  finishReason?: string;
  requestId?: string;
  accounting?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  };
  policy?: RequestPolicy;
}
export function reportedUsage(usage: any): NonNullable<Completion['accounting']> {
  return Object.fromEntries(
    Object.entries({
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
      cacheHitTokens: usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens,
      cacheMissTokens: usage?.prompt_cache_miss_tokens,
    }).filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n >= 0),
  );
}
const unsupportedThinking = new Set<string>();
export interface Provider {
  disableReasoning?(model?: string): void;
  describe?(task?: string): RequestPolicy;
  complete(
    messages: ChatInput,
    signal?: AbortSignal,
    options?: { maxOutputTokens?: number; task?: string },
  ): Promise<Completion>;
}
export class ProviderError extends Error {
  requestId?: string;
  budgetDay?: number;
  accounting?: Completion['accounting'];
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
  if (
    status === 400 &&
    /response_format|json_schema|structured.output/i.test(body) &&
    /unsupported|not.support|invalid|not.available/i.test(body)
  )
    return new ProviderError(
      'unsupported-format',
      '当前模型不支持所选结构化模式，请在AI高级设置改为兼容JSON文本模式。',
    );
  if (
    status === 400 &&
    /thinking|reasoning_effort/i.test(body) &&
    /unsupported|not.support|invalid|not.available/i.test(body)
  )
    return new ProviderError(
      'unsupported-thinking',
      '服务商不支持当前思考参数，将安全回退到原生模式。',
    );
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
  async request(
    path: string,
    method: string,
    payload?: unknown,
    signal?: AbortSignal,
    timeoutMs = 35000,
  ) {
    if (!this.key) throw new ProviderError('missing', '请先填写 API Key。');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
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
    options?: { maxOutputTokens?: number; task?: string },
  ): Promise<Completion> {
    const policy = this.describe(options?.task);
    const compact =
      this.profile.compactProtocol !== false &&
      (this.profile.compactProtocol === true || policy.deepSeek)
        ? compactChatRequest(messages, options?.task)
        : undefined;
    if (compact) messages = compact.messages;
    if (policy.deepSeek && this.profile.stablePrefix !== false) messages = cachedMessages(messages);
    const data = await this.request(
      'chat/completions',
      'POST',
      {
        model: policy.model,
        ...(policy.deepSeek && policy.thinking !== 'unknown'
          ? {
              thinking: { type: policy.thinking === 'on' ? 'enabled' : 'disabled' },
              ...(policy.thinking === 'on' ? { reasoning_effort: policy.effort } : {}),
            }
          : {}),
        messages,
        temperature: 0.65,
        max_tokens: options?.maxOutputTokens ?? 1400,
        ...((this.profile.structuredOutputMode === 'json' ||
          (this.profile.structuredOutputMode !== 'off' &&
            ['api.openai.com', 'api.deepseek.com'].includes(
              new URL(this.profile.baseUrl).hostname,
            ))) &&
        messages[0]?.content.includes('输出契约')
          ? { response_format: { type: 'json_object' } }
          : {}),
      },
      signal,
      policy.thinking !== 'off' && ['novel', 'major', 'evolution'].includes(options?.task ?? '')
        ? 120000
        : 35000,
    );
    const content =
      data?.choices?.[0]?.message?.content ??
      (data?.choices?.[0]?.finish_reason === 'length' ? '' : undefined);
    if (typeof content !== 'string') {
      const error = new ProviderError('json', '模型未返回文本消息。');
      error.accounting = reportedUsage(data.usage);
      throw error;
    }
    return {
      finishReason: data?.choices?.[0]?.finish_reason,
      content: compact ? expandCompactChat(content, compact.speaker) : content,
      inputTokens: Number.isFinite(data.usage?.prompt_tokens)
        ? data.usage.prompt_tokens
        : Math.ceil(JSON.stringify(messages).length / 2),
      outputTokens: Number.isFinite(data.usage?.completion_tokens)
        ? data.usage.completion_tokens
        : Math.ceil(content.length / 2),
      estimated:
        !Number.isFinite(data.usage?.prompt_tokens) ||
        !Number.isFinite(data.usage?.completion_tokens),
      accounting: reportedUsage(data.usage),
      policy,
    };
  }
  describe(task?: string) {
    const p = modelPolicy(this.profile, task);
    return unsupportedThinking.has(this.profile.baseUrl + '|' + p.model) ||
      this.profile.unsupportedThinkingModels?.includes(p.model)
      ? { ...p, thinking: 'unknown' as const, effort: undefined, deepSeek: false }
      : p;
  }
  disableReasoning(model?: string) {
    if (unsupportedThinking.size >= 64)
      unsupportedThinking.delete(unsupportedThinking.values().next().value!);
    unsupportedThinking.add(this.profile.baseUrl + '|' + (model ?? this.describe().model));
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
  return `只返回 JSON 对象 {"speakerId":"${speakerId}","messages":["短消息"],"offsets":[0]}。messages 是字符串数组，不按换行或列表拆分。每批最多 ${snapshot.rules.allowConsecutive ? snapshot.rules.maxMessages : 1} 条，每条最多 ${snapshot.rules.hardLimit} 个 Unicode 字符。${snapshot.rules.allowSilence ? '允许 messages=[] 表示沉默。' : `非空时至少 ${snapshot.rules.allowConsecutive ? snapshot.rules.minMessages : 1} 条。`} offsets 为相同长度的非负秒偏移，递增且不超过 60。不得生成其他角色的消息，不得修改事实或关系。可选 mentionTargets:[{"messageIndex":0,"characterId":"成员ID"}]，仅在群聊中需要点名时使用：对应 messages 文本必须包含 @成员完整姓名，仅可提及 input.participants 中除自己外的成员，不必每条消息都@。可选 reactions:[{"messageId":"历史消息ID","emoji":"😂"}]，最多3项，可自然选择 input.availableReactionEmojis 中适合语境、性格与关系的表情（不限点赞），只能回应 history 中他人的消息，不要对悲伤消息机械点赞。可只返回 messages:[] 与 reactions 表示仅用表情回应；表情不是新的聊天气泡。可选 replyToMessageId 只可引用当前历史中的原消息ID；可选 gifAssetId 只可选择 availableGifs 中授权ID，可附带简短文字。`;
}
