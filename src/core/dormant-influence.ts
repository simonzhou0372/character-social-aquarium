import type { AquariumDB } from '../data/db';
import { worldTime, dayOrdinal } from './calendar';
import { scheduledType, locationAccessFor } from './simulation';
import type { ActivityEvent, World, Relationship, RuntimeState } from './types';
import type { Plan } from './simulation';
import type { resolveObservation } from './selective-observation';
/** At most one sampled, first-hop macro influence per virtual day; never recurse. */
export async function dormantInfluence(
  d: AquariumDB,
  world: World,
  start: number,
  end: number,
  scope: Awaited<ReturnType<typeof resolveObservation>>,
  relations: Relationship[],
  plan: Plan,
) {
  if (
    scope.config.mode === 'full' ||
    worldTime(world, end).hour !== 18 ||
    worldTime(world, start).hour === 18
  )
    return;
  const day = dayOrdinal(worldTime(world, end));
  if (day % 4 !== 0) return;
  const relation = relations
    .filter((r) => scope.activeIds.has(r.from) && !scope.activeIds.has(r.to) && r.closeness >= 60)
    .sort((a, b) => b.closeness - a.closeness)[0];
  if (!relation) return;
  const dormant = await d.characters.get(relation.to);
  if (
    !dormant ||
    dormant.deletedAt ||
    dormant.entityMode === 'background' ||
    scheduledType(dormant, 18) === 'sleep'
  )
    return;
  const base = plan.events.find((e) => e.participants.includes(relation.from) && e.phone > 0.3);
  if (!base) return;
  const access = locationAccessFor(dormant, world);
  if (access && !access.usual.includes(base.location)) return;
  const participants = [...base.participants, dormant.id];
  // CP / group-only focus requires the relevant partner or another group member to actually attend.
  if (!scope.allowsEvent({ participants })) return;
  const conflict = await d.events
    .where('[worldId+end]')
    .between([world.id, start], [world.id, Number.MAX_SAFE_INTEGER], false, true)
    .and((e) => e.start < end && e.participants.includes(dormant.id) && e.status !== 'cancelled')
    .first();
  if (conflict) return;
  const id = `macro:${world.id}:${day}:${relation.from}`;
  const event: ActivityEvent = {
    ...base,
    id,
    type: 'social',
    participants,
    importance: 0.85,
    origin: 'macro',
    generatedAt: Date.now(),
    description: `${dormant.name}带来一条影响近期共同安排的重要消息，当事人需要在后续交流中确认。`,
  };
  plan.events = plan.events.map((e) => (e.id === base.id ? event : e));
  for (const s of plan.states)
    if (base.participants.includes(s.characterId)) {
      s.eventId = id;
      s.activity = '交流重要消息';
      s.phone = event.phone;
      s.location = event.location;
    }
  const state: RuntimeState = {
    id: `${world.id}:${dormant.id}`,
    worldId: world.id,
    characterId: dormant.id,
    eventId: id,
    activity: '临时参与重要交流',
    location: event.location,
    phone: event.phone,
    mood: 0,
    lastPhone: 0,
    lastAction: 0,
    lastTopicAt: end,
  };
  plan.states.push(state);
  return { character: dormant, event };
}
