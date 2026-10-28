import { z } from 'zod';
export const lifeStates = ['alive', 'missing', 'dead', 'resurrecting', 'resurrected'] as const;
export const groupStates = [
  'active',
  'tension',
  'fractured',
  'disbanded',
  'reconciling',
  'reunited',
] as const;
export const lifeNames = {
  alive: '存活',
  missing: '失踪',
  dead: '确认死亡',
  resurrecting: '复活过程中',
  resurrected: '复活后存活',
};
export const groupStateNames = {
  active: '正常运行',
  tension: '矛盾加剧',
  fractured: '决裂',
  disbanded: '解散',
  reconciling: '和解中',
  reunited: '重圆',
};
export const LifeRulesSchema = z.object({
  allowDeath: z.boolean().default(false),
  risk: z.enum(['low', 'standard', 'high', 'custom']).default('low'),
  riskWeight: z.number().min(0).max(1).default(0.05),
  resurrection: z.enum(['forbidden', 'conditional', 'worldRules']).default('forbidden'),
  resurrectionRules: z.string().max(4000).default(''),
  resurrectionRequirements: z.array(z.string().min(1).max(200)).max(12).default([]),
  spiritCommunication: z.boolean().default(false),
});
export const LifeStateSchema = z.object({
  status: z.enum(lifeStates),
  since: z.number(),
  eventId: z.string(),
  body: z.enum(['living', 'dead', 'unknown']),
  consciousness: z.enum(['present', 'absent', 'unknown']),
  canCommunicate: z.boolean(),
});
export const OrganizationStateSchema = z.object({
  id: z.string(),
  worldId: z.string(),
  groupId: z.string(),
  status: z.enum(groupStates),
  since: z.number(),
  eventId: z.string(),
});
export const NarrativeChangeSchema = z.object({
  id: z.string(),
  worldId: z.string(),
  eventId: z.string(),
  entityId: z.string(),
  entityKind: z.enum(['character', 'group']),
  at: z.number(),
  from: z.string(),
  to: z.string(),
  reason: z.string().min(1).max(2000),
  evidence: z.string().min(4).max(1000),
  beforeLife: LifeStateSchema.optional(),
  afterLife: LifeStateSchema.optional(),
  memberChanges: z
    .array(z.object({ characterId: z.string(), action: z.enum(['leave', 'rejoin']) }))
    .default([]),
  successorGroupIds: z.array(z.string()).default([]),
});
export const NarrativeProposalSchema = z.object({
  entityKind: z.enum(['character', 'group']),
  entityId: z.string(),
  to: z.string(),
  reason: z.string().min(1).max(1000),
  evidence: z.string().min(4).max(800),
  ruleQuote: z.string().max(500).optional(),
  spirit: z.boolean().optional(),
  memberChanges: z
    .array(z.object({ characterId: z.string(), action: z.enum(['leave', 'rejoin']) }))
    .max(100)
    .default([]),
  successors: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(2000),
        memberIds: z.array(z.string()).min(1).max(100),
      }),
    )
    .max(4)
    .default([]),
});
export type NarrativeProposal = z.infer<typeof NarrativeProposalSchema>;
export type NarrativeChange = z.infer<typeof NarrativeChangeSchema>;
export type OrganizationState = z.infer<typeof OrganizationStateSchema>;
export type LifeState = z.infer<typeof LifeStateSchema>;
