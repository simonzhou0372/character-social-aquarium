import Dexie from 'dexie';
import type {
  ActivityEvent,
  Conversation,
  InPersonScene,
  MemoryEntry,
  Message,
  Relationship,
} from './types';
import type { AquariumDB } from '../data/db';

/**
 * 线上聊天与线下场景共用的剧情线模型。
 *
 * 一段「剧情线」以一次真实发生的线下共同活动为锚点：
 *  - lead：活动开始前，参与者围绕这次见面产生的线上对话（约定、确认、期待）；
 *  - scene：活动本身的结构化场景；
 *  - follow：活动结束后，参与者对这段共同经历的线上回应。
 *
 * 所有关联都落在真实数据上（messages.eventId 指向同一生活事件），
 * 而不是按时间邻近猜测，因此重跑、补全和备份恢复后仍然稳定。
 */
export type StoryRole = 'lead' | 'follow';

export interface StoryMessageView {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  at: number;
}

export interface StoryThread {
  id: string;
  worldId: string;
  eventId: string;
  sceneId: string;
  title: string;
  location: string;
  participants: string[];
  start: number;
  end: number;
  lead: StoryMessageView[];
  during: StoryMessageView[];
  follow: StoryMessageView[];
  state: 'upcoming' | 'ongoing' | 'past';
  recap: string;
  /** True when the link comes from the legacy fallback (same people, nearby time). */
  derived: boolean;
  scene: InPersonScene;
}

const toView = (m: Message): StoryMessageView => ({
  id: m.id,
  conversationId: m.conversationId,
  senderId: m.senderId,
  text: m.text,
  at: m.simAt,
});

/** 场景的可读回顾：带发言人姓名的少量关键对白与活动说明。 */
export function sceneRecap(scene: InPersonScene, names?: Map<string, string>, maxChars = 700) {
  const lines: string[] = [];
  for (const phase of scene.phases) {
    for (const entry of phase.entries) {
      if (entry.kind === 'dialogue' && entry.speakerId) {
        const name = names?.get(entry.speakerId) ?? entry.speakerId;
        lines.push(`${name}：${entry.text}`);
      } else if (entry.kind === 'activity' && entry.text.trim()) {
        lines.push(entry.text);
      }
      if (lines.length >= 10) break;
    }
    if (lines.length >= 10) break;
  }
  const body = lines.length ? lines.join(' ') : '他们一起待了一段时间。';
  return Array.from(`《${scene.title}》（${scene.location}）${body}`).slice(0, maxChars).join('');
}

/**
 * 把一次线下场景写成参与者共享的经历记忆。
 * 与调度器提交生活事件时使用的 `memory:${eventId}` 使用同一 ID，
 * 因此后写入的完整场景回顾会替换掉只有一句活动描述的占位记忆。
 */
export function sceneRecapMemory(
  scene: InPersonScene,
  options: { names?: Map<string, string>; leadTexts?: string[]; importance?: number } = {},
): MemoryEntry {
  const lead = (options.leadTexts ?? []).filter((t) => t.trim()).slice(-3);
  const prefix = lead.length ? `此前线上约好：${lead.join(' / ')}。` : '';
  return {
    id: `memory:${scene.eventId}`,
    worldId: scene.worldId,
    owners: [...scene.participants],
    content: (prefix + sceneRecap(scene, options.names)).slice(0, 1000),
    keywords: [scene.location, '线下', scene.type].filter(Boolean),
    importance: options.importance ?? 0.7,
    at: scene.end,
    eventId: scene.eventId,
    kind: 'episode',
  };
}

/**
 * 把场景和它们前后关联的线上消息聚合为剧情线。
 * 纯函数：只依赖传入的数据，便于在 UI、报告和测试中复用。
 */
