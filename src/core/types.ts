import { LifeStateSchema, OrganizationStateSchema, NarrativeChangeSchema } from './narrative-types';
import { CostControlsSchema, TaskRouteSchema, UsageLedgerSchema } from './usage-types';
import { MAX_CONTEXT_BUDGET_TOKENS } from './ai-limits';
import { NovelSchema } from './novel-types';
import { ExpansionJobSchema } from './expansion-types';
import {
  ReportSettingsSchema,
  ObservationConfigSchema,
  CoverageSchema,
  BackfillSchema,
  EvolutionRecordSchema,
  EvolutionCursorSchema,
  evolutionFields,
  WorldReportSchema,
  ReportCursorSchema,
} from './focus-types';
import { z } from 'zod';
import { WorldDateTimeSchema } from './calendar';
import { PromptConfigSchema, PromptEntrySchema } from '../ai/prompts';
const id = z.string().min(1).max(160),
  text = z.string().max(8000),
  time = z.number().finite().nonnegative();
export const ProvenanceSchema = z.object({
  catalogId: z.string().max(80),
  sourceIds: z.array(z.string().max(80)).max(80),
  note: z.string().max(2000),
  continuity: z.enum(['windows', 'pc98', 'reference']),
});
export const CharacterSchema = z.object({
  socialBehavior: z
    .object({
      familiar: text,
      stranger: text,
      conflict: text,
      humor: text,
      topics: text,
      avoid: text,
      basis: text,
    })
    .optional(),
  provenance: ProvenanceSchema.optional(),
  locationAccess: z
    .object({ home: z.string().max(100), usual: z.array(z.string().max(100)).min(1).max(20) })
    .optional(),
  deletedAt: time.optional(),
  id,
  name: z.string().min(1).max(60),
  gender: z.string().max(200).optional(),
  aliases: z.array(z.string().max(80)).max(20).optional(),
  entityMode: z.enum(['interactive', 'background']).optional(),
  fame: z.number().min(0).max(100).optional(),
  source: text,
  avatar: z.string().max(1500000),
  avatarSource: z
    .object({
      pack: z.string().max(100),
      assetId: z.string().max(200),
      kind: z.enum(['twilight', 'zun']),
      artist: z.string().max(100),
      work: z.string().max(100),
      sourcePage: z.string().url().max(2000),
      digest: z.string().length(64),
      downloadedAt: time,
    })
    .optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  bio: text,
  personality: text,
  style: text,
  habits: text,
  values: z.string().max(4000).optional(),
  goal: z.string().max(4000).optional(),
  fear: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(20),
  initiative: z.number().min(0).max(1),
  initiationMode: z.enum(['interval', 'important', 'never']).optional(),
  topicIntervalMinutes: z.number().int().min(5).max(10080).optional(),
  replyChance: z.number().min(0).max(1),
  phoneHabit: z.number().min(0).max(1),
  wake: z.number().int().min(0).max(23),
  sleep: z.number().int().min(0).max(23),
  busyStart: z.number().int().min(0).max(23),
  busyEnd: z.number().int().min(0).max(23),
  messagePreferences: z
    .object({
      maxMessages: z.number().int().min(1).max(3),
      suggestedMax: z.number().int().min(1).max(500),
    })
    .optional(),
});
export type Character = z.infer<typeof CharacterSchema>;
export const WorldSchema = z.object({
  narrativeVersion: z.number().int().nonnegative().optional(),
  /** Only worlds explicitly running a countdown crisis use apocalypse bands and wording. */
  crisis: z
    .object({
      enabled: z.boolean(),
      startedAt: time,
      durationDays: z.number().min(1).max(3650).optional(),
    })
    .optional(),
  novel: NovelSchema.optional(),
  novelHistory: z.array(NovelSchema).max(50).optional(),
  provenance: ProvenanceSchema.optional(),
  presetVersion: z.number().int().positive().optional(),
  locationDetails: z
    .array(
      z.object({
        name: z.string().max(100),
        region: z.string().max(100),
        description: z.string().max(1000),
        sourceIds: z.array(z.string().max(80)),
        access: z.enum(['local', 'restricted', 'external', 'legacy']),
      }),
    )
    .max(200)
    .optional(),
  deletedAt: time.optional(),
  evolutionSettings: z
    .object({
      enabled: z.boolean(),
      rules: z.string().max(4000),
      /** Optional daily evaluation cap; keeps one daily census from becoming a request storm. */
      maxPerDay: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  reportSettings: ReportSettingsSchema.optional(),
  majorEventSettings: z
    .object({
      enabled: z.boolean(),
      // Legacy day-based control. Kept so old archives import unchanged.
      maximumIntervalDays: z.number().min(0.01).max(36500),
      // Sub-day cadence. When present it takes precedence over maximumIntervalDays.
      intervalMinutes: z.number().min(15).max(525600).optional(),
      minimumGapMinutes: z.number().min(0).max(1440).optional(),
      maxPerDay: z.number().int().min(1).max(48).optional(),
      allowChainEvents: z.boolean().optional(),
      maxChainDepth: z.number().int().min(0).max(3).optional(),
      levels: z
        .object({
          local: z.boolean().default(true),
          group: z.boolean().default(true),
          world: z.boolean().default(true),
        })
        .optional(),
      tendency: z.string().max(4000),
      allowRelationshipChanges: z.boolean(),
      allowMultipleGroups: z.boolean(),
    })
    .optional(),
  cover: z.string().max(1500000).optional(),
  id,
  name: z.string().min(1).max(80),
  description: text,
  rules: text,
  locations: z.array(z.string().max(100)).min(1).max(200),
  era: z.string().min(1).max(80).optional(),
  calendarSystem: z.literal('gregorian').optional(),
  initialDate: WorldDateTimeSchema.optional(),
  calendarAnchor: z.object({ tick: time, date: WorldDateTimeSchema }).optional(),
  timezone: z.string().max(80),
  tone: text,
  color: z.string().max(20),
});
export type World = z.infer<typeof WorldSchema>;
export const MembershipSchema = z.object({
  life: LifeStateSchema.optional(),
  allowAutomaticDeath: z.boolean().optional(),
  inactive: z.boolean().optional(),
  behaviorOverride: z
    .object({
      initiative: z.number().min(0).max(1).optional(),
      topicIntervalMinutes: z.number().min(5).max(10080).optional(),
      replyChance: z.number().min(0).max(1).optional(),
      style: text.optional(),
      socialBehavior: CharacterSchema.shape.socialBehavior,
    })
    .optional(),
  evolutionFields: z.array(z.enum(evolutionFields)).optional(),
  evolved: z
    .object({
      initiative: z.number().min(0).max(1).optional(),
      personality: text.optional(),
      style: text.optional(),
      habits: text.optional(),
      goal: text.optional(),
      values: text.optional(),
      fear: text.optional(),
    })
    .optional(),
  id,
  worldId: id,
  characterId: id,
  identity: text,
  bioOverride: text,
  styleOverride: text,
});
export type Membership = z.infer<typeof MembershipSchema>;
export const GroupSchema = z.object({
  predecessorGroupId: z.string().optional(),
  provenance: ProvenanceSchema.optional(),
  deletedAt: time.optional(),
  id,
  entityMode: z.enum(['interactive', 'background']).optional(),
  fame: z.number().min(0).max(100).optional(),
  name: z.string().min(1).max(80),
  description: text,
  worldIds: z.array(id),
  color: z.string().max(20),
});
export type Group = z.infer<typeof GroupSchema>;
export const GroupMemberSchema = z.object({
  departedAt: z.number().optional(),
  id,
  groupId: id,
  worldId: id,
  characterId: id,
  nickname: text,
  role: text,
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;
export const RelationshipSchema = z.object({
  behavior: z
    .object({
      competition: z.number().min(0).max(1),
      banter: z.number().min(0).max(1),
      initiativeScale: z.number().min(0.1).max(2),
    })
    .optional(),
  provenance: ProvenanceSchema.optional(),
  generationMetadata: z
    .object({ origin: z.literal('ai'), uncertain: z.boolean(), at: time })
    .optional(),
  id,
  worldId: id,
  from: id,
  to: id,
  label: text,
  closeness: z.number().min(0).max(100),
  trust: z.number().min(0).max(100),
  familiarity: z.number().min(0).max(100),
  stage: text,
  nickname: text,
  attitude: text,
  history: text,
  locked: z.boolean(),
  boundaries: text,
});
export type Relationship = z.infer<typeof RelationshipSchema>;
export const ConversationSchema = z.object({
  plannedHistory: z
    .array(
      z.object({
        id: z.string(),
        speaker: z.string(),
        at: z.number(),
        count: z.number().int().min(0).max(3),
        eventId: z.string(),
      }),
    )
    .max(36)
    .optional(),
  avatar: z.string().max(1500000).optional(),
  titleMode: z.enum(['auto', 'custom']).optional(),
  customTitle: text.optional(),
  autoTitle: text.optional(),
  id,
  worldId: id,
  groupId: id.optional(),
  name: text,
  kind: z.enum(['direct', 'group', 'notes']),
  participantJoinedAt: z.record(time).optional(),
  participants: z.array(id).min(1).max(50),
  createdAt: time,
  lastAt: time,
  topicEndedAt: time.optional(),
  controlledId: id.optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
export const MessageSchema = z.object({
  planVersion: z.literal(1).optional(),
  backfilled: z.boolean().optional(),
  messageType: z.enum(['text', 'gif']).optional(),
  gifAssetId: id.optional(),
  replyToMessageId: id.optional(),
  mentionCharacterIds: z.array(id).max(50).optional(),
  mentions: z
    .array(
      z.object({
        characterId: id,
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        label: z.string().max(100),
      }),
    )
    .max(50)
    .optional(),
  id,
  conversationId: id,
  senderId: id,
  seq: z.number().int().positive(),
  text: z.string().min(1).max(2000),
  realAt: time,
  simAt: time,
  source: z.enum(['user', 'ai', 'demo']),
  eventId: id.optional(),
});
export type Message = z.infer<typeof MessageSchema>;
export const CursorSchema = z.object({
  id: z.string().min(1).max(512),
  conversationId: id,
  readerId: id,
  kind: z.enum(['observer', 'character']),
  seq: z.number().int().nonnegative(),
  at: time,
});
export type ReadCursor = z.infer<typeof CursorSchema>;
export const EventSchema = z.object({
  spiritParticipantIds: z.array(z.string()).optional(),
  lethalCandidateIds: z.array(z.string()).optional(),
  lethalReason: z.string().optional(),
  majorLevel: z.enum(['local', 'group', 'world']).optional(),
  parentEventId: z.string().optional(),
  rootEventId: z.string().optional(),
  chainDepth: z.number().int().min(0).max(3).optional(),
  origin: z.enum(['realtime', 'backfill', 'macro']).optional(),
  generatedAt: time.optional(),
  id,
  worldId: id,
  type: z.enum(['sleep', 'work', 'meal', 'rest', 'out', 'social', 'major']),
  start: time,
  end: time,
  participants: z.array(id).min(1),
  location: text,
  description: text,
  phone: z.number().min(0).max(1),
  status: z.enum(['planned', 'active', 'completed', 'cancelled']),
  sceneType: z
    .enum(['encounter', 'meal', 'rehearsal', 'date', 'gathering', 'walk', 'other'])
    .optional(),
  importance: z.number().min(0).max(1).optional(),
  dependsOn: id.optional(),
});
export type ActivityEvent = z.infer<typeof EventSchema>;
export const RuntimeSchema = z.object({
  id,
  worldId: id,
  characterId: id,
  eventId: id,
  activity: text,
  location: text,
  phone: z.number().min(0).max(1),
  mood: z.number().min(-1).max(1),
  lastPhone: time,
  lastAction: time,
  lastTopicAt: time.optional(),
});
export type RuntimeState = z.infer<typeof RuntimeSchema>;
export const MemorySchema = z.object({
  id,
  worldId: id,
  owners: z.array(id),
  content: text,
  keywords: z.array(z.string()),
  importance: z.number().min(0).max(1),
  at: time,
  eventId: id.optional(),
  conversationId: id.optional(),
  kind: z.enum(['knowledge', 'episode', 'summary']),
});
export type MemoryEntry = z.infer<typeof MemorySchema>;
export const CheckpointSchema = z.object({
  id,
  clockAnchor: z.object({ simTime: time, realTime: time }).optional(),
  simTime: time,
  realTime: time,
  seed: z.number().int(),
  lastEventAt: time,
  nextAt: time,
  paused: z.boolean(),
  speed: z.number().positive().max(3600),
  timeMode: z.enum(['god', 'real']).optional(),
  controlVersion: z.number().int().nonnegative().optional(),
  usageLimited: z.boolean().optional(),
  recoveryRealTarget: time.optional(),
  recoveryKind: z.enum(['offline', 'foreground']).optional(),
  /** When a deliberate time jump is catching up, the HUD shows this destination immediately. */
  jumpTarget: time.optional(),
  /** A jump started while paused lands paused; a jump started during playback keeps running. */
  jumpResumePaused: z.boolean().optional(),
  mode: z.enum(['demo', 'live']),
  recoveryTarget: time.optional(),
  recoveryStart: time.optional(),
  recoveryRequests: z.number().int().nonnegative().default(0),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export const SettingsSchema = z.object({
  adaptiveBatching: z.boolean().optional(),
  costControls: CostControlsSchema.optional(),
  installedPresets: z.record(z.number().int().positive()).optional(),
  id: z.literal('app'),
  worldId: z.string().max(160),
  activity: z.enum(['quiet', 'standard', 'lively', 'boiling', 'carnival']),
  dailyRequests: z.number().int().min(1).max(5000),
  dailyTokens: z.number().int().min(1000).max(10000000),
  dailyMessages: z.number().int().min(1).max(10000),
  recoveryBudget: z.number().int().min(1).max(200),
  nickname: z.string().min(1).max(40),
  userBio: text,
  userAvatar: z.string().max(1500000).optional(),
  unlimitedUsage: z.boolean().optional(),
  sceneReadingMode: z.enum(['stage', 'archive']).optional(),
  /** How eagerly a chat timeline surfaces related in-person scenes. */
  sceneLinkMode: z.enum(['all', 'mutual', 'off']).optional(),
  sceneFrequency: z.number().min(0).max(1).optional(),
  sceneDailyBudget: z.number().int().min(0).max(100).optional(),
  onboarded: z.boolean(),
  gifAutoplay: z.boolean().optional(),
  theme: z.enum(['light', 'dark']),
  uiMode: z.enum(['game', 'classic']).optional(),
  motionLevel: z.enum(['off', 'low', 'standard', 'high']).optional(),
});
export type AppSettings = z.infer<typeof SettingsSchema>;
export const ProfileSchema = z.object({
  id: z.literal('api'),
  provider: z.string().max(60),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(100),
  persistKey: z.boolean(),
  contextBudgetTokens: z.number().int().min(1000).max(MAX_CONTEXT_BUDGET_TOKENS).optional(),
  outputBudgetTokens: z.number().int().min(256).max(16000).optional(),
  structuredOutputMode: z.enum(['auto', 'json', 'off']).optional(),
  thinkingMode: z.enum(['auto', 'off', 'on']).optional(),
  reasoningPolicy: z.enum(['auto', 'user', 'advanced']).optional(),
  reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
  deepSeekCompatible: z.boolean().optional(),
  temperatures: z
    .object({
      chat: z.number().min(0).max(2).optional(),
      scene: z.number().min(0).max(2).optional(),
      major: z.number().min(0).max(2).optional(),
      evolution: z.number().min(0).max(2).optional(),
      report: z.number().min(0).max(2).optional(),
      life: z.number().min(0).max(2).optional(),
      novel: z.number().min(0).max(2).optional(),
      expansion: z.number().min(0).max(2).optional(),
    })
    .optional(),
  stablePrefix: z.boolean().optional(),
  compactProtocol: z.boolean().optional(),
  unsupportedThinkingModels: z.array(z.string()).max(64).optional(),
  taskRoutes: z
    .object({
      routine: TaskRouteSchema.optional(),
      complex: TaskRouteSchema.optional(),
      story: TaskRouteSchema.optional(),
    })
    .optional(),
  key: z.string().max(2000).optional(),
  status: z.enum(['untested', 'connected', 'invalid', 'error']),
  inputPrice: z.number().nonnegative().optional(),
  outputPrice: z.number().nonnegative().optional(),
});
export type ApiProfile = z.infer<typeof ProfileSchema>;
export const UsageSchema = z.object({
  id,
  day: z.string(),
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  messages: z.number().int().nonnegative(),
  estimated: z.boolean(),
});
export type Usage = z.infer<typeof UsageSchema>;
export const BackgroundKnowledgeSchema = z.object({
  knownAt: time.optional(),
  id,
  worldId: id,
  entityId: id,
  characterId: id,
  level: z.enum(['unknown', 'name', 'partial', 'familiar', 'personal']),
  items: z
    .array(
      z.object({
        kind: z.enum(['fact', 'rumor', 'falseRumor', 'opinion']),
        content: text,
        source: text,
        learnedAt: time.optional(),
      }),
    )
    .max(100),
});
export type BackgroundKnowledge = z.infer<typeof BackgroundKnowledgeSchema>;
export const SceneSchema = z.object({
  id,
  worldId: id,
  eventId: id,
  titleMode: z.enum(['auto', 'custom']).optional(),
  customTitle: text.optional(),
  autoTitle: text.optional(),
  generationStatus: z.enum(['partial', 'complete', 'failed']).optional(),
  generationError: text.optional(),
  generationCheckpoint: z.number().int().nonnegative().optional(),
  plannedPhases: z
    .array(z.object({ id, title: text, start: time, end: time, participants: z.array(id) }))
    .max(32)
    .optional(),
  title: z.string().min(1).max(200),
  location: text,
  type: z.string().max(80),
  participants: z.array(id).min(2).max(50),
  start: time,
  end: time,
  promptVersion: z.number().int().positive(),
  phases: z
    .array(
      z.object({
        id,
        title: z.string().min(1).max(120),
        start: time,
        end: time,
        participants: z.array(id).min(1),
        entries: z
          .array(
            z.object({
              kind: z.enum(['dialogue', 'activity']),
              at: time,
              speakerId: id.optional(),
              text: z.string().min(1).max(1000),
            }),
          )
          .min(1)
          .max(40),
      }),
    )
    .max(32),
});
export type InPersonScene = z.infer<typeof SceneSchema>;
export const ContentJobSchema = z
  .object({
    plan: z
      .object({
        version: z.literal(1),
        expectedMessages: z.number().int().min(0).max(3),
        expectedDialogue: z.number().int().min(0).max(200),
        expectedPhases: z.number().int().min(0).max(5),
      })
      .optional(),
    budgetBlockedAt: z.number().optional(),
    budgetBlockedDay: z.number().optional(),
    lastRequestId: z.string().optional(),
    snapshotId: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    createdAt: z.number().optional(),
    completedAt: z.number().optional(),
    partial: z.record(z.unknown()).optional(),
    batchScale: z.number().optional(),
    errorCode: z.string().optional(),

    id: z.string().max(512),
    worldId: z.string(),
    kind: z.enum(['chat', 'life', 'scene', 'major']),
    event: EventSchema,
    conversation: ConversationSchema.optional(),
    speakerId: z.string().optional(),
    at: z.number(),
    state: RuntimeSchema.optional(),
    snapshot: z.union([
      PromptConfigSchema,
      PromptConfigSchema.extend({ entries: z.array(PromptEntrySchema).max(0) }),
    ]),
    recovery: z.boolean(),
    status: z.enum(['pending', 'running', 'failed', 'complete']),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number(),
    error: z.string().optional(),
    controlVersion: z.number().optional(),
  })
  .refine((job) => job.snapshot.entries.length > 0 || !!job.snapshotId, {
    message: '精简任务快照必须引用已保存的完整提示词',
  });
export type ContentJob = z.infer<typeof ContentJobSchema>;

export const ReactionSchema = z.object({
  id: z.string().max(512),
  messageId: id,
  actorId: id,
  emoji: z.string().min(1).max(16),
  reactedAt: time,
});
export type MessageReaction = z.infer<typeof ReactionSchema>;
export const ReadStateSchema = z.object({
  kind: z.enum(['observer', 'character']).optional(),
  id: z.string().max(512),
  messageId: id,
  readerId: id,
  readAt: time,
});
export type MessageReadState = z.infer<typeof ReadStateSchema>;
export const GifAssetSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  tags: z.array(z.string().max(50)).max(30),
  description: text,
  scopeType: z.enum(['world', 'group', 'character']),
  scopeId: id,
  resourceId: id,
  favorite: z.boolean(),
  removed: z.boolean().optional(),
  createdAt: time,
});
export type GifAsset = z.infer<typeof GifAssetSchema>;
export const ResourceBackupSchema = z.object({
  id,
  mime: z.literal('image/gif'),
  size: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  digest: z.string().length(64),
  data: z.string().max(7100000),
});
export type LocalResource = {
  id: string;
  mime: 'image/gif';
  size: number;
  digest: string;
  blob: Blob;
};
export const MajorScheduleSchema = z.object({
  id,
  lastOccurredAt: time,
  nextDueAt: time,
  plannedAt: time,
  sequence: z.number().int().nonnegative(),
  lastType: z.string(),
  dayKey: z.string().max(20).optional(),
  countToday: z.number().int().nonnegative().optional(),
  lastLevel: z.enum(['local', 'group', 'world']).optional(),
});
export type MajorSchedule = z.infer<typeof MajorScheduleSchema>;
/** A causal follow-up whose time has not arrived yet; persisted so it cannot be lost. */
export const MajorChainSchema = z.object({
  id,
  worldId: id,
  parentEventId: id,
  rootEventId: id,
  depth: z.number().int().min(1).max(3),
  dueAt: time,
  level: z.enum(['local', 'group', 'world']),
  groupId: id.optional(),
  participantIds: z.array(id).min(2),
  description: text,
  location: text,
  createdAt: time,
});
export type MajorChain = z.infer<typeof MajorChainSchema>;
export const MajorEventSchema = z.object({
  id,
  eventId: id,
  worldId: id,
  title: z.string().min(1).max(200),
  timestamp: time,
  participantIds: z.array(id).min(1),
  groupIds: z.array(id),
  importance: z.number().min(0).max(1),
  status: z.enum(['contentPending', 'occurred', 'cancelled']),
  type: z.string().max(80),
  level: z.enum(['local', 'group', 'world']).optional(),
  parentEventId: id.optional(),
  rootEventId: id.optional(),
  chainDepth: z.number().int().min(0).max(3).optional(),
  description: text,
  consequences: z
    .array(
      z.object({
        kind: z.enum(['relationship', 'followUp', 'life', 'organization', 'world']),
        description: text,
        from: id.optional(),
        to: id.optional(),
        delta: z.number().min(-5).max(5).optional(),
      }),
    )
    .max(20),
});
export type MajorEvent = z.infer<typeof MajorEventSchema>;
export const NotificationSchema = z.object({
  id,
  eventId: id,
  worldId: id,
  createdAt: time,
  readAt: time.optional(),
  dismissedAt: time.optional(),
  recovery: z.boolean(),
});
export type EventNotification = z.infer<typeof NotificationSchema>;
export const BackupSchema = z.object({
  narrativeChanges: z.array(NarrativeChangeSchema).default([]),
  organizationStates: z.array(OrganizationStateSchema).default([]),
  usageLedger: z.array(UsageLedgerSchema).max(1000000).default([]),
  expansionJobs: z.array(ExpansionJobSchema).max(1000).default([]),
  observationConfigs: z.array(ObservationConfigSchema).default([]),
  observationCoverage: z.array(CoverageSchema).default([]),
  backfillJobs: z.array(BackfillSchema).default([]),
  evolutionRecords: z.array(EvolutionRecordSchema).default([]),
  evolutionCursors: z.array(EvolutionCursorSchema).default([]),
  worldReports: z.array(WorldReportSchema).default([]),
  reportCursors: z.array(ReportCursorSchema).default([]),
  majorSchedules: z.array(MajorScheduleSchema).max(100).default([]),
  majorChains: z.array(MajorChainSchema).max(5000).default([]),
  majorEvents: z.array(MajorEventSchema).max(100000).default([]),
  notifications: z.array(NotificationSchema).max(100000).default([]),
  reactions: z.array(ReactionSchema).max(200000).default([]),
  readStates: z.array(ReadStateSchema).max(1000000).default([]),
  gifAssets: z.array(GifAssetSchema).max(2000).default([]),
  resources: z.array(ResourceBackupSchema).max(2000).default([]),
  taskSnapshots: z.array(z.object({ id: z.string(), config: PromptConfigSchema })).default([]),
  contentJobs: z.array(ContentJobSchema).max(100000).default([]),
  scenes: z.array(SceneSchema).max(50000).default([]),
  backgroundKnowledge: z.array(BackgroundKnowledgeSchema).max(50000).default([]),
  format: z.literal('aquarium'),
  version: z.literal(1),
  exportedAt: time,
  characters: z.array(CharacterSchema).max(1000),
  worlds: z.array(WorldSchema).max(100),
  memberships: z.array(MembershipSchema).max(10000),
  groups: z.array(GroupSchema).max(1000),
  groupMembers: z.array(GroupMemberSchema).max(10000),
  relationships: z.array(RelationshipSchema).max(30000),
  conversations: z.array(ConversationSchema).max(10000),
  messages: z.array(MessageSchema).max(200000),
  cursors: z.array(CursorSchema).max(50000),
  events: z.array(EventSchema).max(200000),
  states: z.array(RuntimeSchema).max(10000),
  memories: z.array(MemorySchema).max(50000),
  checkpoints: z.array(CheckpointSchema).max(100),
  settings: z.array(SettingsSchema).max(1),
  promptConfigs: z.array(PromptConfigSchema).max(1).default([]),
  usage: z.array(UsageSchema).max(10000),
});
export type Backup = z.infer<typeof BackupSchema>;
export const uid = (prefix = 'id') => `${prefix}-${crypto.randomUUID()}`;
export const HOUR = 3600000,
  DAY = 24 * HOUR;
export const activityNames: Record<ActivityEvent['type'], string> = {
  major: '重要事件',
  sleep: '睡觉中',
  work: '忙碌中',
  meal: '吃饭中',
  rest: '休息中',
  out: '外出中',
  social: '一起活动',
};
