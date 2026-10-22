import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed, newCharacter } from '../src/data/seed';
import { runWorld, createDirect } from '../src/core/engine';
import { planSegment, socialWeight, scheduledType } from '../src/core/simulation';
import { MockProvider, apiError, CompatibleProvider } from '../src/ai/provider';
import { retrieveMemories, persistDialogue, sendUserMessage } from '../src/ai/orchestrator';
import { exportBackup, importBackup, validateBackup } from '../src/data/backup';
import { getPrompts, savePrompt } from '../src/ai/prompts';
import { DAY, HOUR } from '../src/core/types';
let d: AquariumDB;
const now = Date.parse('2026-10-22T10:00:00Z');
beforeEach(async () => {
  d = new AquariumDB('engine-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  await d.delete();
});
describe('simulation and persistence', () => {
  it('supports overnight sleeping and independent busy windows', () => {
    const c = { ...newCharacter(), wake: 10, sleep: 2 };
    expect(scheduledType(c, 3)).toBe('sleep');
    expect(scheduledType(c, 23)).not.toBe('sleep');
  });
  it('produces deterministic, nonoverlapping activities including joint events', async () => {
    const world = (await d.worlds.get('w-harbor'))!,
      chars = await d.characters.toArray(),
      relations = await d.relationships.toArray(),
      cp = (await d.checkpoints.get(world.id))!;
    const a = planSegment(world, chars, relations, cp, now + DAY),
      b = planSegment(world, chars, relations, cp, now + DAY);
    expect(a).toEqual(b);
    for (const c of chars) {
      const events = a.events
        .filter((e) => e.participants.includes(c.id))
        .sort((x, y) => x.start - y.start);
      expect(events.length).toBeGreaterThan(20);
      for (let i = 1; i < events.length; i++)
        expect(events[i].start).toBeGreaterThanOrEqual(events[i - 1].end);
      expect(events.some((e) => e.type === 'sleep')).toBe(true);
    }
  });
  it('resumes offline gaps, saves ordered stable IDs, and does not duplicate on rerun', async () => {
    await d.checkpoints.update('w-harbor', { paused: false });
    await runWorld('w-harbor', { now: now + DAY }, d);
    const checkpoint = await d.checkpoints.get('w-harbor');
    expect(checkpoint?.simTime).toBe(now + DAY);
    const backup = await exportBackup(d);
    await runWorld('w-harbor', { now: now + DAY }, d);
    expect(await d.messages.count()).toBe(backup.messages.length);
    expect(await d.events.count()).toBe(backup.events.length);
    for (const c of backup.conversations) {
      const ms = backup.messages
        .filter((m) => m.conversationId === c.id)
        .sort((a, b) => a.seq - b.seq);
      for (let i = 1; i < ms.length; i++)
        expect(ms[i].simAt).toBeGreaterThanOrEqual(ms[i - 1].simAt);
    }
  });
  it('resumes an interrupted batch using its original prompt snapshot', async () => {
    await d.checkpoints.update('w-harbor', { paused: false });
    await runWorld('w-harbor', { now: now + DAY, maxSegments: 1 }, d);
    const count = await d.events.count();
    expect((await d.checkpoints.get('w-harbor'))?.recoveryTarget).toBe(now + DAY);
    const old = (await d.taskSnapshots.get('w-harbor'))!.config;
    await savePrompt(d, 'recovery', '修改后的规范', true);
    await runWorld('w-harbor', { now: now + DAY, maxSegments: 1 }, d);
    const latest = await d.taskSnapshots.get('w-harbor');
    expect(latest?.config.version).toBe(old.version);
    expect(await d.events.count()).toBeGreaterThan(count);
  });
  it('uses checkpoint compare-and-swap against concurrent duplicate work', async () => {
    await d.checkpoints.update('w-harbor', { paused: false });
    await Promise.all([
      runWorld('w-harbor', { now: now + HOUR }, d),
      runWorld('w-harbor', { now: now + HOUR }, d),
    ]);
    const events = await d.events.toArray();
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(now + HOUR);
  });
  it('does not let AI impersonate a user-controlled character', async () => {
    await d.conversations.update('conv-nm', { controlledId: 'c-nagi' });
    const before = await d.messages.count();
    await d.transaction('rw', d.messages, d.conversations, d.usage, async () => {
      await persistDialogue(d, 'conv-nm', 'c-nagi', ['不该出现'], now, 'ai', 'forbidden');
    });
    expect(await d.messages.count()).toBe(before);
    await sendUserMessage('conv-nm', '用户的台词', 'c-nagi', d);
    const m = await d.messages.where('conversationId').equals('conv-nm').sortBy('seq');
    expect(m.at(-1)?.senderId).toBe('c-nagi');
    expect(m.at(-1)?.source).toBe('user');
  });
  it('separates observer cursors from virtual readers', async () => {
    await d.cursors.put({
      id: 'observer:conv-nm',
      conversationId: 'conv-nm',
      readerId: 'observer',
      kind: 'observer',
      seq: 2,
      at: now,
    });
    expect(await d.cursors.get('character:conv-nm:c-mio')).toBeUndefined();
  });
  it('never retrieves secrets for unrelated characters, future events, or another world', () => {
    const memory = {
      id: 'secret',
      worldId: 'w-harbor',
      owners: ['a', 'b'],
      content: '秘密约定',
      keywords: [],
      importance: 0.8,
      at: now,
      kind: 'episode' as const,
    };
    expect(retrieveMemories([memory], 'c', 'w-harbor', now, '秘密')).toEqual([]);
    expect(retrieveMemories([memory], 'a', 'w-harbor', now - 1, '秘密')).toEqual([]);
    expect(retrieveMemories([memory], 'a', 'elsewhere', now, '秘密')).toEqual([]);
    expect(retrieveMemories([memory], 'a', 'w-harbor', now, '秘密')).toHaveLength(1);
  });
  it('backs up all entities and prompts without credentials, restores atomically paused', async () => {
    await savePrompt(d, 'behavior', '自定义规范', true);
    await d.profiles.put({
      id: 'api',
      provider: 'test',
      model: 'test',
      baseUrl: 'https://example.com/v1',
      persistKey: true,
      status: 'connected',
      key: 'TEST-SECRET-NOT-REAL',
    });
    const b = await exportBackup(d);
    expect(JSON.stringify(b)).not.toContain('TEST-SECRET');
    validateBackup(b);
    await importBackup(b, d);
    expect((await getPrompts(d)).entries[0].content).toBe('自定义规范');
    expect(await d.profiles.count()).toBe(0);
    expect((await d.checkpoints.get('w-harbor'))?.paused).toBe(true);
  });
  it('rejects orphaned references before changing the database', async () => {
    const backup = await exportBackup(d);
    backup.messages[0].senderId = 'unknown';
    expect(() => validateBackup(backup)).toThrow('引用');
    expect(await d.messages.count()).toBe(8);
  });
  it('keeps membership overrides scoped to a world', async () => {
    await d.worlds.add({ ...(await d.worlds.get('w-harbor'))!, id: 'w2' });
    await d.memberships.add({
      id: 'm2',
      worldId: 'w2',
      characterId: 'c-nagi',
      identity: '学生',
      bioOverride: '另一个身份',
      styleOverride: '敬语',
    });
    expect(
      (await d.memberships.where('[worldId+characterId]').equals(['w-harbor', 'c-nagi']).first())
        ?.bioOverride,
    ).toBe('');
  });
  it('creates one stable direct conversation per pair', async () => {
    const a = await createDirect('w-harbor', 'c-nagi', 'c-toru', d),
      b = await createDirect('w-harbor', 'c-toru', 'c-nagi', d);
    expect(a).toBe(b);
  });
  it('gives sleeping and user-controlled characters zero social weight', async () => {
    const c = (await d.characters.get('c-nagi'))!,
      conv = (await d.conversations.get('conv-nm'))!,
      state = (await d.states.toArray())[0];
    expect(socialWeight(c, { ...state, phone: 0 }, conv, [], 0, now, true)).toBe(0);
    expect(
      socialWeight(c, { ...state, phone: 1 }, { ...conv, controlledId: c.id }, [], 0, now, true),
    ).toBe(0);
  });
});
describe('provider fault handling', () => {
  it.each([
    [401, 'invalid'],
    [403, 'permission'],
    [429, 'rate'],
    [500, 'server'],
  ])('classifies %s without exposing response text', (status, code) => {
    expect(apiError(Number(status), 'sensitive').code).toBe(code);
    expect(apiError(Number(status), 'sensitive').message).not.toContain('sensitive');
  });
  it('distinguishes quota exhaustion', () =>
    expect(apiError(429, 'insufficient_quota').code).toBe('quota'));
  it.each(['timeout', 'network', 'json', 'server', 'rate'])(
    'supports fault injection: %s',
    async (failure) => {
      await expect(new MockProvider({}, failure).complete([])).rejects.toMatchObject({
        code: failure,
      });
    },
  );
});
describe('live simulation with injected provider', () => {
  it('uses recoveryChat policies, generates private chats and records snapshot versions', async () => {
    const calls: { role: string; content: string }[][] = [];
    const provider = {
      async complete(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]) {
        calls.push(messages);
        const match = messages[0].content.match(/"speakerId":"([^"]+)"/);
        return {
          content: JSON.stringify(
            match
              ? {
                  speakerId: match[1],
                  messages: ['今天风有点大。', '我带了外套。'],
                  offsets: [0, 4],
                }
              : { description: '按计划度过一段平静的日常。' },
          ),
          inputTokens: 20,
          outputTokens: 20,
          estimated: false,
        };
      },
    };
    await d.settings.update('app', {
      sceneDailyBudget: 0,
      activity: 'lively',
      recoveryBudget: 50,
      dailyRequests: 200,
    });
    await d.checkpoints.update('w-harbor', { paused: false, mode: 'live' });
    await runWorld('w-harbor', { now: now + DAY, provider }, d);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.some((c) => c[0].content.includes('禁止 AI 服务式回复'))).toBe(true);
    expect(calls.some((c) => c[0].content.includes('自主生活模拟'))).toBe(true);
    expect(calls.every((c) => c[0].content.includes('离线时间补全'))).toBe(true);
    const ai = (await d.messages.toArray()).filter((m) => m.source === 'ai');
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.length % 2).toBe(0);
    const logs = await d.taskLogs.toArray();
    expect(logs.every((l) => l.promptVersion === 1)).toBe(true);
  }, 15000);
  it('does not advance checkpoint or corrupt saved events when provider fails', async () => {
    await d.checkpoints.update('w-harbor', { paused: false, mode: 'live' });
    await d.settings.update('app', { activity: 'lively' });
    const count = await d.events.count();
    await expect(
      runWorld('w-harbor', { now: now + HOUR, provider: new MockProvider({}, 'server') }, d),
    ).rejects.toThrow();
    expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(now);
    expect(await d.events.count()).toBe(count);
  });
});

