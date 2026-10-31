import { db, type AquariumDB } from '../db';
import { validateBackup } from '../backup';

type Backup = ReturnType<typeof validateBackup>;

/** 内置《最后七天 · 终焉潮汐》七日正式存档。 */
export const LAST_SEVEN_DAYS_WORLD_ID = 'world-25673243-6859-4201-84a8-5a2bebfd04a8';
export const LAST_SEVEN_DAYS_WORLD_NAME = '最后七天 · 终焉潮汐';
const PRESET_VERSION = 2;
const PRESET_URL = `${import.meta.env.BASE_URL}presets/last-seven-days-v2.json`;

let loading: Promise<boolean> | null = null;

async function loadPreset(): Promise<Backup> {
  const res = await fetch(PRESET_URL);
  if (!res.ok) throw new Error(`内置《最后七天》资料读取失败（${res.status}）`);
  const raw = await res.json();
  // 终焉事件与潮汐同一时刻发生，长度为 0；补齐 1 分钟以满足事件时间约束。
  for (const e of raw?.events ?? [])
    if (!(e.end > e.start)) e.end = e.start + 60000;
  // 场景保留了完整时长，事件行的 end 曾被截成 1 分钟；以场景时长为准修正。
  const eventById = new Map((raw?.events ?? []).map((e: { id: string }) => [e.id, e]));
  for (const sc of raw?.scenes ?? []) {
    const ev = eventById.get(sc.eventId) as { start: number; end: number } | undefined;
    if (ev && ev.start === sc.start && sc.end > ev.end) ev.end = sc.end;
  }
  // 终焉时刻的角色状态引用了未持久化的分钟级生活事件；统一挂到终焉事件上。
  const eventIds = new Set((raw?.events ?? []).map((e: { id: string }) => e.id));
  const terminal = (raw?.events ?? []).find((e: { id: string }) => e.id.endsWith(':final-tide'));
  if (terminal)
    for (const st of raw?.states ?? [])
      if (!eventIds.has(st.eventId)) st.eventId = terminal.id;
  // Deluxe 日报使用归档格式；转换为软件 WorldReport（正文放入 overview）。
  raw.worldReports = (raw?.worldReports ?? [])
    .filter((r: { worldId: string }) => r.worldId === LAST_SEVEN_DAYS_WORLD_ID)
    .map((r: Record<string, unknown>) => ({
      id: r.id,
      worldId: r.worldId,
      type: 'daily',
      start: r.startAt ?? r.start ?? r.rangeStart,
      end: r.endAt ?? r.end ?? r.rangeEnd,
      status: 'ready',
      sources: [],
      sections: [],
      overview: String(r.content ?? r.summary ?? r.description ?? '').slice(0, 2000),
      generatedAt: typeof r.generatedAt === 'number' ? r.generatedAt : undefined,
    }));
  // 归档的日报游标字段与本版 ReportCursor 不同；世界已完结，不再排期，直接清空。
  raw.reportCursors = [];
  // 无消息的私信会话在归档里没有 name；用参与者姓名补齐。
  const nameById = new Map(
    (raw?.characters ?? []).map((c: { id: string; name: string }) => [c.id, c.name]),
  );
  for (const m of raw?.messages ?? [])
    if (m.source !== 'user' && m.source !== 'ai' && m.source !== 'demo') m.source = 'ai';
  for (const c of raw?.conversations ?? [])
    if (!c.name)
      c.name =
        c.kind === 'group'
          ? '群聊'
          : c.participants
              .map((id: string) => nameById.get(id) ?? '未知')
              .join(' & ')
              .slice(0, 80);
  for (const w of raw?.worlds ?? [])
    if (w.id === LAST_SEVEN_DAYS_WORLD_ID) {
      w.name = LAST_SEVEN_DAYS_WORLD_NAME;
      w.presetVersion = PRESET_VERSION;
    }
  return validateBackup(raw);
}

/**
 * 首次启动写入内置《最后七天》完整七天存档，并把它设为默认世界。
 * 已存在同 ID 世界时直接跳过，不覆盖用户的任何编辑。
 */
