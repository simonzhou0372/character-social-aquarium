import Dexie from 'dexie';
import { z } from 'zod';
import type { AquariumDB } from '../data/db';
import type { ContentJob } from '../core/types';
import { MAX_READY_CONTENT, activeConversations } from '../core/adaptive-batching';
import { resolveObservation } from '../core/selective-observation';
import { composePrompt } from './prompts';
import { dialogueContract, ProviderError, type Provider } from './provider';
import {
  dialogueContext,
  parseDialogue,
  validateGenerated,
  persistDialogue,
  liveProvider,
} from './orchestrator';
import { requestUnits, type BatchUnit } from './batch-request';
import { generateScene } from './scenes';
import { recordHeardInformation } from '../data/knowledge';
export async function contentSnapshot(job: ContentJob, d: AquariumDB) {
  if (!job.snapshotId) return job.snapshot;
  const saved = await d.taskSnapshots.get(job.snapshotId);
  if (!saved) throw new Error('任务提示词快照缺失，请从完整备份恢复；不会换用新规则');
  return saved.config;
}
async function candidates(worldId: string, d: AquariumDB) {
  const out: ContentJob[] = [];
  const settings = await d.settings.get('app');
  if (settings?.unlimitedUsage)
    await d.contentJobs
      .where('[worldId+status+at]')
      .between([worldId, 'failed', Dexie.minKey], [worldId, 'failed', Dexie.maxKey])
      .filter((j) => j.errorCode === 'budget')
      .limit(MAX_READY_CONTENT)
      .modify({ attempts: 0, nextAttemptAt: 0, errorCode: undefined });
  const viewed = activeConversations.get(worldId);
  if (viewed)
    for (const status of ['pending', 'failed'])
      out.push(
        ...(await d.contentJobs
          .where('[worldId+conversation.id+status+at]')
          .between([worldId, viewed, status, Dexie.minKey], [worldId, viewed, status, Dexie.maxKey])
          .filter((j) => !!j.plan && j.attempts < 3 && j.nextAttemptAt <= Date.now())
          .limit(MAX_READY_CONTENT)
          .toArray()),
      );

  for (const status of ['pending', 'failed', 'running']) {
    const rows = await d.contentJobs
      .where('[worldId+status+at]')
      .between([worldId, status, Dexie.minKey], [worldId, status, Dexie.maxKey])
      .filter((j) => !!j.plan && j.attempts < 3 && j.nextAttemptAt <= Date.now())
      .limit(MAX_READY_CONTENT)
      .toArray();
    out.push(...rows);
  }
  return [...new Map(out.map((j) => [j.id, j])).values()]
    .sort(
      (a, b) =>
        Number(b.conversation?.id === activeConversations.get(worldId)) -
          Number(a.conversation?.id === activeConversations.get(worldId)) || a.at - b.at,
    )
    .slice(0, MAX_READY_CONTENT);
}
export async function drainAdaptive(
  worldId: string,
  d: AquariumDB,
  provider: Provider | undefined,
  signal: AbortSignal,
) {
  const cp = await d.checkpoints.get(worldId);
  if (!cp || cp.paused || signal.aborted) return;
  const version = cp.controlVersion ?? 0,
    jobs = await candidates(worldId, d),
    scope = await resolveObservation(worldId, d);
  const ready: ContentJob[] = [];
  for (const job of jobs) {
    if (job.at > cp.simTime || job.event.end > cp.simTime) continue;
    if (
      (await d.contentJobs.bulkGet(job.dependsOn ?? [])).some((j) => !j || j.status !== 'complete')
    )
      continue;
    if (
      !(job.kind === 'chat' && job.conversation
        ? scope.allowsConversation(job.conversation) ||
          (job.event.origin === 'macro' && scope.allowsEvent(job.event))
        : scope.allowsEvent(job.event))
    )
      continue;
    const actors = await d.characters.bulkGet(job.event.participants);
    const recycled =
      actors.some((c) => !c || c.deletedAt) ||
      !!(job.conversation?.groupId && (await d.groups.get(job.conversation.groupId))?.deletedAt);
    if (
      actors.some((c) => !c || c.deletedAt || c.entityMode === 'background') ||
      job.event.participants.some(
        (id) => !scope.members.some((m) => m.characterId === id && !m.inactive),
      ) ||
      (job.conversation?.groupId && (await d.groups.get(job.conversation.groupId))?.deletedAt)
    ) {
      await d.contentJobs.update(job.id, {
        status: 'failed',
        attempts: 3,
        error: recycled
          ? '对象已移入回收站，任务保留待恢复'
          : '对象已移除或转为背景，任务保留待恢复',
      });
      continue;
    }
    if (!(await d.events.get(job.event.id))) continue;
    if (job.kind === 'chat' && job.conversation) {
      const c = await d.conversations.get(job.conversation.id);
      if (!c || c.controlledId === job.speakerId) continue;
      job.conversation = c;
    }
    ready.push(job);
  }
  if (!ready.length) return;
  const client = provider ?? (await liveProvider(d));
  // One scene per drain yields the generation slot back to user work between micro-batches.
  const scene = ready.find((j) => j.kind === 'scene');
  const first =
    ready[0].kind === 'scene' ? scene : ready.find((j) => j.kind === 'chat' || j.kind === 'life');
  if (!first) return;
  const snapshot = await contentSnapshot(first, d);
  const commitAllowed = async () => {
    const c = await d.checkpoints.get(worldId);
    return !!c && !c.paused && (c.controlVersion ?? 0) === version && !signal.aborted;
  };
  if (first.kind === 'scene') {
    await d.contentJobs.update(first.id, {
      status: 'running',
      attempts: first.attempts + 1,
      nextAttemptAt: Date.now() + 180000,
    });
    try {
      const result = await generateScene(
        d,
        first.event,
        snapshot,
        client,
        first.recovery,
        signal,
        first,
      );
      if (!(await commitAllowed())) {
        await d.contentJobs.update(first.id, { status: 'pending', nextAttemptAt: 0 });
        return;
      }
      const latest = await d.contentJobs.get(first.id),
        progress = JSON.stringify(latest?.partial) !== JSON.stringify(first.partial);
      await d.contentJobs.update(first.id, {
        status:
          result.generationStatus === 'complete' ? 'complete' : progress ? 'pending' : 'failed',
        attempts: progress ? 0 : first.attempts + 1,
        nextAttemptAt: progress ? 0 : Date.now() + 30000,
        completedAt: result.generationStatus === 'complete' ? Date.now() : undefined,
        error: result.generationError,
      });
      if (result.generationStatus === 'complete')
        for (const p of result.phases)
          for (const e of p.entries)
            if (e.kind === 'dialogue' && e.speakerId)
              await recordHeardInformation(
                d,
                worldId,
                e.speakerId,
                e.text,
                p.participants,
                `线下场景 ${result.id} · ${e.at}`,
                e.at,
              );
    } catch (e) {
      await d.contentJobs.update(first.id, {
        status: signal.aborted ? 'pending' : 'failed',
        error: String(e),
        errorCode: e instanceof ProviderError ? e.code : 'validation',
        nextAttemptAt: signal.aborted ? 0 : Date.now() + 30000,
      });
    }
    return;
  }
  const units: BatchUnit[] = [],
    byId = new Map<string, ContentJob>();
  for (const job of ready
    .filter(
      (j) =>
        j.kind === first.kind &&
        (j.kind !== 'chat' ||
          (j.speakerId === first.speakerId &&
            JSON.stringify([...(j.conversation?.participants ?? [])].sort()) ===
              JSON.stringify([...(first.conversation?.participants ?? [])].sort()))) &&
        j.snapshot.version === first.snapshot.version &&
        j.snapshot.updatedAt === first.snapshot.updatedAt &&
        j.recovery === first.recovery,
    )
    .slice(0, MAX_READY_CONTENT)) {
    let request: BatchUnit['request'],
      privacy = 'life:' + worldId;
    if (job.kind === 'life') {
      const w = await d.worlds.get(worldId);
      request = composePrompt(
        job.recovery ? 'recovery' : 'life',
        snapshot,
        { world: w, state: job.event },
        '仅返回 JSON {"description":"一句客观活动描述"}。不得更改已有时间、地点、人物与类型，不添加新事实或对白。',
      );
    } else {
      const c = job.conversation!,
        speaker = job.speakerId!,
        context = await dialogueContext(d, c, speaker, job.at);
      const previous = job.partial?.dialogue as ReturnType<typeof parseDialogue> | undefined,
        remaining = job.plan!.expectedMessages - (previous?.messages.length ?? 0);
      if (remaining <= 0) continue;
      context.state = job.state as any;
      context.input = {
        ...context.input,
        currentEvent: job.event,
        alreadyGenerated: previous,
      } as any;
      const exact = {
        ...snapshot,
        rules: {
          ...snapshot.rules,
          minMessages: remaining,
          maxMessages: remaining,
          allowSilence: false,
        },
      };
      request = composePrompt(
        job.recovery ? 'recoveryChat' : 'chat',
        exact,
        context,
        dialogueContract(speaker, exact) +
          ` 必须正好生成 ${remaining} 条新消息，不能用表情回应替代，不重复 alreadyGenerated；偏移须不早于 ${previous?.offsets?.at(-1) ?? 0} 秒。`,
      );
      // Byte-identical authorized knowledge and participants only. No private context is pooled across audiences.
      privacy = JSON.stringify([
        worldId,
        speaker,
        [...c.participants].sort(),
        context.character,
        context.relationships,
        context.memories,
        context.history,
        (context.input as any).backgroundKnowledge,
      ]);
    }
    units.push({
      id: job.id,
      privacy,
      request,
      outputTokens:
        job.kind === 'life'
          ? 240
          : 220 +
            (job.plan!.expectedMessages - (job.partial?.dialogue as any)?.messages?.length ||
              job.plan!.expectedMessages) *
              150,
      at: job.at,
      createdAt: job.createdAt ?? Date.now(),
      scale: job.batchScale,
    });
    byId.set(job.id, job);
    if (job.kind === 'chat' && units.length >= 12) break;
  }
  if (!units.length) return;
  // Claims precede network I/O; a crash leaves stable IDs and a reclaimable lease.
  for (const u of units) {
    const j = byId.get(u.id)!;
    await d.contentJobs.update(j.id, {
      status: 'running',
      attempts: j.attempts + 1,
      nextAttemptAt: Date.now() + 180000,
    });
  }
  let batch: Awaited<ReturnType<typeof requestUnits>>;
  try {
    batch = await requestUnits(
      d,
      worldId,
      first.kind === 'life'
        ? first.recovery
          ? 'recovery'
          : 'life'
        : first.recovery
          ? 'recoveryChat'
          : 'chat',
      snapshot,
      units,
      client,
      signal,
    );
  } catch (e) {
    for (const u of units)
      await d.contentJobs.update(u.id, {
        status: signal.aborted ? 'pending' : 'failed',
        nextAttemptAt: signal.aborted ? 0 : Date.now() + 30000,
        error: String(e),
        errorCode: e instanceof ProviderError ? e.code : 'validation',
      });
    return;
  }
  const selected = new Set(batch.selected.map((u) => u.id));
  for (const u of units)
    if (!selected.has(u.id))
      await d.contentJobs.update(u.id, {
        status: 'pending',
        attempts: byId.get(u.id)!.attempts,
        nextAttemptAt: 0,
      });
  for (const u of batch.selected) {
    const job = byId.get(u.id)!;
    try {
      if (!batch.values.has(u.id)) throw batch.error ?? new Error('批次缺少该任务，保留待恢复');
      const value = batch.values.get(u.id);
      let result: (ReturnType<typeof parseDialogue> & { gifMessageIndex?: number }) | undefined,
        description: string | undefined;
      if (job.kind === 'life')
        description = z
          .object({ description: z.string().min(1).max(200) })
          .strict()
          .parse(value).description;
      else {
        const rules = {
          ...snapshot,
          rules: { ...snapshot.rules, minMessages: 1, allowSilence: false },
        };
        result = await validateGenerated(
          d,
          job.conversation!,
          job.at,
          parseDialogue(JSON.stringify(value), job.speakerId!, rules),
        );
        const before = job.partial?.dialogue as
            | (ReturnType<typeof parseDialogue> & { gifMessageIndex?: number })
            | undefined,
          length = before?.messages.length ?? 0;
        if (!result.messages.length || length + result.messages.length > job.plan!.expectedMessages)
          throw new Error('返回条数与剩余计划不符');
        const offsets = [
          ...(before?.offsets ?? Array.from({ length }, (_, i) => i * 2)),
          ...(result.offsets ??
            result.messages.map(
              (_, i) => (before?.offsets?.at(-1) ?? Math.max(0, length * 2)) + i * 2,
            )),
        ];
        result = {
          ...before,
          ...result,
          gifAssetId: before?.gifAssetId ?? result.gifAssetId,
          gifMessageIndex: before?.gifAssetId
            ? (before.gifMessageIndex ?? 0)
            : result.gifAssetId
              ? length
              : undefined,
          messages: [...(before?.messages ?? []), ...result.messages],
          offsets,
          mentionTargets: [
            ...(before?.mentionTargets ?? []),
            ...(result.mentionTargets ?? []).map((m) => ({
              ...m,
              messageIndex: m.messageIndex + length,
            })),
          ],
          reactions: [...(before?.reactions ?? []), ...(result.reactions ?? [])],
        };
        if (
          offsets.some(
            (v, i) => v > 60 || job.at + v * 1000 > job.event.end || (i > 0 && v < offsets[i - 1]),
          )
        )
          throw new Error('消息时间越界或倒序');
        if (!(await commitAllowed())) {
          await d.contentJobs.update(job.id, { status: 'pending', nextAttemptAt: 0 });
          continue;
        }
        if (result.messages.length < job.plan!.expectedMessages) {
          await d.contentJobs.update(job.id, {
            status: 'pending',
            partial: { dialogue: result },
            attempts: 0,
            nextAttemptAt: 0,
            batchScale: Math.max(0.25, batch.scale / 2),
            error: '有效消息已暂存，剩余条数待补齐',
          });
          continue;
        }
      }
      await d.transaction('rw', d.tables, async () => {
        if (!(await commitAllowed())) {
          await d.contentJobs.update(job.id, { status: 'pending', nextAttemptAt: 0 });
          return;
        }
        if ((await d.contentJobs.get(job.id))?.status === 'complete') return;
        if (description) await d.events.update(job.event.id, { description });
        if (result) {
          const saved = await persistDialogue(
            d,
            job.conversation!.id,
            job.speakerId!,
            result.messages,
            job.at,
            'ai',
            job.id,
            job.event.id,
            result.offsets,
            { ...result, backfilled: true, planVersion: 1 },
          );
          if (saved.length !== job.plan!.expectedMessages && !(await d.messages.get(job.id + ':0')))
            throw new Error('消息未完整写入，任务保持待恢复');
          for (const m of saved)
            for (const actor of job.conversation!.participants) {
              const state = await d.states.get(`${worldId}:${actor}`);
              if (state && (state.lastPhone ?? 0) >= m.simAt) {
                await d.readStates.put({
                  id: `character:${m.id}:${actor}`,
                  messageId: m.id,
                  readerId: actor,
                  kind: 'character',
                  readAt: state.lastPhone!,
                });
                await recordHeardInformation(
                  d,
                  worldId,
                  m.senderId,
                  m.text,
                  [actor],
                  `会话 ${m.conversationId} · 消息 ${m.id}`,
                  state.lastPhone!,
                );
              }
            }
        }
        await d.contentJobs.update(job.id, {
          status: 'complete',
          completedAt: Date.now(),
          error: undefined,
          partial: undefined,
        });
      });
    } catch (e) {
      await d.contentJobs.update(job.id, {
        status: signal.aborted ? 'pending' : 'failed',
        nextAttemptAt: signal.aborted ? 0 : Date.now() + 30000,
        batchScale: Math.max(0.25, batch.scale / 2),
        error: String(e),
        errorCode: e instanceof ProviderError ? e.code : 'validation',
      });
    }
  }
}
