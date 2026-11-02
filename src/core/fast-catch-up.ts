import { z } from 'zod';
import Dexie from 'dexie';
import { db, withWorldLock, type AquariumDB } from '../data/db';
import { budgetedCompletion, liveProvider } from '../ai/orchestrator';
import { composePrompt, getPrompts, type PromptConfig } from '../ai/prompts';
import { parseStructuredJSON } from '../ai/structured';
import { ProviderError, type Provider } from '../ai/provider';
import { drainContent } from '../ai/content-queue';
import { startWorldTask } from './tasks';
import {
  evolvedCharacter,
  observationKeys,
  recordCoverage,
  resolveObservation,
} from './selective-observation';
import { directConversationId } from './engine';
import { noteWorldHasScenes, sceneRecapMemory } from './storyline';
import { calendarLimit, formatWorldTime } from './calendar';
import {
  DAY,
  HOUR,
  uid,
  type ActivityEvent,
  type Character,
  type Message,
  type Conversation,
  type InPersonScene,
  type Checkpoint,
} from './types';

export interface FastCatchUpProgress {
  worldId: string;
  offline?: boolean;
  from: number;
  to: number;
  at: number;
  events: number;
  messages: number;
  stage: string;
}
export interface FastCatchUpOptions {
  provider?: Provider;
  signal?: AbortSignal;
  now?: number;
  onProgress?: (progress: FastCatchUpProgress) => void;
}

const FAST_WINDOW = 7 * DAY;
const MIN_SPLIT = 2 * HOUR;
const MAX_EVENTS = 48;
const MAX_CHATS = 32;
const MAX_SCENES = 10;

const EventRow = z.object({
  at: z.number().min(0),
  duration: z.number().min(1).max(720).default(30),
  participants: z.array(z.string()).min(1).max(8),
  location: z.string().max(120).default(''),
  type: z.enum(['sleep', 'work', 'meal', 'rest', 'out', 'social']).default('rest'),
  description: z.string().max(500).default(''),
  importance: z.number().min(0).max(1).optional(),
});
const ChatRow = z.object({
  at: z.number().min(0),
  eventIndex: z.number().int().min(0).optional(),
  participants: z.array(z.string()).min(1).max(8),
  messages: z
    .array(
      z.object({
        speakerId: z.string(),
        text: z.string().min(1).max(1000),
        offset: z.number().min(0).max(600).optional(),
      }),
    )
    .min(1)
    .max(3),
});
const SceneRow = z.object({
  eventIndex: z.number().int().min(0),
  title: z.string().min(1).max(200),
  type: z.string().max(80).optional(),
  phases: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        entries: z
          .array(
            z.object({
              kind: z.enum(['dialogue', 'activity']),
              speakerId: z.string().optional(),
              text: z.string().min(1).max(1000),
            }),
          )
          .min(1)
          .max(24),
      }),
    )
    .min(1)
    .max(8),
});
const CatchUpSchema = z.object({
  events: z.array(EventRow).max(MAX_EVENTS).default([]),
  chats: z.array(ChatRow).max(MAX_CHATS).default([]),
  scenes: z.array(SceneRow).max(MAX_SCENES).default([]),
});
type CatchUpPayload = z.infer<typeof CatchUpSchema>;

function retryable(error: unknown) {
  if (!(error instanceof ProviderError))
    return error instanceof SyntaxError || error instanceof z.ZodError;
  return ['json', 'schema', 'truncated', 'length'].includes(error.code);
}

function durationMinutes(from: number, to: number) {
  return Math.max(1, Math.round((to - from) / 60000));
}

/**
 * One opt-in agent handles the entire jump window (and then any leftover content backlog).
 * It is deliberately separate from the per-segment scheduler: a single large request receives
 * the world state and returns a compact, complete slice of events, chats and scenes.
 */
