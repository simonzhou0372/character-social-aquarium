import { LifeRulesSchema } from './narrative-types';
import { z } from 'zod';
const major = z.object({
  enabled: z.boolean(),
  maximumIntervalDays: z.number().min(1).max(36500),
  tendency: z.string().max(4000),
  allowRelationshipChanges: z.boolean(),
  allowMultipleGroups: z.boolean(),
});
export const StoryEvidenceSchema = z.object({
  eventId: z.string(),
  quote: z.string().min(4).max(600),
});
export const StoryConditionSchema = z.object({
  id: z.string().max(80),
  description: z.string().min(1).max(500),
  evidence: z.array(StoryEvidenceSchema).max(20),
});
export const NovelSchema = z
  .object({
    lifeRules: LifeRulesSchema.optional(),
    allowGroupChanges: z.boolean().optional(),
    enabled: z.boolean(),
    goal: z.string().max(4000),
    startedAt: z.number().optional(),
    stage: z
      .enum(['foundation', 'development', 'turning', 'finale', 'completed'])
      .default('foundation'),
    conditions: z.array(StoryConditionSchema).max(8).default([]),
    milestones: z
      .array(z.object({ eventId: z.string(), summary: z.string().max(1000) }))
      .max(500)
      .default([]),
    unresolved: z.array(z.string().max(500)).max(10).default([]),
    ending: z
      .object({ text: z.string().min(1).max(3000), eventIds: z.array(z.string()), at: z.number() })
      .optional(),
    previous: z
      .object({
        evolution: z.object({ enabled: z.boolean(), rules: z.string().max(4000) }).optional(),
        major: major.optional(),
      })
      .optional(),
  })
  .superRefine((n, ctx) => {
    if (n.enabled && !n.goal.trim())
      ctx.addIssue({ code: 'custom', path: ['goal'], message: '小说模式必须填写结局目标' });
  });
export type NovelConfig = z.infer<typeof NovelSchema>;
export const storyStageNames = {
  foundation: '开篇与铺垫',
  development: '发展',
  turning: '转折',
  finale: '结局阶段',
  completed: '故事已完成',
};
/** A new date branch or configuration-only import has no evidence in the new timeline yet. */
export function restartNovel(n: NovelConfig | undefined, at: number): NovelConfig | undefined {
  return n
    ? {
        ...n,
        startedAt: at,
        stage: 'foundation',
        conditions: [],
        milestones: [],
        unresolved: [],
        ending: undefined,
      }
    : undefined;
}
