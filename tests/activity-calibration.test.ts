import { expect, it } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { runWorld } from '../src/core/engine';
import { DAY, HOUR } from '../src/core/types';
// This is the actual scheduler and persistence path, not a second probability model.
it('calibrates quiet / standard / lively with identical worlds and repeated fixed seeds', async () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const rows = [];
  for (const activity of ['quiet', 'standard', 'lively'] as const) {
    const samples = [];
    for (const rng of [42, 2026, 8901]) {
      const d = new AquariumDB(`calibration-${activity}-${rng}-${crypto.randomUUID()}`);
      try {
        await seed(d, now);
        await d.settings.update('app', { activity, unlimitedUsage: true, sceneDailyBudget: 0 });
        await d.characters.toCollection().modify({
          initiative: 0.9,
          replyChance: 0.95,
          phoneHabit: 1,
          wake: 0,
          sleep: 23,
          busyStart: 0,
          busyEnd: 0,
          topicIntervalMinutes: 30,
        });
        await d.relationships.toCollection().modify({ closeness: 90, trust: 90 });
        await d.checkpoints.update('w-harbor', {
          seed: rng,
          simTime: now,
          realTime: now,
          paused: false,
          mode: 'live',
        });
        let requests = 0;
        const fake = {
          async complete(input: any) {
            requests++;
            const speaker = input[0].content.match(/"speakerId":"([^"]+)"/)?.[1];
            return {
              content: JSON.stringify(
                speaker
                  ? {
                      speakerId: speaker,
                      messages: ['这边刚结束。', '等会见。'],
                      offsets: [0, 3],
                    }
                  : { description: '按既定日程活动。' },
              ),
              inputTokens: 10,
              outputTokens: 15,
              estimated: false,
            };
          },
        };
        await runWorld('w-harbor', { now: now + DAY, provider: fake, maxSegments: 240 }, d);
        const messages = (await d.messages.toArray()).filter((m) => m.source === 'ai'),
          convs = await d.conversations.toArray();
        const active = convs.filter((c) => messages.some((m) => m.conversationId === c.id));
        const logs = await d.taskLogs.toArray();
        samples.push({
          seed: rng,
          messages: messages.length,
          initiations: logs.filter((l) => l.task === 'social-initiation').length,
          replies: logs.filter((l) => l.task === 'social-reply').length,
          direct: active.filter((c) => c.kind === 'direct').length,
          group: active.filter((c) => c.kind === 'group').length,
          actorRatio: new Set(messages.map((m) => m.senderId)).size / 5,
          averageIntervalMinutes: messages.length ? 1440 / messages.length : 1440,
          apiRequests: requests,
        });
        expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(now + DAY);
      } finally {
        await d.delete();
      }
    }
    rows.push({
      activity,
      samples,
      mean: samples.reduce((n, s) => n + s.messages, 0) / samples.length,
    });
  }
  console.info('24h scheduler calibration', JSON.stringify(rows));
  expect(rows[1].mean / rows[0].mean).toBeGreaterThan(1.8);
  expect(rows[2].mean / rows[1].mean).toBeGreaterThan(1.35);
}, 60000);
