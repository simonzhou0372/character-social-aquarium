import { expect, it } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { runWorld } from '../src/core/engine';
import { DAY, HOUR, SettingsSchema } from '../src/core/types';
import { activityConfig, activityModes } from '../src/core/activity';
import { defaultSettings } from '../src/data/seed';
// This is the actual scheduler and persistence path, not a second probability model.
it('calibrates all five activity presets with identical worlds and repeated fixed seeds', async () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const rows = [];
  for (const activity of ['quiet', 'standard', 'lively', 'boiling', 'carnival'] as const) {
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
        await runWorld('w-harbor', { now: now + DAY, provider: fake, maxSegments: 600 }, d);
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
  // Extended presets are calibrated against the unchanged lively preset.
  expect(rows[3].mean / rows[2].mean).toBeGreaterThan(1.7);
  expect(rows[3].mean / rows[2].mean).toBeLessThan(2.1);
  expect(rows[4].mean / rows[2].mean).toBeGreaterThan(2.7);
  expect(rows[4].mean / rows[2].mean).toBeLessThan(3.2);
  expect(rows[4].mean / rows[3].mean).toBeGreaterThan(1.4);
  // Adding louder presets must not change the original three.
  expect(rows[0].mean).toBeLessThan(60);
  expect(rows[2].mean).toBeGreaterThan(150);
}, 120000);

it('keeps the original three preset parameters byte-for-byte compatible', () => {
  expect(activityConfig.quiet).toMatchObject({
    onlineSlots: 1,
    opportunity: 0.8,
    cooldownMinutes: 30,
    threshold: 0.12,
    topicScale: 1,
    replyContinuation: 0.65,
    naturalEndChance: 0.2,
    directWeight: 1,
    groupWeight: 0.8,
    groupCrowdBonus: 0,
    replyDelayMinutes: 0,
  });
  expect(activityConfig.standard).toMatchObject({
    onlineSlots: 3,
    opportunity: 0.8,
    cooldownMinutes: 15,
    threshold: 0.08,
    topicScale: 0.5,
    replyContinuation: 0.82,
    naturalEndChance: 0.13,
    directWeight: 1,
    groupWeight: 1,
    groupCrowdBonus: 0,
    replyDelayMinutes: 0,
  });
  expect(activityConfig.lively).toMatchObject({
    onlineSlots: 6,
    opportunity: 0.8,
    cooldownMinutes: 8,
    threshold: 0.055,
    topicScale: 0.25,
    replyContinuation: 0.94,
    naturalEndChance: 0.09,
    directWeight: 1,
    groupWeight: 1.15,
    groupCrowdBonus: 0,
    replyDelayMinutes: 0,
  });
  expect(activityModes.map((m) => m.mode)).toEqual([
    'quiet',
    'standard',
    'lively',
    'boiling',
    'carnival',
  ]);
  const parsed = SettingsSchema.parse({
    ...defaultSettings,
    activity: 'carnival',
    uiMode: 'classic',
    motionLevel: 'off',
  });
  expect(parsed.activity).toBe('carnival');
  expect(parsed.uiMode).toBe('classic');
  expect(parsed.motionLevel).toBe('off');
});

it('never opens a conversation for a sleeping character even at carnival', async () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const d = new AquariumDB('carnival-sleep-' + crypto.randomUUID());
  try {
    await seed(d, now);
    await d.settings.update('app', {
      activity: 'carnival',
      unlimitedUsage: true,
      sceneDailyBudget: 0,
    });
    await d.characters.toCollection().modify({
      initiative: 0.9,
      replyChance: 0.95,
      phoneHabit: 1,
      topicIntervalMinutes: 30,
      busyStart: 0,
      busyEnd: 0,
      wake: 6,
      sleep: 22,
    });
    await d.characters.update('c-nagi', { wake: 12, sleep: 8 });
    await d.relationships.toCollection().modify({ closeness: 90, trust: 90 });
    await d.checkpoints.update('w-harbor', {
      seed: 4242,
      simTime: now,
      realTime: now,
      paused: false,
      mode: 'live',
    });
    const fake = {
      async complete(input: any) {
        const speaker = input[0].content.match(/"speakerId":"([^"]+)"/)?.[1];
        return {
          content: JSON.stringify(
            speaker
              ? { speakerId: speaker, messages: ['刚看到。', '晚点再说。'], offsets: [0, 3] }
              : { description: '按既定日程活动。' },
          ),
          inputTokens: 10,
          outputTokens: 15,
          estimated: false,
        };
      },
    };
    await runWorld('w-harbor', { now: now + 4 * HOUR, provider: fake, maxSegments: 160 }, d);
    const messages = (await d.messages.toArray()).filter((m) => m.source === 'ai');
    expect(messages.length).toBeGreaterThan(0);
    const sleepingTalk = messages.filter(
      (m) => m.senderId === 'c-nagi' && m.simAt < now + 12 * HOUR,
    );
    expect(sleepingTalk).toEqual([]);
  } finally {
    await d.delete();
  }
}, 60000);

it('keeps carnival virtual output independent from 1x and 300x playback speed', async () => {
  const start = Date.parse('2026-10-22T00:00:00Z');
  const span = 6 * HOUR;
  const results: any[] = [];
  for (const speed of [1, 300]) {
    const d = new AquariumDB('carnival-speed-' + speed + '-' + crypto.randomUUID());
    try {
      await seed(d, start);
      await d.settings.update('app', {
        activity: 'carnival',
        unlimitedUsage: true,
        sceneDailyBudget: 0,
      });
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
        seed: 777,
        simTime: start,
        realTime: start,
        paused: false,
        mode: 'live',
        speed,
        clockAnchor: { simTime: start, realTime: start },
      });
      await runWorld(
        'w-harbor',
        {
          now: start + span / speed,
          foregroundSince: start,
          deferContent: true,
          dispatchContent: false,
          maxSegments: 2000,
        },
        d,
      );
      expect((await d.checkpoints.get('w-harbor'))?.simTime).toBe(start + span);
      const jobs = await d.contentJobs.toArray();
      results.push(
        jobs
          .map((j) => ({
            id: j.id,
            at: j.at,
            expected: j.plan?.expectedMessages,
            kind: j.kind,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(jobs.length).toBeGreaterThan(50);
    } finally {
      await d.delete();
    }
  }
  expect(results[1]).toEqual(results[0]);
}, 120000);
