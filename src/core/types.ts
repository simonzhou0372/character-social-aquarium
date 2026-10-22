import { z } from 'zod';
import { WorldDateTimeSchema } from './calendar';
import { PromptConfigSchema } from '../ai/prompts';
const id = z.string().min(1).max(160),
  text = z.string().max(8000),
  time = z.number().finite().nonnegative();
export const CharacterSchema = z.object({
  id,
  name: z.string().min(1).max(60),
  gender: z.string().max(200).optional(),
  entityMode: z.enum(['interactive', 'background']).optional(),
  fame: z.number().min(0).max(100).optional(),
  source: text,
  avatar: z.string().max(1500000),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  bio: text,
  personality: text,
  style: text,
  habits: text,
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
  id,
  name: z.string().min(1).max(80),
  description: text,
  rules: text,
  locations: z.array(z.string().max(100)).min(1).max(30),
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
  id,
  worldId: id,
  characterId: id,
  identity: text,
  bioOverride: text,
  styleOverride: text,
});
export type Membership = z.infer<typeof MembershipSchema>;
export const GroupSchema = z.object({
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
  id,
  groupId: id,
  worldId: id,
  characterId: id,
  nickname: text,
  role: text,
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;
export const RelationshipSchema = z.object({
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
  id,
  worldId: id,
  groupId: id.optional(),
  name: text,
  kind: z.enum(['direct', 'group']),
  participants: z.array(id).min(1).max(50),
  createdAt: time,
  lastAt: time,
  topicEndedAt: time.optional(),
  controlledId: id.optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
export const MessageSchema = z.object({
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
  id,
  worldId: id,
  type: z.enum(['sleep', 'work', 'meal', 'rest', 'out', 'social']),
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
  mode: z.enum(['demo', 'live']),
  recoveryTarget: time.optional(),
  recoveryStart: time.optional(),
  recoveryRequests: z.number().int().nonnegative().default(0),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export const SettingsSchema = z.object({
  id: z.literal('app'),
  worldId: id,
  activity: z.enum(['quiet', 'standard', 'lively']),
  dailyRequests: z.number().int().min(1).max(5000),
  dailyTokens: z.number().int().min(1000).max(10000000),
  dailyMessages: z.number().int().min(1).max(10000),
  recoveryBudget: z.number().int().min(1).max(200),
  nickname: z.string().min(1).max(40),
  userBio: text,
  userAvatar: z.string().max(1500000).optional(),
  unlimitedUsage: z.boolean().optional(),
  sceneFrequency: z.number().min(0).max(1).optional(),
  sceneDailyBudget: z.number().int().min(0).max(100).optional(),
  onboarded: z.boolean(),
  theme: z.enum(['light', 'dark']),
});
export type AppSettings = z.infer<typeof SettingsSchema>;
export const ProfileSchema = z.object({
  id: z.literal('api'),
  provider: z.string().max(60),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(100),
  persistKey: z.boolean(),
  contextBudgetTokens: z.number().int().min(1000).max(32000).optional(),
  outputBudgetTokens: z.number().int().min(256).max(16000).optional(),
  thinkingMode: z.enum(['auto', 'off', 'on']).optional(),
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
      }),
    )
    .max(100),
});
export type BackgroundKnowledge = z.infer<typeof BackgroundKnowledgeSchema>;
export const SceneSchema = z.object({
  id,
  worldId: id,
  eventId: id,
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
    .min(1)
    .max(8),
});
export type InPersonScene = z.infer<typeof SceneSchema>;
export const BackupSchema = z.object({
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
  sleep: '睡觉中',
  work: '忙碌中',
  meal: '吃饭中',
  rest: '休息中',
  out: '外出中',
  social: '一起活动',
};
