import { dayOrdinal, worldTime } from '../core/calendar';
import { assertConversationLife, canLiveAt, actorAvailable } from '../core/narrative';
import {
  requestCost,
  reserveCost,
  requestEntities,
  requestVirtualAt,
  budgetWorldDay,
  recordOutcome,
  recordValidation,
} from './usage-ledger';
import type { UsageLedger } from '../core/usage-types';
import { isSupportedReaction, reactionEmojiGroups } from '../core/reaction-emojis';
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from '../core/ai-limits';
import { conversationAvailable } from '../data/chat';
import { evolvedCharacter, historicalCharacter } from '../core/selective-observation';
import { completedField } from './structured';
import { validateMessageExtras } from '../data/chat';
import { availableGifs } from '../data/gifs';
import { clockTarget } from '../core/time';
import { foregroundStart } from '../core/clock-presence';
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
    mentionTargets: z
      .array(
        z
          .object({ messageIndex: z.number().int().min(0).max(2), characterId: z.string() })
          .strict(),
      )
      .max(12)
      .optional(),
    reactions: z
      .array(
        z.object({ messageId: z.string(), emoji: z.string().refine(isSupportedReaction) }).strict(),
      )
      .max(3)
      .optional(),
    replyToMessageId: z.string().optional(),
    gifAssetId: z.string().optional(),
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
    (!rules.allowSilence && !r.gifAssetId && !r.reactions?.length && r.messages.length < min) ||
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
  if (r.gifAssetId && !r.messages.length) r.messages = ['[GIF]'];
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
    .map((x) => ({
      id: x.m.id,
      eventId: x.m.eventId,
      content: x.m.content,
      knownBy: x.m.owners,
      at: x.m.at,
    }));
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
  options?: {
    outputBudget?: number;
    tightContext?: boolean;
    priority?: number;
    virtualAt?: number;
    capabilityFallback?: boolean;
    retryOf?: string;
    attempt?: number;
  },
): Promise<Completion> {
  if (signal?.aborted) throw new ProviderError('cancelled', '任务已取消');
  const usageId = dayKey(Date.now());
  const profile = await d.profiles.get('api');
  const packed = packRequest(
    messages,
    task,
    profile?.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
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
  const logId = uid('request'),
    policy = provider.describe?.(task),
    now = Date.now();
  const row: UsageLedger = {
    id: logId,
    worldId,
    task,
    model: policy?.model ?? profile?.model ?? 'unknown',
    ...requestEntities(messages),
    virtualAt:
      options?.virtualAt ??
      requestVirtualAt(messages) ??
      (await d.checkpoints.get(worldId))?.simTime,
    startedAt: now,
    status: 'running',
    thinking: policy?.thinking ?? 'unknown',
    effort: policy?.effort,
    estimated: false,
    retryOf: options?.retryOf,
    attempt: options?.attempt ?? 0,
    costQuality: 'unknown',
    completedTaskIds: [],
    events: 0,
    messages: 0,
    dialogue: 0,
  };
  const clockWorld = await d.worlds.get(worldId);
  if (clockWorld && row.virtualAt !== undefined)
    row.virtualDay = dayOrdinal(worldTime(clockWorld, row.virtualAt));
  row.budgetVirtualDay = await budgetWorldDay(d, worldId, now);
  row.pricing = (await d.settings.get('app'))?.costControls?.prices.find(
    (p) => p.model === row.model,
  );
  await d.transaction('rw', d.usage, d.settings, d.usageLedger, async () => {
    try {
      await reserveCost(d, row, estimatedInput, reservedOutput);
    } catch (e) {
      const error = new ProviderError('budget', e instanceof Error ? e.message : String(e));
      error.budgetDay = row.budgetVirtualDay;
      throw error;
    }

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
    await d.usageLedger.add(row);
    await d.usage.put({
      ...u,
      requests: u.requests + 1,
      inputTokens: u.inputTokens + estimatedInput,
      outputTokens: u.outputTokens + reservedOutput,
      estimated: true,
    });
  });
  await d.taskLogs.add({
    id: logId,
    worldId,
    task,
    promptVersion: snapshot.version,
    at: Date.now(),
    status: 'running',
    context: packed.report,
  });
  let sent = false;
  try {
    const result = await withAISlot(
      async () => {
        await d.usageLedger.update(logId, { sentAt: Date.now() });
        sent = true;
        return provider.complete(packed.messages, signal, {
          maxOutputTokens: reservedOutput,
          task,
        });
      },
      signal,
      options?.priority ?? 0,
    );
    const accounting =
      result.accounting ??
      (result.estimated
        ? {}
        : { inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    const priced = requestCost(accounting, row.pricing);
    await d.usageLedger.update(logId, {
      ...accounting,
      ...priced,
      estimated: result.estimated,
      endedAt: Date.now(),
      status: result.finishReason === 'length' ? 'truncated' : 'success',
      reservedCny: priced.costCny === undefined ? row.reservedCny : undefined,
      thinking: result.policy?.thinking ?? row.thinking,
      effort: result.policy?.effort ?? row.effort,
    });
    result.requestId = logId;
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
    if (e instanceof ProviderError) e.requestId = logId;
    const reported = e instanceof ProviderError ? e.accounting : undefined;
    const failedAccounting = !sent ? { inputTokens: 0, outputTokens: 0 } : (reported ?? {});
    const failedPrice = requestCost(failedAccounting, row.pricing);
    if (reported || !sent)
      await d.transaction('rw', d.usage, async () => {
        const u = await d.usage.get(usageId);
        if (u)
          await d.usage.update(usageId, {
            inputTokens: Math.max(
              0,
              u.inputTokens - estimatedInput + (failedAccounting.inputTokens ?? estimatedInput),
            ),
            outputTokens: Math.max(
              0,
              u.outputTokens - reservedOutput + (failedAccounting.outputTokens ?? reservedOutput),
            ),
          });
      });
    await d.usageLedger.update(logId, {
      ...failedAccounting,
      ...failedPrice,
      reservedCny: !sent || failedPrice.costCny !== undefined ? undefined : row.reservedCny,
      status: 'failed',
      endedAt: Date.now(),
      errorCode: e instanceof ProviderError ? e.code : 'unknown',
    });
    await d.taskLogs.update(logId, { status: 'failed' });
    if (
      e instanceof ProviderError &&
      e.code === 'unsupported-thinking' &&
      provider.disableReasoning &&
      !options?.capabilityFallback
    ) {
      provider.disableReasoning(row.model);
      if (profile)
        await d.profiles.update('api', {
          unsupportedThinkingModels: [
            ...new Set([...(profile.unsupportedThinkingModels ?? []), row.model]),
          ].slice(-64),
        });
      return budgetedCompletion(d, provider, messages, worldId, task, snapshot, signal, {
        ...options,
        retryOf: logId,
        attempt: (options?.attempt ?? 0) + 1,
        capabilityFallback: true,
      });
    }
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
  await assertConversationLife(c, at, d);
  const original = c;
  const eligible = await Promise.all(
    c.participants.map(async (id) => ((await actorAvailable(c, id, at, d)) ? id : undefined)),
  );
  c = { ...c, participants: eligible.filter((id): id is string => !!id) };
  if (!c.participants.includes(speakerId)) throw new Error('该人物当前不能参与普通交流');
  const [character, world, membership, relationships, memories, history, state, settings] =
    await Promise.all([
      d.characters.get(speakerId),
      d.worlds.get(c.worldId),
      d.memberships.where('[worldId+characterId]').equals([c.worldId, speakerId]).first(),
      d.relationships.where('worldId').equals(c.worldId).toArray(),
      d.memories
        .where('owners')
        .equals(speakerId)
        .and((m) => m.worldId === c.worldId && m.at <= at)
        .toArray(),
      d.messages.where('conversationId').equals(c.id).sortBy('seq'),
      d.states.get(`${c.worldId}:${speakerId}`),
      d.settings.get('app'),
    ]);
  const narrativeHistory =
    !!membership?.life ||
    !!(c.groupId && (await d.organizationStates.get(`${c.worldId}:${c.groupId}`)));
  const permittedHistory = narrativeHistory ? [] : history;
  if (narrativeHistory)
    for (const m of history.slice(-48))
      if (await actorAvailable(original, speakerId, m.simAt, d)) permittedHistory.push(m);
  const recent = permittedHistory
    .filter((m) => m.simAt <= at && m.simAt >= (c.participantJoinedAt?.[speakerId] ?? 0))
    .sort((a, b) => a.simAt - b.simAt || a.seq - b.seq)
    .slice(-18);
  const aliases = await d.characters.where('id').anyOf(c.participants).toArray();
  const effective = character
    ? await historicalCharacter(d, character, membership, c.worldId, at)
    : undefined;
  return {
    world,
    character: {
      ...effective,
      bio: membership?.bioOverride || character?.bio,
      style: membership?.styleOverride || effective?.style,
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
      id: m.id,
      speakerId: m.senderId,
      text: m.text,
      at: m.simAt,
      source: m.source,
      mentionCharacterIds: m.mentionCharacterIds,
      replyToMessageId: m.replyToMessageId,
      messageType: m.messageType,
      gifAssetId: m.gifAssetId,
    })),
    state,
    input: {
      conversationKind: c.kind,
      conversationId: c.id,
      groupId: c.groupId,
      availableReactionEmojis: reactionEmojiGroups[0].emojis,
      participants: aliases.map((x) => ({ id: x.id, name: x.name })),
      user: { id: 'user', name: settings?.nickname, bio: settings?.userBio },
      simTime: at,
      localTime: world ? formatWorldTime(world, at) : '',
      availableGifs: (await availableGifs(c, speakerId, d)).slice(0, 16).map((a) => ({
        id: a.id,
        name: a.name,
        tags: a.tags.slice(0, 4),
        description: Array.from(a.description).slice(0, 160).join(''),
      })),
      replyContext: recent.at(-1)?.replyToMessageId
        ? await d.messages.get(recent.at(-1)!.replyToMessageId!)
        : undefined,
      backgroundKnowledge: await knownBackground(d, c.worldId, speakerId, at),
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
  if (c.kind === 'notes') throw new ProviderError('identity', '备忘会话不可用作 AI 对话');
  await assertConversationLife(c, at, d);
  if (!(await conversationAvailable(c, d, at)))
    throw new ProviderError('identity', '会话对象不可用或已移入回收站');
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
  const accept = async (answer: Completion, retried = false) => {
    try {
      if (answer.finishReason === 'length')
        throw new ProviderError(
          'truncated',
          retried
            ? '已压缩上下文并重试一次，模型仍超出输出预算。你的消息已保留，可在 AI 高级设置调整输出预算后重试。'
            : '模型输出额度不足，正在压缩后重试。',
        );
      const value = await validateGenerated(
        d,
        c,
        at,
        parseDialogue(answer.content, speakerId, snapshot),
      );
      await recordValidation(d, answer.requestId, 'accepted');
      return { ...value, usageRequestId: answer.requestId };
    } catch (e) {
      await recordValidation(
        d,
        answer.requestId,
        'rejected',
        e instanceof ProviderError ? e.code : 'validation',
      );
      throw e;
    }
  };
  try {
    return await accept(response);
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
        retryOf: response.requestId,
        attempt: 1,
        tightContext: true,
        outputBudget: Math.min(
          16000,
          Math.max(2048, (await d.profiles.get('api'))?.outputBudgetTokens ?? 2048) * 2,
        ),
      },
    );
    return await accept(repaired, true);
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
  extras: Partial<Message> & {
    usageRequestId?: string;
    gifMessageIndex?: number;
    mentionTargets?: { messageIndex: number; characterId: string }[];
    reactions?: { messageId: string; emoji: string }[];
  } = {},
) {
  const candidate = await d.conversations.get(conversationId);
  if (
    !candidate ||
    !candidate.participants.includes(speakerId) ||
    candidate.controlledId === speakerId
  )
    return [];
  if (source !== 'user') {
    await assertConversationLife(candidate, at, d);
    if (!(await actorAvailable(candidate, speakerId, at, d)))
      throw new Error('该人物不能参与当前互动');
  }
  return d.transaction(
    'rw',
    [
      d.messages,
      d.conversations,
      d.usageLedger,
      d.usage,
      d.settings,
      ...(extras.mentionTargets?.length ? [d.characters] : []),
      ...(extras.reactions?.length ? [d.reactions] : []),
    ],
    async () => {
      const c = await d.conversations.get(conversationId);
      if (!c || !c.participants.includes(speakerId) || c.controlledId === speakerId) return [];
      if (await d.messages.get(`${prefix}:0`)) return [];
      const existing = await d.messages
        .where('conversationId')
        .equals(conversationId)
        .sortBy('seq');
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
        backfilled: extras.backfilled,
        planVersion: extras.planVersion,
        replyToMessageId: extras.replyToMessageId,
        gifAssetId: i === (extras.gifMessageIndex ?? 0) ? extras.gifAssetId : undefined,
        messageType: i === (extras.gifMessageIndex ?? 0) && extras.gifAssetId ? 'gif' : 'text',
      }));
      for (const m of messages) {
        const i = messages.indexOf(m);
        const mentions: NonNullable<Message['mentions']> = [];
        for (const target of extras.mentionTargets ?? []) {
          if (
            target.messageIndex !== i ||
            c.kind !== 'group' ||
            target.characterId === speakerId ||
            !c.participants.includes(target.characterId)
          )
            continue;
          const char = await d.characters.get(target.characterId);
          if (!char || char.deletedAt) continue;
          const label = '@' + char.name;
          let start = m.text.indexOf(label);
          while (start >= 0) {
            if (!mentions.some((x) => x.start === start))
              mentions.push({ characterId: char.id, label, start, end: start + label.length });
            start = m.text.indexOf(label, start + label.length);
          }
        }
        m.mentions = mentions.sort((a, b) => a.start - b.start);
        m.mentionCharacterIds = [...new Set(mentions.map((x) => x.characterId))];
      }
      if (messages.some((m) => m.simAt < (last?.simAt ?? 0)) && !extras.backfilled) return [];
      // A reaction-only response is valid; stable IDs make task replay idempotent.
      for (const reaction of extras.reactions ?? []) {
        const target = await d.messages.get(reaction.messageId);
        if (
          !target ||
          target.conversationId !== c.id ||
          target.simAt > at ||
          target.simAt < (c.participantJoinedAt?.[speakerId] ?? 0) ||
          target.senderId === speakerId ||
          !isSupportedReaction(reaction.emoji)
        )
          continue;
        const id = `reaction:${target.id}:${speakerId}:${reaction.emoji}`;
        const duplicate = await d.reactions
          .where('messageId')
          .equals(target.id)
          .and((r) => r.actorId === speakerId && r.emoji === reaction.emoji)
          .first();
        if (!duplicate)
          await d.reactions.put({
            id,
            messageId: target.id,
            actorId: speakerId,
            emoji: reaction.emoji,
            reactedAt: at,
          });
      }
      if (!messages.length) return [];
      await recordOutcome(d, extras.usageRequestId, prefix, { messages: messages.length });
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
        source !== 'demo' &&
        usage.messages + messages.length > settings.dailyMessages
      )
        throw new ProviderError('budget', '今日消息生成上限已用完。');
      await d.messages.bulkAdd(messages);
      await d.conversations.update(conversationId, {
        lastAt: Math.max(c.lastAt, messages.at(-1)!.simAt),
      });
      await d.usage.put({
        ...usage,
        messages: usage.messages + (source === 'demo' ? 0 : messages.length),
      });
      return messages;
    },
  );
}
export async function sendUserMessage(
  conversationId: string,
  text: string,
  identity = 'user',
  d: AquariumDB = db,
  extras: Partial<Message> = {},
) {
  if (!(await conversationAvailable(conversationId, d)))
    throw new Error('会话对象不可用或已移入回收站');
  if (identity !== 'user' && (await d.characters.get(identity))?.entityMode === 'background')
    throw new Error('请先将背景人物转为可互动角色');
  if (!text.trim() || Array.from(text).length > 2000)
    throw new Error('消息不能为空或超过 2000 字。');
  await withWorldLock(
    'interaction',
    () =>
      d.transaction(
        'rw',
        [
          d.conversations,
          d.messages,
          d.checkpoints,
          d.cursors,
          d.gifAssets,
          d.groups,
          d.memberships,
          d.groupMembers,
        ],
        async () => {
          const c = await d.conversations.get(conversationId);
          if (!c) throw new Error('会话不存在');
          if (identity !== 'user' && c.controlledId !== identity)
            throw new Error('请先切换角色身份');
          if (
            identity !== 'user' &&
            !(await canLiveAt(
              c.worldId,
              identity,
              (await d.checkpoints.get(c.worldId))?.simTime ?? Date.now(),
              d,
            ))
          )
            throw new Error('该人物当前不能以存活身份发送消息');
          const metadata = await validateMessageExtras(d, conversationId, text, extras);
          if (
            extras.gifAssetId &&
            !(await availableGifs(c, identity, d)).some((a) => a.id === extras.gifAssetId)
          )
            throw new Error('无权使用此表情');
          const last = await d.messages.where('conversationId').equals(c.id).sortBy('seq');
          const cp = await d.checkpoints.get(c.worldId);
          const at = Math.max(
            cp ? clockTarget(cp, Date.now(), foregroundStart()) : Date.now(),
            last.at(-1)?.simAt ?? 0,
          );
          await d.messages.add({
            id: uid('user'),
            conversationId,
            senderId: identity,
            text: text.trim(),
            seq: (last.at(-1)?.seq ?? 0) + 1,
            realAt: Date.now(),
            simAt: at,
            source: 'user',
            ...metadata,
            messageType: extras.gifAssetId ? 'gif' : 'text',
            gifAssetId: extras.gifAssetId,
          });
          await d.conversations.update(c.id, { lastAt: at });
        },
      ),
    true,
  );
}
export async function replyToUser(conversationId: string, d: AquariumDB = db) {
  const c = await d.conversations.get(conversationId);
  if (!c || c.kind === 'notes' || !(await conversationAvailable(c.id, d))) return;
  if (
    await d.contentJobs
      .where('worldId')
      .equals(c.worldId)
      .and((j) => j.kind === 'chat' && j.conversation?.id === c.id && j.status !== 'complete')
      .first()
  )
    throw new Error('这段会话的较早内容正在补全；你的消息已保存，补全后可继续回复。');
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
  const candidate = eligible
    .filter((id) => id !== last.at(-1)?.senderId)
    .sort(
      (a, b) =>
        Number(last.at(-1)?.mentionCharacterIds?.includes(b)) -
        Number(last.at(-1)?.mentionCharacterIds?.includes(a)),
    )[0];
  if (!candidate) return;
  const at = Math.max(cp?.simTime ?? Date.now(), (last.at(-1)?.simAt ?? 0) + 1000);
  const generated = await generateDialogue(d, c, candidate, at, snapshot, provider);
  await d.transaction(
    'rw',
    [
      d.messages,
      d.reactions,
      d.conversations,
      d.usage,
      d.settings,
      d.characters,
      d.groups,
      d.worlds,
      d.memberships,
      d.checkpoints,
      d.organizationStates,
      d.narrativeChanges,
      d.usageLedger,
    ],
    async () => {
      if (!(await conversationAvailable(c.id, d))) return;
      const current = await d.checkpoints.get(c.worldId);
      if ((current?.controlVersion ?? 0) !== (cp?.controlVersion ?? 0)) return;
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
        generated,
      );
    },
  );
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
  let raw: unknown;
  try {
    raw = parseStructuredJSON(r.content);
  } catch {
    const values = Object.fromEntries(
      ['gender', 'bio', 'personality', 'style', 'habits', 'uncertain']
        .map((key) => [key, completedField(r.content, key)])
        .filter(([, value]) => typeof value === 'string'),
    );
    if (!Object.keys(values).length)
      throw new Error('资料响应没有完整可用字段，已有表单保留，请重试或手动补充。');
    raw = {
      ...values,
      uncertain: String(values.uncertain ?? '') + '（输出未完成，仅保留完整字段；其余待补充。）',
    };
  }
  return z
    .object({
      gender: z.string().max(200).optional(),
      bio: z.string().max(3000).default(''),
      personality: z.string().max(3000).default(''),
      style: z.string().max(3000).default(''),
      habits: z.string().max(3000).default(''),
      uncertain: z.string().max(3000).default(''),
    })
    .parse(raw);
}
export async function describeEvent(
  d: AquariumDB,
  event: ActivityEvent,
  snapshot: PromptConfig,
  provider: Provider,
  recovery: boolean,
  signal?: AbortSignal,
) {
  if ((await d.settings.get('app'))?.costControls?.localDescriptions) return event;
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
  if (!c || c.kind === 'notes' || !(await conversationAvailable(c.id, d))) return;
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
    c.worldId,
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

export async function knownBackground(
  d: AquariumDB,
  worldId: string,
  characterId: string,
  at = Number.MAX_SAFE_INTEGER,
) {
  const records = await d.backgroundKnowledge
    .where('worldId')
    .equals(worldId)
    .and((k) => k.characterId === characterId && k.level !== 'unknown' && (k.knownAt ?? 0) <= at)
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
            : k.items
                .filter((item) => (item.learnedAt ?? 0) <= at)
                .map((item) => ({
                  ...item,
                  kind: item.kind === 'falseRumor' ? 'rumor' : item.kind,
                })),
      };
    }),
  );
}

