import { z } from 'zod';
import { PromptConfigSchema } from '../ai/prompts';
export const ExpansionCharacterSchema = z.object({
  name: z.string().trim().min(1).max(60),
  source: z.string().max(200).default('原创'),
  bio: z.string().max(1000).default(''),
  personality: z.string().max(1000).default(''),
  style: z.string().max(1000).default(''),
  habits: z.string().max(1000).default(''),
  aliases: z.array(z.string().max(80)).max(12).default([]),
});
export const ExpansionGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).default(''),
  memberNames: z.array(z.string().max(80)).min(2).max(50),
});
export const ExpansionJobSchema = z.object({
  id: z.string(),
  worldId: z.string(),
  constraints: z.string().min(1).max(8000),
  target: z.number().int().min(1).max(200),
  characters: z.array(ExpansionCharacterSchema).max(200),
  groups: z.array(ExpansionGroupSchema).max(100),
  status: z.enum(['draft', 'generating', 'cancelled', 'applied']),
  error: z.string().optional(),
  snapshot: PromptConfigSchema,
  createdAt: z.number(),
  decisions: z
    .record(
      z.object({
        action: z.enum(['new', 'use', 'merge', 'skip']),
        characterId: z.string().optional(),
      }),
    )
    .default({}),
});
export type ExpansionJob = z.infer<typeof ExpansionJobSchema>;
