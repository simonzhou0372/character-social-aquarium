import type { ActivityEvent, InPersonScene } from './types';
export type SceneFilter = {
  worldId?: string;
  from?: number;
  to?: number;
  participants?: string[];
  match?: 'any' | 'all';
  groupMembers?: string[];
  location?: string;
  type?: string;
};
export function filterScenes(scenes: InPersonScene[], f: SceneFilter) {
  return scenes
    .filter(
      (s) =>
        (!f.worldId || s.worldId === f.worldId) &&
        (f.from === undefined || s.end >= f.from) &&
        (f.to === undefined || s.start <= f.to) &&
        (!f.participants?.length ||
          (f.match === 'all'
            ? f.participants.every((id) => s.participants.includes(id))
            : f.participants.some((id) => s.participants.includes(id)))) &&
        (f.groupMembers === undefined ||
          f.groupMembers.some((id) => s.participants.includes(id))) &&
        (!f.location || s.location === f.location) &&
        (!f.type || s.type === f.type),
    )
    .sort((a, b) => b.start - a.start);
}
export type TimelineView = 'featured' | 'all' | 'social' | 'shared' | 'personal' | 'routine';
export function featuredEvent(e: ActivityEvent, hasScene = false) {
  return (
    hasScene ||
    e.participants.length > 1 ||
    e.type === 'social' ||
    e.type === 'out' ||
    /失眠|约定|冲突|意外|演出|约会|聚会|重要|告白/.test(e.description)
  );
}
export function timelineMatches(e: ActivityEvent, view: TimelineView, hasScene = false) {
  switch (view) {
    case 'all':
      return true;
    case 'featured':
      return featuredEvent(e, hasScene);
    case 'social':
      return e.type === 'social' || hasScene;
    case 'shared':
      return e.participants.length > 1;
    case 'personal':
      return e.participants.length === 1 && featuredEvent(e, hasScene);
    case 'routine':
      return !featuredEvent(e, hasScene);
  }
}
export function mergeRoutine(events: ActivityEvent[]) {
  const result: ActivityEvent[] = [];
  for (const e of [...events].sort((a, b) => a.start - b.start)) {
    const last = [...result]
      .reverse()
      .find(
        (x) =>
          x.type === e.type &&
          x.location === e.location &&
          x.end === e.start &&
          x.participants.join() === e.participants.join() &&
          !featuredEvent(x) &&
          !featuredEvent(e),
      );
    if (last) last.end = e.end;
    else result.push({ ...e });
  }
  return result.sort((a, b) => b.start - a.start);
}