export async function validateGenerated(
  d: AquariumDB,
  c: Conversation,
  at: number,
  r: ReturnType<typeof parseDialogue>,
) {
  let visible = (await d.messages.where('conversationId').equals(c.id).toArray())
    .filter((m) => m.simAt <= at && m.simAt >= (c.participantJoinedAt?.[r.speakerId] ?? 0))
    .sort((a, b) => a.simAt - b.simAt || a.seq - b.seq)
    .slice(-18);
  const m = await d.memberships
    .where('[worldId+characterId]')
    .equals([c.worldId, r.speakerId])
    .first();
  if (m?.life || (c.groupId && (await d.organizationStates.get(`${c.worldId}:${c.groupId}`)))) {
    const accessible = [];
    for (const item of visible)
      if (await actorAvailable(c, r.speakerId, item.simAt, d)) accessible.push(item);
    visible = accessible;
  }
  for (const target of r.mentionTargets ?? []) {
    const char = await d.characters.get(target.characterId);
    if (
      c.kind !== 'group' ||
      target.characterId === r.speakerId ||
      !c.participants.includes(target.characterId) ||
      !(await actorAvailable(c, target.characterId, at, d)) ||
      !char ||
      char.deletedAt ||
      !r.messages[target.messageIndex]?.includes('@' + char.name)
    )
      throw new ProviderError('schema', '提及对象或对应消息不合法');
  }
  for (const reaction of r.reactions ?? []) {
    if (!visible.some((m) => m.id === reaction.messageId && m.senderId !== r.speakerId))
      throw new ProviderError('schema', '回应对象不在角色可见的当前历史中');
  }
  if (r.replyToMessageId) {
    const m = await d.messages.get(r.replyToMessageId);
    if (
      !m ||
      m.conversationId !== c.id ||
      m.simAt > at ||
      (!(await actorAvailable(c, r.speakerId, m.simAt, d)) &&
        !visible.some((v) => v.replyToMessageId === m.id))
    )
      throw new ProviderError('schema', '引用对象不存在或不在当前会话');
  }
  if (r.gifAssetId && !(await availableGifs(c, r.speakerId, d)).some((a) => a.id === r.gifAssetId))
    throw new ProviderError('schema', '无权使用模型选择的GIF');
  return r;
}
