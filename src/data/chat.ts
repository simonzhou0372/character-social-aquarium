import { db, type AquariumDB } from './db';
import { clockTarget } from '../core/time';
import { foregroundStart } from '../core/clock-presence';
import { uid, type Message } from '../core/types';
export async function toggleReaction(
  messageId: string,
  actorId: string,
  emoji: string,
  d: AquariumDB = db,
) {
  if (!['👍', '❤️', '😂', '😮', '😢', '🎉', '👀', '🙏'].includes(emoji))
    throw new Error('不支持此回应');
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
