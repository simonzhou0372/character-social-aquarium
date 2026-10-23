import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { DAY, HOUR, type Relationship } from '../src/core/types';
import { runWorld, setRunning } from '../src/core/engine';
import { clockTarget } from '../src/core/time';
import { relationshipDrafts, acceptRelationships } from '../src/ai/relationships';
import { MockProvider } from '../src/ai/provider';
import { renameConversation, renameScene } from '../src/data/titles';
import { toggleReaction, recordObserved } from '../src/data/chat';
import {
  sendUserMessage,
  dialogueContext,
  persistDialogue,
  generateDialogue,
} from '../src/ai/orchestrator';
import { uploadGif, availableGifs, removeGif, validateGif } from '../src/data/gifs';
import { exportBackup, importBackup, validateBackup } from '../src/data/backup';
import {
  nextMajorSchedule,
  configureMajor,
  defaultMajorSettings,
  promoteNaturalEvent,
} from '../src/core/major-events';
import { defaultPrompts } from '../src/ai/prompts';
import { drainContent } from '../src/ai/content-queue';
let d: AquariumDB;
const now = Date.parse('2026-10-22T10:00:00Z');
beforeEach(async () => {
  d = new AquariumDB('four-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  vi.useRealTimers();
  await d.delete();
});
const gifBytes = () =>
  Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), (c) => c.charCodeAt(0));