export function buildStoryThreads(
  scenes: InPersonScene[],
  messages: Message[],
  options: {
    now?: number;
    limit?: number;
    from?: number;
    to?: number;
    /** Legacy archives predate Message.eventId; use same-people, nearby-time messages. */
    derived?: Map<string, Message[]>;
  } = {},
): StoryThread[] {
  const now = options.now ?? Number.MAX_SAFE_INTEGER;
  const byEvent = new Map<string, Message[]>();
  for (const message of messages) {
    if (!message.eventId) continue;
    const rows = byEvent.get(message.eventId) ?? [];
    rows.push(message);
    byEvent.set(message.eventId, rows);
  }
  const threads: StoryThread[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) {
    if (seen.has(scene.eventId)) continue;
    seen.add(scene.eventId);
    if (options.from !== undefined && scene.end < options.from) continue;
    if (options.to !== undefined && scene.start > options.to) continue;
    const explicit = (byEvent.get(scene.eventId) ?? []).sort(
      (a, b) => a.simAt - b.simAt || a.seq - b.seq,
    );
    const fallback = explicit.length ? [] : (options.derived?.get(scene.eventId) ?? []);
    const linked = (explicit.length ? explicit : fallback).sort(
      (a, b) => a.simAt - b.simAt || a.seq - b.seq,
    );
    const derived = !explicit.length && linked.length > 0;
    threads.push({
      id: scene.eventId,
      worldId: scene.worldId,
      eventId: scene.eventId,
      sceneId: scene.id,
      title: scene.title,
      location: scene.location,
      participants: scene.participants,
      start: scene.start,
      end: scene.end,
      lead: linked.filter((m) => m.simAt < scene.start).map(toView),
      // Legacy archives rarely carry event ids; any same-people message after the scene
      // began is shown as the after-story rather than silently disappearing.
      during: derived
        ? []
        : linked.filter((m) => m.simAt >= scene.start && m.simAt < scene.end).map(toView),
      follow: linked.filter((m) => m.simAt >= (derived ? scene.start : scene.end)).map(toView),
      state: now < scene.start ? 'upcoming' : now < scene.end ? 'ongoing' : 'past',
      recap: sceneRecap(scene),
      derived,
      scene,
    });
  }
  return threads.sort((a, b) => b.start - a.start).slice(0, options.limit ?? 12);
}

export interface StoryConversationChoice {
  conversation: Conversation;
  /** 优先发起线上约定的人。 */
  leadSpeaker: string;
  /** 在活动结束后继续线上话题的人。 */
  followSpeaker: string;
}

function pairScore(a: string, b: string, relationships: Relationship[]) {
  const forward = relationships.find((r) => r.from === a && r.to === b);
  const backward = relationships.find((r) => r.from === b && r.to === a);
  const value = (r?: Relationship) =>
    r ? r.closeness * 0.5 + r.familiarity * 0.3 + r.trust * 0.2 : 0;
  return Math.max(value(forward), value(backward));
}

function outgoing(a: string, b: string, relationships: Relationship[]) {
  const r = relationships.find((x) => x.from === a && x.to === b);
  if (!r) return 0;
  return (
    (r.closeness * 0.45 + r.familiarity * 0.35 + r.trust * 0.2) * (r.behavior?.initiativeScale ?? 1)
  );
}

/**
 * 为一次线下活动选择最自然的线上会话：
 *  - 三人及以上优先用包含全部参与者的群聊，避免把同行者排除在约定之外；
 *  - 否则选关系最紧密的一对一的私聊。
 * 结果是确定性的（同分按 ID 排序），重跑不会换会话。
 */
