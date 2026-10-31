import { it, expect } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { messagePage, messageKey, messageAround, messageAt } from '../src/data/chat-history';
import { recordObserved } from '../src/data/chat';
import { adaptiveLimits } from '../src/core/adaptive-batching';
import type { Message } from '../src/core/types';
it('cursor pagination handles 50,000 rows, equal times, backfills, jumps and actual reads', async () => {
  const d = new AquariumDB('history-' + crypto.randomUUID());
  try {
    for (let start = 0; start < 50000; start += 1000)
      await d.messages.bulkPut(
        Array.from(
          { length: 1000 },
          (_, i) =>
            ({
              id: String(start + i).padStart(6, '0'),
              conversationId: 'c',
              simAt: Math.floor((start + i) / 3),
              seq: start + i + 1,
              text: '历史消息',
              senderId: 'a',
              realAt: 1,
              source: 'ai',
            }) as Message,
        ),
      );
    const tail = await messagePage('c', 'before', undefined, 40, d);
    expect(tail).toHaveLength(40);
    expect(tail.at(-1)?.seq).toBe(50000);
    const older = await messagePage('c', 'before', messageKey(tail[0]), 40, d);
    expect(older.at(-1)?.seq).toBe(49960);
    const newer = await messagePage('c', 'after', messageKey(older.at(-1)!), 40, d);
    expect(newer.map((m) => m.id)).toEqual(tail.map((m) => m.id));
    await d.messages.put({ ...tail[0], id: 'backfill', seq: 50001, simAt: 100 });
    const around = await messageAround('c', 'backfill', d);
    expect(around).toHaveLength(41);
    expect(around[20].id).toBe('backfill');
    expect((await messageAt('c', 101, d))?.simAt).toBe(101);
    await recordObserved('c', ['000000', '000002', 'absent'], d);
    expect((await d.cursors.get('observer:c'))?.seq).toBe(1);
    await recordObserved('c', ['000001'], d);
    expect((await d.cursors.get('observer:c'))?.seq).toBe(3);
  } finally {
    await d.delete();
  }
}, 30000);
it('load triggers batching at 1x and hysteresis retains it until drained', () => {
  const health = { scale: 1, latencyMs: 45000, successes: 10, failures: 0 };
  expect(adaptiveLimits(1, true, 8192, health, 4).maxTasks).toBeGreaterThan(1);
  expect(adaptiveLimits(1, true, 8192, health, 2).maxTasks).toBe(1);
  expect(adaptiveLimits(1, true, 8192, { ...health, batching: true }, 2).maxTasks).toBeGreaterThan(
    1,
  );
  expect(adaptiveLimits(1, true, 8192, { ...health, batching: true }, 1).maxTasks).toBe(1);
  expect(adaptiveLimits(1440, true, 8192, health, 12).maxTasks).toBe(12);
});

it('links shared scenes once, without exposing them to absent group participants', async () => {
  const { sceneLinks } = await import('../src/data/chat-scenes');
  const d = new AquariumDB('scene-links-' + crypto.randomUUID());
  try {
    await d.scenes.bulkPut(
      ['one', 'duplicate'].map((id) => ({
        id,
        worldId: 'w',
        eventId: 'shared',
        title: '聚会',
        start: 100,
        end: 200,
        participants: ['a', 'b', 'c'],
        location: '咖啡店',
        type: 'social',
        promptVersion: 1,
        phases: [],
      })),
    );
    const c = {
      id: 'ab',
      worldId: 'w',
      kind: 'direct' as const,
      participants: ['a', 'b'],
      name: 'AB',
      createdAt: 0,
      lastAt: 0,
    };
    const links = await sceneLinks(c, 0, 300, 0, 30, false, d);
    expect(links).toHaveLength(1);
    expect(links[0]).not.toHaveProperty('phases');
    expect(
      await sceneLinks(
        { ...c, kind: 'group', participants: ['a', 'b', 'd'] },
        0,
        300,
        0,
        30,
        false,
        d,
      ),
    ).toHaveLength(0);
    expect(
      await sceneLinks(
        { ...c, kind: 'group', participants: ['a', 'b', 'c'] },
        0,
        300,
        0,
        30,
        false,
        d,
      ),
    ).toHaveLength(1);
    // Most eager mode: one group member in the scene is enough.
    const eagerGroup = await sceneLinks(
      { ...c, kind: 'group', participants: ['a', 'd'] },
      0,
      300,
      0,
      30,
      false,
      d,
      'all',
    );
    expect(eagerGroup).toHaveLength(1);
    expect(eagerGroup[0].participants).toEqual(['a', 'b', 'c']);
    // Direct chats still require both sides, even when the scene is a group activity.
    expect(
      await sceneLinks({ ...c, participants: ['a', 'd'] }, 0, 300, 0, 30, false, d, 'all'),
    ).toHaveLength(0);
    expect(await sceneLinks(c, 0, 300, 0, 30, false, d, 'off')).toHaveLength(0);
  } finally {
    await d.delete();
  }
});