it('generates directed single / pair / group / world relation drafts and never replaces locked edges', async () => {
  const ids = (await d.characters.toArray()).map((c) => c.id);
  for (const scope of [[ids[0]], ids.slice(0, 2), ids.slice(0, 3), ids]) {
    const from = scope[0],
      to = scope[1] ?? ids[1];
    await d.relationships.where('[worldId+from+to]').equals(['w-harbor', from, to]).delete();
    const rows = await relationshipDrafts('w-harbor', scope, '保持原作，不熟悉者只认识名字', d, {
      async complete(messages: any) {
        const input = JSON.parse(messages[1].content).input;
        const from = input.sources[0].id,
          to = input.targets.find((c: any) => c.id !== from).id;
        return {
          content: JSON.stringify({ relationships: [{ from, to, label: '认识', closeness: 20 }] }),
          inputTokens: 1,
          outputTokens: 1,
          estimated: false,
        };
      },
    });
    expect(rows[0].from).toBe(from);
    expect(rows[0].to).toBe(to);
    await acceptRelationships(rows, d);
    expect((await d.relationships.get(rows[0].id))?.closeness).toBe(20);
    await d.relationships.update(rows[0].id, { locked: true });
    expect(await acceptRelationships([{ ...rows[0], closeness: 90 }], d)).toBe(0);
    expect((await d.relationships.get(rows[0].id))?.closeness).toBe(20);
  }
});
it('custom titles survive group synchronization and restore automatic naming', async () => {
  const c = (await d.conversations.get('conv-cafe'))!;
  await renameConversation(c.id, '丰川组日常', 'data:image/png;base64,AA==', d);
  await d.checkpoints.update('w-harbor', { paused: false });
  await runWorld('w-harbor', { now: now + HOUR }, d);
  expect((await d.conversations.get(c.id))?.name).toBe('丰川组日常');
  await renameConversation(c.id, undefined, undefined, d);
  expect((await d.conversations.get(c.id))?.titleMode).toBe('auto');
});
it('stores mentions / reply IDs, distinguishes observer reads and deduplicates reactions', async () => {
  const c = (await d.conversations.get('conv-cafe'))!,
    original = (await d.messages.where('conversationId').equals(c.id).sortBy('seq'))[0];
  const target = c.participants[0],
    label = '@' + (await d.characters.get(target))!.name;
  await sendUserMessage(c.id, label + ' 看这里', 'user', d, {
    mentions: [{ characterId: target, start: 0, end: label.length, label }],
    replyToMessageId: original.id,
  });
  const message = (await d.messages.where('conversationId').equals(c.id).sortBy('seq')).at(-1)!;
  expect(message.mentionCharacterIds).toEqual([target]);
  expect(message.replyToMessageId).toBe(original.id);
  const context = await dialogueContext(d, c, target, message.simAt);
  expect(context.history.at(-1)?.mentionCharacterIds).toEqual([target]);
  expect(context.input.replyContext?.id).toBe(original.id);
  await expect(
    sendUserMessage(c.id, '非法@', 'user', d, { mentionCharacterIds: ['alien'] }),
  ).rejects.toThrow();
  await toggleReaction(message.id, 'user', '👍', d);
  expect(await d.reactions.where('messageId').equals(message.id).count()).toBe(1);
  await toggleReaction(message.id, 'user', '👍', d);
  expect(await d.reactions.count()).toBe(0);
  await recordObserved(c.id, [message.id], d);
  expect((await d.cursors.get('observer:' + c.id))?.seq ?? 0).toBe(0);
  expect(
    await d.cursors
      .where('conversationId')
      .equals(c.id)
      .and((x) => x.kind === 'character')
      .count(),
  ).toBe(0);
  validateBackup(await exportBackup(d));
});
it('validates animated GIF structure, layered overrides, permissions, deduplication and backup', async () => {
  const bytes = gifBytes();
  expect(validateGif(bytes).frames).toBe(1);
  expect(() => validateGif(bytes.slice(0, -1))).toThrow();
  const c = (await d.conversations.get('conv-cafe'))!,
    actor = c.participants[0];
  const upload = (name: string, scopeType: 'world' | 'group' | 'character', scopeId: string) =>
    uploadGif(
      new Blob([bytes], { type: 'image/gif' }),
      { name, scopeType, scopeId, tags: ['开心'], description: '打招呼' },
      d,
    );
  const world = await upload('同名', 'world', c.worldId);
  await upload('其他共享', 'world', c.worldId);
  await upload('同名', 'group', c.groupId!);
  const personal = await upload('同名', 'character', actor);
  await upload('私密乐队', 'group', 'g-band');
  expect(await d.resources.count()).toBe(1);
  const available = await availableGifs(c, actor, d);
  expect(available.find((a) => a.name === '同名')?.id).toBe(personal.id);
  expect(available.some((a) => a.name === '其他共享')).toBe(true);
  expect(available.some((a) => a.name === '私密乐队')).toBe(false);
  expect(
    (await availableGifs(c, c.participants.find((id) => id !== actor)!, d)).some(
      (a) => a.id === personal.id,
    ),
  ).toBe(false);
  await d.conversations.update(c.id, { controlledId: actor });
  await sendUserMessage(c.id, '[GIF]', actor, d, { gifAssetId: personal.id });
  await removeGif(personal.id, d);
  expect((await d.resources.toArray())[0].blob).toBeInstanceOf(Blob);
  const backup = await exportBackup(d);
  validateBackup(backup);
  expect(backup.resources[0].data).toBeTruthy();
  await importBackup(backup, d);
  expect((await d.resources.toArray())[0].blob).toBeInstanceOf(Blob);
  expect((await d.messages.toArray()).some((m) => m.gifAssetId === personal.id)).toBe(true);
});
it('AI can choose only authorized GIF IDs without sending binary content', async () => {
  const c = (await d.conversations.get('conv-cafe'))!,
    actor = c.participants[0];
  const a = await uploadGif(
    new Blob([gifBytes()], { type: 'image/gif' }),
    { name: '开心', scopeType: 'world', scopeId: c.worldId, tags: [], description: '开心时使用' },
    d,
  );
  const p = new MockProvider({ speakerId: actor, messages: [], gifAssetId: a.id });
  const result = await generateDialogue(d, c, actor, now, defaultPrompts(), p);
  expect(result.gifAssetId).toBe(a.id);
  expect(result.messages).toEqual(['[GIF]']);
  expect(p.calls[0][1].content).not.toContain('base64');
  await expect(
    generateDialogue(
      d,
      c,
      actor,
      now,
      defaultPrompts(),
      new MockProvider({ speakerId: actor, messages: ['看看'], gifAssetId: 'forbidden' }),
    ),
  ).rejects.toThrow('无权');
});
it('keeps actual simulated read timestamps and virtual reactions separate from observers', async () => {
  await d.characters
    .toCollection()
    .modify({ phoneHabit: 1, wake: 0, sleep: 23, busyStart: 0, busyEnd: 0 });
  await d.checkpoints.update('w-harbor', { paused: false });
  await runWorld('w-harbor', { now: now + 6 * HOUR }, d);
  const states = await d.readStates.toArray();
  expect(states.some((s) => s.kind === 'character')).toBe(true);
  expect(states.every((s) => s.readerId !== 'observer')).toBe(true);
  const r = states[0];
  await runWorld('w-harbor', { now: now + 8 * HOUR }, d);
  expect((await d.readStates.get(r.id))?.readAt).toBe(r.readAt);
  validateBackup(await exportBackup(d));
});
it('guarantees seven-day maximum gaps across thirty simulated offline days, is idempotent and pauses', async () => {
  await d.worlds.update('w-harbor', {
    majorEventSettings: { ...defaultMajorSettings, enabled: true, maximumIntervalDays: 7 },
  });
  await d.majorSchedules.put(nextMajorSchedule('w-harbor', now, 7));
  await d.settings.update('app', { activity: 'quiet', unlimitedUsage: true });
  await d.checkpoints.update('w-harbor', { paused: false });
  await runWorld('w-harbor', { now: now + 30 * DAY, maxSegments: 10000 }, d);
  const events = await d.majorEvents.where('worldId').equals('w-harbor').sortBy('timestamp');
  expect(events.length).toBeGreaterThanOrEqual(4);
  let last = now;
  for (const e of events) {
    expect(e.timestamp - last).toBeLessThanOrEqual(7 * DAY);
    last = e.timestamp;
    const fact = (await d.events.get(e.eventId))!;
    expect(fact.type).toBe('major');
  }
  expect(now + 30 * DAY - last).toBeLessThanOrEqual(7 * DAY);
  expect(await d.notifications.count()).toBe(events.length);
  await runWorld('w-harbor', { now: now + 30 * DAY, maxSegments: 10000 }, d);
  expect(await d.majorEvents.count()).toBe(events.length);
  await d.checkpoints.update('w-harbor', { paused: true });
  await runWorld('w-harbor', { now: now + 60 * DAY }, d);
  expect(await d.majorEvents.count()).toBe(events.length);
  validateBackup(await exportBackup(d));
}, 60000);
it('queues retroactive content without losing messages when user writes ahead', async () => {
  const c = (await d.conversations.get('conv-cafe'))!;
  await sendUserMessage(c.id, '时钟已到现在。', 'user', d);
  const after = (await d.messages.where('conversationId').equals(c.id).sortBy('seq')).at(-1)!;
  await d.transaction('rw', d.messages, d.conversations, d.usage, d.settings, async () => {
    await persistDialogue(
      d,
      c.id,
      c.participants[0],
      ['离线时的一句。'],
      after.simAt - 1000,
      'ai',
      'backfilled-test',
      undefined,
      undefined,
      { backfilled: true },
    );
  });
  const messages = await d.messages.where('conversationId').equals(c.id).toArray();
  expect(messages.some((m) => m.backfilled)).toBe(true);
  expect((await d.conversations.get(c.id))?.lastAt).toBe(after.simAt);
});
it('rewind remaps replies, GIF resources, reads and major-event references without losing the original archive', async () => {
  const { rewindWorld } = await import('../src/core/time');
  const c = (await d.conversations.get('conv-cafe'))!;
  const original = (await d.messages.where('conversationId').equals(c.id).sortBy('seq'))[0];
  const asset = await uploadGif(
    new Blob([gifBytes()], { type: 'image/gif' }),
    { name: '分支表情', scopeType: 'world', scopeId: c.worldId, tags: [], description: '' },
    d,
  );
  await sendUserMessage(c.id, '分支引用', 'user', d, {
    replyToMessageId: original.id,
    gifAssetId: asset.id,
  });
  const sent = (await d.messages.where('conversationId').equals(c.id).sortBy('seq')).at(-1)!;
  await toggleReaction(sent.id, 'user', '👍', d);
  await recordObserved(c.id, [sent.id], d);
  const fact = {
    id: 'branch-major',
    worldId: c.worldId,
    type: 'major' as const,
    start: now,
    end: now + 60000,
    participants: c.participants,
    description: '重要计划',
    location: '咖啡店',
    phone: 1,
    status: 'completed' as const,
    importance: 0.9,
  };
  await d.events.put(fact);
  await d.worlds.update(c.worldId, {
    majorEventSettings: { ...defaultMajorSettings, enabled: true },
  });
  await d.majorEvents.put({
    id: 'branch-important',
    eventId: fact.id,
    worldId: c.worldId,
    title: '重要计划',
    timestamp: now,
    participantIds: c.participants,
    groupIds: [],
    importance: 0.9,
    status: 'occurred',
    type: 'project',
    description: fact.description,
    consequences: [],
  });
  await d.notifications.put({
    id: 'branch-notice',
    eventId: 'branch-important',
    worldId: c.worldId,
    createdAt: now,
    recovery: false,
  });
  await d.checkpoints.update(c.worldId, {
    simTime: now + 2 * HOUR,
    paused: true,
    clockAnchor: { simTime: now + 2 * HOUR, realTime: Date.now() },
  });
  const id = (await rewindWorld(c.worldId, now + HOUR, d))!;
  const branch = (await d.conversations.where('worldId').equals(id).toArray()).find(
    (x) => x.groupId === c.groupId,
  )!;
  const copied = (await d.messages.where('conversationId').equals(branch.id).toArray()).find(
    (x) => x.text === '分支引用',
  )!;
  expect(copied.replyToMessageId).not.toBe(original.id);
  expect((await d.messages.get(copied.replyToMessageId!))?.conversationId).toBe(branch.id);
  expect((await d.gifAssets.get(copied.gifAssetId!))?.scopeId).toBe(id);
  expect(await d.reactions.where('messageId').equals(copied.id).count()).toBe(1);
  expect(await d.readStates.where('messageId').equals(copied.id).count()).toBe(1);
  expect((await d.majorEvents.where('worldId').equals(id).first())?.eventId).not.toBe(fact.id);
  expect(await d.messages.get(sent.id)).toBeDefined();
  validateBackup(await exportBackup(d));
});
it('retains optional and completed fields in single-character profile drafts', async () => {
  const { generateProfile } = await import('../src/ai/orchestrator');
  const minimal = await generateProfile(
    { name: '未知人物' },
    d,
    new MockProvider({ personality: '慢热，熟悉后会主动分享近况。' }),
  );
  expect(minimal.bio).toBe('');
  expect(minimal.personality).toContain('慢热');
  const partial = await generateProfile({ name: '测试' }, d, {
    async complete() {
      return {
        content: '{"bio":"已完成简介","style":"未闭合',
        inputTokens: 1,
        outputTokens: 1,
        estimated: false,
      };
    },
  });
  expect(partial.bio).toBe('已完成简介');
  expect(partial.style).toBe('');
  expect(partial.uncertain).toContain('输出未完成');
});
it('does not claim the same pending content job twice without Web Locks', async () => {
  const event = (await d.events.toArray())[0];
  await d.checkpoints.update(event.worldId, { paused: false });
  await d.contentJobs.put({
    id: 'exclusive-job',
    worldId: event.worldId,
    kind: 'life',
    event,
    at: event.start,
    snapshot: defaultPrompts(),
    recovery: false,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
  });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (started = r));
  let calls = 0;
  const provider = {
    async complete() {
      calls++;
      started();
      await gate;
      return {
        content: JSON.stringify({ description: '继续原定活动。' }),
        inputTokens: 1,
        outputTokens: 1,
        estimated: false,
      };
    },
  };
  const first = drainContent(event.worldId, d, provider);
  await entered;
  await drainContent(event.worldId, d, provider);
  expect(calls).toBe(1);
  release();
  await first;
  expect((await d.contentJobs.get('exclusive-job'))?.status).toBe('complete');
});
it('migrates version-six archives in place without changing prompts, profiles or committed history', async () => {
  const { default: Dexie } = await import('dexie');
  const name = 'legacy-six-' + crypto.randomUUID();
  const newTables = new Set([
    'contentJobs',
    'reactions',
    'readStates',
    'gifAssets',
    'resources',
    'majorSchedules',
    'majorEvents',
    'notifications',
  ]);
  const tables = d.tables.filter((t) => !newTables.has(t.name));
  const old = new Dexie(name);
  old
    .version(6)
    .stores(
      Object.fromEntries(
        tables.map((t) => [
          t.name,
          [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(','),
        ]),
      ),
    );
  for (const table of tables) await old.table(table.name).bulkPut(await table.toArray());
  await old
    .table('checkpoints')
    .update('w-harbor', { recoveryTarget: now + HOUR, recoveryRealTarget: now + 1000 });
  await old.table('profiles').put({
    id: 'api',
    baseUrl: 'https://model.test.invalid/v1',
    model: 'fixture',
    keyStorage: 'session',
    status: 'ready',
  });
  const beforeMessages = await old.table('messages').toArray(),
    beforePrompts = await old.table('promptConfigs').toArray();
  old.close();
  const upgraded = new AquariumDB(name);
  try {
    await upgraded.open();
    expect((await upgraded.checkpoints.get('w-harbor'))?.clockAnchor).toEqual({
      simTime: now + HOUR,
      realTime: now + 1000,
    });
    expect(await upgraded.messages.toArray()).toEqual(beforeMessages);
    expect(await upgraded.promptConfigs.toArray()).toEqual(beforePrompts);
    expect((await upgraded.profiles.get('api'))?.model).toBe('fixture');
    expect(await upgraded.contentJobs.count()).toBe(0);
  } finally {
    await upgraded.delete();
  }
});
it('records joining time on manual group edits and excludes earlier private group history from a new member context', async () => {
  const { saveGroupMembers } = await import('../src/data/worlds');
  const conversation = (await d.conversations.get('conv-cafe'))!,
    group = (await d.groups.get(conversation.groupId!))!;
  const { newCharacter } = await import('../src/data/seed');
  const newMember = newCharacter('稍晚加入的人');
  await d.characters.add(newMember);
  await d.checkpoints.update(conversation.worldId, {
    simTime: now + HOUR,
    clockAnchor: { simTime: now + HOUR, realTime: Date.now() },
    paused: true,
  });
  await saveGroupMembers(
    group,
    conversation.worldId,
    [...conversation.participants, newMember.id],
    [],
    [],
    [newMember.id],
    d,
  );
  const updated = (await d.conversations.get(conversation.id))!;
  expect(updated.participantJoinedAt?.[newMember.id]).toBe(now + HOUR);
  const context = await dialogueContext(d, updated, newMember.id, now + 2 * HOUR);
  expect(context.history).toEqual([]);
});
it('keeps optional GIF hints bounded so long resource descriptions cannot crowd out dialogue context', async () => {
  const c = (await d.conversations.get('conv-cafe'))!;
  await uploadGif(
    new Blob([gifBytes()], { type: 'image/gif' }),
    {
      name: '简短表情',
      scopeType: 'world',
      scopeId: c.worldId,
      tags: ['开心'],
      description: '图像的使用说明。'.repeat(1500),
    },
    d,
  );
  const context = await dialogueContext(d, c, c.participants[0], now);
  expect(context.input.availableGifs[0].description.length).toBeLessThanOrEqual(160);
  const response = await generateDialogue(
    d,
    c,
    c.participants[0],
    now,
    defaultPrompts(),
    new MockProvider({ speakerId: c.participants[0], messages: ['晚点见。'] }),
  );
  expect(response.messages).toEqual(['晚点见。']);
});
