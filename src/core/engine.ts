import { actorAvailable, lethalCandidates, ordinaryLife } from './narrative';
import { crisisAt } from './crisis';
import { computeCoverage, invalidateCoverage } from './coverage';
import Dexie from 'dexie';
import { contentPlan, planningHistory, MAX_PENDING_CONTENT } from './adaptive-batching';
import { simulatedReaction } from './reaction-emojis';
import { dormantInfluence } from './dormant-influence';
import {
  resolveObservation,
  recordCoverage,
  observationKeys,
  evolvedCharacter,
} from './selective-observation';
import {
  materializeChain,
  nextMajorSchedule,
  nextMajorScheduleFor,
  planMajorBatch,
} from './major-events';
import type { ContentJob } from './content-jobs';
import { drainContent } from '../ai/content-queue';
import { foregroundStart } from './clock-presence';
import { diagnostic } from './diagnostics';
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
import {
  HOUR,
  DAY,
  type Checkpoint,
  type Conversation,
  type ActivityEvent,
  type MajorEvent,
} from './types';
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
  deferContent?: boolean;
  dispatchContent?: boolean;
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
  if (running && (await d.worlds.get(worldId))?.deletedAt) throw new Error('世界已移入回收站');
  if (!running) {
    cancelWorld(worldId);
    cancelWorld('content:' + worldId);
  }
  await d.transaction('rw', d.checkpoints, d.taskSnapshots, async () => {
    const cp = await d.checkpoints.get(worldId);
    if (!cp) return;
    await d.checkpoints.put({
      ...cp,
      clockAnchor: {
        simTime: clockTarget(cp, Date.now(), foregroundStart()),
        realTime: Date.now(),
      },
      controlVersion: (cp.controlVersion ?? 0) + 1,
      paused: !running,
      mode,
      realTime: Date.now(),
      recoveryTarget: undefined,
      recoveryStart: undefined,
      recoveryRealTarget: undefined,
      recoveryKind: undefined,
      recoveryRequests: 0,
      jumpTarget: undefined,
      jumpResumePaused: undefined,
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
      if (!cp.clockAnchor) {
        cp = { ...cp, clockAnchor: { simTime: cp.simTime, realTime: cp.realTime } };
        await d.checkpoints.update(worldId, { clockAnchor: cp.clockAnchor });
      }
      const elapsed = Math.max(0, now - cp.realTime);
      const recovery = cp.recoveryTarget
        ? cp.recoveryKind !== 'foreground'
        : elapsed > 15 * 60 * 1000;
      const calendarWorld = await d.worlds.get(worldId);
      if (!calendarWorld || calendarWorld.deletedAt) return;
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
            cp = { ...cp!, clockAnchor: current.clockAnchor ?? cp!.clockAnchor };
            await d.checkpoints.put(cp!);
            return true;
          });
          if (!saved) return;
        }
      } else snapshot = await getPrompts(d);
      const observation = await resolveObservation(worldId, d);
      const discovered = await discoverDirectConversations(worldId, cp.simTime, d);
      const runStart = cp.simTime;
      const cachedCharacters = await d.characters
        .where('id')
        .anyOf([...observation.activeIds])
        .toArray();
      const cachedRelations = await d.relationships.where('worldId').equals(worldId).toArray();
      const cachedGroups = await d.groups
        .filter(
          (g) =>
            g.worldIds.includes(worldId) &&
            !g.deletedAt &&
            g.entityMode !== 'background' &&
            (observation.config.mode === 'full' ||
              observation.config.groupIds.includes(g.id) ||
              observation.gm.some(
                (m) => m.groupId === g.id && observation.fullIds.has(m.characterId),
              )),
        )
        .toArray();
      const cachedActiveRelations = cachedRelations.filter((r) =>
        observation.activeIds.has(r.from),
      );
      const cachedMembers = observation.members.filter(
        (m) =>
          observation.activeIds.has(m.characterId) && !m.inactive && ordinaryLife(m.life?.status),
      );
      const historyCache = new Map<string, import('./types').Message[]>();
      const cursorCache = new Map<string, import('./types').ReadCursor | undefined>();
      const majorReadFacts = options.deferContent
        ? await d.majorEvents.where('worldId').equals(worldId).toArray()
        : undefined;
      const schedulerHistory = async (c: Conversation) => {
        let saved = options.deferContent ? historyCache.get(c.id) : undefined;
        if (!saved) {
          saved = (
            await d.messages
              .where('[conversationId+seq]')
              .between([c.id, Dexie.minKey], [c.id, Dexie.maxKey])
              .reverse()
              .limit(48)
              .toArray()
          ).reverse();
          if (options.deferContent) historyCache.set(c.id, saved);
        }
        return options.deferContent ? planningHistory(saved, c.plannedHistory ?? [], c.id) : saved;
      };
      let settings = (await d.settings.get('app'))!;
      let provider = options.provider;
      let eventCount = 0,
        messageCount = 0,
        steps = 0;
      while (cp.simTime < target && steps++ < (options.maxSegments ?? 240)) {
        if (options.signal?.aborted) return;
        if (options.deferContent) {
          const pending = (
            await Promise.all(
              ['pending', 'running', 'failed'].map((status) =>
                d.contentJobs
                  .where('[worldId+status+at]')
                  .between([worldId, status, Dexie.minKey], [worldId, status, Dexie.maxKey])
                  .count(),
              ),
            )
          ).reduce((a, b) => a + b, 0);
          // Cancelled-by-death majors are terminal; they must not block planning forever.
          const majorPending = (
            await d.contentJobs
              .where('[worldId+kind+status]')
              .anyOf(['pending', 'running', 'failed'].map((status) => [worldId, 'major', status]))
              .toArray()
          ).filter((j) => !/死亡|失联|取消/.test(j.error ?? '')).length;
          if (pending >= MAX_PENDING_CONTENT || majorPending >= 3) {
            diagnostic(worldId, { queueLength: pending, phase: 'idle', planningBlocked: true });
            break; // The unexpanded interval is retained by recoveryTarget / the clock anchor.
          }
        }
        const world = await d.worlds.get(worldId);
        if (
          !world ||
          (world.narrativeVersion ?? 0) !== observation.narrativeVersion ||
          ((await d.observationConfigs.get(worldId))?.updatedAt ?? 0) !==
            observation.config.updatedAt
        )
          return;
        const [members, all, relations, oldStates, allConvs] = await Promise.all([
          Promise.resolve(cachedMembers),
          Promise.resolve(cachedCharacters),
          Promise.resolve(cachedActiveRelations),
          d.states
            .where('id')
            .anyOf([...observation.activeIds].map((id) => worldId + ':' + id))
            .toArray(),
          d.conversations
            .where('participants')
            .anyOf([...observation.activeIds])
            .distinct()
            .and((c) => c.worldId === worldId && observation.canScheduleConversation(c))
            .toArray(),
        ]);
        const controlled = new Set(allConvs.map((c) => c.controlledId).filter(Boolean));
        for (const c of discovered)
          if (
            !allConvs.some(
              (old) =>
                old.id === c.id ||
                (old.kind === 'direct' &&
                  old.participants.length === 2 &&
                  c.participants.every((id) => old.participants.includes(id))),
            )
          )
            allConvs.push(c);
        const characters = all
          .filter(
            (c) => c.entityMode !== 'background' && members.some((m) => m.characterId === c.id),
          )
          .map((c) =>
            evolvedCharacter(
              c,
              members.find((m) => m.characterId === c.id),
              !!world.evolutionSettings?.enabled,
            ),
          );
        for (const r of relations) {
          if (!characters.some((c) => c.id === r.from) || !characters.some((c) => c.id === r.to))
            continue;
          const pair = [r.from, r.to].sort();
          if (
            !observation.allowsConversation({ kind: 'direct', participants: pair } as Conversation)
          )
            continue;
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
        const groups = cachedGroups;
        const groupMembers = observation.gm;
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
              existing.participantJoinedAt = {
                ...existing.participantJoinedAt,
                ...Object.fromEntries(added.map((id) => [id, cp!.simTime])),
              };
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
        diagnostic(worldId, { phase: 'planning', lastScheduledAt: Date.now() });
        // Dormant recipients are sampled only for a concrete, unanswered message from an explicitly observed person.
        if (observation.config.mode === 'selective') {
          for (const c of allConvs
            .filter(
              (c) =>
                c.kind === 'direct' && c.participants.some((id) => observation.fullIds.has(id)),
            )
            .slice(0, 24)) {
            const history = await schedulerHistory(c);
            const last = history.filter((m) => m.simAt <= end).at(-1);
            if (!last || !observation.fullIds.has(last.senderId) || end - last.simAt > 6 * HOUR)
              continue;
            const recipient = c.participants.find((id) => !observation.activeIds.has(id));
            if (!recipient || characters.some((c) => c.id === recipient)) continue;
            if (
              await d.contentJobs
                .where('worldId')
                .equals(worldId)
                .and(
                  (j) =>
                    j.kind === 'chat' &&
                    j.conversation?.id === c.id &&
                    j.speakerId === recipient &&
                    j.status !== 'complete',
                )
                .first()
            )
              continue;
            const actor = await d.characters.get(recipient);
            if (actor && !actor.deletedAt && actor.entityMode !== 'background')
              characters.push(actor);
            if (characters.length >= cachedCharacters.length + 2) break;
          }
        }
        const plan = await planInWorker(world, characters, relations, cp, end, oldStates);
        const influence = await dormantInfluence(
          d,
          world,
          cp.simTime,
          end,
          observation,
          cachedRelations,
          plan,
        );
        if (influence) {
          const actor = characters.find((c) => influence.event.participants.includes(c.id));
          if (actor) {
            const pair = [actor.id, influence.character.id];
            const temporary: Conversation = {
              id: await directConversationId(worldId, pair[0], pair[1]),
              worldId,
              kind: 'direct',
              participants: pair,
              name: [actor.name, influence.character.name].join(' & '),
              createdAt: end,
              lastAt: 0,
            };
            if (!allConvs.some((c) => c.id === temporary.id)) allConvs.push(temporary);
          }
        }
        plan.events = plan.events.map((e) => ({
          ...e,
          origin: e.origin ?? 'realtime',
          generatedAt: e.generatedAt ?? Date.now(),
        }));
        const majorSchedule = world.majorEventSettings?.enabled
          ? ((await d.majorSchedules.get(worldId)) ??
            nextMajorScheduleFor(worldId, cp.simTime, world.majorEventSettings, 0, ''))
          : undefined;
        const majorDue = !!majorSchedule && majorSchedule.plannedAt <= end + 2 * HOUR;
        const coverage =
          world.majorEventSettings?.enabled && majorDue
            ? await computeCoverage(worldId, d, end, false)
            : undefined;
        const majorGroups = cachedGroups.map((g) => ({
          id: g.id,
          name: g.name,
          memberIds: [
            ...new Set(
              observation.gm
                .filter((m) => m.groupId === g.id && !m.departedAt)
                .map((m) => m.characterId)
                .filter((id) => plan.states.some((s) => s.characterId === id)),
            ),
          ],
        }));
        const majorBatch = majorSchedule
          ? planMajorBatch(world, majorSchedule, plan.events, end, observation.members, {
              groups: majorGroups,
              relationships: relations,
              coverage: coverage?.rows,
              locations: world.locations,
              from: cp.simTime,
            })
          : undefined;
        const dueChains = await d.majorChains
          .where('[worldId+dueAt]')
          .between([worldId, Dexie.minKey], [worldId, end], true, true)
          .toArray();
        const chainPlans: { event: ActivityEvent; major: MajorEvent }[] = [];
        for (const chain of dueChains) {
          const materialized = materializeChain(
            world,
            chain,
            cp.simTime,
            end,
            plan.events,
            observation.members,
          );
          if (!materialized) continue;
          plan.events = materialized.events;
          chainPlans.push({ event: materialized.event, major: materialized.major });
          plan.states = plan.states.map((s) =>
            materialized.event.participants.includes(s.characterId)
              ? {
                  ...s,
                  eventId: materialized.event.id,
                  activity: '连锁重大事件',
                  location: materialized.event.location,
                  phone: materialized.event.phone,
                }
              : s,
          );
          await d.majorChains.delete(chain.id);
        }
        if (majorBatch) {
          plan.events = majorBatch.events;
          for (const partial of majorBatch.states) {
            const index = plan.states.findIndex((s) => s.characterId === partial.characterId);
            if (index >= 0) plan.states[index] = { ...plan.states[index], ...partial };
            else
              plan.states.push({
                id: partial.id!,
                worldId,
                characterId: partial.characterId!,
                eventId: partial.eventId!,
                activity: partial.activity ?? '重要事件',
                location: partial.location ?? '未知',
                phone: partial.phone ?? 0.3,
                mood: 0,
                lastPhone: 0,
                lastAction: 0,
                lastTopicAt: cp.simTime,
              });
          }
        }

        const allMajorPlans = [...(majorBatch?.plans ?? []), ...chainPlans];
        let seed = plan.seed;
        const endedConversations: Conversation[] = [];
        type SocialChoice = {
          c: Conversation;
          speaker: string;
          at: number;
          eventId: string;
          initiating: boolean;
        };
        const choices: SocialChoice[] = [];
        const roll = random(seed);
        seed = roll.seed;
        const frequency =
          tuning.opportunity *
          (observation.config.mode === 'full'
            ? 1
            : Math.sqrt(observation.activeIds.size / Math.max(1, observation.interactiveCount))) *
          Math.min(1, (end - cp.simTime) / onlineStep(settings.activity));
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
            const history = await schedulerHistory(c);
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
            for (const char of [...characters, ...(influence ? [influence.character] : [])]) {
              const state = plan.states.find((s) => s.characterId === char.id)!;
              if (
                c.groupId &&
                !observation.gm.some((m) => m.groupId === c.groupId && m.characterId === char.id)
              )
                continue;
              if (
                last?.senderId === char.id ||
                controlled.has(char.id) ||
                (c.participantJoinedAt?.[char.id] ?? 0) > end
              )
                continue;
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
              const deficit = coverage?.byId.get(char.id)?.deficit ?? 0;
              const coverageBoost = 1 + Math.min(1.4, deficit * 0.035);
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
                (last?.mentionCharacterIds?.includes(char.id) ? 1.6 : 1) *
                (0.3 + r.value) *
                (c.kind === 'group'
                  ? tuning.groupWeight *
                    (1 + Math.max(0, c.participants.length - 2) * tuning.groupCrowdBonus)
                  : tuning.directWeight) *
                coverageBoost;
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
          // High presets can open more than one independent conversation in a
          // segment. Each extra opening is a separate scheduler roll, so lively
          // and below keep their original single-opportunity behavior.
          while (choices.length < tuning.simultaneous) {
            if (choices.length > 0) {
              const extra = random(seed);
              seed = extra.seed;
              if (extra.value >= tuning.burstChance) break;
            }
            const best = ranked.find(
              (candidate) =>
                !choices.some(
                  (pick) => pick.c.id === candidate.c.id || pick.speaker === candidate.speaker,
                ),
            );
            if (!best) break;
            const state = plan.states.find((s) => s.characterId === best.speaker)!;
            const event = plan.events.find((e) => e.id === state.eventId)!;
            const replyDelay = best.initiating ? 0 : tuning.replyDelayMinutes * 60000;
            const at = Math.min(
              end - 61000,
              event.start + Math.max(1000, (end - event.start) * 0.6) + replyDelay,
            );
            if (at <= cp.simTime) break;
            choices.push({
              c: best.c,
              speaker: best.speaker,
              at,
              eventId: state.eventId,
              initiating: best.initiating,
            });
          }
        }
        if (allMajorPlans.length) {
          const snapshotCrisis = crisisAt(world, end);
          for (const item of allMajorPlans) {
            item.event.lethalCandidateIds = lethalCandidates(
              world,
              item.event,
              observation.members,
              seed,
              { day: snapshotCrisis.day, pressure: snapshotCrisis.pressure },
            );
            if (item.event.lethalCandidateIds.length)
              item.event.lethalReason =
                (world.majorEventSettings?.tendency || world.novel?.goal) +
                `（Day ${snapshotCrisis.day}，${snapshotCrisis.label}，风险压力 ${snapshotCrisis.pressure.toFixed(2)}）`;
          }
        }
        const queued: ContentJob[] = [];
        const chatChoices: SocialChoice[] = [];
        if (allMajorPlans.length && cp.mode === 'live')
          for (const item of allMajorPlans) {
            queued.push({
              id: `major-content:${item.event.id}`,
              worldId,
              kind: 'major',
              event: item.event,
              at: item.event.start,
              snapshot,
              recovery,
              status: 'pending',
              attempts: 0,
              nextAttemptAt: 0,
            });
            // Local/group events also produce a real in-person scene, not only chat.
            if (item.event.participants.length >= 2 && item.event.majorLevel !== 'world')
              queued.push({
                id: `scene:${item.event.id}:major`,
                worldId,
                kind: 'scene',
                plan: contentPlan('scene', seed, snapshot, item.event),
                createdAt: Date.now(),
                event: item.event,
                at: item.event.start,
                snapshot,
                recovery,
                status: 'pending',
                attempts: 0,
                nextAttemptAt: 0,
              });
          }
        const enqueue = (
          kind: ContentJob['kind'],
          event: (typeof plan.events)[number],
          choice?: SocialChoice,
        ) => {
          queued.push({
            id: `${kind}:${event.id}:${choice?.speaker ?? ''}`,
            worldId,
            kind,
            plan: contentPlan(
              kind,
              seed,
              snapshot,
              event,
              characters.find((c) => c.id === choice?.speaker),
            ),
            createdAt: Date.now(),
            event,
            at: kind === 'chat' ? (choice?.at ?? event.start) : event.start,
            conversation:
              kind === 'chat' && choice
                ? { ...choice.c, avatar: undefined, plannedHistory: undefined }
                : undefined,
            speakerId: kind === 'chat' ? choice?.speaker : undefined,
            state:
              kind === 'chat'
                ? plan.states.find((s) => s.characterId === choice?.speaker)
                : undefined,
            snapshot,
            recovery,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: 0,
          });
        };
        const day = new Date(Date.now()).toISOString().slice(0, 10);
        const usage = await d.usage.get(day);
        // One representative life description per six simulated hours, regardless of online preset.
        // Routine scheduling remains local and does not make one request per character or tick.
        if (
          cp.mode === 'live' &&
          plan.events.some(observation.allowsEvent) &&
          Math.floor(cp.simTime / (6 * HOUR)) !== Math.floor(end / (6 * HOUR)) &&
          (settings.unlimitedUsage ||
            !recovery ||
            cp.recoveryRequests + choices.length < settings.recoveryBudget)
        ) {
          if (options.deferContent) {
            enqueue('life', plan.events.find(observation.allowsEvent)!);
          } else {
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
        }
        const canGenerate =
          cp.mode === 'live' &&
          (options.deferContent ||
            settings.unlimitedUsage ||
            ((usage?.messages ?? 0) + snapshot.rules.maxMessages <= settings.dailyMessages &&
              (!recovery || cp.recoveryRequests < settings.recoveryBudget)));
        type Generated = Pick<
          Awaited<ReturnType<typeof generateDialogue>>,
          | 'messages'
          | 'offsets'
          | 'gifAssetId'
          | 'replyToMessageId'
          | 'mentionTargets'
          | 'reactions'
        >;
        const generatedList: { choice: SocialChoice; generated: Generated }[] = [];
        let generationSkipped = false;
        for (const choice of choices) {
          if (canGenerate && options.deferContent) {
            enqueue('chat', plan.events.find((e) => e.id === choice.eventId)!, choice);
            chatChoices.push(choice);
          } else if (canGenerate) {
            if (
              recovery &&
              !settings.unlimitedUsage &&
              cp.recoveryRequests >= settings.recoveryBudget
            ) {
              generationSkipped = true;
              continue;
            }
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
            const generated = await generateDialogue(
              d,
              choice.c,
              choice.speaker,
              choice.at,
              snapshot,
              provider,
              recovery ? 'recoveryChat' : 'chat',
              options.signal,
              {
                state: plan.states.find((s) => s.characterId === choice.speaker),
                event: plan.events.find((e) => e.id === choice.eventId),
              },
            );
            generatedList.push({ choice, generated });
          } else if (cp.mode === 'demo') {
            const pick = random(seed);
            seed = pick.seed;
            generatedList.push({
              choice,
              generated: {
                messages: [demoLines[Math.floor(pick.value * 100) % demoLines.length]],
              },
            });
          } else generationSkipped = true;
        }
        const scenes: InPersonScene[] = [];
        // Scene sampling and budget are independent of online activity presets.
        if (cp.mode === 'live')
          for (const event of plan.events.filter(
            (e) => e.participants.length > 1 && observation.allowsEvent(e),
          )) {
            const existing = await d.scenes.where('worldId').equals(worldId).toArray();
            const today = calendarDate(world, event.start);
            const reserved = options.deferContent
              ? await d.contentJobs
                  .where('worldId')
                  .equals(worldId)
                  .and(
                    (j) =>
                      j.kind === 'scene' &&
                      j.event.type !== 'major' &&
                      j.status !== 'complete' &&
                      calendarDate(world, j.at) === today,
                  )
                  .toArray()
              : [];
            const used =
              existing.filter((s) => calendarDate(world, s.start) === today).length +
              reserved.filter((j) => !existing.some((s) => s.eventId === j.event.id)).length +
              queued.filter(
                (j) =>
                  j.kind === 'scene' &&
                  j.event.type !== 'major' &&
                  calendarDate(world, j.at) === today,
              ).length;
            const pick = random(seed);
            seed = pick.seed;
            if (
              (event.type !== 'major' &&
                used + scenes.length >= (settings.sceneDailyBudget ?? 3)) ||
              (event.type !== 'major' && pick.value >= (settings.sceneFrequency ?? 0.5)) ||
              (recovery &&
                !settings.unlimitedUsage &&
                cp.recoveryRequests >= settings.recoveryBudget)
            )
              continue;
            if (recovery) {
              cp = { ...cp, recoveryRequests: cp.recoveryRequests + 1 };
              await d.checkpoints.update(worldId, { recoveryRequests: cp.recoveryRequests });
            }
            if (options.deferContent) {
              enqueue('scene', event);
              continue;
            }
            provider ??= await liveProvider(d);
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
        const pings = await d.messages
          .where('simAt')
          .between(Math.max(0, end - 6 * HOUR), end, true, true)
          .and(
            (m) =>
              (!options.deferContent || m.source === 'user') &&
              !!m.mentionCharacterIds?.length &&
              allConvs.some((c) => c.id === m.conversationId),
          )
          .toArray();
        const before = cp;
        const commitStarted = Date.now();
        const committed = await d.transaction(
          'rw',
          [
            d.worlds,
            d.observationCoverage,
            d.organizationStates,
            d.narrativeChanges,
            d.memberships,
            d.usageLedger,
            d.majorSchedules,
            d.majorChains,
            d.majorEvents,
            d.notifications,
            d.readStates,
            d.reactions,
            d.contentJobs,
            d.taskSnapshots,
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
            d.groupMembers,
          ],
          async () => {
            const current = await d.checkpoints.get(worldId);
            if (
              !current ||
              current.simTime !== before.simTime ||
              current.seed !== before.seed ||
              (current.controlVersion ?? 0) !== (before.controlVersion ?? 0) ||
              current.paused ||
              ((await d.worlds.get(worldId))?.narrativeVersion ?? 0) !==
                observation.narrativeVersion
            )
              return false;
            const activeNow = await d.characters
              .where('id')
              .anyOf(characters.map((c) => c.id))
              .toArray();
            if (activeNow.some((c) => c.deletedAt || c.entityMode === 'background')) return false;
            for (const choice of choices)
              if (
                choice.c.groupId &&
                (await d.groups.get(choice.c.groupId))?.entityMode === 'background'
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
                  participantJoinedAt: {
                    ...existing.participantJoinedAt,
                    ...c.participantJoinedAt,
                  },
                });
            }
            for (const job of queued) {
              if (job.conversation && !(await d.conversations.get(job.conversation.id)))
                await d.conversations.add(job.conversation);
              const snapshotId = `content:${worldId}:${snapshot.version}:${snapshot.updatedAt}`;
              if (!(await d.taskSnapshots.get(snapshotId)))
                await d.taskSnapshots.put({ id: snapshotId, config: snapshot });
              const conversation = job.conversation
                ? await d.conversations.get(job.conversation.id)
                : undefined;
              const predecessor = conversation?.plannedHistory?.at(-1);
              await d.contentJobs.put({
                ...job,
                snapshotId,
                snapshot: { ...snapshot, entries: [] },
                dependsOn: [
                  ...(predecessor && (await d.contentJobs.get(predecessor.id))
                    ? [predecessor.id]
                    : []),
                  ...(job.event.type === 'major' && job.kind !== 'major'
                    ? ['major-content:' + job.event.id]
                    : []),
                ],
              });
              if (job.kind === 'chat' && job.conversation && job.plan) {
                const c = await d.conversations.get(job.conversation.id);
                await d.conversations.update(job.conversation.id, {
                  plannedHistory: [
                    ...(c?.plannedHistory ?? []),
                    {
                      id: job.id,
                      speaker: job.speakerId!,
                      at: job.at,
                      count: job.plan.expectedMessages,
                      eventId: job.event.id,
                    },
                  ].slice(-36),
                });
              }
            }
            for (const choice of chatChoices) {
              const state = plan.states.find((s) => s.characterId === choice.speaker);
              if (state) {
                state.lastAction = choice.at;
                if (choice.initiating) state.lastTopicAt = choice.at;
              }
            }
            if (majorSchedule && !majorBatch) await d.majorSchedules.put(majorSchedule);
            if (allMajorPlans.length) {
              const memberships = await d.groupMembers.where('worldId').equals(worldId).toArray();
              for (const item of allMajorPlans) {
                const groupIds = [
                  ...new Set(
                    memberships
                      .filter((m) => item.event.participants.includes(m.characterId))
                      .map((m) => m.groupId),
                  ),
                ];
                item.major.groupIds = world.majorEventSettings?.allowMultipleGroups
                  ? groupIds
                  : groupIds.slice(0, 1);
                await d.majorEvents.put({
                  ...item.major,
                  status: cp!.mode === 'demo' ? 'occurred' : item.major.status,
                });
                await d.notifications.put({
                  id: `notice:${item.major.id}`,
                  eventId: item.major.id,
                  worldId,
                  createdAt: Date.now(),
                  recovery,
                });
              }
              if (majorBatch) await d.majorSchedules.put(majorBatch.schedule);
            }
            if (majorBatch?.deferredChains.length)
              await d.majorChains.bulkPut(majorBatch.deferredChains);
            await d.events.bulkPut(plan.events);
            invalidateCoverage(worldId);
            if (observation.config.mode === 'selective')
              await recordCoverage(
                worldId,
                observationKeys(observation.config),
                before.simTime,
                end,
                d,
              );
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
                      entry.at,
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
              if (
                readRoll.value <
                Math.min(
                  1,
                  state.phone *
                    char.phoneHabit *
                    (pings.some((m) => m.mentionCharacterIds?.includes(char.id)) ? 1.6 : 1),
                )
              ) {
                state.lastPhone = end;
                for (const major of (
                  majorReadFacts ?? (await d.majorEvents.where('worldId').equals(worldId).toArray())
                ).filter(
                  (e) => e.timestamp <= end && e.participantIds.includes(state.characterId),
                )) {
                  const id = `major-read:${major.id}:${state.characterId}`;
                  if (!(await d.memories.get(id)))
                    await d.memories.put({
                      id,
                      worldId,
                      owners: [state.characterId],
                      content:
                        major.description +
                        ' ' +
                        major.consequences.map((c) => c.description).join(' '),
                      keywords: [major.type],
                      importance: 0.95,
                      at: end,
                      eventId: major.eventId,
                      kind: 'episode',
                    });
                }

                for (const conv of allConvs.filter((c) =>
                  c.participants.includes(state.characterId),
                )) {
                  const cursorId = `character:${conv.id}:${state.characterId}`;
                  if (!cursorCache.has(cursorId))
                    cursorCache.set(cursorId, await d.cursors.get(cursorId));
                  const old = options.deferContent
                    ? cursorCache.get(cursorId)
                    : await d.cursors.get(cursorId);
                  const known = historyCache.get(conv.id)?.at(-1)?.seq;
                  if (options.deferContent && known !== undefined && (old?.seq ?? 0) >= known)
                    continue;
                  const messages = await d.messages
                    .where('[conversationId+seq]')
                    .between([conv.id, old?.seq ?? 0], [conv.id, Dexie.maxKey], false, true)
                    .limit(200)
                    .toArray();
                  const joinedAt = conv.participantJoinedAt?.[state.characterId] ?? 0;
                  const visible = messages.filter((m) => m.simAt <= end && m.simAt >= joinedAt);
                  for (const message of visible.filter((m) => m.seq > (old?.seq ?? 0))) {
                    if (
                      observation.hasNarrativeChanges &&
                      !(await actorAvailable(conv, state.characterId, message.simAt, d))
                    )
                      continue;
                    const readId = `character:${message.id}:${state.characterId}`;
                    if (await d.readStates.get(readId)) continue;
                    await d.readStates.put({
                      id: readId,
                      messageId: message.id,
                      readerId: state.characterId,
                      kind: 'character',
                      readAt: end,
                    });
                    const reactionRoll = random(
                      options.deferContent
                        ? Array.from(message.id + state.characterId).reduce(
                            (n, c) => (n * 31 + c.charCodeAt(0)) >>> 0,
                            1,
                          )
                        : seed,
                    );
                    if (!options.deferContent) seed = reactionRoll.seed;
                    if (
                      conv.controlledId !== state.characterId &&
                      message.senderId !== state.characterId &&
                      reactionRoll.value < 0.04
                    )
                      await d.reactions.put({
                        id: `reaction:${message.id}:${state.characterId}:auto`,
                        messageId: message.id,
                        actorId: state.characterId,
                        emoji: simulatedReaction(message.text, reactionRoll.value / 0.04),
                        reactedAt: end,
                      });
                    await recordHeardInformation(
                      d,
                      worldId,
                      message.senderId,
                      message.text,
                      [state.characterId],
                      `会话 ${conv.id} · 消息 ${message.id}`,
                      end,
                    );
                  }
                  let seq = old?.seq ?? 0;
                  for (const message of messages.filter((m) => m.seq > seq)) {
                    if (message.simAt > end && message.simAt >= joinedAt) break;
                    seq = message.seq;
                  }
                  if (seq > (old?.seq ?? 0)) {
                    cursorCache.set(cursorId, {
                      id: cursorId,
                      conversationId: conv.id,
                      readerId: state.characterId,
                      kind: 'character',
                      seq,
                      at: end,
                    });
                    await d.cursors.put({
                      id: cursorId,
                      conversationId: conv.id,
                      readerId: state.characterId,
                      kind: 'character',
                      seq,
                      at: end,
                    });
                  }
                }
              }
            }
            for (const { choice, generated } of generatedList) {
              if (!(await d.conversations.get(choice.c.id))) await d.conversations.add(choice.c);
              const msgs = await persistDialogue(
                d,
                choice.c.id,
                choice.speaker,
                generated.messages,
                choice.at,
                cp!.mode === 'demo' ? 'demo' : 'ai',
                `sim:${worldId}:${before.simTime}:${choice.speaker}`,
                choice.eventId,
                generated.offsets,
                generated,
              );
              messageCount += msgs.length;
              if (msgs.length || generated.reactions?.length)
                await d.taskLogs.put({
                  id: `social:${worldId}:${before.simTime}:${choice.c.id}:${choice.speaker}`,
                  worldId,
                  task: choice.initiating ? 'social-initiation' : 'social-reply',
                  promptVersion: snapshot.version,
                  at: Date.now(),
                  status: 'committed',
                });
              const state = plan.states.find((s) => s.characterId === choice.speaker)!;
              if (msgs.length || generated.reactions?.length) {
                state.lastAction = choice.at;
                if (choice.initiating) state.lastTopicAt = choice.at;
              }
            }
            await d.states.bulkPut(plan.states);
            // Event memory is private to its actual participants, never global by default.
            for (const event of plan.events.filter(
              (e) => e.type === 'social' || e.type === 'major',
            ))
              await d.memories.put({
                id: `memory:${event.id}`,
                worldId,
                owners: event.type === 'major' && event.phone === 0 ? [] : event.participants,
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
              usageLimited:
                cp!.mode === 'live' && choices.length > 0 && (generationSkipped || !canGenerate),
              clockAnchor: done
                ? before.jumpTarget
                  ? // A deliberate jump lands exactly on its destination, not on natural-time drift.
                    { simTime: end, realTime: realTarget }
                  : (current.clockAnchor?.realTime ?? 0) <= realTarget
                    ? {
                        simTime: clockTarget(current, realTarget, options.foregroundSince),
                        realTime: realTarget,
                      }
                    : current.clockAnchor
                : (current.clockAnchor ?? before.clockAnchor),
              paused: end >= limit || (done && before.jumpResumePaused === true),
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
                    jumpTarget: undefined,
                    jumpResumePaused: undefined,
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
        diagnostic(worldId, {
          phase: 'idle',
          lastCommittedAt: Date.now(),
          commitLatencyMs: Date.now() - commitStarted,
        });
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
      if (options.deferContent && options.dispatchContent !== false)
        void drainContent(worldId, d, options.provider).catch((e) =>
          diagnostic(worldId, { phase: 'error', error: String(e) }),
        );
    }
  });
}
/** Discover bounded, known contacts without requiring a UI-created conversation. */
export async function discoverDirectConversations(worldId: string, at: number, d: AquariumDB = db) {
  const scope = await resolveObservation(worldId, d);
  const pairs: string[][] = [];
  const relations = await d.relationships.where('worldId').equals(worldId).toArray();
  for (const edge of relations)
    if (scope.activeIds.has(edge.from) || scope.activeIds.has(edge.to))
      pairs.push([edge.from, edge.to]);
  pairs.push(...scope.config.pairs);
  const groups = await d.groups
    .filter((g) => !g.deletedAt && g.entityMode !== 'background' && g.worldIds.includes(worldId))
    .toArray();
  for (const group of groups) {
    const ids = scope.gm.filter((m) => m.groupId === group.id).map((m) => m.characterId);
    for (let i = 0; i < ids.length; i++)
      if (scope.activeIds.has(ids[i]))
        for (let step = 1; step <= Math.min(2, ids.length - 1); step++)
          pairs.push([ids[i], ids[(i + step) % ids.length]]);
  }
  const chars = new Map(
    (await d.characters.bulkGet([...new Set(pairs.flat())]))
      .filter((c) => !!c && !c.deletedAt && c.entityMode !== 'background')
      .map((c) => [c!.id, c!]),
  );
  const memberIds = new Set(scope.members.map((m) => m.characterId));
  const found = new Map<string, Conversation>();
  for (const pair of pairs) {
    const participants = [...new Set(pair)].sort();
    if (
      participants.length !== 2 ||
      !participants.every((id) => chars.has(id) && memberIds.has(id)) ||
      !scope.allowsConversation({ kind: 'direct', participants } as Conversation)
    )
      continue;
    const id = await directConversationId(worldId, participants[0], participants[1]);
    found.set(id, {
      id,
      worldId,
      kind: 'direct',
      participants,
      name: participants.map((id) => chars.get(id)!.name).join(' & '),
      createdAt: at,
      lastAt: 0,
    });
  }
  return [...found.values()];
}
export async function createDirect(worldId: string, a: string, b: string, d: AquariumDB = db) {
  const selected = await d.characters.where('id').anyOf([a, b]).toArray();
  if (selected.some((c) => c.deletedAt || c.entityMode === 'background'))
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
