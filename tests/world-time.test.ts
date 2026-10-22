import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import {
  createWorld,
  exportWorld,
  importWorld,
  saveGroupMembers,
  validateWorldPackage,
} from '../src/data/worlds';
import { clockTarget, configureTime, rewindWorld, dateStart, worldDate } from '../src/core/time';
import { runWorld, setRunning } from '../src/core/engine';
import { topicPolicy, topicDue } from '../src/core/simulation';
import { exportBackup, validateBackup } from '../src/data/backup';
import { generateCreationDraft, validateDraft, type CreationDraft } from '../src/ai/drafts';
import { MockProvider } from '../src/ai/provider';
import { HOUR, DAY, type World } from '../src/core/types';
let d: AquariumDB;
const now = Date.parse('2026-10-22T10:00:00Z');
beforeEach(async () => {
  d = new AquariumDB('world-' + crypto.randomUUID());
  await seed(d, now);
});
afterEach(async () => {
  vi.useRealTimers();
  await d.delete();
});
async function world(id = 'w2'): Promise<World> {
  return { ...(await d.worlds.get('w-harbor'))!, id, name: '第二个世界' };
}
describe('world and group creation', () => {
  it('creates a world with shared characters, selected groups and newly entered members/groups atomically', async () => {
    await createWorld(
      await world(),
      ['c-nagi'],
      ['g-band'],
      ['新人甲', '新人乙'],
      ['新社团：新人甲、新人乙'],
      d,
    );
    const members = await d.memberships.where('worldId').equals('w2').toArray();
    expect(members).toHaveLength(5);
    expect(new Set(members.map((m) => m.characterId)).size).toBe(5);
    expect((await d.groups.get('g-band'))?.worldIds).toContain('w2');
    expect(await d.conversations.where('worldId').equals('w2').count()).toBe(2);
    expect((await d.checkpoints.get('w2'))?.timeMode).toBe('god');
    validateBackup(await exportBackup(d));
  });
  it('rejects an invalid member name without creating partial entities', async () => {
    const count = await d.characters.count();
    await expect(
      createWorld(await world(), [], [], ['新人甲'], ['新社团：新人甲、不存在'], d),
    ).rejects.toThrow();
    expect(await d.worlds.get('w2')).toBeUndefined();
    expect(await d.characters.count()).toBe(count);
  });
  it('imports a scoped world package without overwriting original characters, histories or API config', async () => {
    const pkg = await exportWorld('w-harbor', d),
      before = await d.messages.count();
    const id = (await importWorld(pkg, d))!;
    expect(id).not.toBe('w-harbor');
    expect(await d.characters.count()).toBe(10);
    expect(await d.messages.count()).toBe(before);
    expect(await d.memberships.where('worldId').equals(id).count()).toBe(5);
    validateBackup(await exportBackup(d));
  });
  it('rejects a corrupted world package before write', async () => {
    const pkg = await exportWorld('w-harbor', d);
    pkg.groupMembers[0].characterId = 'missing';
    expect(() => validateWorldPackage(pkg)).toThrow();
    expect(await d.worlds.count()).toBe(1);
  });
  it('requires explicit confirmation for world-external members and joins them atomically on save', async () => {
    await createWorld(await world(), [], [], ['外来角色'], [], d);
    const outsider = (await d.characters.where('name').equals('外来角色').first())!;
    const group = {
      id: 'new-group',
      name: '跨世界社团',
      description: '',
      worldIds: ['w-harbor'],
      color: '#d9ef69',
    };
    await expect(
      saveGroupMembers(group, 'w-harbor', ['c-nagi', outsider.id], [], [], [], d),
    ).rejects.toThrow('确认');
    expect(await d.groups.get('new-group')).toBeUndefined();
    await saveGroupMembers(
      group,
      'w-harbor',
      ['c-nagi', outsider.id],
      ['新队员'],
      [],
      [outsider.id],
      d,
    );
    expect(
      await d.memberships.where('[worldId+characterId]').equals(['w-harbor', outsider.id]).count(),
    ).toBe(1);
    expect(
      await d.memberships.where('[worldId+characterId]').equals(['w2', outsider.id]).count(),
    ).toBe(1);
    expect(
      (await d.conversations.where('groupId').equals('new-group').first())?.participants,
    ).toHaveLength(3);
    validateBackup(await exportBackup(d));
  });
  it('preserves generated character profiles when creating groups', async () => {
    await saveGroupMembers(
      {
        id: 'g-new',
        name: '新团体',
        description: '活动',
        worldIds: ['w-harbor'],
        color: '#d9ef69',
      },
      'w-harbor',
      ['c-nagi'],
      ['新队员'],
      [
        {
          name: '新队员',
          source: '原创',
          bio: 'AI 草稿具体身份',
          personality: '冷静',
          style: '简短',
          habits: '散步',
        },
      ],
      [],
      d,
    );
    expect((await d.characters.where('name').equals('新队员').first())?.bio).toBe(
      'AI 草稿具体身份',
    );
  });
});
describe('time modes and rewind', () => {
  it('accelerates only the explicitly visible foreground interval; offline always remains 1x', async () => {
    const cp = {
      ...(await d.checkpoints.get('w-harbor'))!,
      paused: false,
      speed: 3600,
      timeMode: 'god' as const,
    };
    expect(clockTarget(cp, now + DAY)).toBe(now + DAY);
    expect(clockTarget(cp, now + 24000, now)).toBe(now + DAY);
    expect(clockTarget({ ...cp, timeMode: 'real' }, now + 24000, now)).toBe(now + 24000);
  });
  it('runs an accelerated day then catches up a later offline hour at 1x', async () => {
    await d.checkpoints.update('w-harbor', { paused: false, speed: 3600, timeMode: 'god' });
    await runWorld('w-harbor', { now: now + 24000, foregroundSince: now }, d);
    expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(now + DAY);
    expect((await d.checkpoints.get('w-harbor'))?.realTime).toBe(now + 24000);
    await runWorld('w-harbor', { now: now + 24000 + HOUR }, d);
    expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(now + DAY + HOUR);
  });
  it('switches real mode to exactly 1x and forbids rewind', async () => {
    await configureTime('w-harbor', 'real', 3600, d);
    const cp = await d.checkpoints.get('w-harbor');
    expect(cp?.speed).toBe(1);
    await expect(rewindWorld('w-harbor', now - HOUR, d)).rejects.toThrow('不能回退');
  });
  it('pausing real-world observation freezes its clock across reopening', async () => {
    await d.checkpoints.update('w-harbor', { timeMode: 'real', speed: 1 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + HOUR);
    await setRunning('w-harbor', false, 'demo', d);
    await setRunning('w-harbor', true, 'demo', d);
    const cp = (await d.checkpoints.get('w-harbor'))!;
    expect(cp.realTime).toBe(now + HOUR);
    expect(clockTarget(cp, now + HOUR)).toBe(now);
  });
  it('rewinds by branching, excludes future records and preserves original timeline', async () => {
    const original = await d.messages.count(),
      at = now - 10 * 60000;
    const id = (await rewindWorld('w-harbor', at, d))!;
    expect(id).not.toBe('w-harbor');
    expect((await d.checkpoints.get(id))?.simTime).toBe(at);
    expect((await d.checkpoints.get(id))?.paused).toBe(true);
    expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(now);
    expect(await d.messages.where('conversationId').equals('conv-cafe').count()).toBe(4);
    const conversations = await d.conversations.where('worldId').equals(id).toArray();
    const messages = (await d.messages.toArray()).filter((m) =>
      conversations.some((c) => c.id === m.conversationId),
    );
    expect(messages.every((m) => m.simAt <= at)).toBe(true);
    expect((await d.events.where('worldId').equals(id).toArray()).every((e) => e.end <= at)).toBe(
      true,
    );
    expect(await d.messages.count()).toBeGreaterThanOrEqual(original);
    validateBackup(await exportBackup(d));
  });
  it('converts world-local day boundaries correctly across time zones', () => {
    expect(dateStart('2026-10-22', 'Asia/Shanghai')).toBe(Date.parse('2026-10-21T16:00:00Z'));
    expect(worldDate(dateStart('2026-10-22', 'America/New_York'), 'America/New_York')).toBe(
      '2026-10-22',
    );
    expect(() => dateStart('2026-02-31', 'Asia/Shanghai')).toThrow();
  });
});
describe('quantified initiative', () => {
  it('uses an explicit interval and keeps it separate from recent replies', async () => {
    const c = {
        ...(await d.characters.get('c-nagi'))!,
        initiationMode: 'interval' as const,
        topicIntervalMinutes: 30,
      },
      state = {
        ...(await d.states.where('characterId').equals('c-nagi').first())!,
        lastTopicAt: now,
        lastAction: now + 29 * 60000,
      };
    expect(topicDue(c, state, now + 29 * 60000, false)).toBe(false);
    expect(topicDue(c, state, now + 30 * 60000, false)).toBe(true);
  });
  it('supports nearly passive and important-only characters', async () => {
    const c = (await d.characters.get('c-nagi'))!,
      state = (await d.states.where('characterId').equals(c.id).first())!;
    expect(topicDue({ ...c, initiationMode: 'never' }, state, now + DAY, true)).toBe(false);
    expect(topicDue({ ...c, initiationMode: 'important' }, state, now + DAY, false)).toBe(false);
    expect(topicDue({ ...c, initiationMode: 'important' }, state, now + DAY, true)).toBe(true);
  });
});
describe('creation AI drafting', () => {
  const draft: CreationDraft = {
    world: {
      name: '原创小镇',
      description: '生活在海边',
      rules: '没有超自然能力',
      locations: ['咖啡馆'],
      timezone: 'Asia/Shanghai',
      tone: '轻松',
    },
    characters: [
      {
        name: '新角色甲',
        source: '原创',
        bio: '咖啡师',
        personality: '冷静',
        style: '简短',
        habits: '读书',
      },
    ],
    groups: [{ name: '小圈子', description: '朋友', memberNames: ['凪 夏生', '新角色甲'] }],
    uncertain: '原创补充',
  };
  it('uses related task policies and user constraints, without saving before acceptance', async () => {
    const provider = new MockProvider(draft),
      before = await d.worlds.count();
    const result = await generateCreationDraft(
      'world',
      { name: '预填名称' },
      '只要普通日常',
      ['凪 夏生'],
      d,
      provider,
    );
    expect(result.characters).toHaveLength(1);
    expect(provider.calls[0][1].content).toContain('只要普通日常');
    expect(provider.calls[0][0].content).not.toContain('禁止输出 Markdown');
    expect(await d.worlds.count()).toBe(before);
  });
  it('rejects hallucinated members and duplicate character names', () => {
    expect(() =>
      validateDraft(
        {
          ...draft,
          groups: [{ name: '组', description: '', memberNames: ['不存在', '新角色甲'] }],
        },
        'world',
        ['凪 夏生'],
      ),
    ).toThrow();
    expect(() => validateDraft(draft, 'world', ['新角色甲'])).toThrow();
  });
});

describe('imported world composite IDs', () => {
  it('keeps generated direct conversation IDs short and exports all virtual read cursors', async () => {
    const id = (await importWorld(await exportWorld('w-harbor', d), d))!;
    await d.checkpoints.update(id, { simTime: now, realTime: now, paused: false });
    await runWorld(id, { now: now + DAY }, d);
    const conversations = await d.conversations.where('worldId').equals(id).toArray();
    expect(conversations.filter((c) => c.kind === 'direct').every((c) => c.id.length < 100)).toBe(
      true,
    );
    validateBackup(await exportBackup(d));
  });
});
