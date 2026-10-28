import { assertConversationLife, canLiveAt } from '../core/narrative';
import { db, type AquariumDB } from './db';
import { clockTarget } from '../core/time';
import { foregroundStart } from '../core/clock-presence';
import { uid, type Message } from '../core/types';
import { isSupportedReaction } from '../core/reaction-emojis';
export async function conversationAvailable(
  conversation: string | import('../core/types').Conversation,
  d: AquariumDB = db,
  at?: number,
) {
  const c =
    typeof conversation === 'string' ? await d.conversations.get(conversation) : conversation;
  if (!c || c.kind === 'notes') return false;
  const world = await d.worlds.get(c.worldId);
  if (!world || world.deletedAt) return false;
  if (c.groupId && (await d.groups.get(c.groupId))?.deletedAt) return false;
  try {
    await assertConversationLife(
      c,
      at ?? (await d.checkpoints.get(c.worldId))?.simTime ?? Date.now(),
      d,
    );
  } catch {
    return false;
  }
  const members = await d.memberships.where('worldId').equals(c.worldId).toArray();
  if (c.participants.some((id) => !members.some((m) => m.characterId === id && !m.inactive)))
    return false;
  const chars = await d.characters.bulkGet(c.participants);
  return chars.every((c) => !!c && !c.deletedAt && c.entityMode !== 'background');
}
export async function ensureNotes(worldId: string, d: AquariumDB = db) {
  const world = await d.worlds.get(worldId);
  if (!world || world.deletedAt) throw new Error('当前世界不可用');
  return d.transaction('rw', d.conversations, async () => {
    const old = await d.conversations
      .where('worldId')
      .equals(worldId)
      .and((c) => c.kind === 'notes')
      .first();
    if (old) return old.id;
    const id = uid('notes');
    await d.conversations.add({
      id,
      worldId,
      kind: 'notes',
      participants: ['user'],
      name: '我的备忘',
      createdAt: Date.now(),
      lastAt: 0,
    });
    return id;
  });
}
export async function saveNote(
  conversationId: string,
  text: string,
  replyToMessageId?: string,
  d: AquariumDB = db,
) {
  if (!text.trim() || Array.from(text).length > 2000) throw new Error('备注须为 1～2000 字');
  return d.transaction('rw', [d.conversations, d.messages, d.worlds], async () => {
    const c = await d.conversations.get(conversationId);
    if (!c || c.kind !== 'notes' || (await d.worlds.get(c.worldId))?.deletedAt)
      throw new Error('备忘会话不可用');
    if (replyToMessageId && (await d.messages.get(replyToMessageId))?.conversationId !== c.id)
      throw new Error('引用消息不属于当前备忘');
    const last = await d.messages.where('conversationId').equals(c.id).sortBy('seq');
    const at = Math.max(Date.now(), last.at(-1)?.simAt ?? 0);
    await d.messages.add({
      id: uid('note'),
      conversationId: c.id,
      senderId: 'user',
      text: text.trim(),
      seq: (last.at(-1)?.seq ?? 0) + 1,
      realAt: at,
      simAt: at,
      source: 'user',
      replyToMessageId,
    });
    await d.conversations.update(c.id, { lastAt: at });
  });
}
export async function toggleReaction(
  messageId: string,
  actorId: string,
  emoji: string,
  d: AquariumDB = db,
) {
  if (!isSupportedReaction(emoji)) throw new Error('不支持此回应');
  return d.transaction('rw', d.reactions, d.messages, d.conversations, d.checkpoints, async () => {
    const m = await d.messages.get(messageId);
    if (!m) throw new Error('消息不存在');
    const c = await d.conversations.get(m.conversationId);
    if (!c || (actorId !== 'user' && !c.participants.includes(actorId)))
      throw new Error('回应身份不属于当前会话');
    if (actorId !== 'user' && c.controlledId !== actorId) throw new Error('请先切换到该角色身份');
    const old = await d.reactions
      .where('messageId')
      .equals(messageId)
      .and((r) => r.actorId === actorId && r.emoji === emoji)
      .first();
    const cp = await d.checkpoints.get(c.worldId);
    if (old) await d.reactions.delete(old.id);
    else
      await d.reactions.add({
        id: uid('reaction'),
        messageId,
        actorId,
        emoji,
        reactedAt: cp ? clockTarget(cp, Date.now(), foregroundStart()) : m.simAt,
      });
  });
}
export async function validateMessageExtras(
  d: AquariumDB,
  conversationId: string,
  text: string,
  extras: Partial<Message>,
) {
  const c = await d.conversations.get(conversationId);
  if (!c) throw new Error('会话不存在');
  if (extras.replyToMessageId) {
    const reply = await d.messages.get(extras.replyToMessageId);
    if (!reply || reply.conversationId !== conversationId)
      throw new Error('引用消息不属于当前会话');
  }
  const mentions = (extras.mentions ?? []).filter(
    (m) =>
      c.participants.includes(m.characterId) &&
      m.end > m.start &&
      text.slice(m.start, m.end) === m.label,
  );
  if ((extras.mentionCharacterIds ?? []).some((id) => !c.participants.includes(id)))
    throw new Error('提及对象不在会话中');
  return {
    replyToMessageId: extras.replyToMessageId,
    mentions,
    mentionCharacterIds: [
      ...new Set([...mentions.map((m) => m.characterId), ...(extras.mentionCharacterIds ?? [])]),
    ],
  };
}
export async function recordVisible(conversationId: string, seq: number, d: AquariumDB = db) {
  if (seq <= 0) return;
  await d.transaction('rw', d.cursors, async () => {
    const id = `observer:${conversationId}`,
      old = await d.cursors.get(id);
    if ((old?.seq ?? 0) >= seq) return;
    await d.cursors.put({
      id,
      conversationId,
      readerId: 'observer',
      kind: 'observer',
      seq,
      at: Date.now(),
    });
  });
}
export async function recordObserved(conversationId: string, ids: string[], d: AquariumDB = db) {
  await d.transaction('rw', d.messages, d.readStates, d.cursors, async () => {
    const messages = await d.messages.where('conversationId').equals(conversationId).sortBy('seq');
    const known = new Set(messages.map((m) => m.id));
    for (const messageId of ids.filter((id) => known.has(id))) {
      const key = 'observer:' + messageId;
      if (!(await d.readStates.get(key)))
        await d.readStates.put({
          id: key,
          messageId,
          readerId: 'observer',
          kind: 'observer',
          readAt: Date.now(),
        });
    }
    const records = await d.readStates.where('readerId').equals('observer').toArray();
    const seen = new Set(records.map((r) => r.messageId)),
      id = `observer:${conversationId}`,
      old = await d.cursors.get(id);
    let seq = old?.seq ?? 0;
    for (const m of messages.filter((m) => m.seq > seq)) {
      if (!seen.has(m.id)) break;
      seq = m.seq;
    }
    if (seq > (old?.seq ?? 0))
      await d.cursors.put({
        id,
        conversationId,
        readerId: 'observer',
        kind: 'observer',
        seq,
        at: Date.now(),
      });
  });
}
