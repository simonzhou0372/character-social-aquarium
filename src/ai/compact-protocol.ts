import type { ChatInput } from './provider';
/** Versioned wire codec. Only program-defined names change; text and optional social actions remain intact. */
export function compactChatRequest(messages: ChatInput, task?: string) {
  if (!['chat', 'recoveryChat'].includes(task ?? '') || messages.length !== 2) return undefined;
  const marker = '【不可覆盖的输出契约】\n',
    index = messages[0].content.indexOf(marker);
  const speaker = messages[0].content.slice(index).match(/"speakerId":"([^"]+)"/)?.[1];
  if (index < 0 || !speaker) return undefined;
  try {
    if (JSON.parse(messages[1].content).tasks) return undefined;
  } catch {
    return undefined;
  }
  const contract = `返回紧凑JSON {"m":["消息"],"o":[0]}。m即messages，遵循上面的消息条数、长度、格式和沉默规则；o即offsets，与m等长，0～60秒递增。固定发言者${speaker}由程序补齐，不能代替他人发言。可选r=replyToMessageId、g=gifAssetId、a=[{i:消息索引,c:成员ID}]表示mentionTargets、e=[{id:历史消息ID,v:表情}]表示reactions。@须在对应文本中写出成员完整姓名，只选input.participants的其他成员。引用与表情仅针对history中他人已存在的消息；GIF仅选availableGifs；emoji仅选availableReactionEmojis，最多3项回应。不要返回额外字段。`;
  return {
    speaker,
    messages: [
      { ...messages[0], content: messages[0].content.slice(0, index) + marker + contract },
      messages[1],
    ] as ChatInput,
  };
}
export function expandCompactChat(content: string, speaker: string) {
  let value: any;
  try {
    value = JSON.parse(
      content
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, ''),
    );
  } catch {
    return content;
  }
  if (!value || !Object.hasOwn(value, 'm')) return content;
  const extras = Object.fromEntries(
    Object.entries(value).filter(([k]) => !['m', 'o', 'r', 'g', 'a', 'e'].includes(k)),
  );
  return JSON.stringify({
    ...extras,
    ...(Object.keys(extras).length ? { _invalidCompactFields: Object.keys(extras) } : {}),
    speakerId: speaker,
    messages: value.m,
    ...(value.o === undefined ? {} : { offsets: value.o }),
    ...(value.r === undefined ? {} : { replyToMessageId: value.r }),
    ...(value.g === undefined ? {} : { gifAssetId: value.g }),
    ...(value.a === undefined
      ? {}
      : {
          mentionTargets: Array.isArray(value.a)
            ? value.a.map((a: any) =>
                a && typeof a === 'object'
                  ? {
                      messageIndex: a.i,
                      characterId: a.c,
                      ...Object.fromEntries(
                        Object.entries(a).filter(([k]) => !['i', 'c'].includes(k)),
                      ),
                    }
                  : a,
              )
            : value.a,
        }),
    ...(value.e === undefined
      ? {}
      : {
          reactions: Array.isArray(value.e)
            ? value.e.map((e: any) =>
                e && typeof e === 'object'
                  ? {
                      messageId: e.id,
                      emoji: e.v,
                      ...Object.fromEntries(
                        Object.entries(e).filter(([k]) => !['id', 'v'].includes(k)),
                      ),
                    }
                  : e,
              )
            : value.e,
        }),
  });
}
