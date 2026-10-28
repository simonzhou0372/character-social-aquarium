import { NarrativeProposalSchema } from '../core/narrative-types';
import { applyNarrativeConsequences } from '../core/narrative';
import { recordOutcome, recordValidation } from './usage-ledger';
import { DirectorSchema, applyStory } from '../core/novel';
import { z } from 'zod';
import type { AquariumDB } from '../data/db';
import type { ContentJob } from '../core/types';
import { getPrompts, composePrompt } from './prompts';
import { budgetedCompletion } from './orchestrator';
import type { Provider } from './provider';
import { parseStructuredJSON } from './structured';
const Result = z.object({
  story: DirectorSchema.optional(),
  narrative: z.array(NarrativeProposalSchema).max(8).default([]),
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
      world.novel?.enabled && !world.novel.ending ? 'novel' : 'major',
      job.snapshot,
      {
        world,
        relationships: relations.filter(
          (r) => job.event.participants.includes(r.from) && job.event.participants.includes(r.to),
        ),
        input: {
          event: job.event,
          characters,
          lifeRules: world.novel?.lifeRules,
          allowGroupChanges: world.novel?.allowGroupChanges ?? false,
          memberships: (await d.memberships.where('worldId').equals(job.worldId).toArray()).map(
            (m) => ({
              characterId: m.characterId,
              life: m.life,
              allowAutomaticDeath: m.allowAutomaticDeath === true,
            }),
          ),
          organizationStates: await d.organizationStates
            .where('worldId')
            .equals(job.worldId)
            .toArray(),
          recent: recent.map((e) => ({ type: e.type, title: e.title, description: e.description })),
          tendency: world.majorEventSettings?.tendency,
          ...(world.novel?.enabled && !world.novel.ending
            ? {
                story: world.novel,
                storyEvidence: recent
                  .filter((e) => e.status === 'occurred')
                  .map((e) => ({
                    eventId: e.eventId,
                    description: e.description,
                    timestamp: e.timestamp,
                  })),
                currentEventId: job.event.id,
              }
            : {}),
        },
      },
      '返回 JSON {"title":"事件标题","description":"对已规划重要事件的具体经过","followUp":"未来可以落实的后续安排","relationshipChanges":[{"from":"参与者ID","to":"参与者ID","delta":1,"reason":"理由"}]}。不得改变时间地点参与者，不创造已发生但不存在的旧经历，不重复近期事件类型；不得删除实体、擅改核心身份或世界规则。未启用小说生死及团体变化规则时禁止死亡、永久失踪和解散。以重要机会、决定、长期计划和有因果的互动为主。关系后果仅供配置允许时应用，幅度不超过5。' +
        (world.novel?.enabled && !world.novel.ending
          ? ` 可选 narrative:[{entityKind:"character|group",entityId:"ID",to:"目标状态",reason:"原因",evidence:"description中的逐字4字以上引文",ruleQuote:"复活规则原文引文",memberChanges:[{characterId:"ID",action:"leave|rejoin"}],successors:[]}]。没有必要则返回空数组，不为了戏剧性强行制造死亡。没有对应的合法narrative后果时，description不得宣告死亡、复活或团体解散等既成结果。死亡仅允许event.lethalCandidateIds内明确解除死亡保护且确实在事件现场的人物；不得推测失踪者已死亡。复活严格遵守lifeRules，conditional只能申请resurrecting，worldRules也必须满足配置的所有条件，不能制造万能复活。人物状态alive/missing/dead/resurrecting/resurrected。团体状态active/tension/fractured/disbanded/reconciling/reunited；重圆须经历有依据的和解，不跳过过程；新团体用successors:[{name,description,memberIds}]记录继承关系。
 小说模式：事件须向用户结局目标推进一个有因果的小步骤，不跳结局。额外返回 story:{stage:"foundation|development|turning|finale|completed",conditions:[{id:"稳定编号",description:"与用户结局目标对应的必要条件",evidence:[{eventId:"已发生或当前事件ID",quote:"该事件description中逐字存在的4字以上证据"}]}],unresolved:["未解矛盾"],milestone:"当前节点与目标的关联",ending:"仅最终阶段条件有充分过程时返回回顾结尾"}。首次建立2～8个可验证目标条件，此后沿用编号与文字不可弱化。每次最多推进一个阶段，证据必须来自实际事件，未发生计划不算完成。`
          : ''),
    ),
    job.worldId,
    world.novel?.enabled && !world.novel.ending ? 'novel' : 'major',
    job.snapshot,
    signal,
    { outputBudget: 3500, attempt: job.attempts, retryOf: job.lastRequestId },
  );
  try {
    const result = Result.parse(parseStructuredJSON(r.content));
    if (world.novel?.enabled && !world.novel.ending && !result.story)
      throw new Error('缺少可验证的剧情导演结果');
    if (
      !world.novel?.enabled &&
      /死亡|死去|永久失踪|解散|永久改变身份|分手/.test(result.description + result.followUp)
    )
      throw new Error('事件涉及默认禁止的破坏性后果');
    await recordValidation(d, r.requestId, 'accepted');
    return { ...result, usageRequestId: r.requestId };
  } catch (e) {
    await recordValidation(d, r.requestId, 'rejected', 'major-validation');
    throw e;
  }
}
export async function applyMajor(
  d: AquariumDB,
  job: ContentJob,
  result: NonNullable<Awaited<ReturnType<typeof generateMajor>>>,
) {
  return d.transaction('rw', d.tables, async () => {
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
    if (result.narrative.length)
      await applyNarrativeConsequences(job.worldId, job.event.id, result.narrative, d);
    await recordOutcome(d, result.usageRequestId, job.id, { events: 1 });
    if (result.story) await applyStory(job.worldId, job.event.id, result.story, d);
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
  });
}
