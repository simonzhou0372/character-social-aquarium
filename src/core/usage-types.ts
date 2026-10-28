import { z } from 'zod';
const tokens = z.number().finite().nonnegative();
export const ModelPricingSchema = z.object({
  model: z.string().min(1).max(100),
  currency: z.enum(['CNY', 'USD']),
  input: tokens,
  cachedInput: tokens.optional(),
  output: tokens,
  offPeak: z.object({ input: tokens, cachedInput: tokens, output: tokens }).optional(),
  // Holidays cannot be inferred reliably from a weekday calculation.
  period: z.enum(['peak', 'offPeak', 'conservativePeak']).default('conservativePeak'),
  cnyPerUnit: z.number().positive().optional(),
  confirmedAt: z.number(),
  source: z.string().max(500),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;
export const CostControlsSchema = z.object({
  prices: z.array(ModelPricingSchema).max(100).default([]),
  budget: z
    .object({
      period: z.enum(['unlimited', 'realDay', 'virtualDay', 'virtualWeek']),
      cny: z.number().positive(),
      warnRatio: z.number().min(0.1).max(1).default(0.8),
    })
    .optional(),
  localDescriptions: z.boolean().optional(),
  economy: z.boolean().optional(),
});
export const TaskRouteSchema = z.object({
  model: z.string().max(100).optional(),
  thinking: z.enum(['off', 'on', 'default']).optional(),
  effort: z.enum(['low', 'high', 'max']).optional(),
});
export const UsageLedgerSchema = z.object({
  id: z.string(),
  worldId: z.string(),
  task: z.string(),
  model: z.string(),
  characterIds: z.array(z.string()).default([]),
  groupIds: z.array(z.string()).default([]),
  virtualAt: z.number().optional(),
  virtualDay: z.number().int().optional(),
  budgetVirtualDay: z.number().int().optional(),
  startedAt: z.number(),
  sentAt: z.number().optional(),
  endedAt: z.number().optional(),
  status: z.enum(['running', 'success', 'failed', 'truncated']),
  errorCode: z.string().optional(),
  validationStatus: z.enum(['accepted', 'partial', 'rejected']).optional(),
  validationCode: z.string().optional(),
  thinking: z.enum(['on', 'off', 'unknown']),
  effort: z.string().optional(),
  inputTokens: tokens.optional(),
  outputTokens: tokens.optional(),
  reasoningTokens: tokens.optional(),
  cacheHitTokens: tokens.optional(),
  cacheMissTokens: tokens.optional(),
  estimated: z.boolean(),
  retryOf: z.string().optional(),
  attempt: z.number().int().nonnegative().default(0),
  pricing: ModelPricingSchema.optional(),
  cost: tokens.optional(),
  costCny: tokens.optional(),
  costQuality: z.enum(['configured-estimate', 'incomplete', 'unknown']).default('unknown'),
  completedTaskIds: z.array(z.string()).default([]),
  events: tokens.default(0),
  messages: tokens.default(0),
  dialogue: tokens.default(0),
  reservedCny: tokens.optional(),
});
export type UsageLedger = z.infer<typeof UsageLedgerSchema>;
