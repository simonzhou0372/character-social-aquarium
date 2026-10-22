import { recordHeardInformation } from '../data/knowledge';
import { activityFor, onlineStep } from './activity';
import { generateScene } from '../ai/scenes';
import { calendarLimit, calendarDate } from './calendar';
import type { InPersonScene } from './types';
import { cancelWorld, startWorldTask } from './tasks';
import { db, withWorldLock, type AquariumDB } from '../data/db';
import { getPrompts, PromptConfigSchema, type PromptConfig } from '../ai/prompts';
import { describeEvent, generateDialogue, liveProvider, persistDialogue } from '../ai/orchestrator';
import { type Provider, ProviderError } from '../ai/provider';
import { planInWorker } from './planner';
import { random, segmentEnd, socialWeight, topicPolicy, topicDue } from './simulation';
import { clockTarget } from './time';
import { HOUR, DAY, type Checkpoint, type Conversation } from './types';
export interface RecoveryProgress {
  worldId: string;
  from: number;
  to: number;
  at: number;
  events: number;
  messages: number;
  stage: string;
  offline?: boolean;
}
export interface RunOptions {
  now?: number;
  provider?: Provider;
  signal?: AbortSignal;
  onProgress?: (progress: RecoveryProgress) => void;
  maxSegments?: number;
  foregroundSince?: number;
}
const demoLines = [
  '风好像变大了。',
  '刚忙完，歇一会儿。',
  '那就晚一点见。',
  '我先去吃点东西。',
  '这边今天很安静。',
];
export async function directConversationId(worldId: string, a: string, b: string) {
  const data = new TextEncoder().encode(JSON.stringify([worldId, ...[a, b].sort()]));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return (
    'direct:' + Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('')
  );
}
export async function setRunning(
  worldId: string,
  running: boolean,
  mode: 'demo' | 'live',
  d: AquariumDB = db,
) {
  if (!running) cancelWorld(worldId);
  await d.transaction('rw', d.checkpoints, d.taskSnapshots, async () => {
    const cp = await d.checkpoints.get(worldId);
    if (!cp) return;
    await d.checkpoints.put({
      ...cp,
      controlVersion: (cp.controlVersion ?? 0) + 1,
      paused: !running,
      mode,
      realTime: Date.now(),
      recoveryTarget: undefined,
      recoveryStart: undefined,
      recoveryRealTarget: undefined,
      recoveryKind: undefined,
      recoveryRequests: 0,
    });
    await d.taskSnapshots.delete(worldId);
  });
}
export async function runWorld(worldId: string, options: RunOptions = {}, d: AquariumDB = db) {
  return withWorldLock(worldId, async () => {
    const task = startWorldTask(worldId, options.signal);
    options = { ...options, signal: task.signal };
    try {
      let cp = await d.checkpoints.get(worldId);
      if (!cp || cp.paused) return;
      const now = options.now ?? Date.now();
      const elapsed = Math.max(0, now - cp.realTime);
      const recovery = cp.recoveryTarget
        ? cp.recoveryKind !== 'foreground'
        : elapsed > 15 * 60 * 1000;
      const calendarWorld = await d.worlds.get(worldId);
      if (!calendarWorld) return;
      const limit = calendarLimit(calendarWorld);
      if (cp.simTime >= limit) {
        await d.checkpoints.update(worldId, { paused: true });
        throw new Error('世界已到达历法上限，请建立新的日期分支后继续。');
      }
      const target = Math.min(
        limit,
        cp.recoveryTarget ?? clockTarget(cp, now, options.foregroundSince),
      );
      const realTarget = cp.recoveryRealTarget ?? now;
      const effectiveRate = (target - cp.simTime) / Math.max(1, realTarget - cp.realTime);
      const batched = !!cp.recoveryTarget || recovery || target - cp.simTime > HOUR;
      if (target <= cp.simTime || (!recovery && target < limit && target - cp.simTime < 300000))
        return;
      let snapshot: PromptConfig;
      if (batched) {
        const stored = await d.taskSnapshots.get(worldId);
        snapshot = stored ? PromptConfigSchema.parse(stored.config) : await getPrompts(d);
        if (!stored || stored.config.entries.length !== snapshot.entries.length)
          await d.taskSnapshots.put({ id: worldId, config: snapshot });
        if (!cp.recoveryTarget) {
          cp = {
            ...cp,
            recoveryStart: cp.simTime,
            recoveryTarget: target,
            recoveryRealTarget: realTarget,
            recoveryKind: recovery ? 'offline' : 'foreground',
            recoveryRequests: 0,
          };
          const saved = await d.transaction('rw', d.checkpoints, async () => {
            const current = await d.checkpoints.get(worldId);
            if (
              options.signal?.aborted ||
              current?.paused ||
              current?.simTime !== cp!.simTime ||
              (current?.controlVersion ?? 0) !== (cp!.controlVersion ?? 0)
            )
              return false;
            await d.checkpoints.put(cp!);
            return true;
          });
          if (!saved) return;
        }
      } else snapshot = await getPrompts(d);
      let settings = (await d.settings.get('app'))!;
      let provider = options.provider;
      let eventCount = 0,
        messageCount = 0,
        steps = 0;
      while (cp.simTime < target && steps++ < (options.maxSegments ?? 240)) {
        if (options.signal?.aborted) return;
        const world = await d.worlds.get(worldId);
        if (!world) return;
        const [members, all, relations, oldStates, allConvs] = await Promise.all([
          d.memberships.where('worldId').equals(worldId).toArray(),
          d.characters.toArray(),
          d.relationships.where('worldId').equals(worldId).toArray(),
          d.states.where('worldId').equals(worldId).toArray(),
          d.conversations.where('worldId').equals(worldId).toArray(),
        ]);
        const controlled = new Set(allConvs.map((c) => c.controlledId).filter(Boolean));
        const characters = all.filter(
          (c) => c.entityMode !== 'background' && members.some((m) => m.characterId === c.id),
        );
        for (const r of relations) {
          if (!characters.some((c) => c.id === r.from) || !characters.some((c) => c.id === r.to))
            continue;
          const pair = [r.from, r.to].sort();
          if (
            !allConvs.some(
              (c) => c.kind === 'direct' && pair.every((id) => c.participants.includes(id)),
            )
          )
            allConvs.push({
              id: await directConversationId(worldId, pair[0], pair[1]),
              worldId,
              name: pair.map((id) => characters.find((c) => c.id === id)!.name).join(' & '),
              kind: 'direct',
              participants: pair,
              createdAt: cp.simTime,
              lastAt: 0,
            });
        }
        const groupSync: Conversation[] = [];
        const groups = await d.groups
          .filter((g) => g.worldIds.includes(worldId) && g.entityMode !== 'background')
          .toArray();
        const groupMembers = await d.groupMembers.where('worldId').equals(worldId).toArray();
        for (const group of groups) {
          const participants = [
            ...new Set(
              groupMembers
                .filter(
                  (m) => m.groupId === group.id && characters.some((c) => c.id === m.characterId),
                )
                .map((m) => m.characterId),
            ),
          ];
          if (participants.length < 2) continue;
          const existing = allConvs.find((c) => c.groupId === group.id);
          if (existing) {
            const added = participants.filter((id) => !existing.participants.includes(id));
            if (added.length) {
              existing.participants = [...existing.participants, ...added];
              groupSync.push(existing);
            }
          } else {
            const conversation: Conversation = {
              id: await directConversationId(worldId, 'group', group.id),
              groupId: group.id,
              worldId,
              name: group.name,
              kind: 'group',
              participants,
              createdAt: cp.simTime,
              lastAt: 0,
            };
            allConvs.push(conversation);
            groupSync.push(conversation);
          }
        }
        settings = (await d.settings.get('app'))!;
        const tuning = activityFor(settings.activity);
        const end = Math.min(segmentEnd(cp, target), cp.simTime + onlineStep(settings.activity));
        const plan = await planInWorker(world, characters, relations, cp, end, oldStates);
        let seed = plan.seed;
        const endedConversations: Conversation[] = [];
        let chosen:
          | { c: Conversation; speaker: string; at: number; eventId: string; initiating: boolean }
          | undefined;
        const roll = random(seed);
        seed = roll.seed;
        const frequency =
          tuning.opportunity * Math.min(1, (end - cp.simTime) / onlineStep(settings.activity));
        if (snapshot.rules.autonomous && roll.value < frequency) {
          const ranked: {
            c: Conversation;
            speaker: string;
            weight: number;
            initiating: boolean;
          }[] = [];
          const backgroundGroups = await d.groups
            .filter((g) => g.entityMode === 'background')
            .primaryKeys();
          for (const c of allConvs.filter(
            (c) => !c.groupId || !backgroundGroups.includes(c.groupId),
          )) {
            const history = await d.messages.where('conversationId').equals(c.id).sortBy('seq');
            const last = history.at(-1);
            const rhythm = random(seed);
            seed = rhythm.seed;
            if (
              last &&
              last.simAt > (c.topicEndedAt ?? 0) &&
              snapshot.rules.allowEnd &&
              rhythm.value < tuning.naturalEndChance
            ) {
              endedConversations.push({ ...c, topicEndedAt: end });
              continue;
            }
            for (const char of characters) {
              const state = plan.states.find((s) => s.characterId === char.id)!;
              if (last?.senderId === char.id || controlled.has(char.id)) continue;
              const ownLast = history.filter((m) => m.senderId === char.id).at(-1);
              const unreplied =
                !!last &&
                last.senderId !== char.id &&
                last.seq > (ownLast?.seq ?? 0) &&
                end - last.simAt <= 6 * HOUR &&
                last.simAt > (c.topicEndedAt ?? 0) &&
                rhythm.value < tuning.replyContinuation;
              const important = plan.events.some(
                (e) =>
                  e.type === 'social' &&
                  e.participants.includes(char.id) &&
                  c.participants.some((id) => id !== char.id && e.participants.includes(id)),
              );
              if (!unreplied && !topicDue(char, state, end, important, tuning.topicScale)) continue;
              const r = random(seed);
              seed = r.seed;
              const weight =
                socialWeight(
                  char,
                  state,
                  c,
                  relations,
                  last?.simAt ?? 0,
                  end,
                  unreplied,
                  tuning.cooldownMinutes,
                ) *
                (0.3 + r.value) *
                (c.kind === 'group' ? tuning.groupWeight : tuning.directWeight);
              if (weight > tuning.threshold)
                ranked.push({
                  c,
                  speaker: char.id,
                  weight:
                    weight *
                    (!unreplied && topicPolicy(char).mode === 'interval'
                      ? Math.min(
                          3,
                          1 +
                            (end - (state.lastTopicAt ?? cp.simTime)) /
                              (topicPolicy(char).minutes * 60000),
                        )
                      : 1),
                  initiating: !unreplied,
                });
            }
          }
          ranked.sort((a, b) => b.weight - a.weight);
          const best = ranked[0];
          if (best) {
            const state = plan.states.find((s) => s.characterId === best.speaker)!;
            const event = plan.events.find((e) => e.id === state.eventId)!;
            const at = Math.min(
              end - 61000,
              event.start + Math.max(1000, (end - event.start) * 0.6),
            );
            if (at > cp.simTime)
              chosen = {
                c: best.c,
                speaker: best.speaker,
                at,
                eventId: state.eventId,
                initiating: best.initiating,
              };
          }
        }
        const day = new Date(Date.now()).toISOString().slice(0, 10);
        const usage = await d.usage.get(day);
        // One representative life description per six simulated hours, regardless of online preset.
        // Routine scheduling remains local and does not make one request per character or tick.
        if (
          cp.mode === 'live' &&
          plan.events.length &&
          Math.floor(cp.simTime / (6 * HOUR)) !== Math.floor(end / (6 * HOUR)) &&
          (settings.unlimitedUsage ||
            !recovery ||
            cp.recoveryRequests + (chosen ? 1 : 0) < settings.recoveryBudget)
        ) {
          provider ??= await liveProvider(d);
          if (recovery) {
            cp = { ...cp, recoveryRequests: cp.recoveryRequests + 1 };
            await d.checkpoints.update(worldId, { recoveryRequests: cp.recoveryRequests });
          }
          const index = Math.max(
            0,
            plan.events.findIndex((e) => e.participants.length > 1),
          );
          plan.events[index] = await describeEvent(
            d,
            plan.events[index],
            snapshot,
            provider,
            recovery,
            options.signal,
          );
        }
        const canGenerate =
          cp.mode === 'live' &&
          (settings.unlimitedUsage ||
            ((usage?.messages ?? 0) + snapshot.rules.maxMessages <= settings.dailyMessages &&
              (!recovery || cp.recoveryRequests < settings.recoveryBudget)));
        let generated: { messages: string[]; offsets?: number[] } | undefined;
        if (canGenerate && chosen) {
          provider ??= await liveProvider(d);
          options.onProgress?.({
            worldId,
            offline: recovery,
            from: cp.recoveryStart ?? cp.simTime,
            to: target,
            at: cp.simTime,
            events: eventCount,
            messages: messageCount,
            stage: '正在复原生活与聊天',
          });
          if (recovery) {
            cp = { ...cp, recoveryRequests: cp.recoveryRequests + 1 };
            await d.checkpoints.update(worldId, { recoveryRequests: cp.recoveryRequests });
          }
          generated = await generateDialogue(
            d,
            chosen.c,
            chosen.speaker,
            chosen.at,
            snapshot,
            provider,
            recovery ? 'recoveryChat' : 'chat',
            options.signal,
            {
              state: plan.states.find((s) => s.characterId === chosen!.speaker),
              event: plan.events.find((e) => e.id === chosen!.eventId),
            },
          );
        } else if (cp.mode === 'demo' && chosen) {
          generated = { messages: [demoLines[Math.floor(roll.value * 100) % demoLines.length]] };
        }
        const scenes: InPersonScene[] = [];
        // Scene sampling and budget are independent of online activity presets.
        if (cp.mode === 'live')
          for (const event of plan.events.filter((e) => e.participants.length > 1)) {
            const existing = await d.scenes.where('worldId').equals(worldId).toArray();
            const used = existing.filter(
              (s) => calendarDate(world, s.start) === calendarDate(world, event.start),
            ).length;
            const pick = random(seed);
            seed = pick.seed;
            if (
              used + scenes.length >= (settings.sceneDailyBudget ?? 3) ||
              pick.value >= (settings.sceneFrequency ?? 0.5) ||
              (recovery &&
                !settings.unlimitedUsage &&
                cp.recoveryRequests >= settings.recoveryBudget)
            )
              continue;
            provider ??= await liveProvider(d);
            if (recovery) {
              cp = { ...cp, recoveryRequests: cp.recoveryRequests + 1 };
              await d.checkpoints.update(worldId, { recoveryRequests: cp.recoveryRequests });
            }
            try {
              scenes.push(
                await generateScene(d, event, snapshot, provider, recovery, options.signal),
              );
            } catch (error) {
              if (options.signal?.aborted) return;
              await d.taskLogs.put({
                id: `scene-error:${event.id}`,
                worldId,
                task: 'scene-generation',
                promptVersion: snapshot.version,
                at: Date.now(),
                detail: error instanceof Error ? error.message.slice(0, 500) : '场景生成失败',
                status:
                  error instanceof ProviderError && error.code === 'budget'
                    ? 'budget-limited'
                    : 'failed',
              });
            }
          }
        if (options.signal?.aborted) return;
        const before = cp;
        const committed = await d.transaction(
          'rw',
          [
            d.checkpoints,
            d.events,
            d.scenes,
            d.states,
            d.messages,
            d.conversations,
            d.cursors,
            d.memories,
            d.usage,
            d.taskLogs,
            d.settings,
            d.backgroundKnowledge,
            d.characters,
            d.groups,
          ],
          async () => {
            const current = await d.checkpoints.get(worldId);
            if (
              !current ||
              current.simTime !== before.simTime ||
              current.seed !== before.seed ||
              (current.controlVersion ?? 0) !== (before.controlVersion ?? 0) ||
              current.paused
            )
              return false;
            const activeNow = await d.characters
              .where('id')
              .anyOf(characters.map((c) => c.id))
              .toArray();
            if (activeNow.some((c) => c.entityMode === 'background')) return false;
            if (
              chosen?.c.groupId &&
              (await d.groups.get(chosen.c.groupId))?.entityMode === 'background'
            )
              return false;
            for (const c of groupSync) {
              if (c.groupId && (await d.groups.get(c.groupId))?.entityMode === 'background')
                continue;
              const existing = await d.conversations.get(c.id);
              if (!existing) await d.conversations.add(c);
              else
                await d.conversations.update(c.id, {
                  participants: [...new Set([...existing.participants, ...c.participants])],
                });
            }
            await d.events.bulkPut(plan.events);
            await d.scenes.bulkPut(scenes);
            for (const scene of scenes)
              for (const phase of scene.phases)
                for (const entry of phase.entries)
                  if (entry.kind === 'dialogue' && entry.speakerId)
                    await recordHeardInformation(
                      d,
                      worldId,
                      entry.speakerId,
                      entry.text,
                      phase.participants,
                      `线下场景 ${scene.id} · ${entry.at}`,
                    );
            for (const ended of endedConversations) {
              const current = await d.conversations.get(ended.id);
              if (current && current.lastAt === ended.lastAt)
                await d.conversations.update(ended.id, { topicEndedAt: ended.topicEndedAt });
            }
            for (const state of plan.states) {
              const char = characters.find((c) => c.id === state.characterId)!;
              const readRoll = random(seed);
              seed = readRoll.seed;
              if (readRoll.value < state.phone * char.phoneHabit) {
                state.lastPhone = end;
                for (const conv of allConvs.filter((c) =>
                  c.participants.includes(state.characterId),
                )) {
                  const messages = await d.messages
                    .where('conversationId')
                    .equals(conv.id)
                    .sortBy('seq');
                  const visible = messages.filter((m) => m.simAt <= end);
                  const latest = visible.at(-1);
                  if (latest)
                    await d.cursors.put({
                      id: `character:${conv.id}:${state.characterId}`,
                      conversationId: conv.id,
                      readerId: state.characterId,
                      kind: 'character',
                      seq: latest.seq,
                      at: end,
                    });
                }
              }
            }
            if (chosen && generated) {
              if (!(await d.conversations.get(chosen.c.id))) await d.conversations.add(chosen.c);
              const msgs = await persistDialogue(
                d,
                chosen.c.id,
                chosen.speaker,
                generated.messages,
                chosen.at,
                cp!.mode === 'demo' ? 'demo' : 'ai',
                `sim:${worldId}:${before.simTime}`,
                chosen.eventId,
                generated.offsets,
              );
              messageCount += msgs.length;
              if (msgs.length)
                await d.taskLogs.put({
                  id: `social:${worldId}:${before.simTime}`,
                  worldId,
                  task: chosen.initiating ? 'social-initiation' : 'social-reply',
                  promptVersion: snapshot.version,
                  at: Date.now(),
                  status: 'committed',
                });
              const state = plan.states.find((s) => s.characterId === chosen!.speaker)!;
              if (msgs.length) {
                state.lastAction = chosen.at;
                if (chosen.initiating) state.lastTopicAt = chosen.at;
              }
            }
            await d.states.bulkPut(plan.states);
            // Event memory is private to its actual participants, never global by default.
            for (const event of plan.events.filter((e) => e.type === 'social'))
              await d.memories.put({
                id: `memory:${event.id}`,
                worldId,
                owners: event.participants,
                content: event.description,
                keywords: [event.location],
                importance: 0.5,
                at: event.end,
                eventId: event.id,
                kind: 'episode',
              });
            const done = end >= target;
            const advancedReal = before.realTime + (end - before.simTime) / effectiveRate;
            cp = {
              ...before,
              usageLimited: cp!.mode === 'live' && !!chosen && !canGenerate,
              paused: end >= limit,
              simTime: end,
              realTime: done ? realTarget : Math.min(realTarget, advancedReal),
              seed,
              lastEventAt: end,
              nextAt: end + 300000,
              ...(done
                ? {
                    recoveryStart: undefined,
                    recoveryTarget: undefined,
                    recoveryRealTarget: undefined,
                    recoveryKind: undefined,
                    recoveryRequests: 0,
                  }
                : {}),
            };
            await d.checkpoints.put(cp);
            await d.taskLogs.put({
              id: `segment:${worldId}:${before.simTime}`,
              worldId,
              task: recovery ? 'recovery-segment' : 'life-segment',
              promptVersion: snapshot.version,
              at: Date.now(),
              status: 'committed',
            });
            return true;
          },
        );
        if (!committed) return;
        eventCount += plan.events.length;
        options.onProgress?.({
          worldId,
          offline: recovery,
          from: before.recoveryStart ?? before.simTime,
          to: target,
          at: cp!.simTime,
          events: eventCount,
          messages: messageCount,
          stage: '正在保存生活日记',
        });
      }
      if (cp!.simTime >= target) await d.taskSnapshots.delete(worldId);
    } finally {
      task.done();
    }
  });
}
export async function createDirect(worldId: string, a: string, b: string, d: AquariumDB = db) {
  const selected = await d.characters.where('id').anyOf([a, b]).toArray();
  if (selected.some((c) => c.entityMode === 'background'))
    throw new Error('背景人物不参与聊天，请先启用互动能力');
  if (a === b) throw new Error('请选择两位不同角色');
  const ids = [a, b].sort();
  const existing = await d.conversations
    .where('worldId')
    .equals(worldId)
    .and(
      (c) =>
        c.kind === 'direct' &&
        c.participants.length === 2 &&
        ids.every((id) => c.participants.includes(id)),
    )
    .first();
  if (existing) return existing.id;
  const id = await directConversationId(worldId, ids[0], ids[1]);
  await d.transaction('rw', d.conversations, d.memberships, async () => {
    const members = await d.memberships.where('worldId').equals(worldId).toArray();
    if (!ids.every((id) => members.some((m) => m.characterId === id)))
      throw new Error('角色不在当前世界');
    if (!(await d.conversations.get(id)))
      await d.conversations.add({
        id,
        worldId,
        name: '双人对话',
        kind: 'direct',
        participants: ids,
        createdAt: Date.now(),
        lastAt: 0,
      });
  });
  return id;
}
export function explainError(error: unknown) {
  return error instanceof ProviderError || error instanceof Error
    ? error.message
    : '发生了未知错误，请重试。';
}
