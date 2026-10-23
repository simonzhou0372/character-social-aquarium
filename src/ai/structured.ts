import { ProviderError } from './provider';
/** Decode an envelope without ever splitting or inventing character dialogue. */
export function parseStructuredJSON(raw: string): unknown {
  if (raw.length > 100000) throw new ProviderError('json', '模型响应过大，本次生成未写入。');
  const input = raw
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^(?:<think>[\s\S]*?<\/think>\s*)+/, '');
  try {
    return JSON.parse(input);
  } catch {
    /* Accept a single unambiguous JSON object inside provider wrappers. */
  }
  const candidates: unknown[] = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
        quoted = false;
        escaped = false;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        candidates.push(JSON.parse(input.slice(start, i + 1)));
      } catch {
        /* Incomplete JSON is repaired with a bounded model request. */
      }
      start = -1;
    }
  }
  if (candidates.length === 1) return candidates[0];
  throw new ProviderError('json', '模型回复格式暂时无法读取，请重试；你发出的消息已保留。');
}

/** Repair only array-bracket mistakes in an otherwise tokenizable dialogue object.
 * Every returned string is an original JSON string token; no newline/text inference.
 */
export function repairDialogueJSON(raw: string): unknown {
  if (raw.length > 100000) throw new ProviderError('json', '模型响应过大，本次生成未写入。');
  const input = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (input[0] !== '{' || input.at(-1) !== '}')
    throw new ProviderError('json', '模型回复格式暂时无法读取，请重试；你发出的消息已保留。');
  const tokens: { raw: string; value?: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i++;
      continue;
    }
    const start = i;
    if (input[i] === '"') {
      i++;
      let escaped = false,
        closed = false;
      while (i < input.length) {
        const ch = input[i++];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new ProviderError('json', '模型消息字符串未闭合。');
      const raw = input.slice(start, i);
      let value: string;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new ProviderError('json', '模型消息转义无效。');
      }
      tokens.push({ raw, value, start, end: i });
    } else if (/[{}\[\],:]/.test(input[i])) {
      tokens.push({ raw: input[i++], start, end: i });
    } else {
      const m = input.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!m) throw new ProviderError('json', '模型回复包含无法安全修复的内容。');
      i += m[0].length;
      tokens.push({ raw: m[0], start, end: i });
    }
  }
  const fields = tokens
    .map((t, index) => ({ t, index }))
    .filter(({ t, index }) => t.value !== undefined && tokens[index + 1]?.raw === ':');
  if (
    fields.length < 2 ||
    fields.length > 3 ||
    new Set(fields.map((f) => f.t.value)).size !== fields.length ||
    fields.some((f) => !['speakerId', 'messages', 'offsets'].includes(f.t.value!))
  )
    throw new ProviderError('json', '模型回复字段无法安全修复。');
  const output: Record<string, unknown> = {};
  for (let n = 0; n < fields.length; n++) {
    const f = fields[n],
      next = fields[n + 1]?.index ?? tokens.length - 1;
    const values = tokens.slice(f.index + 2, next);
    if (values.at(-1)?.raw === ',') values.pop();
    if (f.t.value === 'messages') {
      if (
        values[0]?.raw !== '[' ||
        values.some((t) => t.value === undefined && !['[', ']', ','].includes(t.raw))
      )
        throw new ProviderError('json', '角色消息必须由 JSON 字符串数组组成。');
      const strings = values.filter((t) => t.value !== undefined).map((t) => t.value!);
      if (strings.length > 3) throw new ProviderError('schema', '角色消息数量超过上限。');
      output.messages = strings;
    } else if (f.t.value === 'speakerId') {
      if (values.length !== 1 || values[0].value === undefined)
        throw new ProviderError('json', '发言者编号无法安全修复。');
      output.speakerId = values[0].value;
    } else {
      try {
        output.offsets = JSON.parse(values.map((t) => t.raw).join(''));
      } catch {
        throw new ProviderError('json', '时间偏移无法安全修复。');
      }
    }
  }
  return output;
}

/** Recover only fully closed original values from a truncated top-level object.
 * Never closes a broken string or fabricates braces/field values. */
export function completedField(raw: string, key: string): unknown {
  let depth = 0,
    quoted = false,
    escape = false,
    start = -1;
  for (let i = 0; i < Math.min(raw.length, 100000); i++) {
    const c = raw[i];
    if (quoted) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') {
        quoted = false;
        if (depth === 1 && start >= 0) {
          let name: unknown;
          try {
            name = JSON.parse(raw.slice(start, i + 1));
          } catch {}
          let j = i + 1;
          while (/\s/.test(raw[j] ?? '') && j < raw.length) j++;
          if (name === key && raw[j] === ':') {
            j++;
            while (/\s/.test(raw[j] ?? '') && j < raw.length) j++;
            if (raw[j] === '"') {
              let escaped = false;
              for (let k = j + 1; k < raw.length; k++) {
                if (escaped) {
                  escaped = false;
                  continue;
                }
                if (raw[k] === '\\') {
                  escaped = true;
                  continue;
                }
                if (raw[k] === '"') {
                  try {
                    return JSON.parse(raw.slice(j, k + 1));
                  } catch {
                    return;
                  }
                }
              }
              return;
            }
            if (raw[j] === '[') {
              const items: unknown[] = [];
              let itemStart = -1,
                nested = 0,
                inString = false,
                escaped = false;
              for (let k = j + 1; k < raw.length; k++) {
                const x = raw[k];
                if (inString) {
                  if (escaped) escaped = false;
                  else if (x === '\\') escaped = true;
                  else if (x === '"') inString = false;
                  continue;
                }
                if (x === '"') inString = true;
                if (x === '{') {
                  if (nested === 0) itemStart = k;
                  nested++;
                }
                if (x === '}' && nested > 0 && --nested === 0) {
                  try {
                    items.push(JSON.parse(raw.slice(itemStart, k + 1)));
                  } catch {}
                }
                if (x === ']' && nested === 0) break;
              }
              return items;
            }
            if (raw[j] === '{') {
              let nesting = 0,
                inString = false,
                escaped = false;
              for (let k = j; k < raw.length; k++) {
                const x = raw[k];
                if (inString) {
                  if (escaped) escaped = false;
                  else if (x === '\\') escaped = true;
                  else if (x === '"') inString = false;
                  continue;
                }
                if (x === '"') inString = true;
                else if (x === '{') nesting++;
                else if (x === '}' && --nesting === 0) {
                  try {
                    return JSON.parse(raw.slice(j, k + 1));
                  } catch {
                    return;
                  }
                }
              }
            }
          }
        }
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      start = i;
    } else if (c === '{') depth++;
    else if (c === '}') depth--;
  }
}