export async function runFastCatchUp(
  worldId: string,
  options: FastCatchUpOptions = {},
  d: AquariumDB = db,
) {
  return withWorldLock(
    worldId,
    async () => {
      const task = startWorldTask(worldId, options.signal);
      options = { ...options, signal: task.signal };
      try {
        let cp = await d.checkpoints.get(worldId);
        const world = await d.worlds.get(worldId);
        if (!cp || !world || world.deletedAt) return;
        if (cp.paused) return;
        const version = cp.controlVersion ?? 0;
        const provider = options.provider ?? (await liveProvider(d));
        const target = cp.recoveryTarget;
        if (target && target <= cp.simTime) {
          await finishCatchUp(d, cp, options.now);
          cp = (await d.checkpoints.get(worldId))!;
        }
        if (target && target > cp.simTime) {
          const snapshot = await fastSnapshot(d, worldId);
          const endTarget = Math.min(target, calendarLimit(world));
          let cursor = cp.simTime;
          while (cursor < endTarget) {
            if (options.signal?.aborted) break;
            const end = Math.min(endTarget, cursor + FAST_WINDOW);
            await applyWindow(worldId, cursor, end, 0, snapshot, version, provider, options, d);
            cursor = end;
            cp = (await d.checkpoints.get(worldId))!;
          }
          const latest = await d.checkpoints.get(worldId);
          if (latest?.recoveryTarget && latest.recoveryTarget <= latest.simTime)
            await finishCatchUp(d, latest, options.now);
        }
        // A queue can predate this mode. Drain it aggressively instead of waiting for the
        // one-per-second foreground tick, while still reusing the normal validated batches.
        await drainBacklog(worldId, provider, options, d);
      } finally {
        task.done();
      }
    },
    true,
  );
}

async function fastSnapshot(d: AquariumDB, worldId: string) {
  const stored = await d.taskSnapshots.get(worldId);
  return stored?.config ?? (await getPrompts(d));
}

async function applyWindow(
  worldId: string,
  start: number,
  end: number,
  depth: number,
  snapshot: PromptConfig,
  version: number,
  provider: Provider,
  options: FastCatchUpOptions,
  d: AquariumDB,
): Promise<void> {
  try {
    const payload = await requestWindow(worldId, start, end, snapshot, provider, options, d);
    await writeWindow(worldId, start, end, payload, snapshot, version, d);
  } catch (error) {
    if (!retryable(error) || end - start <= MIN_SPLIT || depth >= 2 || options.signal?.aborted)
      throw error;
    // Truncated or malformed output: keep the same agent, but give it a narrower window.
    const mid = start + Math.floor((end - start) / 2 / 60000) * 60000;
    await applyWindow(worldId, start, mid, depth + 1, snapshot, version, provider, options, d);
    await applyWindow(worldId, mid, end, depth + 1, snapshot, version, provider, options, d);
  }
}

