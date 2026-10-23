import { beforeEach, afterEach, it, expect } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { relationshipDrafts } from '../src/ai/relationships';
import { MockProvider } from '../src/ai/provider';
import { runWorld, discoverDirectConversations } from '../src/core/engine';
import {
  resolveObservation,
  saveObservation,
  fullObservation,
} from '../src/core/selective-observation';
import { recycleEntity, purgeEntity } from '../src/data/recycle';
import { ensureNotes, saveNote } from '../src/data/chat';
import { exportBackup, validateBackup, importBackup } from '../src/data/backup';
import { replyToUser, consolidateMemory, generateDialogue } from '../src/ai/orchestrator';
import { defaultPrompts } from '../src/ai/prompts';
import { HOUR } from '../src/core/types';
const world = 'w-harbor',
  now = Date.parse('2026-10-22T01:00:00Z');
let d: AquariumDB;
beforeEach(async () => {
  d = new AquariumDB('recycle-test-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  await d.delete();
});
it('resolves short IDs, exact IDs and unique names while preserving good rows beside malformed endpoints', async () => {
  await d.relationships.clear();
  const rows = await relationshipDrafts(
    world,
    ['c-nagi', 'c-mio'],
    '',
    d,
    new MockProvider({
      relationships: [
        { from: 'P1', to: 'P2', label: '队友' },
        { from: '凪 夏生', to: 'c-mio', label: '认识' },
        { from: 'external', to: 'P2' },
        { from: 'P1', to: 'P1' },
      ],
    }),
  );
  expect(rows.length).toBe(2);
  expect(
    rows.every(
      (r) =>
        ['c-nagi', 'c-mio'].includes(r.from) &&
        ['c-nagi', 'c-mio'].includes(r.to) &&
        r.from !== r.to,
    ),
  ).toBe(true);
  expect(rows.warnings.length).toBe(2);
});
it('rejects unknown or ambiguous names without persisting guessed relations', async () => {
  await d.characters.update('c-nagi', { name: '同名' });
  await d.characters.update('c-mio', { name: '同名' });
  const count = await d.relationships.count();
  await expect(
    relationshipDrafts(
      world,
      ['c-nagi', 'c-mio'],
      '',
      d,
      new MockProvider({ relationships: [{ from: '同名', to: 'P2' }] }),
    ),
  ).rejects.toThrow('没有返回可用关系');
  expect(await d.relationships.count()).toBe(count);
});
it('discovers group contacts and produces private messages without any manually opened conversations', async () => {
  await d.conversations.clear();
  await d.messages.clear();
  await d.relationships.clear();
  await d.characters
    .toCollection()
    .modify({
      initiative: 1,
      replyChance: 1,
      phoneHabit: 1,
      wake: 0,
      sleep: 23,
      busyStart: 0,
      busyEnd: 0,
      initiationMode: 'interval',
      topicIntervalMinutes: 5,
    });
  const candidates = await discoverDirectConversations(world, now, d);
  expect(
    candidates.some((c) => c.participants.includes('c-mio') && c.participants.includes('c-ritsu')),
  ).toBe(true);
  await d.settings.update('app', { activity: 'lively', unlimitedUsage: true });
  await d.checkpoints.update(world, { paused: false, mode: 'demo', seed: 42 });
  await runWorld(world, { now: now + 8 * HOUR }, d);
  const direct = (await d.conversations.toArray()).filter((c) => c.kind === 'direct');
  expect(direct.length).toBeGreaterThan(0);
  expect(
    (await d.messages.toArray()).some((m) => direct.some((c) => c.id === m.conversationId)),
  ).toBe(true);
});
it('observing one person can discover dormant first-hop contacts without activating their networks', async () => {
  await saveObservation(
    { ...fullObservation(world), mode: 'selective', characterIds: ['c-nagi'] },
    d,
  );
  const candidates = await discoverDirectConversations(world, now, d);
  expect(
    candidates.some((c) => c.participants.includes('c-nagi') && c.participants.includes('c-mio')),
  ).toBe(true);
  expect(candidates.every((c) => c.participants.includes('c-nagi'))).toBe(true);
  expect([...(await resolveObservation(world, d)).activeIds]).toEqual(['c-nagi']);
});
it.each(['worlds', 'groups', 'characters'] as const)(
  'recycles and restores %s with all history and valid backup intact',
  async (kind) => {
    const id = kind === 'worlds' ? world : kind === 'groups' ? 'g-band' : 'c-mio';
    const original = await d.table(kind).get(id),
      count = await d.messages.count();
    await recycleEntity(kind, id, false, d);
    expect((await d.table(kind).get(id)).deletedAt).toBeGreaterThan(0);
    expect(await d.messages.count()).toBe(count);
    if (kind === 'characters')
      expect((await resolveObservation(world, d)).activeIds.has(id)).toBe(false);
    if (kind === 'worlds') {
      expect((await d.checkpoints.get(world))?.paused).toBe(true);
      const before = await d.events.count();
      await d.checkpoints.update(world, { paused: false });
      await runWorld(world, { now: now + HOUR }, d);
      expect(await d.events.count()).toBe(before);
    }
    validateBackup(await exportBackup(d));
    await recycleEntity(kind, id, true, d);
    expect(await d.table(kind).get(id)).toEqual(original);
    validateBackup(await exportBackup(d));
  },
);
it.each(['worlds', 'groups', 'characters'] as const)(
  'permanent removal of %s cleans references but preserves independent entities',
  async (kind) => {
    const id = kind === 'worlds' ? world : kind === 'groups' ? 'g-band' : 'c-mio';
    const notes = await ensureNotes(world, d);
    await saveNote(notes, '个人备忘', undefined, d);
    await expect(purgeEntity(kind, id, d)).rejects.toThrow('先将对象移入回收站');
    await recycleEntity(kind, id, false, d);
    await purgeEntity(kind, id, d);
    expect(await d.table(kind).get(id)).toBeUndefined();
    expect(await d.characters.get('c-nagi')).toBeDefined();
    if (kind !== 'worlds')
      expect((await d.messages.where('conversationId').equals(notes).toArray())[0].text).toBe(
        '个人备忘',
      );
    validateBackup(await exportBackup(d));
  },
);
it('notes are idempotent, private, real-time, and included in backups without AI calls', async () => {
  const [a, b] = await Promise.all([ensureNotes(world, d), ensureNotes(world, d)]);
  expect(a).toBe(b);
  await d.checkpoints.update(world, { simTime: now + 100000 * HOUR });
  await saveNote(a, '先记下这段故事', undefined, d);
  const message = (await d.messages.where('conversationId').equals(a).toArray())[0];
  expect(Math.abs(message.simAt - Date.now())).toBeLessThan(2000);
  await replyToUser(a, d);
  await consolidateMemory(a, d);
  expect(await d.usage.count()).toBe(0);
  expect(await d.memories.where('conversationId').equals(a).count()).toBe(0);
  await expect(
    generateDialogue(
      d,
      (await d.conversations.get(a))!,
      'user',
      now,
      defaultPrompts(),
      new MockProvider({}),
    ),
  ).rejects.toThrow('不可用');
  const backup = validateBackup(await exportBackup(d));
  await importBackup(backup, d);
  expect((await d.messages.get(message.id))?.text).toBe('先记下这段故事');
});
