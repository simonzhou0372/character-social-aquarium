import type { ContentJob, Message, Character, Conversation } from './types';
import type { PromptConfig } from '../ai/prompts';
import { sceneDialogueBudget } from './scenes';
export const MAX_PENDING_CONTENT = 256;
export const MAX_READY_CONTENT = 48;
export const activeConversations = new Map<string, string>();
export function plannedCount(seed: number, config: PromptConfig, character?: Character) {
  const max = config.rules.allowConsecutive
    ? Math.min(config.rules.maxMessages, character?.messagePreferences?.maxMessages ?? 3)
    : 1;
  const min = Math.min(max, config.rules.minMessages);
  return min + (Math.abs(seed) % (max - min + 1));
}
export function contentPlan(
  kind: ContentJob['kind'],
  seed: number,
  config: PromptConfig,
  event: ContentJob['event'],
  character?: Character,
) {
  return {
    version: 1 as const,
    expectedMessages: kind === 'chat' ? plannedCount(seed, config, character) : 0,
    expectedDialogue: kind === 'scene' ? sceneDialogueBudget(event) : 0,
    expectedPhases: kind === 'scene' ? (event.end - event.start < 15 * 60000 ? 1 : 3) : 0,
  };
}
/** Headers only: scheduler decisions depend on saved plans, never API latency or phrasing. */
export function planningHistory(
  history: Message[],
  plans: NonNullable<Conversation['plannedHistory']>,
  conversationId: string,
): Message[] {
  const actual = history.filter((m) => m.planVersion !== 1);
  for (const j of plans)
    for (let i = 0; i < j.count; i++)
      actual.push({
        id: `${j.id}:planned:${i}`,
        conversationId,
        senderId: j.speaker,
        text: '',
        simAt: j.at + i * 1000,
        seq: 1,
        realAt: 0,
        source: 'ai',
        eventId: j.eventId,
      } as Message);
  return actual
    .sort((a, b) => a.simAt - b.simAt || a.seq - b.seq)
    .map((m, i) => ({ ...m, seq: i + 1 }));
}
export type BatchHealth = { scale: number; latencyMs: number; successes: number; failures: number };
export function adaptiveLimits(
  speed: number,
  enabled: boolean,
  outputLimit: number,
  health: BatchHealth,
) {
  const ceiling = !enabled || speed < 300 ? 1 : speed < 1000 ? 4 : speed < 3000 ? 8 : 12;
  return {
    maxTasks: Math.max(
      1,
      Math.floor(
        ceiling *
          health.scale *
          (health.latencyMs > 25000 ? 0.65 : 1) *
          (health.failures > 2 && health.failures / (health.successes + health.failures) > 0.3
            ? 0.7
            : 1),
      ),
    ),
    outputTokens: Math.max(
      256,
      Math.floor(Math.min(12000, outputLimit) * Math.max(0.35, health.scale)),
    ),
    inputTokens: 32000,
  };
}
