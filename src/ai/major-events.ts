import { NarrativeProposalSchema } from '../core/narrative-types';
import { applyNarrativeConsequences } from '../core/narrative';
import { recordOutcome, recordValidation } from './usage-ledger';
import { DirectorSchema, applyStory } from '../core/novel';
import { z } from 'zod';
import { uid } from '../core/types';
import type { AquariumDB } from '../data/db';
import type { ContentJob } from '../core/types';
import { getPrompts, composePrompt } from './prompts';
import { budgetedCompletion } from './orchestrator';
import type { Provider } from './provider';
import { parseStructuredJSON } from './structured';
import { crisisEnabled, crisisPrompt } from '../core/crisis';
const Result = z.object({
  story: DirectorSchema.optional(),
  narrative: z.array(NarrativeProposalSchema).max(12).default([]),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(3000),
  followUp: z.string().min(1).max(1500),
  relationshipChanges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        delta: z.number().min(-20).max(20),
        trustDelta: z.number().min(-20).max(20).optional(),
        reason: z.string().max(800),
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
      -8,
    ),
    allGroupMembers = await d.groupMembers.where('worldId').equals(job.worldId).toArray(),
    groups = (await d.groups.filter((g) => g.worldIds.includes(job.worldId)).toArray()).filter(
      (g) =>
        allGroupMembers.some(
          (m) => m.groupId === g.id && job.event.participants.includes(m.characterId),
        ),
    );
  if (!major || !world) return;
  const crisis = crisisEnabled(world),
    novelMode = world.novel?.enabled === true && !world.novel.ending,
    death = novelMode && world.novel?.lifeRules?.allowDeath === true,
    groupChanges = novelMode && world.novel?.allowGroupChanges === true,
    relationshipChanges = world.majorEventSettings?.allowRelationshipChanges === true;
  const eventForPrompt = crisis
    ? job.event
    : {
        ...job.event,
        // Pending jobs created before this fix may still carry last-seven crisis copy.
        description: /文明末期|末日|终焉|最后24小时|全球灾难/.test(job.event.description)
          ? '一次与当前世界设定相关的重大事件，相关人物需要共同应对现实后果。'
          : job.event.description,
      };
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
          event: eventForPrompt,
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
          recent: recent.map((e) => ({
            type: e.type,
            level: e.level,
            title: e.title,
            description: e.description,
            timestamp: e.timestamp,
          })),
          groups: groups.map((g) => ({
            id: g.id,
            name: g.name,
            memberIds: allGroupMembers
              .filter((m) => m.groupId === g.id && !m.departedAt)
              .map((m) => m.characterId),
          })),
          crisis: crisisPrompt(world, job.event.start),
          lethalCandidateIds: job.event.lethalCandidateIds ?? [],
          lethalReason: job.event.lethalReason,
          eventLevel: job.event.majorLevel ?? 'local',
          parentEventId: job.event.parentEventId,
          chainDepth: job.event.chainDepth ?? 0,
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
      `返回 JSON {"title":"事件标题","description":"对已规划重要事件的具体经过","followUp":"未来可以落实的后续安排","relationshipChanges":[{"from":"参与者ID","to":"参与者ID","delta":5,"trustDelta":-3,"reason":"理由"}]}。事件等级 local/group/world 决定影响范围：local 影响2～5人，group 影响一个团体，world 影响多个团体和大量人物。${
        crisis
          ? '必须围绕当前危机的具体阶段、世界规则和参与者已知事实展开'
          : '必须围绕世界自身的设定、人物性格与关系、当前生活和参与者已知事实展开；不得引入与本世界无关的末日、文明崩溃或全球灾难'
      }，不得改变时间、地点、事件等级与参与者，不创造不存在的旧经历，不重复近期事件类型。` +
        (death
          ? '本次世界已开启永久死亡：若 eventLevel 为 world 或事件描述包含险情/事故/灾难/冲突，且 lethalCandidateIds 非空，可以在 narrative 中宣告其中 0～2 人死亡；description 必须写出具体死亡过程与依据，死者必须是候选且在现场/受影响范围。不得顺手杀死候选外的人，不得把死亡改写成轻伤，也不得为了凑死亡率强行制造死亡。'
          : '本次世界没有允许自动死亡：不得宣告死亡、致命伤、永久失踪或无法挽回的伤亡；lethalCandidateIds 保持为空，description 与 followUp 不得写死亡或致命结果。') +
        (groupChanges
          ? '允许团体 tension/fractured/disbanded/reconciling/reunited 与成员 leave/rejoin；group 级事件至少给出一个团体后果或明确说明为何没有。'
          : '不得宣告团体解散、分裂、永久决裂、成员退出或加入、领导权永久变更；可以写当下的争执或合作，但不能把状态变化当成既成结果。') +
        'world 级事件应产生跨团体后果。' +
        (relationshipChanges
          ? '关系变化必须有事件内依据，delta/trustDelta 范围 -20～20；不得随机抽关系改数值。'
          : '不得改变任何关系数值，relationshipChanges 必须返回空数组；description 与 followUp 不得声称关系发生永久改变、确立恋爱关系、分手或绝交。') +
        '写法要有具体动作、时间、地点与代价，避免空泛的“局势升级”。标题不得与 recent 中任何标题相同或近似；同一团体不得连续两次成为 group 级事件的主角，若必须重复，必须写出新的阶段与不同后果。' +
        (novelMode
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
    const text = `${result.title}\n${result.description}\n${result.followUp}`;
    if (!crisis && /末日|文明末期|终焉|最后24小时|全球灾难/.test(text))
      throw new Error('事件引入了与当前世界无关的末日叙事');
    if (!death && /死亡|死去|致命|永久失踪/.test(text))
      throw new Error('事件涉及当前世界未允许的死亡或失踪');
    if (
      !groupChanges &&
      /团体.{0,12}(解散|分裂|决裂|除名)|退出.{0,6}团体|加入.{0,6}团体/.test(text)
    )
      throw new Error('事件涉及当前未允许的团体状态变化');
    if (
      !relationshipChanges &&
      /永久关系变化|确立.{0,6}(恋爱|情侣)|成为恋人|恋人关系|分手|绝交|反目成仇/.test(text)
    )
      throw new Error('事件涉及当前未允许的关系变化');
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
        // New ties are the point of a crisis world: a shared disaster can create a bond that
        // did not exist in the initial package, so upsert instead of silently dropping it.
        const base = r ?? {
          id: uid('rel'),
          worldId: job.worldId,
          from: change.from,
          to: change.to,
          label: '共同经历',
          closeness: 18,
          trust: 18,
          familiarity: 12,
          stage: '初识',
          nickname: '',
          attitude: '',
          history: '',
          locked: false,
          boundaries: '',
        };
        if (base.locked) continue;
        await d.relationships.put({
          ...base,
          closeness: Math.max(0, Math.min(100, base.closeness + change.delta)),
          trust: Math.max(0, Math.min(100, base.trust + (change.trustDelta ?? 0))),
          familiarity: Math.max(
            0,
            Math.min(100, base.familiarity + Math.max(1, Math.round(Math.abs(change.delta) / 2))),
          ),
          history: [base.history, `${change.reason}`].filter(Boolean).join('\n').slice(-2000),
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
