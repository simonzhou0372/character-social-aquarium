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
  }
}
export const db = new AquariumDB();
export const dataTables = (d: AquariumDB) => [
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
export async function withWorldLock<T>(
  worldId: string,
  fn: () => Promise<T>,
  wait = false,
): Promise<T | undefined> {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request(`aquarium:${worldId}`, { ifAvailable: !wait }, (lock) =>
      lock ? fn() : undefined,
    );
  // Browsers without Web Locks still get commit-level checkpoint compare-and-swap.
  return fn();
}
