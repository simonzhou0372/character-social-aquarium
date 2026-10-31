import Dexie from 'dexie';
import { db, type AquariumDB } from './db';
import type { Message } from '../core/types';
export const CHAT_PAGE = 40;
export const CHAT_WINDOW = 160;
export type MessageKey = [string, number, string];
export const messageKey = (m: Message): MessageKey => [m.conversationId, m.simAt, m.id];
export function historyRange(id: string, d: AquariumDB = db) {
  return d.messages
    .where('[conversationId+simAt+id]')
    .between([id, Dexie.minKey, Dexie.minKey], [id, Infinity, Dexie.maxKey]);
}
export async function messagePage(
  id: string,
  direction: 'before' | 'after',
  key?: MessageKey,
  limit = CHAT_PAGE,
  d: AquariumDB = db,
) {
  const q = d.messages
    .where('[conversationId+simAt+id]')
    .between(
      direction === 'after' && key ? key : [id, Dexie.minKey, Dexie.minKey],
      direction === 'before' && key ? key : [id, Infinity, Dexie.maxKey],
      false,
      false,
    );
  const rows = await (direction === 'before' ? q.reverse() : q).limit(limit).toArray();
  return direction === 'before' ? rows.reverse() : rows;
}
export async function messageAround(id: string, target: string, d: AquariumDB = db) {
  const m = await d.messages.get(target);
  if (!m || m.conversationId !== id) return [];
  const [before, after] = await Promise.all([
    messagePage(id, 'before', messageKey(m), 20, d),
    messagePage(id, 'after', messageKey(m), 20, d),
  ]);
  return [...before, m, ...after];
}
export async function messageAt(id: string, at: number, d: AquariumDB = db) {
  const next = await d.messages
    .where('[conversationId+simAt+id]')
    .between([id, at, Dexie.minKey], [id, Infinity, Dexie.maxKey])
    .first();
  return next ?? historyRange(id, d).reverse().first();
}
