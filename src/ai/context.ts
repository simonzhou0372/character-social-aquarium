import { ProviderError, type ChatInput } from './provider';
import { estimateTokens, type TaskKind, type PromptContext } from './prompts';
type Obj = Record<string, unknown>;
const record = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const critical = /(禁止|不得|不能|必须|边界|约定|秘密|保密|never|must|do not)/i;
export interface ContextReport {
  beforeTokens: number;
  afterTokens: number;
  budgetTokens: number;
  removedHistory: number;
  removedMemories: number;
  tier: 'balanced' | 'tight';
}
/** Local extractive compression. Originals remain in IndexedDB; no new facts are invented. */
export function selectiveText(value: unknown, limit: number) {
  if (typeof value !== 'string' || Array.from(value).length <= limit) return value;
  const lines = value.split(/(?<=[。！？.!?\n])/u);
  const required = lines.filter((line) => critical.test(line));
  const others = lines.filter((line) => !critical.test(line));
  const kept = [...required];
  let remaining = Math.max(0, limit - required.join('').length);
  for (const line of others) {
    if (line.length <= remaining) {
      kept.push(line);
      remaining -= line.length;
    }
  }
  return (
    lines.filter((line) => kept.includes(line)).join('') + '〔部分普通细节已省略，勿推断省略内容〕'
  );
}
function stripDecorative(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDecorative);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            ![
              'avatar',
              'cover',
              'color',
              'imageData',
              'realAt',
              'majorEventSettings',
              'evolutionSettings',
              'reportSettings',
            ].includes(k),
        )
        .map(([k, v]) => [k, stripDecorative(v)]),
    );
  return value;
}
export function compressContext(
  context: PromptContext,
  tier: 'balanced' | 'tight' = 'balanced',
): { context: PromptContext; removedHistory: number; removedMemories: number } {
  const clean = stripDecorative(context) as PromptContext,
    compact = tier === 'tight';
  const character = record(clean.character);
  if (Object.keys(character).length) {
    clean.character = {
      ...character,
      personality: selectiveText(character.personality, compact ? 300 : 700),
      style: selectiveText(character.style, compact ? 220 : 500),
      habits: selectiveText(character.habits, compact ? 120 : 250),
    };
  }
  if (Array.isArray(clean.relationships))
    clean.relationships = clean.relationships.map((item) => {
      const r = record(item);
      return {
        ...r,
        history: selectiveText(r.history, compact ? 120 : 260),
        attitude: selectiveText(r.attitude, compact ? 100 : 200),
      };
    });
  const history = Array.isArray(clean.history) ? clean.history : [];
  const retained = new Set(history.slice(compact ? -3 : -7));
  const latestUser = [...history].reverse().find((item) => {
    const m = record(item);
    return m.source === 'user' || m.speakerId === 'user';
  });
  if (latestUser) retained.add(latestUser);
  const older = history.filter((item) => !retained.has(item));
  const evidence = older
    .filter((item) => critical.test(String(record(item).text ?? '')))
    .slice(compact ? -1 : -3);
  evidence.forEach((item) => retained.add(item));
  clean.history = history
    .filter((item) => retained.has(item))
    .map((item) =>
      item === latestUser || item === history.at(-1)
        ? item
        : { ...record(item), text: selectiveText(record(item).text, compact ? 180 : 360) },
    );
  const memories = Array.isArray(clean.memories) ? clean.memories : [];
  const memoryLimit = compact ? 2 : 4;
  const important = memories.filter((m) => critical.test(String(record(m).content ?? '')));
  const ordinary = memories.filter((m) => !important.includes(m));
  const kept = [...important, ...ordinary].slice(0, memoryLimit);
  clean.memories = kept.map((m) => ({
    ...record(m),
    content: selectiveText(record(m).content, compact ? 240 : 450),
  }));
  // Facts, active participants, timestamps, locked boundaries, user constraints and newest user text remain verbatim.
  return {
    context: clean,
    removedHistory: history.length - (clean.history as unknown[]).length,
    removedMemories: memories.length - kept.length,
  };
}
export function packRequest(
  messages: ChatInput,
  _task: TaskKind,
  budgetTokens = 4000,
  forceTight = false,
): { messages: ChatInput; report: ContextReport } {
  const beforeTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  let chosen: ChatInput = messages,
    removedHistory = 0,
    removedMemories = 0,
    tier: 'balanced' | 'tight' = forceTight ? 'tight' : 'balanced';
  for (const candidateTier of forceTight
    ? (['tight'] as const)
    : (['balanced', 'tight'] as const)) {
    let historyCount = 0,
      memoryCount = 0;
    const packed = messages.map((message) => {
      if (message.role !== 'user') return { ...message };
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.content);
      } catch {
        return { ...message };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...message };
      const result = compressContext(parsed as PromptContext, candidateTier);
      historyCount += result.removedHistory;
      memoryCount += result.removedMemories;
      return { ...message, content: JSON.stringify(result.context) };
    });
    chosen = packed;
    removedHistory = historyCount;
    removedMemories = memoryCount;
    tier = candidateTier;
    if (packed.reduce((sum, m) => sum + estimateTokens(m.content), 0) <= budgetTokens) break;
  }
  const afterTokens = chosen.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (afterTokens > budgetTokens)
    throw new ProviderError(
      'context-budget',
      `必要的世界事实、全局规则与最新消息约 ${afterTokens} Token，超过当前上下文预算 ${budgetTokens}。已保留这些必要内容，请在 AI 高级设置调高输入预算，或缩短自定义全局提示词；不会静默删除事实。`,
    );
  return {
    messages: chosen,
    report: { beforeTokens, afterTokens, budgetTokens, removedHistory, removedMemories, tier },
  };
}