describe('failure budgets', () => {
  it('reserves recovery request budget before a failed request, including after a restart', async () => {
    await d.settings.update('app', { activity: 'lively', recoveryBudget: 1 });
    await d.checkpoints.update('w-harbor', { paused: false, mode: 'live' });
    const provider = new MockProvider({}, 'server');
    await expect(runWorld('w-harbor', { now: now + HOUR, provider }, d)).rejects.toThrow();
    expect((await d.checkpoints.get('w-harbor'))?.recoveryRequests).toBe(1);
    await runWorld('w-harbor', { now: now + HOUR, provider }, d);
    expect(provider.calls).toHaveLength(1);
    expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(now + HOUR);
  });
});

describe('normal tick routing', () => {
  it('does not apply offline policy to ordinary autonomous chat', async () => {
    const calls: string[] = [];
    const provider = {
      async complete(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]) {
        const system = messages[0].content;
        calls.push(system);
        const speaker = system.match(/"speakerId":"([^"]+)"/)?.[1];
        return {
          content: JSON.stringify(
            speaker
              ? { speakerId: speaker, messages: ['刚歇下来。'] }
              : { description: '在既定地点休息。' },
          ),
          inputTokens: 20,
          outputTokens: 20,
          estimated: false,
        };
      },
    };
    await d.settings.update('app', { activity: 'lively' });
    await d.checkpoints.update('w-harbor', { paused: false, mode: 'live' });
    await runWorld('w-harbor', { now: now + 6 * 60000, provider }, d);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((s) => !s.includes('离线时间补全'))).toBe(true);
    expect(calls.some((s) => s.includes('角色行为与语言规范'))).toBe(true);
    expect(calls.every((s) => s.includes('社交决策与主动聊天'))).toBe(true);
  });
});
