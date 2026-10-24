import { persistDialogue } from '../ai/orchestrator';
import { locationAccessFor } from './simulation';
import { db, withWorldLock, type AquariumDB } from '../data/db';
import { worldTime } from './calendar';
import { DAY, type ActivityEvent, type Conversation } from './types';
import { getPrompts } from '../ai/prompts';
import {
  observationKeys,
  resolveObservation,
  recordCoverage,
  pairKey,
} from './selective-observation';
import { directConversationId } from './engine';
/** One persisted virtual-day chunk per turn. Planning is local; AI uses the existing content queue. */
export async function processBackfill(worldId: string, d: AquariumDB = db) {
  return withWorldLock(
    worldId,
    async () => {
      const cp = await d.checkpoints.get(worldId);
      if (!cp || cp.paused) return;
      const job = await d.backfillJobs
        .where('worldId')
        .equals(worldId)
        .and((j) => ['pending', 'running', 'waiting', 'failed'].includes(j.status))
        .first();
      if (!job) return;
      const members = await d.memberships.where('worldId').equals(worldId).toArray();
      if (
        job.characterIds.some((id) => !members.some((m) => m.characterId === id && !m.inactive))
      ) {
        await d.backfillJobs.update(job.id, {
          status: 'paused',
          error: '角色已从世界移除，回溯已暂停',
        });
        return;
      }
      const actors = await d.characters.bulkGet(job.characterIds);
      if (actors.some((c) => !c || c.deletedAt)) {
        await d.backfillJobs.update(job.id, {
          status: 'paused',
          error: '对象已移入回收站，回溯已挂起',
        });
        return;
      }
      const scope = await resolveObservation(worldId, d),
        currentKeys = observationKeys(scope.config);
      if (job.targets.some((t) => scope.config.mode !== 'full' && !currentKeys.includes(t))) {
        await d.backfillJobs.update(job.id, { status: 'paused', error: '观察对象已取消' });
        return;
      }
      const prompt = job.snapshot ?? (await getPrompts(d)),
        end = Math.min(job.end, job.checkpoint + DAY),
        start = job.checkpoint;
      if (start < job.end) {
        const occupied = await d.events
          .where('[worldId+end]')
          .between([worldId, start], [worldId, Number.MAX_SAFE_INTEGER], true, true)
          .and((e) => e.start < end && e.status !== 'cancelled')
          .toArray();
        const groups = job.groupIds.map((id) =>
          scope.gm.filter((m) => m.groupId === id).map((m) => m.characterId),
        );
        const pairs = job.pairs.filter((p) => job.targets.includes(pairKey(p)));
        const clusters: string[][] = [
          ...pairs,
          ...groups,
          ...job.characterIds
            .filter(
              (id) => !groups.some((g) => g.includes(id)) && !pairs.some((p) => p.includes(id)),
            )
            .map((id) => [id]),
        ];
        const used = new Set<string>(),
          events: ActivityEvent[] = [],
          conversations: Conversation[] = [],
          jobs: import('./types').ContentJob[] = [],
          demoChats: { conversationId: string; speakerId: string; event: ActivityEvent }[] = [];
        for (const cluster of clusters) {
          const participants = [...new Set(cluster)].filter((id) => !used.has(id)).slice(0, 12);
          if (!participants.length) continue;
          const chars = await d.characters.where('id').anyOf(participants).toArray();
          if (chars.some((c) => c.entityMode === 'background')) continue;
          const backfillWorld = (await d.worlds.get(worldId))!;
          const accesses = chars.map((c) => locationAccessFor(c, backfillWorld));
          const availablePlaces = backfillWorld.locations.filter((name) =>
            accesses.every((a) => !a || a.usual.includes(name)),
          );
          if (accesses.some(Boolean) && !availablePlaces.length) continue;
          const blocks = occupied
            .filter((e) => e.participants.some((id) => participants.includes(id)))
            .sort((a, b) => a.start - b.start);
          const date = worldTime((await d.worlds.get(worldId))!, start);
          const morning = (9 * 60 - date.hour * 60 - date.minute + 1440) % 1440;
          let at = morning * 60000 + start < end ? start + morning * 60000 : start;
          const duration = Math.min(30 * 60000, end - start);
          for (const block of blocks) {
            if (block.end <= at) continue;
            if (block.start - at >= duration) break;
            at = Math.max(at, block.end);
          }
          if (at + duration > end) continue;
          const id = `bf:${job.id}:${start}:${(await directConversationId(worldId, job.id + ':' + start, [...participants].sort().join('|'))).slice(-20)}`;
          const event: ActivityEvent = {
            id,
            worldId,
            start: at,
            end: at + duration,
            type: participants.length > 1 ? 'social' : 'out',
            participants,
            location: accesses.some(Boolean)
              ? availablePlaces[0]
              : (occupied.find((e) => e.participants.some((id) => participants.includes(id)))
                  ?.location ?? '日常活动地点'),
            description:
              participants.length > 1
                ? `${chars.map((c) => c.name).join('、')}有过一次简短的共同交流。`
                : `${chars[0].name}处理日常事务，近期没有其他已确认的重要变化。`,
            phone: participants.length > 1 ? 0.15 : 0.7,
            status: 'completed',
            importance: 0.6,
            origin: 'backfill',
            generatedAt: Date.now(),
          };
          events.push(event);
          participants.forEach((id) => used.add(id));
          // A representative online check-in is optional; it does not wake the recipient's private network.
          if (
            participants.length === 1 &&
            Math.floor((start - job.start) / DAY) === 1 &&
            chars[0].initiative > 0.5 &&
            !['never', 'important'].includes(chars[0].initiationMode ?? '')
          ) {
            const relation = await d.relationships
              .where('from')
              .equals(participants[0])
              .and(
                (r) =>
                  r.worldId === worldId &&
                  r.closeness >= 55 &&
                  scope.members.some((m) => m.characterId === r.to),
              )
              .first();
            const buddy = relation ? await d.characters.get(relation.to) : undefined;
            if (buddy && buddy.entityMode !== 'background') {
              const pair = [participants[0], buddy.id];
              let c = await d.conversations
                .where('worldId')
                .equals(worldId)
                .and((c) => c.kind === 'direct' && pair.every((id) => c.participants.includes(id)))
                .first();
              if (!c) {
                c = {
                  id: await directConversationId(worldId, pair[0], pair[1]),
                  worldId,
                  kind: 'direct',
                  participants: pair,
                  name: chars[0].name + ' & ' + buddy.name,
                  createdAt: at,
                  lastAt: 0,
                };
                conversations.push(c);
              }
              if (
                !(await d.messages
                  .where('conversationId')
                  .equals(c.id)
                  .and((m) => m.simAt >= start && m.simAt < end)
                  .first())
              ) {
                if (cp.mode === 'live')
                  jobs.push({
                    id: 'chat:' + id + ':' + participants[0],
                    worldId,
                    kind: 'chat',
                    event,
                    at: at + 1000,
                    snapshot: prompt,
                    recovery: true,
                    conversation: c,
                    speakerId: participants[0],
                    status: 'pending',
                    attempts: 0,
                    nextAttemptAt: 0,
                  });
                else demoChats.push({ conversationId: c.id, speakerId: participants[0], event });
              }
            }
          }
          if (cp.mode === 'live') {
            jobs.push({
              id: 'life:' + id,
              worldId,
              kind: 'life',
              event,
              at,
              snapshot: prompt,
              recovery: true,
              status: 'pending',
              attempts: 0,
              nextAttemptAt: 0,
            });
            if (participants.length >= 2) {
              const groupId = job.groupIds.find((g) =>
                participants.every((id) =>
                  scope.gm.some((m) => m.groupId === g && m.characterId === id),
                ),
              );
              let conversation = groupId
                ? await d.conversations
                    .where('worldId')
                    .equals(worldId)
                    .and((c) => c.groupId === groupId)
                    .first()
                : await d.conversations
                    .where('worldId')
                    .equals(worldId)
                    .and(
                      (c) =>
                        c.kind === 'direct' &&
                        participants.length === 2 &&
                        participants.every((id) => c.participants.includes(id)),
                    )
                    .first();
              if (!conversation && participants.length === 2) {
                conversation = {
                  id: await directConversationId(worldId, participants[0], participants[1]),
                  worldId,
                  kind: 'direct',
                  name: chars.map((c) => c.name).join(' & '),
                  participants,
                  createdAt: at,
                  lastAt: 0,
                };
                conversations.push(conversation);
              }
              if (conversation) {
                for (const speakerId of participants.slice(0, 2))
                  jobs.push({
                    id: `chat:${id}:${speakerId}`,
                    worldId,
                    kind: 'chat',
                    event,
                    at: at + 1000,
                    snapshot: prompt,
                    recovery: true,
                    conversation,
                    speakerId,
                    status: 'pending',
                    attempts: 0,
                    nextAttemptAt: 0,
                  });
              }
              jobs.push({
                id: 'scene:' + id,
                worldId,
                kind: 'scene',
                event,
                at,
                snapshot: prompt,
                recovery: true,
                status: 'pending',
                attempts: 0,
                nextAttemptAt: 0,
              });
            }
          }
        }
        await d.transaction('rw', d.tables, async () => {
          const current = await d.backfillJobs.get(job.id),
            check = await d.checkpoints.get(worldId);
          if (
            !current ||
            current.status === 'paused' ||
            check?.paused ||
            check?.controlVersion !== cp.controlVersion
          )
            return;
          await d.events.bulkPut(events);
          await d.conversations.bulkPut(conversations);
          await d.contentJobs.bulkPut(jobs);
          for (const chat of demoChats)
            await persistDialogue(
              d,
              chat.conversationId,
              chat.speakerId,
              ['刚忙完，歇一会儿。'],
              chat.event.start + 1000,
              'demo',
              'demo:' + chat.event.id,
              chat.event.id,
              undefined,
              { backfilled: true },
            );
          for (const event of events)
            await d.memories.put({
              id: 'memory:' + event.id,
              worldId,
              owners: event.participants,
              content: event.description,
              keywords: ['历史回溯'],
              importance: 0.6,
              at: event.end,
              eventId: event.id,
              kind: 'episode',
            });
          await d.backfillJobs.update(job.id, {
            checkpoint: end,
            completedIntervals: [...current.completedIntervals, [start, end]],
            status: end >= job.end ? 'waiting' : 'pending',
            eventCount: current.eventCount + events.length,
            contentJobIds: [...new Set([...current.contentJobIds, ...jobs.map((j) => j.id)])],
            notes: [
              ...current.notes.slice(-20),
              events.length
                ? '已按现存活动占用补全代表性经历。'
                : '此段已有活动占用或没有可确认的新活动，保留事实，不强行插入。',
            ],
            error: undefined,
          });
        });
      }
      const relevant = await d.contentJobs
        .where('worldId')
        .equals(worldId)
        .and(
          (j) =>
            (j.kind === 'chat' && j.conversation
              ? scope.allowsConversation(j.conversation)
              : scope.allowsEvent(j.event)) &&
            j.at >= job.start &&
            j.at < job.end &&
            j.event.participants.some((id) => job.characterIds.includes(id)) &&
            j.status !== 'complete',
        )
        .primaryKeys();
      if (relevant.length)
        await d.backfillJobs.update(job.id, {
          contentJobIds: [
            ...new Set([
              ...job.contentJobIds,
              ...relevant.map(String),
              ...((await d.backfillJobs.get(job.id))?.contentJobIds ?? []),
            ]),
          ],
        });
      const latest = await d.backfillJobs.get(job.id);
      if (!latest || latest.checkpoint < latest.end) return;
      const content = await d.contentJobs.bulkGet(latest.contentJobIds),
        pending = content.filter(
          (j) =>
            j &&
            j.status !== 'complete' &&
            (j.kind === 'chat' && j.conversation
              ? scope.allowsConversation(j.conversation)
              : scope.allowsEvent(j.event)),
        );
      const ids = new Set(
        (
          await d.messages
            .where('eventId')
            .startsWith('bf:' + job.id + ':')
            .toArray()
        )
          .filter((m) => m.eventId && m.eventId.startsWith('bf:' + job.id + ':'))
          .map((m) => m.id),
      );
      await d.transaction('rw', d.backfillJobs, d.observationCoverage, async () => {
        await d.backfillJobs.update(job.id, {
          status: pending.length ? 'waiting' : 'complete',
          messageCount: ids.size,
          error: pending.some((j) => j?.status === 'failed')
            ? '部分AI内容尚未完成，可在生成任务中重试。'
            : undefined,
        });
        if (!pending.length) await recordCoverage(worldId, job.targets, job.start, job.end, d);
      });
    },
    true,
  );
}
export async function setBackfillPaused(id: string, paused: boolean, d: AquariumDB = db) {
  const j = await d.backfillJobs.get(id);
  if (j && j.status !== 'complete')
    await d.backfillJobs.update(id, { status: paused ? 'paused' : 'pending', error: undefined });
}