export function ensureLastSevenDaysPreset(d: AquariumDB = db): Promise<boolean> {
  loading ??= install(d).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function purgeWorld(d: AquariumDB, worldId: string) {
  const memberships = await d.memberships.where('worldId').equals(worldId).toArray();
  const characterIds = memberships.map((m) => m.characterId);
  const conversations = await d.conversations.where('worldId').equals(worldId).toArray();
  const conversationIds = conversations.map((c) => c.id);
  if (conversationIds.length) {
    await d.messages.where('conversationId').anyOf(conversationIds).delete();
    await d.cursors.where('conversationId').anyOf(conversationIds).delete();
  }
  await d.readStates.filter((r) => r.id.includes(worldId)).delete();
  await d.events.where('worldId').equals(worldId).delete();
  await d.scenes.where('worldId').equals(worldId).delete();
  await d.majorEvents.where('worldId').equals(worldId).delete();
  await d.notifications.where('worldId').equals(worldId).delete();
  await d.worldReports.where('worldId').equals(worldId).delete();
  await d.states.where('worldId').equals(worldId).delete();
  await d.memories.where('worldId').equals(worldId).delete();
  await d.backgroundKnowledge.where('worldId').equals(worldId).delete();
  await d.narrativeChanges.where('worldId').equals(worldId).delete();
  await d.organizationStates.where('worldId').equals(worldId).delete();
  await d.evolutionRecords.where('worldId').equals(worldId).delete();
  await d.groupMembers.where('worldId').equals(worldId).delete();
  await d.relationships.where('worldId').equals(worldId).delete();
  await d.memberships.where('worldId').equals(worldId).delete();
  await d.conversations.where('worldId').equals(worldId).delete();
  await d.majorChains.where('worldId').equals(worldId).delete();
  await d.majorSchedules.where('id').equals(worldId).delete();
  await d.evolutionCursors.where('id').equals(worldId).delete();
  await d.observationConfigs.where('id').equals(worldId).delete();
  await d.checkpoints.where('id').equals(worldId).delete();
  await d.groups.filter((g) => g.worldIds.includes(worldId)).delete();
  if (characterIds.length) await d.characters.bulkDelete(characterIds);
  await d.worlds.where('id').equals(worldId).delete();
}

async function install(d: AquariumDB): Promise<boolean> {
  const existing = await d.worlds.get(LAST_SEVEN_DAYS_WORLD_ID);
  if (existing && (existing as { presetVersion?: number }).presetVersion === PRESET_VERSION)
    return false;
  const b = await loadPreset();
  const worldId = LAST_SEVEN_DAYS_WORLD_ID;
  const memberships = b.memberships.filter((m) => m.worldId === worldId);
  const characterIds = new Set(memberships.map((m) => m.characterId));
  const conversations = b.conversations.filter((c) => c.worldId === worldId);
  const conversationIds = new Set(conversations.map((c) => c.id));
  const messages = b.messages.filter((m) => conversationIds.has(m.conversationId));
  const messageIds = new Set(messages.map((m) => m.id));

  await d.transaction('rw', d.tables, async () => {
    if (existing) await purgeWorld(d, worldId);
    await d.worlds.bulkPut(b.worlds.filter((w) => w.id === worldId));
    await d.characters.bulkPut(b.characters.filter((c) => characterIds.has(c.id)));
    await d.memberships.bulkPut(memberships);
    await d.groups.bulkPut(b.groups.filter((g) => g.worldIds.includes(worldId)));
    await d.groupMembers.bulkPut(b.groupMembers.filter((g) => g.worldId === worldId));
    await d.relationships.bulkPut(b.relationships.filter((r) => r.worldId === worldId));
    await d.conversations.bulkPut(conversations);
    await d.messages.bulkPut(messages);
    await d.cursors.bulkPut(b.cursors.filter((c) => conversationIds.has(c.conversationId)));
    await d.readStates.bulkPut(b.readStates.filter((r) => r.id.includes(worldId)));
    await d.events.bulkPut(b.events.filter((e) => e.worldId === worldId));
    await d.scenes.bulkPut(b.scenes.filter((s) => s.worldId === worldId));
    await d.majorEvents.bulkPut(b.majorEvents.filter((m) => m.worldId === worldId));
    await d.majorChains.bulkPut(b.majorChains.filter((m) => m.worldId === worldId));
    await d.majorSchedules.bulkPut(b.majorSchedules.filter((m) => m.id === worldId));
    await d.notifications.bulkPut(b.notifications.filter((n) => n.worldId === worldId));
    await d.worldReports.bulkPut(b.worldReports.filter((r) => r.worldId === worldId));
    await d.states.bulkPut(b.states.filter((s) => s.worldId === worldId));
    await d.memories.bulkPut(b.memories.filter((m) => m.worldId === worldId));
    await d.backgroundKnowledge.bulkPut(
      b.backgroundKnowledge.filter((k) => k.worldId === worldId),
    );
    await d.narrativeChanges.bulkPut(b.narrativeChanges.filter((n) => n.worldId === worldId));
    await d.organizationStates.bulkPut(
      b.organizationStates.filter((o) => o.worldId === worldId),
    );
    await d.evolutionRecords.bulkPut(b.evolutionRecords.filter((e) => e.worldId === worldId));
    await d.evolutionCursors.bulkPut(b.evolutionCursors.filter((e) => e.id === worldId));
    await d.observationConfigs.bulkPut(b.observationConfigs.filter((o) => o.id === worldId));
    const checkpoint = b.checkpoints.find((c) => c.id === worldId);
    if (checkpoint) await d.checkpoints.bulkPut([{ ...checkpoint, paused: true }]);
    if (messageIds.size)
      await d.reactions.bulkPut(b.reactions.filter((r) => messageIds.has(r.messageId)));
  });

  const settings = await d.settings.get('app');
  if (settings)
    await d.settings.update('app', {
      worldId,
      activity: 'quiet',
      sceneFrequency: 0.25,
      sceneDailyBudget: 4,
    });
  return true;
}
