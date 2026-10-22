import {
  markdownPattern as markdown,
  servicePattern,
  thoughtPattern as thought,
} from '../core/message-format';
import { withAISlot } from './concurrency';
import { formatWorldTime } from '../core/calendar';
import { z } from 'zod';
import { packRequest } from './context';
import { parseStructuredJSON, repairDialogueJSON } from './structured';
import { db, type AquariumDB, withWorldLock } from '../data/db';
import {
  type Conversation,
  type Message,
  type ApiProfile,
  type MemoryEntry,
  type ActivityEvent,
  uid,
} from '../core/types';
import { composePrompt, getPrompts, type PromptConfig, type TaskKind } from './prompts';
import {
  CompatibleProvider,
  dialogueContract,
  ProviderError,
  type Provider,
  type Completion,
  type ChatInput,
} from './provider';
const DialogueSchema = z
  .object({
    speakerId: z.string(),
    messages: z.array(z.string().min(1)).max(3),
    offsets: z.array(z.number().int().min(0).max(60)).max(3).optional(),
  })
  .strict();
const action = /[（(][^）)\n]{1,160}[）)]|^[*＊].+[*＊]$/;
export function parseDialogue(raw: string, speakerId: string, snapshot: PromptConfig) {
  let value: unknown;
  try {
    value = parseStructuredJSON(raw);
  } catch {
    value = repairDialogueJSON(raw);
  }
  const result = DialogueSchema.safeParse(value);
  if (!result.success)
    throw new ProviderError('schema', '角色回复格式不符合约定，本次生成未写入。');
  const r = result.data,
    rules = snapshot.rules,
    max = rules.allowConsecutive ? rules.maxMessages : 1,
    min = rules.allowConsecutive ? rules.minMessages : 1;
  if (
    r.speakerId !== speakerId ||
    r.messages.length > max ||
    (!rules.allowSilence && r.messages.length < min) ||
    (r.messages.length > 0 && r.messages.length < min)
  )
    throw new ProviderError('schema', '回复角色或消息数量不合法，本次生成未写入。');
  if (
    r.offsets &&
    (r.offsets.length !== r.messages.length ||
      r.offsets.some((n, i) => i > 0 && n < r.offsets![i - 1]))
  )
    throw new ProviderError('schema', '消息时间偏移不合法。');
  for (const text of r.messages) {
    if (!text.trim() || Array.from(text).length > rules.hardLimit)
      throw new ProviderError('length', '角色回复超过消息长度上限，本次生成未写入。');
    if (!rules.allowMarkdown && markdown.test(text))
      throw new ProviderError('format', '回复包含禁用的 Markdown，本次生成未写入。');
    if (!rules.allowActions && action.test(text))
      throw new ProviderError('format', '回复包含禁用的动作描写，本次生成未写入。');
    if (!rules.allowThoughts && thought.test(text))
      throw new ProviderError('format', '回复包含禁用的心理描写，本次生成未写入。');
    if (servicePattern.test(text) && snapshot.entries.find((e) => e.key === 'behavior')?.enabled)
      throw new ProviderError('format', '回复包含服务式套话，本次生成未写入。');
  }
  return r;
}
export function lexicalScore(text: string, query: string) {
  const a = text.toLowerCase(),
    q = query.toLowerCase();
  let score = 0;
  for (let i = 0; i < q.length - 1; i++) if (a.includes(q.slice(i, i + 2))) score++;
  return score;
}
export function retrieveMemories(
  memories: MemoryEntry[],
  speakerId: string,
  worldId: string,
  at: number,
  query: string,
) {
  return memories
    .filter((m) => m.worldId === worldId && m.at <= at && m.owners.includes(speakerId))
    .map((m) => ({
      m,
      score:
        lexicalScore(m.content + ' ' + m.keywords.join(' '), query) +
        m.importance * 2 +
        Math.max(0, 1 - (at - m.at) / 604800000),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => ({ content: x.m.content, knownBy: x.m.owners, at: x.m.at }));
}
function dayKey(at: number) {
  return new Date(at).toISOString().slice(0, 10);
}
export async function budgetedCompletion(
  d: AquariumDB,
  provider: Provider,
  messages: ChatInput,
  worldId: string,
  task: TaskKind,
  snapshot: PromptConfig,
  signal?: AbortSignal,
  options?: { outputBudget?: number; tightContext?: boolean },
): Promise<Completion> {
  if (signal?.aborted) throw new ProviderError('cancelled', '任务已取消');
  const usageId = dayKey(Date.now());
  const profile = await d.profiles.get('api');
  const packed = packRequest(
    messages,
    task,
    profile?.contextBudgetTokens ?? 4000,
    options?.tightContext,
  );
  const estimatedInput = packed.report.afterTokens;
  const reservedOutput =
    options?.outputBudget ??
    (task === 'worldDraft'
      ? 5000
      : task === 'groupDraft'
        ? 3500
        : (profile?.outputBudgetTokens ?? 2048));
  await d.transaction('rw', d.usage, d.settings, async () => {
    const s = await d.settings.get('app');
    const u = (await d.usage.get(usageId)) ?? {
      id: usageId,
      day: usageId,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      messages: 0,
      estimated: false,
    };
    if (
      s &&
      !s.unlimitedUsage &&
      (u.requests >= s.dailyRequests ||
        u.inputTokens + u.outputTokens + estimatedInput + reservedOutput > s.dailyTokens)
    )
      throw new ProviderError('budget', '今日 AI 预算已用完，可以在模拟设置中调整。');
    await d.usage.put({
      ...u,
      requests: u.requests + 1,
      inputTokens: u.inputTokens + estimatedInput,
      outputTokens: u.outputTokens + reservedOutput,
      estimated: true,
    });
  });
  const logId = uid('task');
  await d.taskLogs.add({
    id: logId,
    worldId,
    task,
    promptVersion: snapshot.version,
    at: Date.now(),
    status: 'running',
    context: packed.report,
  });
  try {
    const result = await withAISlot(
      () =>
        provider.complete(packed.messages, signal, {
          maxOutputTokens: reservedOutput,
        }),
      signal,
    );
    await d.transaction('rw', d.usage, d.taskLogs, async () => {
      const u = (await d.usage.get(usageId))!;
      await d.usage.put({
        ...u,
        inputTokens: Math.max(0, u.inputTokens - estimatedInput + result.inputTokens),
        outputTokens: Math.max(0, u.outputTokens - reservedOutput + result.outputTokens),
        estimated: u.estimated || result.estimated,
      });
      await d.taskLogs.update(logId, {
        status: result.finishReason === 'length' ? 'truncated' : 'completed',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        finishReason: result.finishReason,
      });
    });
    if (signal?.aborted) throw new ProviderError('cancelled', '任务已取消');
    return result;
  } catch (e) {
    await d.taskLogs.update(logId, { status: 'failed' });
    if (e instanceof ProviderError && e.code === 'invalid')
      await d.profiles.update('api', { status: 'invalid' });
    throw e;
  }
}
export async function liveProvider(d: AquariumDB = db): Promise<Provider> {
  const p = await d.profiles.get('api');
  if (!p) throw new ProviderError('missing', '请先在 AI 设置中配置接口。');
  return new CompatibleProvider(p);
}
export async function dialogueContext(
  d: AquariumDB,
  c: Conversation,
  speakerId: string,
  at: number,
) {
  const [character, world, membership, relationships, memories, history, state, settings] =
    await Promise.all([
      d.characters.get(speakerId),
      d.worlds.get(c.worldId),
      d.memberships.where('[worldId+characterId]').equals([c.worldId, speakerId]).first(),
      d.relationships.where('worldId').equals(c.worldId).toArray(),
      d.memories.where('worldId').equals(c.worldId).toArray(),
      d.messages.where('conversationId').equals(c.id).sortBy('seq'),
      d.states.get(`${c.worldId}:${speakerId}`),
      d.settings.get('app'),
    ]);
  const recent = history.filter((m) => m.simAt <= at).slice(-18);
  const aliases = await d.characters.where('id').anyOf(c.participants).toArray();
  return {
    world,
    character: {
      ...character,
      bio: membership?.bioOverride || character?.bio,
      style: membership?.styleOverride || character?.style,
      identity: membership?.identity,
    },
    relationships: relationships.filter(
      (r) => r.from === speakerId && c.participants.includes(r.to),
    ),
    memories: retrieveMemories(
      memories,
      speakerId,
      c.worldId,
      at,
      recent
        .slice(-3)
        .map((m) => m.text)
        .join(' '),
    ),
    history: recent.map((m) => ({
      speakerId: m.senderId,
      text: m.text,
      at: m.simAt,
      source: m.source,
    })),
    state,
    input: {
      participants: aliases.map((x) => ({ id: x.id, name: x.name })),
      user: { id: 'user', name: settings?.nickname, bio: settings?.userBio },
      simTime: at,
      localTime: world ? formatWorldTime(world, at) : '',
      backgroundKnowledge: await knownBackground(d, c.worldId, speakerId),
    },
  };
}
export async function generateDialogue(
  d: AquariumDB,
  c: Conversation,
  speakerId: string,
  at: number,
  snapshot: PromptConfig,
  provider: Provider,
  task: 'chat' | 'recoveryChat' = 'chat',
  signal?: AbortSignal,
  current?: { state: unknown; event: unknown },
) {
  if (c.groupId && (await d.groups.get(c.groupId))?.entityMode === 'background')
    throw new ProviderError('identity', '背景团体不参与聊天');
  if (c.controlledId === speakerId || !c.participants.includes(speakerId))
    throw new ProviderError('identity', '该角色当前由用户控制。');
  const context = await dialogueContext(d, c, speakerId, at);
  if (context.character.entityMode === 'background')
    throw new ProviderError('identity', '背景人物不参与聊天');
  const prefs = context.character.messagePreferences;
  if (prefs) {
    const maxMessages = Math.min(snapshot.rules.maxMessages, prefs.maxMessages);
    const suggestedMax = Math.min(
      snapshot.rules.suggestedMax,
      prefs.suggestedMax,
      snapshot.rules.hardLimit,
    );
    snapshot = {
      ...snapshot,
      rules: {
        ...snapshot.rules,
        maxMessages,
        minMessages: Math.min(snapshot.rules.minMessages, maxMessages),
        suggestedMax,
        suggestedMin: Math.min(snapshot.rules.suggestedMin, suggestedMax),
      },
    };
  }
  if (current) {
    context.state = current.state as typeof context.state;
    context.input = { ...context.input, currentEvent: current.event } as typeof context.input;
  }
  const messages = composePrompt(task, snapshot, context, dialogueContract(speakerId, snapshot));
  const response = await budgetedCompletion(
    d,
    provider,
    messages,
    c.worldId,
    task,
    snapshot,
    signal,
  );
  try {
    if (response.finishReason === 'length')
      throw new ProviderError('truncated', '模型输出额度不足，正在压缩后重试。');
    return parseDialogue(response.content, speakerId, snapshot);
  } catch (error) {
    if (!(error instanceof ProviderError) || !['json', 'schema', 'truncated'].includes(error.code))
      throw error;
    // One bounded repair uses exactly the same facts and prompt snapshot; no plain-text fallback.
    const repaired = await budgetedCompletion(
      d,
      provider,
      [
        ...messages,

        {
          role: 'user',
          content: `上次响应未满足结构契约。只修复成一个 JSON 对象，不添加新事实或新的发言者。${dialogueContract(speakerId, snapshot)} 不要代码围栏、前后说明、思考过程或多余字段。`,
        },
      ],
      c.worldId,
      task,
      snapshot,
      signal,
      {
        tightContext: true,
        outputBudget: Math.min(
          16000,
          Math.max(2048, (await d.profiles.get('api'))?.outputBudgetTokens ?? 2048) * 2,
        ),
      },
    );
    if (repaired.finishReason === 'length')
      throw new ProviderError(
        'truncated',
        '已压缩上下文并重试一次，模型仍超出输出预算。你的消息已保留，可在 AI 高级设置调整输出预算后重试。',
      );
    return parseDialogue(repaired.content, speakerId, snapshot);
  }
}
export async function persistDialogue(
  d: AquariumDB,
  conversationId: string,
  speakerId: string,
  texts: string[],
  at: number,
  source: Message['source'],
  prefix: string,
  eventId?: string,
  offsets?: number[],
) {
  const c = await d.conversations.get(conversationId);
  if (!c || c.controlledId === speakerId) return [];
  const existing = await d.messages.where('conversationId').equals(conversationId).sortBy('seq');
  const last = existing.at(-1);
  let seq = last?.seq ?? 0;
  const messages: Message[] = texts.map((text, i) => ({
    id: `${prefix}:${i}`,
    conversationId,
    senderId: speakerId,
    seq: ++seq,
    text,
    realAt: Date.now(),
    simAt: at + (offsets?.[i] ?? i * 2) * 1000,
    source,
    eventId,
  }));
  if (messages.some((m) => m.simAt < (last?.simAt ?? 0))) return [];
  if (!messages.length) return [];
  const day = dayKey(Date.now()),
    usage = (await d.usage.get(day)) ?? {
      id: day,
      day,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      messages: 0,
      estimated: false,
    };
  const settings = await d.settings.get('app');
  if (
    settings &&
    !settings.unlimitedUsage &&
    usage.messages + messages.length > settings.dailyMessages
  )
    throw new ProviderError('budget', '今日消息生成上限已用完。');
  await d.messages.bulkAdd(messages);
  await d.conversations.update(conversationId, { lastAt: messages.at(-1)!.simAt });
  await d.usage.put({ ...usage, messages: usage.messages + messages.length });
  return messages;
}
export async function sendUserMessage(
  conversationId: string,
  text: string,
  identity = 'user',
  d: AquariumDB = db,
) {
  if (identity !== 'user' && (await d.characters.get(identity))?.entityMode === 'background')
    throw new Error('请先将背景人物转为可互动角色');
  if (!text.trim() || Array.from(text).length > 2000)
    throw new Error('消息不能为空或超过 2000 字。');
  await withWorldLock(
    'interaction',
    () =>
      d.transaction('rw', d.conversations, d.messages, d.checkpoints, d.cursors, async () => {
        const c = await d.conversations.get(conversationId);
        if (!c) throw new Error('会话不存在');
        if (identity !== 'user' && c.controlledId !== identity) throw new Error('请先切换角色身份');
        const last = await d.messages.where('conversationId').equals(c.id).sortBy('seq');
        const cp = await d.checkpoints.get(c.worldId);
        const at = Math.max(cp?.simTime ?? Date.now(), last.at(-1)?.simAt ?? 0);
        await d.messages.add({
          id: uid('user'),
          conversationId,
          senderId: identity,
          text: text.trim(),
          seq: (last.at(-1)?.seq ?? 0) + 1,
          realAt: Date.now(),
          simAt: at,
          source: 'user',
        });
        await d.conversations.update(c.id, { lastAt: at });
      }),
    true,
  );
}
export async function replyToUser(conversationId: string, d: AquariumDB = db) {
  const c = await d.conversations.get(conversationId);
  if (!c) return;
  const provider = await liveProvider(d);
  const snapshot = await getPrompts(d);
  const cp = await d.checkpoints.get(c.worldId);
  const states = await d.states.where('worldId').equals(c.worldId).toArray();
  const activeCharacters = await d.characters.where('id').anyOf(c.participants).toArray();
  const eligible = c.participants.filter(
    (id) =>
      activeCharacters.some((char) => char.id === id && char.entityMode !== 'background') &&
      id !== c.controlledId &&
      (states.find((s) => s.characterId === id)?.phone ?? 1) > 0.3,
  );
  if (!eligible.length) throw new Error('大家现在不方便看手机，稍后会由模拟器决定是否回复。');
  const last = await d.messages.where('conversationId').equals(c.id).sortBy('seq');
  const candidate = eligible.filter((id) => id !== last.at(-1)?.senderId)[0];
  if (!candidate) return;
  const at = Math.max(cp?.simTime ?? Date.now(), (last.at(-1)?.simAt ?? 0) + 1000);
  const generated = await generateDialogue(d, c, candidate, at, snapshot, provider);
  await d.transaction('rw', d.messages, d.conversations, d.usage, d.settings, async () => {
    const latest = await d.messages.where('conversationId').equals(c.id).sortBy('seq');
    if (latest.at(-1)?.id !== last.at(-1)?.id) return;
    await persistDialogue(
      d,
      c.id,
      candidate,
      generated.messages,
      at,
      'ai',
      uid('reply'),
      undefined,
      generated.offsets,
    );
  });
}
export async function generateProfile(input: unknown, d: AquariumDB = db, provider?: Provider) {
  const snap = await getPrompts(d);
  const p = provider ?? (await liveProvider(d));
  const r = await budgetedCompletion(
    d,
    p,
    composePrompt(
      'profile',
      snap,
      { input },
      '返回 JSON：{"bio":"...","personality":"...","style":"...","habits":"...","uncertain":"不确定的信息及事实来源说明"}。性别 gender 可选，仅作为用户确认前的建议；不推测未知性别。全部字段是字符串，不改变关系。',
    ),
    'global',
    'profile',
    snap,
  );
  return z
    .object({
      gender: z.string().max(200).optional(),
      bio: z.string().max(3000),
      personality: z.string().max(3000),
      style: z.string().max(3000),
      habits: z.string().max(3000),
      uncertain: z.string().max(3000),
    })
    .parse(parseStructuredJSON(r.content));
}
export async function describeEvent(
  d: AquariumDB,
  event: ActivityEvent,
  snapshot: PromptConfig,
  provider: Provider,
  recovery: boolean,
  signal?: AbortSignal,
) {
  const world = await d.worlds.get(event.worldId);
  const input = composePrompt(
    recovery ? 'recovery' : 'life',
    snapshot,
    {
      world,
      state: {
        ...event,
        localStart: world ? formatWorldTime(world, event.start) : '',
      },
    },
    '仅返回 JSON {"description":"一句客观的活动描述"}。禁止改变已有活动时间、地点、人物和类型，不生成对白。描述不添加未给出的行动细节，不猜测上午/午后等时段，遵守 localStart。',
  );
  const r = await budgetedCompletion(
    d,
    provider,
    input,
    event.worldId,
    recovery ? 'recovery' : 'life',
    snapshot,
    signal,
  );
  const v = z
    .object({ description: z.string().min(1).max(200) })
    .strict()
    .parse(parseStructuredJSON(r.content));
  return { ...event, description: v.description };
}
export async function consolidateMemory(
  conversationId: string,
  d: AquariumDB = db,
  provider?: Provider,
) {
  const c = await d.conversations.get(conversationId);
  if (!c) return;
  const snapshot = await getPrompts(d);
  const history = await d.messages.where('conversationId').equals(c.id).sortBy('seq');
  if (history.length < 4) throw new Error('至少有 4 条消息后再整理记忆。');
  const last = history.at(-1)!;
  const id = `summary:${c.id}:${last.seq}`;
  if (await d.memories.get(id)) return;
  const r = await budgetedCompletion(
    d,
    provider ?? (await liveProvider(d)),
    composePrompt(
      'memory',
      snapshot,
      {
        history: history
          .slice(-30)
          .map((m) => ({ speakerId: m.senderId, text: m.text, at: m.simAt, source: m.source })),
        input: { owners: c.participants },
      },
      '只返回 JSON {"content":"事实摘要"}，不增加输入记录之外的事实。',
    ),
    'global',
    'memory',
    snapshot,
  );
  const v = z
    .object({ content: z.string().min(1).max(1800) })
    .strict()
    .parse(parseStructuredJSON(r.content));
  await d.memories.put({
    id,
    worldId: c.worldId,
    owners: c.participants,
    content: v.content,
    keywords: [],
    importance: 0.8,
    at: last.simAt,
    conversationId: c.id,
    kind: 'summary',
  });
}

export async function knownBackground(d: AquariumDB, worldId: string, characterId: string) {
  const records = await d.backgroundKnowledge
    .where('worldId')
    .equals(worldId)
    .and((k) => k.characterId === characterId && k.level !== 'unknown')
    .toArray();
  return Promise.all(
    records.map(async (k) => {
      const entity = (await d.characters.get(k.entityId)) ?? (await d.groups.get(k.entityId));
      return {
        entityId: k.entityId,
        name: entity?.name,
        level: k.level,
        information:
          k.level === 'name'
            ? []
            : k.items.map((item) => ({
                ...item,
                kind: item.kind === 'falseRumor' ? 'rumor' : item.kind,
              })),
      };
    }),
  );
}