async function requestWindow(
  worldId: string,
  start: number,
  end: number,
  snapshot: PromptConfig,
  provider: Provider,
  options: FastCatchUpOptions,
  d: AquariumDB,
): Promise<CatchUpPayload> {
  const scope = await resolveObservation(worldId, d);
  const world = (await d.worlds.get(worldId))!;
  const members = await d.memberships.where('worldId').equals(worldId).toArray();
  const byId = new Map(members.map((m) => [m.characterId, m]));
  const active = await d.characters.bulkGet([...scope.activeIds]);
  const characters = active
    .filter((c): c is Character => !!c && !c.deletedAt && c.entityMode !== 'background')
    .slice(0, 80)
    .map((c) => {
      const evolved = evolvedCharacter(c, byId.get(c.id), !!world.evolutionSettings?.enabled);
      return {
        id: evolved.id,
        name: evolved.name,
        bio: evolved.bio.slice(0, 180),
        personality: evolved.personality.slice(0, 120),
        style: evolved.style.slice(0, 120),
        habits: evolved.habits.slice(0, 120),
        initiative: evolved.initiative,
        tags: evolved.tags.slice(0, 8),
      };
    });
  const ids = new Set(characters.map((c) => c.id));
  const relationships = (await d.relationships.where('worldId').equals(worldId).toArray())
    .filter((r) => ids.has(r.from) && ids.has(r.to))
    .slice(0, 180)
    .map((r) => ({
      from: r.from,
      to: r.to,
      label: r.label,
      closeness: r.closeness,
      trust: r.trust,
      familiarity: r.familiarity,
      stage: r.stage,
    }));
  const recentEvents = (
    await d.events
      .where('[worldId+start]')
      .between([worldId, start - 3 * DAY], [worldId, start], true, true)
      .reverse()
      .limit(36)
      .toArray()
  ).map((e) => ({
    at: formatWorldTime(world, e.start),
    participants: e.participants,
    location: e.location,
    description: e.description,
    type: e.type,
  }));
  const conversations = await d.conversations
    .where('participants')
    .anyOf([...scope.activeIds])
    .and((c) => c.worldId === worldId && c.kind !== 'notes' && c.createdAt <= start)
    .limit(48)
    .toArray();
  const recentChats: unknown[] = [];
  for (const c of conversations) {
    const rows = await d.messages
      .where('[conversationId+seq]')
      .between([c.id, Dexie.minKey], [c.id, Dexie.maxKey])
      .and((m) => m.simAt <= start)
      .reverse()
      .limit(4)
      .toArray();
    if (!rows.length) continue;
    recentChats.push({
      participants: c.participants,
      messages: rows.reverse().map((m) => ({
        at: formatWorldTime(world, m.simAt),
        speakerId: m.senderId,
        text: m.text,
      })),
    });
    if (recentChats.length >= 12) break;
  }
  const days = Math.max(0.1, (end - start) / DAY);
  const maxEvents = Math.min(MAX_EVENTS, Math.max(2, Math.ceil(days * 8)));
  const maxChats = Math.min(MAX_CHATS, Math.max(1, Math.ceil(days * 6)));
  const maxScenes = Math.min(MAX_SCENES, Math.max(0, Math.ceil(days * 2)));
  const context = {
    world: {
      name: world.name,
      description: world.description,
      rules: world.rules,
      era: world.era,
      locations: world.locations,
      from: formatWorldTime(world, start),
      to: formatWorldTime(world, end),
      durationMinutes: durationMinutes(start, end),
    },
    characters,
    relationships,
    history: recentChats,
    memories: [],
    input: {
      task: 'fastCatchUp',
      maxEvents,
      maxChats,
      maxScenes,
      timezone: world.timezone,
    },
  };
  const contract = `只返回一个 JSON 对象，不要 Markdown、解释或额外文本。格式：
{"events":[{"at":0,"duration":30,"participants":["角色ID"],"location":"地点","type":"rest|work|meal|out|social","description":"一句客观描述","importance":0.5}],"chats":[{"at":10,"eventIndex":0,"participants":["角色ID"],"messages":[{"speakerId":"角色ID","text":"短消息","offset":0}]}],"scenes":[{"eventIndex":0,"title":"场景短标题","type":"meal","phases":[{"title":"阶段标题","entries":[{"kind":"dialogue","speakerId":"角色ID","text":"对白"},{"kind":"activity","text":"活动描述"}]}]}]}
要求：
- at 是从开始时间起的分钟偏移，0～${durationMinutes(start, end)}；duration 为分钟。
- 只使用 characters 中的角色 ID；多角色事件必须都在 characters 中，且地点来自 world.locations 或自然合理。
- events 覆盖整段时间，先安排日常，再安排少量社交；最多 ${maxEvents} 条，可少但不要只写一两条。
- chats 最多 ${maxChats} 段，每段最多 3 条短消息，符合人物关系、口吻和当前时间；消息不要写成小作文。
- eventIndex 指向同一响应 events 数组的下标；scenes 最多 ${maxScenes} 段，仅用于多人事件，阶段内对白保持简短。
- 严格按时间顺序，不重复既有历史，不凭空让角色知道未发生的事；不需要对每条消息都回复。
- 同一 eventIndex 的 chats 与 scenes 必须组成一条连贯剧情线：线上先说过的约定、地点或情绪，线下场景要自然承接；线下场景发生后，可以再有一条线上回味。没有铺垫时不要硬造巧合。
- 输出必须能直接 JSON.parse，字段名和结构固定。`;
  options.onProgress?.({
    worldId,
    offline: true,
    from: start,
    to: end,
    at: start,
    events: 0,
    messages: 0,
    stage: '单 Agent 正在一次性补全整段时间',
  });
  const messages = composePrompt('recovery', snapshot, context, contract);
  const result = await budgetedCompletion(
    d,
    provider,
    messages,
    worldId,
    'recovery',
    snapshot,
    options.signal,
    {
      outputBudget: 8000,
      priority: -1,
      virtualAt: start,
    },
  );
  const parsed = CatchUpSchema.safeParse(parseStructuredJSON(result.content));
  if (!parsed.success) throw new ProviderError('schema', '单 Agent 快速补全返回的结构不合法');
  return parsed.data;
}

