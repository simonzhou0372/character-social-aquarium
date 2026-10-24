import { worldTime, nextWorldHour } from './calendar';
import {
  type Character,
  type World,
  type ActivityEvent,
  type RuntimeState,
  type Relationship,
  type Conversation,
  type Checkpoint,
  HOUR,
  DAY,
  activityNames,
} from './types';
export function random(seed: number) {
  const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return { seed: next, value: next / 4294967296 };
}
export function localHour(at: number, timezone: string) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(at),
  );
}
export function hourInRange(hour: number, start: number, end: number) {
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
export function scheduledType(c: Character, hour: number): ActivityEvent['type'] {
  if (hourInRange(hour, c.sleep, c.wake)) return 'sleep';
  if (hour === 12 || hour === 19) return 'meal';
  if (c.busyStart !== c.busyEnd && hourInRange(hour, c.busyStart, c.busyEnd)) return 'work';
  return 'rest';
}
export interface Plan {
  events: ActivityEvent[];
  states: RuntimeState[];
  seed: number;
  socialCandidates: string[];
}
/** A bundled profile's geography belongs to that preset, not every AU sharing its character. */
export function locationAccessFor(c: Character, world: World) {
  if (
    c.provenance &&
    (c.provenance.catalogId !== world.provenance?.catalogId ||
      (c.provenance.continuity === 'pc98') !== (world.provenance?.continuity === 'pc98'))
  )
    return undefined;
  return c.locationAccess;
}
function planHour(
  world: World,
  characters: Character[],
  relationships: Relationship[],
  checkpoint: Checkpoint,
  end: number,
  oldStates: RuntimeState[] = [],
): Plan {
  const events: ActivityEvent[] = [],
    states: RuntimeState[] = [],
    socialCandidates: string[] = [];
  let seed = checkpoint.seed;
  const start = checkpoint.simTime;
  const hour = worldTime(world, start).hour;
  for (const c of characters.filter((c) => c.entityMode !== 'background')) {
    const roll = random(seed);
    seed = roll.seed;
    const scheduled = scheduledType(c, hour);
    const type =
      scheduled === 'rest' && roll.value < (0.12 * (end - start)) / HOUR ? 'out' : scheduled;
    const access = locationAccessFor(c, world);
    const allowed = access?.usual.filter((name) => world.locations.includes(name));
    const location = access
      ? (type === 'out' || type === 'meal') && allowed?.length
        ? allowed[Math.floor(roll.value * 1000) % allowed.length]
        : access.home
      : type === 'sleep'
        ? '家'
        : type === 'work'
          ? world.locations.find((x) => /排练/.test(x)) && /乐队|鼓|键盘/.test(c.bio)
            ? '排练室'
            : (world.locations[1] ?? world.locations[0])
          : type === 'out'
            ? world.locations[Math.floor(roll.value * 1000) % world.locations.length]
            : type === 'meal'
              ? world.locations[0]
              : '家';
    const phone = type === 'sleep' ? 0 : type === 'work' ? 0.12 : type === 'meal' ? 0.5 : 0.95;
    const old = oldStates.find((s) => s.characterId === c.id);
    const id = `ev:${world.id}:${start}:${c.id}`;
    const event: ActivityEvent = {
      id,
      worldId: world.id,
      type,
      start,
      end,
      participants: [c.id],
      location,
      description: `${c.name} · ${activityNames[type]}`,
      phone,
      status: 'completed',
    };
    events.push(event);
    states.push({
      id: `${world.id}:${c.id}`,
      worldId: world.id,
      characterId: c.id,
      eventId: id,
      activity: activityNames[type],
      location,
      phone,
      mood: (roll.value - 0.5) * 0.4,
      lastPhone: old?.lastPhone ?? 0,
      lastAction: old?.lastAction ?? 0,
      lastTopicAt: old?.lastTopicAt ?? checkpoint.simTime,
    });
    if (phone > 0.3) socialCandidates.push(c.id);
  }
  // One joint event replaces individual events; participants cannot occupy two locations.
  const roll = random(seed);
  seed = roll.seed;
  if (roll.value < (0.4 * (end - start)) / HOUR && socialCandidates.length > 1) {
    const a = socialCandidates[Math.floor(roll.value * 100) % socialCandidates.length];
    const relation = relationships
      .filter((r) => r.from === a && socialCandidates.includes(r.to))
      .sort((a, b) => b.closeness - a.closeness)[0];
    if (relation) {
      const companions =
        roll.seed % 3 === 0
          ? relationships
              .filter(
                (r) =>
                  r.from === a &&
                  r.to !== relation.to &&
                  r.closeness >= 55 &&
                  socialCandidates.includes(r.to),
              )
              .slice(0, roll.seed % 7 === 0 ? 2 : 1)
              .map((r) => r.to)
          : [];
      const pair = [...new Set([a, relation.to, ...companions])],
        id = `joint:${world.id}:${start}:${a}`;
      const sharedPlaces = world.locations.filter((name) =>
        pair.every((id) => {
          const person = characters.find((c) => c.id === id);
          const access = person && locationAccessFor(person, world);
          return !access || access.usual.includes(name);
        }),
      );
      if (!sharedPlaces.length) return { events, states, seed, socialCandidates };
      for (let i = events.length - 1; i >= 0; i--)
        if (pair.includes(events[i].participants[0])) events.splice(i, 1);
      const location = sharedPlaces[Math.floor(roll.value * 20) % sharedPlaces.length];
      events.push({
        id,
        worldId: world.id,
        type: 'social',
        sceneType: /排练|音乐/.test(location)
          ? 'rehearsal'
          : /咖啡|餐/.test(location)
            ? 'meal'
            : /海|公园/.test(location)
              ? 'walk'
              : 'gathering',
        importance: Math.min(1, 0.4 + relation.closeness / 200),
        start,
        end,
        participants: pair,
        location,
        description: `${pair.map((id) => characters.find((c) => c.id === id)?.name).join('、')} 一起在${location}`,
        phone: 0.08,
        status: 'completed',
      });
      states.forEach((s) => {
        if (pair.includes(s.characterId)) {
          s.eventId = id;
          s.activity = '一起活动';
          s.location = location;
          s.phone = 0.08;
        }
      });
    }
  }
  return { events, states, seed, socialCandidates };
}
export function socialWeight(
  c: Character,
  state: RuntimeState,
  conversation: Conversation,
  relations: Relationship[],
  lastMessageAt: number,
  at: number,
  hasUnreplied: boolean,
  cooldownMinutes = 30,
) {
  if (
    state.phone === 0 ||
    conversation.controlledId === c.id ||
    !conversation.participants.includes(c.id)
  )
    return 0;
  const affinity = relations
    .filter((r) => r.from === c.id && conversation.participants.includes(r.to))
    .reduce(
      (v, r) => Math.max(v, (r.closeness * 0.45 + r.familiarity * 0.35 + r.trust * 0.2) / 100),
      0.25,
    );
  const initiativeScale = relations
    .filter((r) => r.from === c.id && conversation.participants.includes(r.to))
    .reduce((v, r) => Math.max(v, r.behavior?.initiativeScale ?? 1), 0.1);
  const relationshipScale = relations.some(
    (r) => r.from === c.id && conversation.participants.includes(r.to),
  )
    ? initiativeScale
    : 1;
  const cooldown = Math.min(1, Math.max(0, (at - state.lastAction) / (cooldownMinutes * 60000)));
  const stale = at - lastMessageAt > 6 * HOUR ? 0.6 : 1;
  return (
    state.phone *
    c.phoneHabit *
    (hasUnreplied ? 1 : relationshipScale) *
    (hasUnreplied ? c.replyChance : c.initiative) *
    (0.4 + affinity * 0.6) *
    cooldown *
    stale *
    (1 + state.mood * 0.2)
  );
}
export function segmentEnd(cp: Checkpoint, target: number) {
  const remaining = target - cp.simTime;
  const step =
    remaining > 30 * DAY ? DAY : remaining > 7 * DAY ? 6 * HOUR : remaining > DAY ? 3 * HOUR : HOUR;
  return Math.min(
    target,
    cp.simTime + step,
    Math.ceil((cp.simTime + 1) / HOUR) * HOUR + (step - HOUR),
  );
}

export function planSegment(
  world: World,
  characters: Character[],
  relationships: Relationship[],
  checkpoint: Checkpoint,
  end: number,
  oldStates: RuntimeState[] = [],
): Plan {
  let start = checkpoint.simTime,
    seed = checkpoint.seed,
    states = oldStates;
  const events: ActivityEvent[] = [];
  let socialCandidates: string[] = [];
  while (start < end) {
    const stop = Math.min(end, nextWorldHour(world, start));
    const plan = planHour(
      world,
      characters,
      relationships,
      { ...checkpoint, simTime: start, seed },
      stop,
      states,
    );
    events.push(...plan.events);
    states = plan.states;
    socialCandidates = plan.socialCandidates;
    seed = plan.seed;
    start = stop;
  }
  return { events, states, seed, socialCandidates };
}

export function topicPolicy(c: Character) {
  return {
    mode: c.initiationMode ?? (c.initiative === 0 ? 'never' : 'interval'),
    minutes: c.topicIntervalMinutes ?? Math.round(240 - c.initiative * 210),
  };
}
export function topicDue(
  c: Character,
  state: RuntimeState,
  at: number,
  important: boolean,
  scale = 1,
) {
  const p = topicPolicy(c);
  if (p.mode === 'never') return false;
  if (p.mode === 'important') return important && at - state.lastAction >= 6 * HOUR;
  return at - (state.lastTopicAt ?? at) >= p.minutes * 60000 * (c.topicIntervalMinutes ? 1 : scale);
}
