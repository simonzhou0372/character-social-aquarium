import { z } from 'zod';
import type { AquariumDB } from '../data/db';
import type { ContentJob, InPersonScene } from '../core/types';
import { SceneSchema } from '../core/types';
import { composePrompt, type PromptConfig, type PromptContext } from './prompts';
import { validateScene } from '../core/scenes';
import { requestUnits, type BatchUnit } from './batch-request';
import type { Provider } from './provider';
const Entries = z
  .object({
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
      .max(40),
  })
  .strict();
export async function generatePlannedScene(
  d: AquariumDB,
  job: ContentJob,
  snapshot: PromptConfig,
  context: PromptContext,
  provider: Provider,
  signal?: AbortSignal,
) {
  const event = job.event,
    plan = job.plan!,
    id = `scene:${event.id}`,
    count = plan.expectedPhases,
    total = plan.expectedDialogue;
  const controlVersion = (await d.checkpoints.get(job.worldId))?.controlVersion ?? 0;
  const allowed = async () => {
    const cp = await d.checkpoints.get(job.worldId);
    if (signal?.aborted || cp?.paused || (cp?.controlVersion ?? 0) !== controlVersion)
      throw new Error('时间控制已改变，阶段保留待恢复');
  };
  const stored = await d.scenes.get(id);
  const plannedPhases = Array.from({ length: count }, (_, i) => ({
    id: `${id}:phase:${i}`,
    title: count === 1 ? '共同活动' : ['活动开始', '共同活动', '活动结束'][i],
    start: event.start + Math.floor(((event.end - event.start) * i) / count),
    end: event.start + Math.floor(((event.end - event.start) * (i + 1)) / count),
    participants: event.participants,
  }));
  let scene: InPersonScene = stored ?? {
    id,
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
    plannedPhases,
    generationStatus: 'partial',
    generationCheckpoint: 0,
  };
  const drafts: Record<string, InPersonScene['phases'][number]['entries']> = structuredClone(
    (job.partial?.phases as any) ?? {},
  );
  for (let i = 0; i < count; i++) if (scene.phases[i]) drafts[String(i)] = scene.phases[i].entries;
  const desired = (i: number) => Math.floor(total / count) + (i < total % count ? 1 : 0);
  const outputLimit = (await d.profiles.get('api'))?.outputBudgetTokens ?? 2048;
  const units: BatchUnit[] = [];
  for (let i = 0; i < count; i++) {
    const p = plannedPhases[i],
      done = (drafts[String(i)] ?? []).filter((e) => e.kind === 'dialogue').length;
    if (done >= desired(i)) continue;
    const n = Math.min(desired(i) - done, Math.max(1, Math.floor((outputLimit - 400) / 330)));
    const contract = `仅返回 JSON {"entries":[{"kind":"dialogue","offset":${(p.start - event.start) / 1000 + 1},"speakerId":"合法ID","text":"对白"}]}。当前阶段 ${p.title}，必须正好生成 ${n} 条对白，不能用摘要或活动说明替代。可另加最多2条 activity。offset为相对主活动开始的秒数，范围 ${(Math.max(p.start, (drafts[String(i)] ?? []).at(-1)?.at ?? p.start) - event.start) / 1000}～${(p.end - event.start) / 1000}，按时间排序。仅允许发言者 ${p.participants.join(',')}；每条对白最多300字，禁止Markdown、服务套话与心理描写。前面已保存的条目不能重复。`;
    units.push({
      id: job.id + ':phase:' + i,
      privacy: `scene:${event.id}`,
      request: composePrompt(
        job.recovery ? 'offlineScene' : 'inPerson',
        snapshot,
        {
          ...context,
          input: { ...(context.input as any), phase: p, alreadyGenerated: drafts[String(i)] ?? [] },
        },
        contract,
      ),
      outputTokens: 180 + n * 330,
      at: p.start,
      createdAt: job.createdAt ?? Date.now(),
      scale: job.batchScale,
    });
  }
  let failure = '';
  if (units.length) {
    const batch = await requestUnits(
      d,
      event.worldId,
      job.recovery ? 'offlineScene' : 'inPerson',
      snapshot,
      units,
      provider,
      signal,
    );
    if (batch.error && !batch.values.size) throw batch.error;
    for (const u of batch.selected) {
      const i = units.indexOf(u) >= 0 ? Number(u.id.split(':').at(-1)) : -1,
        p = plannedPhases[i];
      try {
        if (!batch.values.has(u.id)) throw batch.error ?? new Error('阶段结果缺失');
        const parsed = Entries.parse(batch.values.get(u.id)),
          previous = drafts[String(i)] ?? [];
        const normalized = parsed.entries.map((e) => ({
          kind: e.kind,
          speakerId: e.speakerId,
          text: e.text,
          at: event.start + e.offset * 1000,
        }));
        const entries = [...previous, ...normalized];
        if (entries.length > 40) throw new Error('阶段条目超过结构上限，保留待拆分');
        if (entries.filter((e) => e.kind === 'dialogue').length > desired(i))
          throw new Error('阶段对白超过计划数量');
        validateScene(
          { ...scene, phases: [{ ...p, entries }] },
          event,
          200,
          snapshot.rules.allowMarkdown,
          snapshot.entries.find((e) => e.key === 'behavior')?.enabled ?? false,
        );
        drafts[String(i)] = entries;
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
    }
    await allowed();
    await d.contentJobs.update(job.id, {
      partial: { ...job.partial, phases: drafts },
      batchScale: failure ? Math.max(0.25, batch.scale / 2) : batch.scale,
    });
  }
  const phases: InPersonScene['phases'] = [];
  for (let i = 0; i < count; i++) {
    const entries = drafts[String(i)];
    if (!entries || entries.filter((e) => e.kind === 'dialogue').length !== desired(i)) break;
    phases.push({ ...plannedPhases[i], entries });
  }
  scene = {
    ...scene,
    phases,
    generationCheckpoint: phases.length,
    generationStatus: phases.length === count ? 'complete' : 'partial',
    generationError:
      phases.length === count ? undefined : failure || '部分阶段已保存，剩余对白待继续生成',
  };
  validateScene(
    scene,
    event,
    200,
    snapshot.rules.allowMarkdown,
    snapshot.entries.find((e) => e.key === 'behavior')?.enabled ?? false,
  );
  await allowed();
  await d.scenes.put(SceneSchema.parse(scene));
  return scene;
}
