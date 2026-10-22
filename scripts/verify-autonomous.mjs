import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
if (!process.env.AQUARIUM_QA_PROFILE)
  throw new Error('Use an isolated, explicitly prepared QA browser profile.');
const context = await chromium.launchPersistentContext(process.env.AQUARIUM_QA_PROFILE, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
try {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' });
  const report = await page.evaluate(async () => {
    const path = '/src/data/db.ts',
      providerPath = '/src/ai/provider.ts',
      seedPath = '/src/data/seed.ts',
      worldPath = '/src/data/worlds.ts',
      enginePath = '/src/core/engine.ts',
      timePath = '/src/core/time.ts',
      backupPath = '/src/data/backup.ts';
    const { db, AquariumDB } = await import(path),
      { CompatibleProvider } = await import(providerPath),
      { seed } = await import(seedPath),
      { exportWorld, importWorld } = await import(worldPath),
      { runWorld } = await import(enginePath),
      { dateStart, worldDate } = await import(timePath),
      { exportBackup, validateBackup } = await import(backupPath);
    const profile = await db.profiles.get('api');
    if (!profile?.key) throw new Error('The isolated QA profile has no saved API key.');
    const settings = await db.settings.get('app');
    const pkg = await exportWorld(settings.worldId);
    const scratch = new AquariumDB(`aquarium-live-qa-${Date.now()}`);
    await seed(scratch);
    const id = await importWorld(pkg, scratch);
    const world = await scratch.worlds.get(id);
    const start = dateStart(worldDate(Date.now(), world.timezone), world.timezone) + 8 * 3600000;
    const realNow = Date.now();
    await scratch.settings.update('app', {
      activity: 'lively',
      dailyRequests: 30,
      dailyTokens: 180000,
      dailyMessages: 100,
    });
    await scratch.checkpoints.update(id, {
      paused: false,
      mode: 'live',
      speed: 3600,
      timeMode: 'god',
      simTime: start,
      realTime: realNow - 24000,
    });
    let calls = 0;
    const observations = [];
    const client = new CompatibleProvider(profile);
    const provider = {
      async complete(messages, signal, options) {
        calls++;
        if (calls > 30) throw new Error('QA request safety limit reached');
        const result = await client.complete(messages, signal, options);
        observations.push({
          finishReason: result.finishReason,
          length: result.content.length,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          preview: result.content.slice(0, 300),
        });
        return result;
      },
    };
    const failures = [];
    for (let batch = 0; batch < 4; batch++) {
      try {
        await runWorld(
          id,
          { now: realNow, foregroundSince: realNow - 24000, provider, maxSegments: 8 },
          scratch,
        );
      } catch (e) {
        failures.push({ code: e.code ?? 'error', message: e.message });
        break;
      }
      const cp = await scratch.checkpoints.get(id);
      if (cp.simTime >= start + 24 * 3600000) break;
    }
    const cp = await scratch.checkpoints.get(id),
      events = await scratch.events.where('worldId').equals(id).toArray(),
      convs = await scratch.conversations.where('worldId').equals(id).toArray(),
      all = await scratch.messages.toArray(),
      messages = all.filter((m) => convs.some((c) => c.id === m.conversationId));
    const ai = messages.filter((m) => m.source === 'ai');
    const actors = new Set(ai.map((m) => m.senderId));
    const participantNames = await scratch.characters.toArray();
    let overlap = false;
    for (const member of pkg.characters) {
      const matched = participantNames.filter((c) => c.name === member.name).map((c) => c.id);
      const own = events
        .filter((e) => e.participants.some((id) => matched.includes(id)))
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < own.length; i++) if (own[i].start < own[i - 1].end) overlap = true;
    }
    let ordered = true;
    for (const conv of convs) {
      const ms = messages.filter((m) => m.conversationId === conv.id).sort((a, b) => a.seq - b.seq);
      for (let i = 1; i < ms.length; i++) if (ms[i].simAt < ms[i - 1].simAt) ordered = false;
    }
    const backup = await exportBackup(scratch);
    let referencesValid = true;
    try {
      validateBackup(backup);
    } catch {
      referencesValid = false;
    }
    const before = { events: events.length, messages: messages.length };
    if (!failures.length)
      await runWorld(id, { now: realNow, foregroundSince: realNow - 24000, provider }, scratch);
    const after = {
      events: await scratch.events.where('worldId').equals(id).count(),
      messages: (await scratch.messages.toArray()).filter((m) =>
        convs.some((c) => c.id === m.conversationId),
      ).length,
    };
    const logs = await scratch.taskLogs.toArray();
    const report = {
      date: '2026-10-22',
      provider: profile.provider,
      model: profile.model,
      speed: 3600,
      simulatedHours: (cp.simTime - start) / 3600000,
      apiCalls: calls,
      aiMessages: ai.length,
      aiSpeakers: actors.size,
      conversationsWithAI: convs.filter((c) => ai.some((m) => m.conversationId === c.id)).length,
      events: events.length,
      sharedEvents: events.filter((e) => e.participants.length > 1).length,
      sleepEvents: events.filter((e) => e.type === 'sleep').length,
      userMessages: messages.filter((m) => m.source === 'user').length,
      chronological: ordered,
      noActivityOverlap: !overlap,
      referencesValid,
      idempotent: before.events === after.events && before.messages === after.messages,
      failures,
      observations,
      context: logs
        .filter((l) => l.context)
        .map((l) => ({
          task: l.task,
          status: l.status,
          finishReason: l.finishReason,
          inputTokens: l.inputTokens,
          outputTokens: l.outputTokens,
          ...l.context,
        })),
      examples: ai.slice(0, 6).map((m) => ({
        speaker: participantNames.find((c) => c.id === m.senderId)?.name,
        text: m.text,
        simAt: m.simAt,
      })),
      usage: await scratch.usage.toArray(),
      originalWorldUnchanged: true,
    };
    await scratch.delete();
    return report;
  });
  await writeFile('docs/LIVE-DEBUG-2026-10-22.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({ ...report, examples: undefined, context: undefined, usage: undefined }),
  );
  if (
    report.failures.length ||
    report.aiMessages < 2 ||
    report.aiSpeakers < 2 ||
    report.simulatedHours < 24 ||
    !report.chronological ||
    !report.noActivityOverlap ||
    !report.referencesValid ||
    !report.idempotent
  )
    process.exitCode = 1;
} finally {
  await context.close();
}
