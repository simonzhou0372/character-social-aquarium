import { z } from 'zod';
import type { AquariumDB } from '../data/db';
import type { ContentJob } from '../core/types';
import { getPrompts, composePrompt } from './prompts';
import { budgetedCompletion } from './orchestrator';
import type { Provider } from './provider';
import { parseStructuredJSON } from './structured';
const Result = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(3000),
  followUp: z.string().min(1).max(1500),
  relationshipChanges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        delta: z.number().min(-5).max(5),
        reason: z.string().max(500),
      }),
    )
    .max(8)
    .default([]),
});
export async function generateMajor(
  d: AquariumDB,
  job: ContentJob,
  provider: Provider,
  signal?: AbortSignal,
) {
  const world = await d.worlds.get(job.worldId),
    major = await d.majorEvents.where('eventId').equals(job.event.id).first(),
    characters = await d.characters.where('id').anyOf(job.event.participants).toArray(),
    relations = await d.relationships.where('worldId').equals(job.worldId).toArray(),
    recent = (await d.majorEvents.where('worldId').equals(job.worldId).sortBy('timestamp')).slice(
      -5,
    );
  if (!major || !world) return;
  const r = await budgetedCompletion(
    d,
    provider,
    composePrompt(
      'life',
      job.snapshot,
      {
        world,
        relationships: relations.filter(
          (r) => job.event.participants.includes(r.from) && job.event.participants.includes(r.to),
        ),
        input: {
          event: job.event,
          characters,
          recent: recent.map((e) => ({ type: e.type, title: e.title, description: e.description })),
          tendency: world.majorEventSettings?.tendency,
        },
      },
      '返回 JSON {"title":"事件标题","description":"对已规划重要事件的具体经过","followUp":"未来可以落实的后续安排","relationshipChanges":[{"from":"参与者ID","to":"参与者ID","delta":1,"reason":"理由"}]}。不得改变时间地点参与者，不创造已发生但不存在的旧经历，不重复近期事件类型；不得自动制造死亡、永久失踪、永久身份变化、解散团体、分手、删除、改变世界规则或锁定人设。以重要机会、决定、长期计划和有因果的互动为主。关系后果仅供配置允许时应用，幅度不超过5。',
    ),
    job.worldId,
    'life',
    job.snapshot,
    signal,
    { outputBudget: 3500 },
  );
  const result = Result.parse(parseStructuredJSON(r.content));
  if (/死亡|死去|永久失踪|解散|永久改变身份|分手/.test(result.description + result.followUp))
    throw new Error('事件涉及默认禁止的破坏性后果');
  return result;
}
export async function applyMajor(
  d: AquariumDB,
  job: ContentJob,
  result: NonNullable<Awaited<ReturnType<typeof generateMajor>>>,
) {
  const world = await d.worlds.get(job.worldId),
    major = await d.majorEvents.where('eventId').equals(job.event.id).first();
  if (!world || !major || major.status === 'occurred') return;
  const consequences: typeof major.consequences = [
    { kind: 'followUp', description: result.followUp },
  ];
  if (world.majorEventSettings?.allowRelationshipChanges)
    for (const change of result.relationshipChanges) {
      if (
        !job.event.participants.includes(change.from) ||
        !job.event.participants.includes(change.to) ||
        change.from === change.to
      )
        throw new Error('关系后果端点非法');
      const r = await d.relationships
        .where('[worldId+from+to]')
        .equals([job.worldId, change.from, change.to])
        .first();
      if (!r || r.locked) continue;
      await d.relationships.update(r.id, {
        closeness: Math.max(0, Math.min(100, r.closeness + change.delta)),
      });
      consequences.push({
        kind: 'relationship',
        description: change.reason,
        from: change.from,
        to: change.to,
        delta: change.delta,
      });
    }
  await d.majorEvents.update(major.id, {
    title: result.title,
    description: result.description,
    consequences,
    status: 'occurred',
  });
  await d.events.update(job.event.id, { description: result.description });
  await d.memories.put({
    id: `major-memory:${major.id}`,
    worldId: job.worldId,
    owners: job.event.phone > 0 ? job.event.participants : [],
    content: result.description + ' 后续：' + result.followUp,
    keywords: [job.event.location, major.type],
    importance: 0.95,
    at: job.event.end,
    eventId: job.event.id,
    kind: 'episode',
  });
}
