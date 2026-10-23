import { PromptConfigSchema } from '../ai/prompts';
import { z } from 'zod';
const id = z.string().min(1).max(160),
  at = z.number().finite().nonnegative();
export const ObservationConfigSchema = z.object({
  id,
  mode: z.enum(['full', 'selective']),
  characterIds: z.array(id),
  groupIds: z.array(id),
  pairs: z.array(z.tuple([id, id])),
  updatedAt: at,
});
export type ObservationConfig = z.infer<typeof ObservationConfigSchema>;
export const CoverageSchema = z.object({
  id: z.string().max(512),
  worldId: id,
  target: z.string().max(350),
  intervals: z.array(z.tuple([at, at])).max(512),
});
export const BackfillSchema = z.object({
  snapshot: PromptConfigSchema.optional(),
  id,
  worldId: id,
  targets: z.array(z.string().max(350)),
  characterIds: z.array(id),
  groupIds: z.array(id),
  pairs: z.array(z.tuple([id, id])),
  start: at,
  end: at,
  checkpoint: at,
  completedIntervals: z.array(z.tuple([at, at])),
  status: z.enum(['pending', 'running', 'waiting', 'paused', 'complete', 'failed']),
  eventCount: z.number(),
  messageCount: z.number(),
  contentJobIds: z.array(z.string().max(512)),
  notes: z.array(z.string().max(1000)),
  error: z.string().optional(),
  createdAt: at,
});
export type BackfillJob = z.infer<typeof BackfillSchema>;
export const evolutionFields = ['initiative', 'personality', 'style', 'habits'] as const;
export type EvolutionField = (typeof evolutionFields)[number];
export const EvolutionRecordSchema = z.object({
  id,
  worldId: id,
  characterId: id,
  at,
  field: z.enum(evolutionFields),
  previousValue: z.union([z.number(), z.string().max(8000)]),
  newValue: z.union([z.number(), z.string().max(8000)]),
  sourceEventIds: z.array(id).min(1),
  reason: z.string().max(2000),
  status: z.enum(['applied', 'reverted']),
  dependsOn: id.optional(),
});
export type EvolutionRecord = z.infer<typeof EvolutionRecordSchema>;
export const EvolutionCursorSchema = z.object({ id, lastAt: at });
export const reportTypes = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
export const reportNames = {
  daily: '日报',
  weekly: '周报',
  monthly: '月报',
  quarterly: '季报',
  yearly: '年报',
};
export const ReportSettingsSchema = z.object({
  daily: z.boolean(),
  weekly: z.boolean(),
  monthly: z.boolean(),
  quarterly: z.boolean(),
  yearly: z.boolean(),
});
export const emptyReports = {
  daily: false,
  weekly: false,
  monthly: false,
  quarterly: false,
  yearly: false,
};
export type ReportType = (typeof reportTypes)[number];
export const ReportSourceSchema = z.object({
  id,
  type: z.enum(['event', 'message', 'scene', 'evolution', 'memory']),
  label: z.string().max(8000),
  at,
  characterIds: z.array(id),
  conversationId: id.optional(),
});
export type ReportSource = z.infer<typeof ReportSourceSchema>;
export const WorldReportSchema = z.object({
  id: z.string().max(512),
  worldId: id,
  type: z.enum(reportTypes),
  start: at,
  end: at,
  status: z.enum(['pending', 'generating', 'ready', 'failed']),
  sources: z.array(ReportSourceSchema).max(120),
  sections: z
    .array(z.object({ heading: z.string().max(120), sourceIds: z.array(id).max(100) }))
    .max(12),
  overview: z.string().max(2000),
  generatedAt: at.optional(),
  promptVersion: z.number().optional(),
  error: z.string().optional(),
});
export type WorldReport = z.infer<typeof WorldReportSchema>;
export const ReportCursorSchema = z.object({
  id: z.string().max(512),
  worldId: id,
  type: z.enum(reportTypes),
  nextStart: at,
});
