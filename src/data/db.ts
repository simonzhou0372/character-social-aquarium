import type { NarrativeChange, OrganizationState } from '../core/narrative-types';
import type { UsageLedger } from '../core/usage-types';
import type { ExpansionJob } from '../core/expansion-types';
import type {
  ObservationConfig,
  BackfillJob,
  EvolutionRecord,
  WorldReport,
} from '../core/focus-types';
import type { z } from 'zod';
import type {
  CoverageSchema,
  EvolutionCursorSchema,
  ReportCursorSchema,
} from '../core/focus-types';
import type {
  MajorSchedule,
  MajorEvent,
  MajorChain,
  EventNotification,
} from '../core/types';
import type { MessageReaction, MessageReadState, GifAsset, LocalResource } from '../core/types';
import type { ContentJob } from '../core/content-jobs';
import { realLocalDate } from '../core/calendar';
import type { InPersonScene, BackgroundKnowledge } from '../core/types';
import type { PromptConfig } from '../ai/prompts';
import Dexie, { type Table } from 'dexie';
import type {
  Character,
  World,
  Membership,
  Group,
  GroupMember,
  Relationship,
  Conversation,
  Message,
  ReadCursor,
  ActivityEvent,
  RuntimeState,
  MemoryEntry,
  Checkpoint,
  AppSettings,
  ApiProfile,
  Usage,
} from '../core/types';
export class AquariumDB extends Dexie {
  usageLedger!: Table<UsageLedger>;
  narrativeChanges!: Table<NarrativeChange>;
  organizationStates!: Table<OrganizationState>;
  expansionJobs!: Table<ExpansionJob>;
  observationConfigs!: Table<ObservationConfig>;
  observationCoverage!: Table<z.infer<typeof CoverageSchema>>;
  backfillJobs!: Table<BackfillJob>;
  evolutionRecords!: Table<EvolutionRecord>;
  evolutionCursors!: Table<z.infer<typeof EvolutionCursorSchema>>;
  worldReports!: Table<WorldReport>;
  reportCursors!: Table<z.infer<typeof ReportCursorSchema>>;
  majorSchedules!: Table<MajorSchedule>;
  majorChains!: Table<MajorChain>;
  majorEvents!: Table<MajorEvent>;
  notifications!: Table<EventNotification>;
  reactions!: Table<MessageReaction>;
  readStates!: Table<MessageReadState>;
  gifAssets!: Table<GifAsset>;
  resources!: Table<LocalResource>;
  contentJobs!: Table<ContentJob>;
  scenes!: Table<InPersonScene>;
  backgroundKnowledge!: Table<BackgroundKnowledge>;
  taskSnapshots!: Table<{ id: string; config: PromptConfig }>;
  promptConfigs!: Table<PromptConfig>;
  taskLogs!: Table<{
    id: string;
    worldId: string;
    task: string;
    promptVersion: number;
    at: number;
    status: string;
    context?: import('../ai/context').ContextReport;
    inputTokens?: number;
    outputTokens?: number;
    finishReason?: string;
    detail?: string;
  }>;
  characters!: Table<Character>;
  worlds!: Table<World>;
  memberships!: Table<Membership>;
  groups!: Table<Group>;
  groupMembers!: Table<GroupMember>;
  relationships!: Table<Relationship>;
  conversations!: Table<Conversation>;
  messages!: Table<Message>;
  cursors!: Table<ReadCursor>;
  events!: Table<ActivityEvent>;
  states!: Table<RuntimeState>;
  memories!: Table<MemoryEntry>;
  checkpoints!: Table<Checkpoint>;
  settings!: Table<AppSettings>;
  profiles!: Table<ApiProfile>;
  usage!: Table<Usage>;
  constructor(name = 'aquarium-local-v1') {
    super(name);
    this.version(1).stores({
      characters: 'id,name',
      worlds: 'id',
      memberships: 'id,worldId,characterId,[worldId+characterId]',
      groups: 'id,*worldIds',
      groupMembers: 'id,groupId,worldId,characterId',
      relationships: 'id,worldId,from,to,[worldId+from+to]',
      conversations: 'id,worldId,groupId,lastAt,*participants',
      messages: 'id,conversationId,[conversationId+seq],simAt,eventId',
      cursors: 'id,conversationId,[conversationId+readerId]',
      events: 'id,worldId,start,[worldId+start],*participants',
      states: 'id,worldId,characterId',
      memories: 'id,worldId,*owners,at',
      checkpoints: 'id',
      settings: 'id',
      profiles: 'id',
      usage: 'id,day',
    });
    this.version(2).stores({ promptConfigs: 'id', taskLogs: 'id,worldId,at' });
    this.version(3).stores({ taskSnapshots: 'id' });
    this.version(4).stores({ memories: 'id,worldId,*owners,at,conversationId' });
    this.version(5)
      .stores({})
      .upgrade((tx) =>
        tx
          .table('checkpoints')
          .toCollection()
          .modify((cp) => {
            cp.timeMode ??= 'god';
          }),
      );
    this.version(6)
      .stores({
        scenes: 'id,worldId,eventId,start,*participants',
        backgroundKnowledge: 'id,worldId,entityId,characterId',
      })
      .upgrade(async (tx) => {
        const cps = await tx.table('checkpoints').toArray();
        const events = await tx.table('events').toArray();
        await tx
          .table('worlds')
          .toCollection()
          .modify((w) => {
            const cp = cps.find((c) => c.id === w.id);
            const tick = cp?.simTime ?? Date.now();
            w.era ??= 'AD';
            w.calendarSystem ??= 'gregorian';
            w.calendarAnchor ??= { tick, date: realLocalDate(tick, w.timezone) };
            w.initialDate ??= realLocalDate(
              events.filter((e) => e.worldId === w.id).reduce((n, e) => Math.min(n, e.start), tick),
              w.timezone,
            );
          });
        await tx
          .table('characters')
          .toCollection()
          .modify((c) => {
            c.gender ??= '';
            c.entityMode ??= 'interactive';
          });
        await tx
          .table('groups')
          .toCollection()
          .modify((g) => {
            g.entityMode ??= 'interactive';
          });
        await tx
          .table('settings')
          .toCollection()
          .modify((s) => {
            s.unlimitedUsage ??= false;
          });
      });
    this.version(7)
      .stores({ contentJobs: 'id,worldId,status,at' })
      .upgrade(async (tx) => {
        await tx
          .table('checkpoints')
          .toCollection()
          .modify((cp) => {
            cp.clockAnchor ??= {
              simTime: cp.recoveryTarget ?? cp.simTime,
              realTime: cp.recoveryRealTarget ?? cp.realTime,
            };
          });
      });
    this.version(8).stores({
      reactions: 'id,messageId,actorId',
      readStates: 'id,messageId,readerId',
      gifAssets: 'id,scopeType,scopeId,resourceId',
      resources: 'id,digest',
    });
    this.version(9).stores({
      majorSchedules: 'id',
      majorEvents: 'id,worldId,eventId,timestamp',
      notifications: 'id,worldId,eventId,createdAt',
    });
    this.version(10).stores({
      characters: 'id,name,entityMode',
      observationConfigs: 'id',
      observationCoverage: 'id,worldId,target',
      backfillJobs: 'id,worldId,status',
      evolutionRecords: 'id,worldId,characterId,at,[worldId+at]',
      evolutionCursors: 'id',
      worldReports: 'id,worldId,type,start,[worldId+type+start]',
      reportCursors: 'id,worldId',
      events: 'id,worldId,start,end,[worldId+start],[worldId+end],*participants',
      scenes: 'id,worldId,eventId,start,[worldId+start],*participants',
    });
    this.version(12).stores({ expansionJobs: 'id,worldId,status' });
    this.version(13).stores({
      taskLogs: 'id,worldId,at,[worldId+task+at]',
      contentJobs:
        'id,worldId,status,at,[worldId+status+at],[worldId+kind+status],[worldId+conversation.id+status+at]',
    });
    this.version(11).stores({
      worlds: 'id,deletedAt',
      characters: 'id,name,entityMode,deletedAt',
      groups: 'id,*worldIds,deletedAt',
    });
    this.version(15).stores({
      usageLedger:
        'id,worldId,model,task,startedAt,[worldId+startedAt],[worldId+virtualAt],[worldId+virtualDay],[worldId+budgetVirtualDay]',
      narrativeChanges: 'id,worldId,entityId,eventId,[worldId+at],[worldId+entityId+at]',
      organizationStates: 'id,worldId,groupId',
    });
    this.version(16).stores({ majorChains: 'id,worldId,dueAt,[worldId+dueAt]' });
    this.version(14).upgrade((tx) =>
      tx
        .table('settings')
        .toCollection()
        .modify((s) => {
          // Existing activity values are intentionally untouched. New presets are opt-in.
          s.uiMode ??= 'game';
          s.motionLevel ??= 'standard';
        }),
    );
  }
}
export const db = new AquariumDB();
export const dataTables = (d: AquariumDB) => [
  d.usageLedger,
  d.narrativeChanges,
  d.organizationStates,
  d.taskSnapshots,
  d.expansionJobs,
  d.observationConfigs,
  d.observationCoverage,
  d.backfillJobs,
  d.evolutionRecords,
  d.evolutionCursors,
  d.worldReports,
  d.reportCursors,
  d.majorSchedules,
  d.majorChains,
  d.majorEvents,
  d.notifications,
  d.reactions,
  d.readStates,
  d.gifAssets,
  d.resources,
  d.contentJobs,
  d.scenes,
  d.backgroundKnowledge,
  d.characters,
  d.worlds,
  d.memberships,
  d.groups,
  d.groupMembers,
  d.relationships,
  d.conversations,
  d.messages,
  d.cursors,
  d.events,
  d.states,
  d.memories,
  d.checkpoints,
  d.settings,
  d.usage,
  d.promptConfigs,
];
const localLocks = new Map<string, Promise<unknown>>();
export async function withWorldLock<T>(
  worldId: string,
  fn: () => Promise<T>,
  wait = false,
): Promise<T | undefined> {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request(`aquarium:${worldId}`, { ifAvailable: !wait }, (lock) =>
      lock ? fn() : undefined,
    );
  const active = localLocks.get(worldId);
  if (active) {
    if (!wait) return undefined;
    await active.catch(() => undefined);
    return withWorldLock(worldId, fn, wait);
  }
  const task = Promise.resolve().then(fn);
  localLocks.set(worldId, task);
  try {
    return await task;
  } finally {
    if (localLocks.get(worldId) === task) localLocks.delete(worldId);
  }
}
