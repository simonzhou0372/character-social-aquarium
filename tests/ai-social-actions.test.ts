import { afterEach, beforeEach, expect, it } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import {
  dialogueContext,
  generateDialogue,
  parseDialogue,
  persistDialogue,
} from '../src/ai/orchestrator';
import { defaultPrompts } from '../src/ai/prompts';
import { simulatedReaction, isSupportedReaction } from '../src/core/reaction-emojis';
import { exportBackup, importBackup } from '../src/data/backup';
let d: AquariumDB;
const now = Date.parse('2026-10-22T10:00:00Z');
beforeEach(async () => {
  d = new AquariumDB('actions-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  await d.delete();
});
async function setup() {
  const c = (await d.conversations.get('conv-cafe'))!;
  const [speaker, target] = c.participants;
  const char = (await d.characters.get(target))!;
  const message = {
    id: 'social-source',
    conversationId: c.id,
    senderId: target,
    seq: 999,
    text: '哈哈今天的排练好有趣',
    simAt: now,
    realAt: now,
    source: 'ai' as const,
  };
  await d.messages.put(message);
  return { c, speaker, target, char, message };
}
it('AI can mention a group member and react with a non-like emoji through generation, persistence and backup', async () => {
  const { c, speaker, target, char, message } = await setup();
  const text = `@${char.name} 这段我也听到了。`;
  let calls = 0;
  const r = await generateDialogue(d, c, speaker, now + 1000, defaultPrompts(), {
    async complete(messages) {
      calls++;
      const context = JSON.parse(messages[1].content);
      expect(context.history.some((m: any) => m.id === message.id)).toBe(true);
      expect(context.input.availableReactionEmojis).toContain('😂');
      expect(messages[0].content).toContain('mentionTargets');
      return {
        content: JSON.stringify({
          speakerId: speaker,
          messages: [text, '等会儿再聊。'],
          mentionTargets: [{ messageIndex: 0, characterId: target }],
          reactions: [{ messageId: message.id, emoji: '😂' }],
        }),
        inputTokens: 1,
        outputTokens: 1,
        estimated: false,
      };
    },
  });
  await persistDialogue(
    d,
    c.id,
    speaker,
    r.messages,
    now + 1000,
    'ai',
    'social-batch',
    undefined,
    r.offsets,
    r,
  );
  await persistDialogue(
    d,
    c.id,
    speaker,
    r.messages,
    now + 1000,
    'ai',
    'social-batch',
    undefined,
    r.offsets,
    r,
  );
  const saved = (await d.messages.get('social-batch:0'))!;
  expect(saved.mentionCharacterIds).toEqual([target]);
  expect(saved.text.slice(saved.mentions![0].start, saved.mentions![0].end)).toBe('@' + char.name);
  expect((await d.messages.get('social-batch:1'))?.mentionCharacterIds).toEqual([]);
  expect(await d.reactions.where('messageId').equals(message.id).count()).toBe(1);
  expect((await d.reactions.toArray())[0].emoji).toBe('😂');
  expect(calls).toBe(1);
  await importBackup(await exportBackup(d), d);
  expect((await d.messages.get(saved.id))?.mentions).toEqual(saved.mentions);
  expect((await d.reactions.toArray())[0].emoji).toBe('😂');
});
it('a reaction-only reply does not invent a bubble and replay does not toggle it off', async () => {
  const { c, speaker, message } = await setup();
  const snapshot = defaultPrompts();
  snapshot.rules.allowSilence = false;
  const r = parseDialogue(
    JSON.stringify({
      speakerId: speaker,
      messages: [],
      reactions: [{ messageId: message.id, emoji: '❤️' }],
    }),
    speaker,
    snapshot,
  );
  const count = await d.messages.count();
  for (let i = 0; i < 2; i++)
    await persistDialogue(
      d,
      c.id,
      speaker,
      r.messages,
      now + 1000,
      'ai',
      'reaction-only',
      undefined,
      undefined,
      r,
    );
  expect(await d.messages.count()).toBe(count);
  expect(await d.reactions.count()).toBe(1);
});
it('rejects nonmembers, absent @ text, future messages and self reactions before saving', async () => {
  const { c, speaker, message } = await setup();
  await d.messages.put({ ...message, id: 'future-social', simAt: now + 100000 });
  await d.messages.put({ ...message, id: 'self-social', senderId: speaker });
  for (const extras of [
    { mentionTargets: [{ messageIndex: 0, characterId: 'not-a-member' }] },
    { mentionTargets: [{ messageIndex: 0, characterId: c.participants[1] }] },
    { reactions: [{ messageId: 'future-social', emoji: '😂' }] },
    { reactions: [{ messageId: 'other-world-message', emoji: '😂' }] },
    { reactions: [{ messageId: 'self-social', emoji: '😂' }] },
  ]) {
    await expect(
      generateDialogue(d, c, speaker, now + 1000, defaultPrompts(), {
        async complete() {
          return {
            content: JSON.stringify({ speakerId: speaker, messages: ['好。'], ...extras }),
            inputTokens: 1,
            outputTokens: 1,
            estimated: false,
          };
        },
      }),
    ).rejects.toThrow();
  }
  expect(await d.reactions.count()).toBe(0);
});
it('rolls back reactions together with messages if the message budget is exhausted', async () => {
  const { c, speaker, message } = await setup();
  await d.settings.update('app', { unlimitedUsage: false, dailyMessages: 0 });
  await expect(
    persistDialogue(d, c.id, speaker, ['好。'], now + 1000, 'ai', 'blocked', undefined, undefined, {
      reactions: [{ messageId: message.id, emoji: '😊' }],
    }),
  ).rejects.toThrow('消息生成上限');
  expect(await d.reactions.count()).toBe(0);
});
it('read simulation chooses varied supported emotions and avoids liking sad messages', () => {
  const picks = Array.from({ length: 20 }, (_, i) => simulatedReaction('今天下班了', i / 20));
  expect(new Set(picks).size).toBeGreaterThan(1);
  expect(picks.every(isSupportedReaction)).toBe(true);
  expect(simulatedReaction('今天好难过', 0.5)).not.toBe('👍');
});