async function writeWindow(
  worldId: string,
  start: number,
  end: number,
  payload: CatchUpPayload,
  snapshot: PromptConfig,
  version: number,
  d: AquariumDB,
) {
  const scope = await resolveObservation(worldId, d);
  const world = (await d.worlds.get(worldId))!;
  const valid = scope.activeIds;
  const characters = await d.characters.bulkGet([...valid]);
  const names = new Map(
    characters.filter((c): c is Character => !!c && !c.deletedAt).map((c) => [c.id, c.name]),
  );
  const minutes = durationMinutes(start, end);
  const events: ActivityEvent[] = [];
  const eventIds: string[] = [];
  for (const [index, row] of payload.events.entries()) {
    const participants = [...new Set(row.participants)].filter((id) => valid.has(id));
    if (!participants.length) continue;
    const at = start + Math.min(minutes - 1, Math.max(0, Math.round(row.at))) * 60000;
    const eventEnd = Math.min(end, at + Math.max(1, Math.round(row.duration)) * 60000);
    const id = `fast:${worldId}:${start}:e${index}`;
    const event: ActivityEvent = {
      id,
      worldId,
      type: row.type,
      start: at,
      end: eventEnd,
      participants,
      location:
        row.location && world.locations.includes(row.location)
          ? row.location
          : (world.locations[0] ?? '日常地点'),
      description:
        row.description || `${participants.map((x) => names.get(x) ?? x).join('、')}的日常。`,
      phone: row.type === 'social' ? 0.15 : row.type === 'sleep' ? 0 : 0.8,
      status: 'completed',
      importance: row.importance ?? (participants.length > 1 ? 0.65 : 0.4),
      origin: 'backfill',
      generatedAt: Date.now(),
    };
    eventIds[index] = id;
    events.push(event);
  }
  const existing = await d.conversations.where('worldId').equals(worldId).toArray();
  const convs = new Map(existing.map((c) => [conversationKey(c.participants), c]));
  const newConversations: Conversation[] = [];
  const messages: Message[] = [];
  const seqs = new Map<string, number>();
  for (const c of existing) {
    const last = await d.messages
      .where('[conversationId+seq]')
      .between([c.id, Dexie.minKey], [c.id, Dexie.maxKey])
      .reverse()
      .first();
    seqs.set(c.id, last?.seq ?? 0);
  }
  const newChats: { conversation: Conversation; eventId?: string; at: number }[] = [];
  for (const [index, row] of payload.chats.entries()) {
    const participants = [...new Set(row.participants)].filter((id) => valid.has(id));
    if (!participants.length) continue;
    const speakerRows = row.messages.filter(
      (m) => participants.includes(m.speakerId) && valid.has(m.speakerId),
    );
    if (!speakerRows.length) continue;
    const at = start + Math.min(minutes - 1, Math.max(0, Math.round(row.at))) * 60000;
    const key = conversationKey(participants);
    let conversation = convs.get(key);
    if (!conversation) {
      conversation = {
        id:
          participants.length === 2
            ? await directConversationId(worldId, participants[0], participants[1])
            : `fastconv:${worldId}:${uid('c')}`,
        worldId,
        kind: participants.length === 2 ? 'direct' : 'group',
        name: participants
          .map((id) => names.get(id) ?? id)
          .join(participants.length === 2 ? ' & ' : '、'),
        participants,
        createdAt: at,
        lastAt: at,
      };
      convs.set(key, conversation);
      newConversations.push(conversation);
      seqs.set(conversation.id, 0);
    }
    let seq = seqs.get(conversation.id) ?? 0;
    speakerRows.forEach((m, i) => {
      seq += 1;
      messages.push({
        id: `fast:${worldId}:${start}:c${index}:m${i}`,
        conversationId: conversation!.id,
        senderId: m.speakerId,
        seq,
        text: m.text.slice(0, snapshot.rules.hardLimit),
        realAt: Date.now(),
        simAt: Math.min(end - 1, at + (m.offset ?? i * 30) * 1000),
        source: 'ai',
        eventId: row.eventIndex !== undefined ? eventIds[row.eventIndex] : undefined,
        backfilled: true,
      });
    });
    seqs.set(conversation.id, seq);
    conversation.lastAt = Math.max(conversation.lastAt, at);
    newChats.push({
      conversation,
      eventId: row.eventIndex !== undefined ? eventIds[row.eventIndex] : undefined,
      at,
    });
  }
  const scenes: InPersonScene[] = [];
  for (const [index, row] of payload.scenes.entries()) {
    const event = events.find((e) => e.id === eventIds[row.eventIndex]);
    if (!event || event.participants.length < 2) continue;
    const phases = row.phases.map((phase, pi) => {
      const phaseStart =
        event.start + Math.floor(((event.end - event.start) * pi) / row.phases.length);
      const phaseEnd =
        event.start + Math.floor(((event.end - event.start) * (pi + 1)) / row.phases.length);
      const entries = phase.entries
        .map((entry, ei) => {
          const speakerId =
            entry.speakerId && event.participants.includes(entry.speakerId)
              ? entry.speakerId
              : entry.kind === 'dialogue'
                ? event.participants[ei % event.participants.length]
                : undefined;
          return {
            kind: entry.kind,
            at:
              phaseStart +
              Math.floor(((phaseEnd - phaseStart) * ei) / Math.max(1, phase.entries.length)),
            speakerId,
            text: entry.text.slice(0, snapshot.rules.hardLimit),
          };
        })
        .filter((e) => e.kind !== 'dialogue' || !!e.speakerId);
      if (!entries.length) return undefined;
      return {
        id: `fast:${worldId}:${start}:s${index}:p${pi}`,
        title: phase.title,
        start: phaseStart,
        end: phaseEnd,
        participants: event.participants,
        entries,
      };
    });
    const compact = phases.filter((p): p is NonNullable<typeof p> => !!p);
    if (!compact.length) continue;
    scenes.push({
      id: `fast:${worldId}:${start}:s${index}`,
      worldId,
      eventId: event.id,
      title: row.title,
      location: event.location,
      type: row.type ?? event.sceneType ?? 'gathering',
      participants: event.participants,
      start: event.start,
      end: event.end,
      promptVersion: snapshot.version,
      phases: compact,
    });
  }
  // Wait out a content drain that may still be committing, then retire its window.
  await withWorldLock('content:' + worldId, async () => {}, true);
  await d.transaction('rw', d.tables, async () => {
    const current = await d.checkpoints.get(worldId);
    if (!current || current.paused || (current.controlVersion ?? 0) !== version) {
      throw new Error('快速补全已暂停，未写入本次窗口');
    }
    const stale = await d.contentJobs
      .where('worldId')
      .equals(worldId)
      .and((j) => j.status !== 'complete' && j.at >= start && j.at < end)
      .toArray();
    if (stale.length)
      await d.contentJobs.bulkPut(
        stale.map((job) => ({
          ...job,
          status: 'complete' as const,
          completedAt: Date.now(),
          nextAttemptAt: 0,
          error: undefined,
          partial: undefined,
        })),
      );
    for (const c of existing) {
      if (!c.plannedHistory?.some((p) => p.at >= start && p.at < end)) continue;
      await d.conversations.update(c.id, {
        plannedHistory: c.plannedHistory.filter((p) => p.at < start || p.at >= end),
      });
    }
    await d.events.bulkPut(events);
    if (newConversations.length) await d.conversations.bulkPut(newConversations);
    for (const c of newChats) {
      if (!newConversations.some((n) => n.id === c.conversation.id))
        await d.conversations.update(c.conversation.id, { lastAt: c.conversation.lastAt });
    }
    if (messages.length) {
      await d.messages.bulkPut(messages);
      const day = new Date().toISOString().slice(0, 10);
      const usage = (await d.usage.get(day)) ?? {
        id: day,
        day,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        messages: 0,
        estimated: false,
      };
      await d.usage.put({ ...usage, messages: usage.messages + messages.length });
    }
    if (scenes.length) {
      await d.scenes.bulkPut(scenes);
      noteWorldHasScenes(d, worldId);
    }
    for (const event of events) {
      const scene = scenes.find((s) => s.eventId === event.id);
      if (scene) {
        // Include the online lead-up so the next chat remembers both halves.
        const lead = messages
          .filter((m) => m.eventId === event.id && m.simAt < scene.start)
          .sort((a, b) => a.simAt - b.simAt)
          .map((m) => m.text);
        await d.memories.put(sceneRecapMemory(scene, { names, leadTexts: lead }));
        continue;
      }
      await d.memories.put({
        id: 'memory:' + event.id,
        worldId,
        owners: event.participants,
        content: event.description,
        keywords: [event.location, '快速补全'],
        importance: event.importance ?? 0.5,
        at: event.end,
        eventId: event.id,
        kind: 'episode',
      });
    }
    for (const state of await d.states.where('worldId').equals(worldId).toArray()) {
      const last = events
        .filter((e) => e.participants.includes(state.characterId))
        .sort((a, b) => b.end - a.end)[0];
      if (!last) continue;
      await d.states.put({
        ...state,
        eventId: last.id,
        activity: last.description,
        location: last.location,
        phone: last.phone,
        lastPhone: end,
        lastAction: end,
      });
    }
    await recordCoverage(worldId, observationKeys(scope.config), start, end, d);
    // Keep the visible clock moving one window at a time; recoveryTarget stays until the
    // destination is reached so a reload can resume from the last written window.
    await d.checkpoints.put({
      ...current,
      simTime: end,
      realTime: Date.now(),
      clockAnchor: { simTime: end, realTime: Date.now() },
      lastEventAt: end,
      nextAt: end + 300000,
    });
    await d.taskLogs.put({
      id: `fast-catch-up:${worldId}:${start}`,
      worldId,
      task: 'fast-catch-up',
      promptVersion: snapshot.version,
      at: Date.now(),
      status: 'committed',
      detail: JSON.stringify({
        events: events.length,
        chats: payload.chats.length,
        scenes: scenes.length,
      }),
    });
  });
}

async function finishCatchUp(d: AquariumDB, cp: Checkpoint, now = Date.now()) {
  const realTime = cp.recoveryRealTarget ?? now;
  const paused = cp.jumpResumePaused === true;
  await d.checkpoints.put({
    ...cp,
    paused,
    realTime,
    clockAnchor: { simTime: cp.simTime, realTime },
    recoveryStart: undefined,
    recoveryTarget: undefined,
    recoveryRealTarget: undefined,
    recoveryKind: undefined,
    recoveryRequests: 0,
    jumpTarget: undefined,
    jumpResumePaused: undefined,
    usageLimited: false,
  });
}
async function drainBacklog(
  worldId: string,
  provider: Provider,
  options: FastCatchUpOptions,
  d: AquariumDB,
) {
  for (let round = 0; round < 12; round++) {
    if (options.signal?.aborted) return;
    const outstanding = await d.contentJobs
      .where('worldId')
      .equals(worldId)
      .and((j) => j.status !== 'complete' && j.attempts < 3)
      .count();
    if (!outstanding) return;
    await drainContent(worldId, d, provider);
  }
}

function conversationKey(participants: string[]) {
  return [...participants].sort().join('|');
}
