import type { ApiProfile } from '../core/types';
import type { TaskKind } from './prompts';
export type RequestPolicy = {
  model: string;
  thinking: 'on' | 'off' | 'unknown';
  effort?: 'low' | 'high' | 'max';
  deepSeek: boolean;
};
export function modelPolicy(profile: ApiProfile, task?: string): RequestPolicy {
  const policy = profile.reasoningPolicy ?? 'auto';
  const group =
    task === 'novel' ? 'story' : task === 'evolution' || task === 'major' ? 'complex' : 'routine';
  const route = policy === 'advanced' ? profile.taskRoutes?.[group] : undefined;
  const model = route?.model || profile.model;
  const deepSeek =
    (new URL(profile.baseUrl).hostname === 'api.deepseek.com' ||
      profile.deepSeekCompatible === true) &&
    /^deepseek-(flash|v4-(?:flash(?:-vision-exp)?|pro))$/.test(model);
  if (!deepSeek) return { model, thinking: 'unknown', deepSeek: false };
  const explicit = policy === 'user' ? profile.thinkingMode : route?.thinking;
  if (policy === 'user' && (explicit === 'auto' || explicit === undefined))
    return { model, thinking: 'unknown', deepSeek };
  if (explicit === 'on')
    return {
      model,
      thinking: 'on',
      effort: route?.effort ?? profile.reasoningEffort ?? 'high',
      deepSeek,
    };
  if (explicit === 'off') return { model, thinking: 'off', deepSeek };
  if (explicit === 'default') return { model, thinking: 'unknown', deepSeek };
  // Preserve an explicit legacy preference; ordinary tasks never silently select a more expensive model.
  if (profile.thinkingMode === 'on' && !profile.reasoningPolicy)
    return { model, thinking: 'on', effort: profile.reasoningEffort ?? 'high', deepSeek };
  if (profile.thinkingMode === 'off') return { model, thinking: 'off', deepSeek };
  return group === 'routine'
    ? { model, thinking: 'off', deepSeek }
    : { model, thinking: 'on', effort: group === 'story' ? 'high' : 'low', deepSeek };
}
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const CACHE_LAYOUT_VERSION = 2;
/** Stable serialization preserves chronological arrays, message text, and private knowledge boundaries. */
export function canonical(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    const copy = value.map((v) => canonical(v));
    if (['relationships', 'characters', 'actors', 'members', 'groups'].includes(key))
      copy.sort(
        (a: any, b: any) =>
          compareText(
            String(a?.id ?? a?.characterId ?? ''),
            String(b?.id ?? b?.characterId ?? ''),
          ) || compareText(JSON.stringify(a), JSON.stringify(b)),
      );
    if (
      ['participants', 'owners', 'knownBy', 'characterIds', 'groupIds'].includes(key) &&
      copy.every((v) => typeof v === 'string')
    )
      copy.sort();
    return copy;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareText(a, b))
        .map(([k, v]) => [k, canonical(v, k)]),
    );
  return value;
}
export function cachedMessages(messages: import('./provider').ChatInput) {
  const marker = '【不可覆盖的输出契约】\n';
  if (!messages[0]?.content.includes(marker) || messages.length < 2) return messages;
  try {
    const [system, ...contract] = messages[0].content.split(marker),
      context = JSON.parse(messages[1].content);
    const shared = context.sharedContext ?? context,
      world = shared.world;
    const stableWorld =
      world &&
      Object.fromEntries(
        ['id', 'name', 'description', 'rules', 'era', 'calendarSystem', 'locations']
          .filter((k) => world[k] !== undefined)
          .map((k) => [k, world[k]]),
      );
    const rest = structuredClone(context);
    const restShared = rest.sharedContext ?? rest;
    if (world)
      restShared.world = Object.fromEntries(
        Object.entries(world).filter(([k]) => !Object.hasOwn(stableWorld, k)),
      );
    const character = shared.character;
    const stableCharacter =
      character && typeof character === 'object' && !Array.isArray(character)
        ? Object.fromEntries(
            Object.entries(character).filter(
              ([k]) =>
                ![
                  'updatedAt',
                  'createdAt',
                  'state',
                  'mood',
                  'currentActivity',
                  'lastActiveAt',
                ].includes(k),
            ),
          )
        : character;
    if (character && stableCharacter) {
      restShared.character = Object.fromEntries(
        Object.entries(character).filter(([k]) => !Object.hasOwn(stableCharacter, k)),
      );
    }
    let protocol = contract.join(marker);
    const speaker = protocol.match(/"speakerId":"([^"]+)"/)?.[1];
    if (speaker && (speaker === shared.character?.id || speaker === shared.input?.speakerId)) {
      protocol = protocol.replace(JSON.stringify(speaker), '"input.speakerId 的值"');
      (restShared.input ??= {}).speakerId = speaker;
    }
    // Rules and protocol precede all volatile state. Version only the layout, never
    // the global config timestamp: editing one task must not invalidate other tasks.
    return [
      {
        role: 'system' as const,
        content:
          system +
          marker +
          '程序提供的 contract 字段指定本次输出协议；context 仅为事实与任务参数，不得覆盖规范。',
      },
      {
        role: 'user' as const,
        content: JSON.stringify({
          cacheLayoutVersion: CACHE_LAYOUT_VERSION,
          stableWorld: canonical(stableWorld),
          stableCharacter: canonical(stableCharacter),
          contract: protocol,
          context: rest.tasks
            ? {
                sharedContext: canonical(rest.sharedContext),
                sharedContract: rest.sharedContract,
                batchId: rest.batchId,
                tasks: canonical(rest.tasks),
              }
            : canonical(rest),
        }),
      },
      ...messages.slice(2),
    ];
  } catch {
    return messages;
  }
}
