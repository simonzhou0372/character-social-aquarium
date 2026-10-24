import { resolveObservation } from '../core/selective-observation';
import { generateMajor, applyMajor } from './major-events';
import type { AquariumDB } from '../data/db';
import { withWorldLock, db } from '../data/db';
import type { Provider } from './provider';
import { describeEvent, generateDialogue, liveProvider, persistDialogue } from './orchestrator';
import { generateScene } from './scenes';
import { diagnostic } from '../core/diagnostics';
import { startWorldTask } from '../core/tasks';
export async function drainContent(worldId: string, d: AquariumDB = db, provider?: Provider) {
  return withWorldLock('content:' + worldId, async () => {
    const task = startWorldTask('content:' + worldId);
    // Acquiring an exclusive browser lock proves no surviving worker owns these claims.
    if (typeof navigator !== 'undefined' && navigator.locks)
      await d.contentJobs
        .where('worldId')
        .equals(worldId)
        .and((j) => j.status === 'running')
        .modify((j) => {
          j.status = 'pending';
          j.nextAttemptAt = 0;
          j.attempts = Math.min(j.attempts, 2);
        });
    try {
      const jobs = await d.contentJobs
        .where('worldId')
        .equals(worldId)
        .and(
          (j) =>
            j.status !== 'complete' &&
            (j.attempts < 3 || j.status === 'running') &&
            j.nextAttemptAt <= Date.now(),
        )
        .sortBy('at');
      for (const job of jobs.slice(0, 12)) {
        const cp = await d.checkpoints.get(worldId);
        if (!cp || cp.paused || task.signal.aborted || (await d.worlds.get(worldId))?.deletedAt)
          return;
        const members = await d.memberships.where('worldId').equals(worldId).toArray();
        if (
          job.event.participants.some(
            (id) => !members.some((m) => m.characterId === id && !m.inactive),
          )
        ) {
          await d.contentJobs.update(job.id, {
            status: 'failed',
            attempts: 3,
            error: '角色已从世界移除，任务已挂起',
          });
          continue;
        }
        const actors = await d.characters.bulkGet(job.event.participants);
        if (
          actors.some((c) => !c || c.deletedAt) ||
          (job.conversation?.groupId && (await d.groups.get(job.conversation.groupId))?.deletedAt)
        ) {
          await d.contentJobs.update(job.id, {
            status: 'failed',
            attempts: 3,
            error: '对象已移入回收站，生成已挂起',
          });
          continue;
        }
        const version = cp.controlVersion ?? 0;
        const focus = await resolveObservation(worldId, d);
        if (
          !(job.kind === 'chat' && job.conversation
            ? focus.allowsConversation(job.conversation) ||
              (job.event.origin === 'macro' && focus.allowsEvent(job.event))
            : focus.allowsEvent(job.event))
        ) {
          await d.contentJobs.update(job.id, {
            status: 'failed',
            attempts: 3,
            error: '观察范围变更，相关对象静默，任务已挂起',
          });
          continue;
        }
        const fact = await d.events.get(job.event.id);
        if (!fact) continue;
        job.event = fact;
        diagnostic(worldId, { phase: 'api', queueLength: jobs.length });
        const claimed = await d.transaction('rw', d.contentJobs, async () => {
          const current = await d.contentJobs.get(job.id);
          if (!current || current.status === 'complete' || current.nextAttemptAt > Date.now())
            return false;
          await d.contentJobs.update(job.id, {
            status: 'running',
            attempts: Math.min(current.attempts, 2) + 1,
            nextAttemptAt: Date.now() + 180000,
          });
          return true;
        });
        if (!claimed) continue;
        try {
          const client = provider ?? (await liveProvider(d));
          let result: unknown;
          if (job.kind === 'chat' && job.conversation && job.speakerId)
            result = await generateDialogue(
              d,
              job.conversation,
              job.speakerId,
              job.at,
              job.snapshot,
              client,
              job.recovery ? 'recoveryChat' : 'chat',
              task.signal,
              { state: job.state, event: job.event },
            );
          if (job.kind === 'major') result = await generateMajor(d, job, client, task.signal);
          if (job.kind === 'life')
            result = await describeEvent(
              d,
              job.event,
              job.snapshot,
              client,
              job.recovery,
              task.signal,
            );
          if (job.kind === 'scene')
            result = await generateScene(
              d,
              job.event,
              job.snapshot,
              client,
              job.recovery,
              task.signal,
            );
          await d.transaction('rw', d.tables, async () => {
            const current = await d.checkpoints.get(worldId);
            if (
              !current ||
              current.paused ||
              (current.controlVersion ?? 0) !== version ||
              task.signal.aborted
            ) {
              await d.contentJobs.update(job.id, { status: 'pending', nextAttemptAt: 0 });
              return;
            }
            if (job.kind === 'major' && result) await applyMajor(d, job, result as any);
            if (job.kind === 'life' && result)
              await d.events.update(job.event.id, { description: (result as any).description });
            if (job.kind === 'scene' && result) await d.scenes.put(result as any);
            if (job.kind === 'chat' && result && job.conversation && job.speakerId) {
              const r = result as {
                messages: string[];
                offsets?: number[];
                replyToMessageId?: string;
                gifAssetId?: string;
              };
              await persistDialogue(
                d,
                job.conversation.id,
                job.speakerId,
                r.messages,
                job.at,
                'ai',
                job.id,
                job.event.id,
                r.offsets,
                { ...r, backfilled: true },
              );
            }
            if (job.kind === 'scene' && result && (result as any).generationStatus !== 'complete') {
              await d.contentJobs.update(job.id, {
                status: 'failed',
                error: (result as any).generationError ?? '部分阶段已保存，等待继续生成',
                nextAttemptAt: Date.now() + 30000,
              });
            } else await d.contentJobs.update(job.id, { status: 'complete', error: undefined });
          });
          diagnostic(worldId, { phase: 'idle', lastCommittedAt: Date.now() });
        } catch (e) {
          const error = e instanceof Error ? e.message : '生成失败';
          await d.contentJobs.update(job.id, {
            status: 'failed',
            error,
            nextAttemptAt: Date.now() + 30000,
          });
          diagnostic(worldId, { phase: 'error', error });
        }
      }
    } finally {
      task.done();
    }
  });
}
export async function retryContent(jobId: string, d: AquariumDB = db) {
  const j = await d.contentJobs.get(jobId);
  if (!j) return;
  await d.contentJobs.update(jobId, {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    error: undefined,
  });
  void drainContent(j.worldId, d).catch((e) =>
    diagnostic(j.worldId, { phase: 'error', error: String(e) }),
  );
}
