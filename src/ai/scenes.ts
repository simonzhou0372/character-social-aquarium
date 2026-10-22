import { sceneDialogueBudget, validateScene } from '../core/scenes';
export { sceneDialogueBudget, validateScene } from '../core/scenes';
import { z } from 'zod';
import type { AquariumDB } from '../data/db';
import { SceneSchema, type ActivityEvent, type InPersonScene, uid } from '../core/types';
import { composePrompt, type PromptConfig } from './prompts';
import { budgetedCompletion, knownBackground, retrieveMemories } from './orchestrator';
import { parseStructuredJSON } from './structured';
import { ProviderError, type Provider } from './provider';
import { formatWorldTime } from '../core/calendar';
import { selectiveText } from './context';
const Output = z
  .object({
    title: z.string().min(1).max(200),
    phases: z
      .array(
        z
          .object({
            title: z.string().min(1).max(120),
            startOffset: z.number().nonnegative(),
            endOffset: z.number().positive(),
            participants: z.array(z.string()).min(1),
            entries: z
              .array(
                z
                  .object({
                    kind: z.enum(['dialogue', 'activity']),
                    offset: z.number().nonnegative(),
                    speakerId: z.string().optional(),
                    text: z.string().min(1).max(1000),
                  })
                  .strict(),
              )
              .min(1)
              .max(40),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
export async function generateScene(
  d: AquariumDB,
  event: ActivityEvent,
  snapshot: PromptConfig,
  provider: Provider,
  recovery = false,
  signal?: AbortSignal,
): Promise<InPersonScene> {
  if (event.participants.length < 2) throw new Error('线下场景至少两人');
  const world = await d.worlds.get(event.worldId);
  const characters = await d.characters.where('id').anyOf(event.participants).toArray();
  if (
    characters.length !== event.participants.length ||
    characters.some((c) => c.entityMode === 'background')
  )
    throw new Error('背景实体不能参加场景');
  const memberships = await d.memberships.where('worldId').equals(event.worldId).toArray();
  const relations = await d.relationships
    .where('worldId')
    .equals(event.worldId)
    .and((r) => event.participants.includes(r.from) && event.participants.includes(r.to))
    .toArray();
  const memories = await d.memories.where('worldId').equals(event.worldId).toArray();
  const actors = await Promise.all(
    characters.map(async (c) => {
      const m = memberships.find((m) => m.characterId === c.id);
      return {
        id: c.id,
        name: c.name,
        gender: c.gender,
        bio: m?.bioOverride || c.bio,
        style: selectiveText(m?.styleOverride || c.style, 250),
        personality: selectiveText(c.personality, 300),
        knownBackground: await knownBackground(d, event.worldId, c.id),
        privateMemories: retrieveMemories(
          memories,
          c.id,
          event.worldId,
          event.start,
          event.description,
        ).slice(0, 2),
      };
    }),
  );
  const limit = sceneDialogueBudget(event),
    duration = (event.end - event.start) / 1000;
  const task = recovery ? 'offlineScene' : 'inPerson';
  const contract = `仅返回 JSON {"title":"场景名","phases":[{"title":"阶段名","startOffset":0,"endOffset":60,"participants":["合法角色ID"],"entries":[{"kind":"dialogue","offset":10,"speakerId":"合法角色ID","text":"对白"},{"kind":"activity","offset":20,"text":"活动或环境说明"}]}]}。所有 offset 是相对主事件开始的秒数，范围 0～${duration}；阶段必须按时间有序不重叠，条目属于其阶段，发言者必须在该阶段。生成 2～4 个阶段（极短偶遇可一个），对白总量最多 ${limit} 条，每条最多300字。不要求填满时间。不添加、改写地点与主活动事实。禁止 Markdown 和服务式套话；不输出心理活动。活动描写单独放 activity；本任务明确不使用线上1～3条限制。每个角色的 privateMemories 与认知仅能作为该角色的已有知识，不得当作其他人的已知信息。私人记忆不会自动向同场角色公开，只有角色在场景中实际说出的内容才能传播。`;
  const request = composePrompt(
    task,
    snapshot,
    {
      world: world
        ? { name: world.name, description: world.description, rules: world.rules, era: world.era }
        : undefined,
      relationships: relations,
      input: { event, localStart: world ? formatWorldTime(world, event.start) : '', actors },
    },
    contract,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await budgetedCompletion(
      d,
      provider,
      request,
      event.worldId,
      task,
      snapshot,
      signal,
      { outputBudget: attempt ? 5000 : 3500, tightContext: attempt > 0 },
    );
    try {
      if (r.finishReason === 'length') throw new Error('场景输出截断');
      const result = Output.parse(parseStructuredJSON(r.content));
      const scene: InPersonScene = {
        id: `scene:${event.id}`,
        worldId: event.worldId,
        eventId: event.id,
        title: result.title,
        location: event.location,
        type: event.sceneType ?? event.type,
        participants: event.participants,
        start: event.start,
        end: event.end,
        promptVersion: snapshot.version,
        phases: result.phases.map((p) => ({
          id: uid('phase'),
          title: p.title,
          start: event.start + p.startOffset * 1000,
          end: event.start + p.endOffset * 1000,
          participants: p.participants,
          entries: p.entries.map((e) => ({
            kind: e.kind,
            at: event.start + e.offset * 1000,
            speakerId: e.speakerId,
            text: e.text,
          })),
        })),
      };
      return validateScene(
        scene,
        event,
        limit,
        snapshot.rules.allowMarkdown,
        snapshot.entries.find((e) => e.key === 'behavior')?.enabled ?? false,
      );
    } catch (error) {
      if (attempt)
        throw new ProviderError(
          'scene',
          `线下场景未保存：${error instanceof Error ? error.message : '结构无效'}`,
        );
      request[0].content += '\n上次结构校验失败；缩短对白，严格遵守阶段、发送者、时间与数量约束。';
    }
  }
  throw new Error('场景生成失败');
}
