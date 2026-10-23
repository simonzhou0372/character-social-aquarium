import { historicalCharacter } from '../core/selective-observation';
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
              .max(160)
              .optional(),
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
  const memories = await d.memories
    .where('owners')
    .anyOf(event.participants)
    .distinct()
    .and((m) => m.worldId === event.worldId && m.at <= event.start)
    .toArray();
  const actors = await Promise.all(
    characters.map(async (c) => {
      const m = memberships.find((m) => m.characterId === c.id);
      c = await historicalCharacter(d, c, m, event.worldId, event.start);
      return {
        id: c.id,
        name: c.name,
        gender: c.gender,
        bio: m?.bioOverride || c.bio,
        style: selectiveText(m?.styleOverride || c.style, 250),
        personality: selectiveText(c.personality, 300),
        knownBackground: await knownBackground(d, event.worldId, c.id, event.start),
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
  const contract = `仅返回 JSON {"title":"场景名","phases":[{"title":"阶段名","startOffset":0,"endOffset":60,"participants":["合法角色ID"],"entries":[{"kind":"dialogue","offset":10,"speakerId":"合法角色ID","text":"对白"},{"kind":"activity","offset":20,"text":"活动或环境说明"}]}]}。所有 offset 是相对主事件开始的秒数，范围 0～${duration}；阶段必须按时间有序不重叠，条目属于其阶段，发言者必须在该阶段。生成 2～4 个阶段（极短偶遇可一个），对白总量建议约 ${limit} 条，可根据场景自然调整，每条最多300字。不要求填满时间。不添加、改写地点与主活动事实。禁止 Markdown 和服务式套话；不输出心理活动。活动描写单独放 activity；本任务明确不使用线上1～3条限制。每个角色的 privateMemories 与认知仅能作为该角色的已有知识，不得当作其他人的已知信息。私人记忆不会自动向同场角色公开，只有角色在场景中实际说出的内容才能传播。`;
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

  const stored = await d.scenes.get(`scene:${event.id}`);
  let scene: InPersonScene = stored ?? {
    id: `scene:${event.id}`,
    worldId: event.worldId,
    eventId: event.id,
    title: event.description.slice(0, 200),
    location: event.location,
    type: event.sceneType ?? event.type,
    participants: event.participants,
    start: event.start,
    end: event.end,
    promptVersion: snapshot.version,
    phases: [],
    generationStatus: 'partial',
    generationCheckpoint: 0,
  };
  let plan: ReturnType<typeof Output.parse>;
  if (stored?.plannedPhases?.length) {
    plan = {
      title: stored.title,
      phases: stored.plannedPhases.map((p) => ({
        title: p.title,
        startOffset: (p.start - event.start) / 1000,
        endOffset: (p.end - event.start) / 1000,
        participants: p.participants,
      })),
    };
  } else {
    request[0].content +=
      '\n本次仅规划阶段，phases只填写标题、起止偏移与参与者，不要生成entries。之后逐阶段生成并保存对白。每阶段对白建议数按时长/人数分配；对白条数是建议，不是结构损坏判据。';
    const result = await budgetedCompletion(
      d,
      provider,
      request,
      event.worldId,
      task,
      snapshot,
      signal,
      { outputBudget: 3500 },
    );
    try {
      plan = Output.parse(parseStructuredJSON(result.content));
    } catch (e) {
      throw new ProviderError(
        result.finishReason === 'length' ? 'truncated' : 'scene-plan',
        `场景阶段规划无法读取：${e instanceof Error ? e.message : 'JSON 错误'}；可继续生成。`,
      );
    }
    scene = {
      ...scene,
      title: plan.title,
      plannedPhases: plan.phases.map((p, i) => ({
        id: `${scene.id}:phase:${i}`,
        title: p.title,
        start: event.start + p.startOffset * 1000,
        end: event.start + p.endOffset * 1000,
        participants: p.participants,
      })),
    };
    // Validate the entire temporal plan before issuing more requests.
    let previous = event.start;
    for (const p of scene.plannedPhases!) {
      if (
        p.start < previous ||
        p.end <= p.start ||
        p.end > event.end ||
        p.participants.some((id) => !event.participants.includes(id)) ||
        new Set(p.participants).size !== p.participants.length
      )
        throw new ProviderError('scene-plan', '场景阶段时间或人物无效');
      previous = p.end;
    }
  }
  const save = async () => {
    if (signal?.aborted) throw new ProviderError('cancelled', '任务已取消');
    if (await d.events.get(event.id)) await d.scenes.put(SceneSchema.parse(scene));
  };
  await save();
  for (let i = scene.generationCheckpoint ?? scene.phases.length; i < plan.phases.length; i++) {
    const p = plan.phases[i];
    let failure = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let entries = p.entries;
        if (!entries || attempt) {
          const phasePrompt = composePrompt(
            task,
            snapshot,
            {
              world: world ? { name: world.name, rules: world.rules } : undefined,
              input: {
                event,
                actors,
                phase: p,
                previousPhaseSummary: scene.phases.at(-1)?.entries.slice(-3),
                failure,
              },
            },
            `仅生成当前阶段，返回 JSON {"entries":[{"kind":"dialogue","offset":${p.startOffset + 1},"speakerId":"合法ID","text":"对白"},{"kind":"activity","offset":${p.startOffset + 2},"text":"活动说明"}]}。offset相对主事件开始秒数，范围 ${p.startOffset}～${p.endOffset}。对白建议 ${Math.max(4, Math.ceil(limit / plan.phases.length))} 条，可自然增加。不要生成其他阶段；对白禁止 Markdown、服务套话及心理描写。参与者只可使用 ${p.participants.join(',')}。`,
          );
          const response = await budgetedCompletion(
            d,
            provider,
            phasePrompt,
            event.worldId,
            task,
            snapshot,
            signal,
            { outputBudget: attempt ? 5000 : 3500, tightContext: attempt > 0 },
          );
          if (response.finishReason === 'length')
            throw new ProviderError('truncated', '当前阶段输出被截断');
          entries = z
            .object({ entries: Output.shape.phases.element.shape.entries.unwrap() })
            .parse(parseStructuredJSON(response.content)).entries;
        }
        const normalized: InPersonScene['phases'][number]['entries'] = [];
        for (const entry of entries ?? []) {
          const chars = Array.from(entry.text);
          if (entry.kind === 'dialogue' && chars.length > 300) {
            for (let n = 0; n < chars.length; n += 300)
              normalized.push({
                kind: entry.kind,
                speakerId: entry.speakerId,
                at: event.start + entry.offset * 1000,
                text: chars.slice(n, n + 300).join(''),
              });
          } else
            normalized.push({
              kind: entry.kind,
              speakerId: entry.speakerId,
              at: event.start + entry.offset * 1000,
              text: entry.text,
            });
        }
        // Split oversized phase batches without dropping words or charging activity entries as dialogue.
        const parts: InPersonScene['phases'] = [];
        for (let n = 0; n < normalized.length; n += 40) {
          const chunk = normalized.slice(n, n + 40);
          parts.push({
            id: uid('phase'),
            title: p.title + (n ? ` · 续 ${n / 40 + 1}` : ''),
            start: n ? chunk[0].at : event.start + p.startOffset * 1000,
            end:
              n + 40 < normalized.length ? normalized[n + 40].at : event.start + p.endOffset * 1000,
            participants: p.participants,
            entries: chunk,
          });
        }
        const candidate = {
          ...scene,
          phases: [...scene.phases, ...parts],
          generationCheckpoint: i + 1,
          generationStatus: 'partial' as const,
          generationError: undefined,
        };
        validateScene(
          candidate,
          event,
          1280,
          snapshot.rules.allowMarkdown,
          snapshot.entries.find((e) => e.key === 'behavior')?.enabled ?? false,
        );
        scene = candidate;
        await save();
        failure = '';
        break;
      } catch (e) {
        if (signal?.aborted) throw e;
        failure = e instanceof Error ? e.message : '阶段生成失败';
        if (
          e instanceof ProviderError &&
          ['budget', 'rate', 'quota', 'network', 'server', 'missing', 'invalid'].includes(e.code)
        )
          break;
      }
    }
    if (failure) {
      scene = {
        ...scene,
        generationStatus: 'partial',
        generationError: `阶段 ${i + 1} 未完成：${failure}`,
      };
      await save();
      return scene;
    }
  }
  scene = { ...scene, generationStatus: 'complete', generationError: undefined };
  await save();
  return scene;
}
