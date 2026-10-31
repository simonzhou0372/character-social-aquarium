import { db, type AquariumDB } from './db';
import type { Conversation, InPersonScene } from '../core/types';
export type SceneLink = Pick<
  InPersonScene,
  'id' | 'eventId' | 'title' | 'start' | 'participants' | 'location'
>;
export type SceneLinkMode = 'all' | 'mutual' | 'off';
/** Keep only link metadata; the caller decides whether a group preview may include absent members. */
export async function sceneLinks(
  c: Conversation,
  from = -Infinity,
  to = Infinity,
  offset = 0,
  limit = 30,
  reverse = false,
  d: AquariumDB = db,
  mode: SceneLinkMode = 'mutual',
) {
  if (mode === 'off' || c.kind === 'notes' || c.participants.length < 2) return [];
  // Group chats surface an in-person event when anyone in the room was there;
  // direct chats only surface events that both people shared, even if others joined.
  const matches =
    mode === 'all' && c.kind === 'group'
      ? (s: InPersonScene) => s.participants.some((id) => c.participants.includes(id))
      : (s: InPersonScene) => c.participants.every((id) => s.participants.includes(id));
  let query = d.scenes
    .where('[worldId+start]')
    .between([c.worldId, from], [c.worldId, to], true, true)
    .filter(matches);
  if (reverse) query = query.reverse();
  const links: SceneLink[] = [],
    seen = new Set<string>();
  await query
    .offset(offset)
    .limit(limit)
    .each((s) => {
      if (seen.has(s.eventId)) return;
      seen.add(s.eventId);
      links.push({
        id: s.id,
        eventId: s.eventId,
        title: s.title,
        start: s.start,
        participants: s.participants,
        location: s.location,
      });
    });
  return links;
}