export function chooseStoryConversation(
  participants: string[],
  conversations: Conversation[],
  relationships: Relationship[],
): StoryConversationChoice | undefined {
  const people = [...new Set(participants)];
  if (people.length < 2) return undefined;
  const usable = conversations.filter((c) => c.kind !== 'notes' && !c.controlledId);
  // One pass to index direct chats; otherwise every candidate pair scans every conversation.
  const directByPair = new Map<string, Conversation>();
  for (const c of usable) {
    if (c.kind !== 'direct' || c.participants.length !== 2) continue;
    const key = [...c.participants].sort().join('\u0000');
    const previous = directByPair.get(key);
    if (!previous || c.id < previous.id) directByPair.set(key, c);
  }
  if (people.length >= 3) {
    const groups = usable
      .filter(
        (c) =>
          c.kind === 'group' &&
          people.every((id) => c.participants.includes(id)) &&
          c.participants.length >= people.length,
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    if (groups.length) {
      const group = groups[0];
      return {
        conversation: group,
        leadSpeaker: leadOf(people, relationships, group),
        followSpeaker: followOf(people, relationships, group),
      };
    }
  }
  let best: { conversation: Conversation; pair: [string, string]; score: number } | undefined;
  for (let i = 0; i < people.length; i++)
    for (let j = i + 1; j < people.length; j++) {
      const pair: [string, string] = [people[i], people[j]];
      const conversation = directByPair.get([...pair].sort().join('\u0000'));
      if (!conversation) continue;
      const score = pairScore(pair[0], pair[1], relationships);
      if (
        !best ||
        score > best.score ||
        (score === best.score && conversation.id < best.conversation.id)
      )
        best = { conversation, pair, score };
    }
  if (!best) return undefined;
  return {
    conversation: best.conversation,
    leadSpeaker: leadOf(people, relationships, best.conversation),
    followSpeaker: followOf(people, relationships, best.conversation),
  };
}

function leadOf(people: string[], relationships: Relationship[], conversation: Conversation) {
  const candidates = people.filter((id) => conversation.participants.includes(id));
  return [...candidates].sort((a, b) => {
    const score = (id: string) =>
      Math.max(0, ...candidates.filter((x) => x !== id).map((x) => outgoing(id, x, relationships)));
    return score(b) - score(a) || a.localeCompare(b);
  })[0];
}

function followOf(people: string[], relationships: Relationship[], conversation: Conversation) {
  const candidates = people.filter((id) => conversation.participants.includes(id));
  if (candidates.length < 2) return candidates[0];
  const lead = leadOf(people, relationships, conversation);
  return [...candidates]
    .filter((id) => id !== lead)
    .sort(
      (a, b) =>
        pairScore(lead, b, relationships) - pairScore(lead, a, relationships) || a.localeCompare(b),
    )[0];
}

/** 读取一个世界最近的剧情线；只查询被场景引用的事件消息，避免全表扫描。 */
export async function loadStoryThreads(
  worldId: string,
  d: AquariumDB,
  options: { now?: number; limit?: number; from?: number; to?: number } = {},
) {
  const scenes = await d.scenes.where('worldId').equals(worldId).toArray();
  const limited = buildStoryThreads(scenes, [], { ...options, limit: options.limit ?? 24 });
  const ids = limited.map((t) => t.eventId);
  if (!ids.length) return [];
  const explicit = await d.messages.where('eventId').anyOf(ids).toArray();
  const explicitEvents = new Set(explicit.map((m) => m.eventId));
  const missing = limited.filter((t) => !explicitEvents.has(t.eventId)).slice(0, 8);
  const derived = new Map<string, Message[]>();
  if (missing.length) {
    // Legacy archives (including the bundled seven-day story) were written before
    // Message.eventId existed. Fall back to "the same people talked right around the scene"
    // so the relationship is still visible, and mark it as derived rather than pretending
    // the event id was stored.
    const people = new Set(missing.flatMap((t) => t.participants));
    const conversations = [
      ...new Map(
        (
          await d.conversations
            .where('participants')
            .anyOf([...people])
            .and((c) => c.worldId === worldId && c.kind !== 'notes')
            .toArray()
        ).map((c) => [c.id, c]),
      ).values(),
    ];
    const used = new Set<string>();
    for (const thread of missing) {
      const scene = thread.scene;
      const candidates = conversations
        .filter((c) => {
          const overlap = c.participants.filter((id) => scene.participants.includes(id)).length;
          return c.kind === 'direct' && c.participants.length === 2
            ? overlap === 2
            : overlap >= Math.min(2, scene.participants.length);
        })
        .slice(0, 4);
      if (!candidates.length) continue;
      const rows: Message[] = [];
      const rowIds = new Set<string>();
      for (const c of candidates) {
        const messages = await d.messages
          .where('[conversationId+simAt+seq]')
          .between(
            [c.id, Math.max(0, scene.start - 4 * 60 * 60 * 1000), Dexie.minKey],
            [c.id, scene.end + 8 * 60 * 60 * 1000, Dexie.maxKey],
            true,
            true,
          )
          .toArray();
        for (const m of messages) if (!m.eventId && !used.has(m.id)) rows.push(m);
      }
      if (!rows.length) continue;
      rows.sort((a, b) => a.simAt - b.simAt);
      const lead = rows.filter((m) => m.simAt < scene.start).slice(-1);
      const after = rows.filter((m) => m.simAt >= scene.start).slice(0, 2);
      const picked = [...lead, ...after];
      if (!picked.length) continue;
      for (const m of picked) used.add(m.id);
      derived.set(scene.eventId, picked);
    }
  }
  return buildStoryThreads(scenes, explicit, { ...options, derived });
}

/** 一条消息在剧情线中的位置；供聊天页标注「线上约定/事后回应」。 */
export function storyRoleOf(message: Message, scene: InPersonScene): StoryRole | undefined {
  if (message.eventId !== scene.eventId) return undefined;
  if (message.simAt < scene.start) return 'lead';
  if (message.simAt >= scene.end) return 'follow';
  return undefined;
}

export function storyEventIdsOf(threads: StoryThread[]) {
  return [...new Set(threads.map((t) => t.eventId))];
}

/** 供提示词使用的紧凑线下摘要，避免把整段场景塞进上下文。 */
export function scenePromptDigest(scene: InPersonScene, names?: Map<string, string>) {
  return {
    title: scene.title,
    location: scene.location,
    start: scene.start,
    end: scene.end,
    participants: scene.participants,
    highlights: scene.phases
      .flatMap((p) => p.entries)
      .filter((e) => e.kind === 'dialogue' || e.text.trim())
      .slice(0, 6)
      .map((e) => ({
        at: e.at,
        speaker: e.speakerId ? (names?.get(e.speakerId) ?? e.speakerId) : undefined,
        text: e.text,
      })),
  };
}

/** 供提示词使用的线上片段。 */
export function messagePromptDigest(messages: Message[], names?: Map<string, string>) {
  return messages.slice(-10).map((m) => ({
    at: m.simAt,
    speaker: names?.get(m.senderId) ?? m.senderId,
    text: m.text,
    eventId: m.eventId,
  }));
}

/**
 * 线下场景生成前可以看见的线上铺垫。
 * 只取「场景参与者共同在场」的会话，避免把某个人与局外人的私聊带进场景。
 */
export async function sceneChatContext(
  d: AquariumDB,
  event: ActivityEvent,
  window = 8 * 60 * 60 * 1000,
) {
  const people = event.participants;
  const conversations = [
    ...new Map(
      (
        await d.conversations
          .where('participants')
          .anyOf(people)
          .and((c) => c.worldId === event.worldId && c.kind !== 'notes')
          .toArray()
      ).map((c) => [c.id, c]),
    ).values(),
  ]
    .filter((c) => {
      const overlap = people.filter((id) => c.participants.includes(id)).length;
      // A two-person scene may look at their direct chat and shared groups; a group scene
      // only looks at rooms where at least two of the participants are present.
      return c.kind === 'direct' && c.participants.length === 2
        ? people.length === 2 && overlap === 2
        : overlap >= Math.min(2, people.length);
    })
    .sort(
      (a, b) =>
        people.filter((id) => b.participants.includes(id)).length -
          people.filter((id) => a.participants.includes(id)).length || a.id.localeCompare(b.id),
    )
    .slice(0, 8);
  const rows: Message[] = [];
  for (const c of conversations) {
    const recent = await d.messages
      .where('[conversationId+simAt+seq]')
      .between(
        [c.id, Math.max(0, event.start - window), Dexie.minKey],
        [c.id, event.start, Dexie.maxKey],
        true,
        true,
      )
      .reverse()
      .limit(8)
      .toArray();
    rows.push(...recent);
  }
  const linked = (
    await d.messages
      .where('eventId')
      .equals(event.id)
      .and((m) => m.simAt <= event.start)
      .toArray()
  ).sort((a, b) => a.simAt - b.simAt || a.seq - b.seq);
  const merged = [...new Map([...rows, ...linked].map((m) => [m.id, m])).values()].sort(
    (a, b) => a.simAt - b.simAt,
  );
  const ids = new Set<string>([...people, ...merged.map((m) => m.senderId)]);
  const characters = await d.characters.bulkGet([...ids]);
  const names = new Map(
    characters.filter(Boolean).map((c) => [c!.id, c!.name] as [string, string]),
  );
  return {
    recentChat: messagePromptDigest(merged.slice(-10), names),
    linkedChat: messagePromptDigest(linked.slice(-6), names),
    note: linked.length
      ? 'linkedChat 是参与者围绕这次见面已经说过的线上内容：场景需要自然承接，不能与之矛盾，也不要逐句复述。'
      : 'recentChat 是见面之前参与者之间的线上交流；如其中有约定、地点、情绪或未说完的话题，场景应当自然承接。没有就正常开始。',
  };
}

// Worlds with no scenes at all should not pay a scene-range query on every chat.
const scenePresence = new WeakMap<AquariumDB, Map<string, { checkedAt: number; has: boolean }>>();
async function worldHasScenes(d: AquariumDB, worldId: string) {
  let cache = scenePresence.get(d);
  if (!cache) scenePresence.set(d, (cache = new Map()));
  const hit = cache.get(worldId);
  if (hit && Date.now() - hit.checkedAt < 5 * 60 * 1000) return hit.has;
  const has = (await d.scenes.where('worldId').equals(worldId).count()) > 0;
  cache.set(worldId, { checkedAt: Date.now(), has });
  return has;
}
/** Called when a scene is first written so the next chat does not miss it. */
export function noteWorldHasScenes(d: AquariumDB, worldId: string) {
  let cache = scenePresence.get(d);
  if (!cache) scenePresence.set(d, (cache = new Map()));
  cache.set(worldId, { checkedAt: Date.now(), has: true });
}

/**
 * 线上对话可以看见的线下剧情上下文。
 * 只给「说话人亲历」或「与当前会话对象共同经历」的场景，避免把别人的私密场景泄露进来。
 */
export async function storyPromptContext(
  d: AquariumDB,
  input: {
    worldId: string;
    at: number;
    participants: string[];
    speakerId: string;
    event?: ActivityEvent;
    role?: StoryRole;
  },
) {
  if (!(await worldHasScenes(d, input.worldId)))
    return {
      role: input.role,
      upcoming: input.event
        ? {
            eventId: input.event.id,
            title: input.event.description,
            location: input.event.location,
            start: input.event.start,
            end: input.event.end,
            participants: input.event.participants,
            note: '这次共同活动已经排入计划；线上对话发生在它之前，可以确认时间地点或表达期待，但不要编造尚未发生的细节。',
          }
        : undefined,
      happeningNow: [],
      justHappened: [],
      linkedScene: undefined,
      priorOnline: [],
      note:
        input.role === 'lead'
          ? '你正在为即将发生的线下见面做线上铺垫。可以确认安排、表达期待，不要提前演出见面的内容。'
          : '目前没有可引用的线下场景，按普通线上聊天自然进行。',
    };
  const window = 36 * 60 * 60 * 1000;
  const scenes = (
    await d.scenes
      .where('[worldId+start]')
      .between([input.worldId, input.at - window], [input.worldId, input.at + window], true, true)
      .toArray()
  ).filter(
    (scene) =>
      scene.participants.includes(input.speakerId) &&
      (scene.participants.length > 1 ||
        scene.participants.some((id) => input.participants.includes(id))) &&
      (scene.participants.some((id) => input.participants.includes(id)) ||
        scene.eventId === input.event?.id),
  );
  const recent = scenes
    .filter((s) => s.end <= input.at)
    .sort((a, b) => b.end - a.end)
    .slice(0, 2);
  const ongoing = scenes
    .filter((s) => s.start <= input.at && input.at < s.end)
    .sort((a, b) => a.start - b.start)
    .slice(0, 1);
  const upcoming = scenes
    .filter((s) => s.start > input.at)
    .sort((a, b) => a.start - b.start)
    .slice(0, 1);
  const linkedScenes = input.event ? scenes.filter((s) => s.eventId === input.event!.id) : [];
  const ids = new Set<string>([input.speakerId, ...input.participants]);
  for (const s of [...recent, ...upcoming, ...linkedScenes])
    for (const id of s.participants) ids.add(id);
  const characters = await d.characters.bulkGet([...ids]);
  const names = new Map(
    characters.filter(Boolean).map((c) => [c!.id, c!.name] as [string, string]),
  );
  const linkedEventIds = new Set(
    [input.event?.id, ...recent.map((s) => s.eventId), ...ongoing.map((s) => s.eventId)].filter(
      (x): x is string => !!x,
    ),
  );
  const priorMessages = linkedEventIds.size
    ? (
        await d.messages
          .where('eventId')
          .anyOf([...linkedEventIds])
          .and((m) => m.simAt <= input.at)
          .toArray()
      )
        .sort((a, b) => a.simAt - b.simAt || a.seq - b.seq)
        .slice(-8)
    : [];
  return {
    role: input.role,
    upcoming: input.event
      ? {
          eventId: input.event.id,
          title: input.event.description,
          location: input.event.location,
          start: input.event.start,
          end: input.event.end,
          participants: input.event.participants.map((id) => names.get(id) ?? id),
          note: '这次共同活动已经排入计划；线上对话发生在它之前，可以确认时间地点或表达期待，但不要编造尚未发生的细节。',
        }
      : upcoming[0]
        ? scenePromptDigest(upcoming[0], names)
        : undefined,
    happeningNow: ongoing.map((s) => scenePromptDigest(s, names)),
    justHappened: recent.map((s) => scenePromptDigest(s, names)),
    linkedScene: linkedScenes[0] ? scenePromptDigest(linkedScenes[0], names) : undefined,
    priorOnline: messagePromptDigest(priorMessages, names),
    note:
      input.role === 'lead'
        ? '你正在为即将发生的线下见面做线上铺垫。对话要像真实的朋友确认安排，可以提到已经知道的信息；不要提前演出见面的内容。'
        : input.role === 'follow'
          ? '线下活动刚刚结束。可以自然提起刚才共同经历的一个细节，也可以不提起；不要机械复述整段场景，更不要发明没有发生的情节。'
          : ongoing.length
            ? '说话人此刻正在参与 happeningNow 中的线下活动：线上回复应体现出「正在忙/正和朋友在一起」，不能像独自在家一样展开长聊。'
            : '如果 justHappened 中有刚结束的线下场景，线上回复可以与它自然呼应；没有就不必强行提起。',
  };
}
