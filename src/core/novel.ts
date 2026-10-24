import { z } from 'zod';
import { db, type AquariumDB } from '../data/db';
import { DAY, WorldSchema, type World } from './types';
import { defaultMajorSettings, nextMajorSchedule } from './major-events';
import { NovelSchema, StoryConditionSchema, type NovelConfig } from './novel-types';
export function normalizeNovel(world: World, previous?: World, at = Date.now()): World {
  const n = world.novel;
  if (n?.enabled) {
    NovelSchema.parse(n);
    const first = !previous?.novel?.enabled;
    return {
      ...world,
      novel: {
        ...n,
        startedAt: first ? at : (n.startedAt ?? at),
        previous: first
          ? { evolution: previous?.evolutionSettings, major: previous?.majorEventSettings }
          : previous?.novel?.previous,
      },
      evolutionSettings: {
        ...world.evolutionSettings,
        enabled: true,
        rules:
          world.evolutionSettings?.rules ?? '只允许有经历依据的缓慢变化，保护核心身份和锁定字段。',
      },
      majorEventSettings: { ...(world.majorEventSettings ?? defaultMajorSettings), enabled: true },
    };
  }
  if (previous?.novel?.enabled)
    return {
      ...world,
      evolutionSettings: previous.novel.previous?.evolution,
      majorEventSettings: previous.novel.previous?.major,
    };
  return world;
}
export async function saveManagedWorld(input: World, d: AquariumDB = db) {
  return d.transaction('rw', d.worlds, d.checkpoints, d.majorSchedules, async () => {
    const old = await d.worlds.get(input.id),
      cp = await d.checkpoints.get(input.id);
    if (!old || old.deletedAt) throw new Error('世界不可用');
    // Editors may have been open while a director task advanced the story.
    // Preserve the latest factual progress when the user only edits configuration.
    if (old.novel && input.novel && old.novel.goal.trim() === input.novel.goal.trim()) {
      input = {
        ...input,
        novelHistory: old.novelHistory,
        novel: { ...old.novel, enabled: input.novel.enabled, goal: input.novel.goal },
      };
    }
    let normalized = normalizeNovel(input, old, cp?.simTime);
    if (
      old.novel?.enabled &&
      input.novel?.enabled &&
      old.novel.goal.trim() !== input.novel.goal.trim()
    ) {
      normalized = {
        ...normalized,
        novelHistory: [...(old.novelHistory ?? []), old.novel],
        novel: {
          ...normalized.novel!,
          startedAt: cp?.simTime ?? Date.now(),
          stage: 'foundation',
          conditions: [],
          milestones: [],
          unresolved: [],
          ending: undefined,
        },
      };
    }
    const world = WorldSchema.parse(normalized);
    await d.worlds.put(world);
    if (
      world.majorEventSettings?.enabled &&
      (!old.majorEventSettings?.enabled ||
        world.majorEventSettings.maximumIntervalDays !== old.majorEventSettings.maximumIntervalDays)
    )
      await d.majorSchedules.put(
        nextMajorSchedule(
          world.id,
          cp?.simTime ?? Date.now(),
          world.majorEventSettings.maximumIntervalDays,
        ),
      );
    if (cp) await d.checkpoints.update(world.id, { controlVersion: (cp.controlVersion ?? 0) + 1 });
  });
}
export const DirectorSchema = z.object({
  stage: z.enum(['foundation', 'development', 'turning', 'finale', 'completed']),
  conditions: z.array(StoryConditionSchema).min(2).max(8),
  unresolved: z.array(z.string().max(500)).max(10),
  milestone: z.string().min(1).max(1000),
  ending: z.string().max(3000).optional(),
});
export type DirectorResult = z.infer<typeof DirectorSchema>;
/** Exact evidence excerpts, existing facts, monotonic phases; never mutate characters to reach a goal. */
export async function applyStory(
  worldId: string,
  eventId: string,
  proposal: DirectorResult,
  d: AquariumDB = db,
) {
  const w = await d.worlds.get(worldId),
    n = w?.novel;
  if (!w || !n?.enabled || n.ending) return;
  const cp = await d.checkpoints.get(worldId),
    events = (await d.majorEvents.where('worldId').equals(worldId).sortBy('timestamp')).filter(
      (e) =>
        e.status === 'occurred' &&
        e.timestamp >= (n.startedAt ?? 0) &&
        (!cp || e.timestamp <= cp.simTime),
    );
  const current = events.find((e) => e.eventId === eventId);
  if (!current) throw new Error('剧情节点缺少已发生事件');
  if (n.milestones.some((m) => m.eventId === eventId)) return;
  const facts = new Map(events.map((e) => [e.eventId, e]));
  const prior = n.conditions.length
    ? n.conditions
    : proposal.conditions.map((c) => ({ ...c, evidence: [] }));
  const conditions = prior.map((c) => {
    const proposed = proposal.conditions.find((p) => p.id === c.id);
    const valid = (proposed?.evidence ?? []).filter((e) => {
      const fact = facts.get(e.eventId);
      return !!fact && fact.description.includes(e.quote);
    });
    return {
      ...c,
      evidence: [
        ...new Map(
          [
            ...c.evidence.filter((e) => facts.get(e.eventId)?.description.includes(e.quote)),
            ...valid,
          ].map((e) => [e.eventId + '|' + e.quote, e]),
        ).values(),
      ].slice(-20),
    };
  });
  const stages = ['foundation', 'development', 'turning', 'finale', 'completed'] as const;
  const index = stages.indexOf(n.stage),
    requested = stages.indexOf(proposal.stage);
  let stage = stages[Math.max(index, Math.min(index + 1, requested))];
  const enough =
    events.length >= 3 &&
    current.timestamp - (n.startedAt ?? current.timestamp) >= 2 * DAY &&
    conditions.every((c) => new Set(c.evidence.map((e) => e.eventId)).size >= 2);
  if (stage === 'completed' && (!enough || n.stage !== 'finale' || !proposal.ending?.trim()))
    stage = 'finale';
  const next: NovelConfig = {
    ...n,
    stage,
    conditions,
    unresolved: proposal.unresolved,
    milestones: [...n.milestones, { eventId, summary: proposal.milestone }].slice(-500),
  };
  if (stage === 'completed' && proposal.ending)
    next.ending = {
      text: proposal.ending,
      eventIds: [...new Set(conditions.flatMap((c) => c.evidence.map((e) => e.eventId)))],
      at: current.timestamp,
    };
  await d.worlds.update(worldId, { novel: NovelSchema.parse(next) });
}
