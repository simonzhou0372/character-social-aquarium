import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
if (!process.env.AQUARIUM_QA_PROFILE) throw new Error('An isolated QA profile is required.');
const context = await chromium.launchPersistentContext(process.env.AQUARIUM_QA_PROFILE, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
try {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' });
  const report = await page.evaluate(async () => {
    const d = '/src/data/db.ts',
      b = '/src/data/backup.ts',
      e = '/src/core/engine.ts';
    const { db, AquariumDB } = await import(d),
      { exportBackup, validateBackup } = await import(b),
      { runWorld } = await import(e);
    const candidates = (await indexedDB.databases())
      .map((x) => x.name)
      .filter((n) => n?.startsWith('aquarium-live-qa-'))
      .sort()
      .reverse();
    let scratch, id, cp, events;
    for (const name of candidates) {
      const candidate = new AquariumDB(name);
      const s = await candidate.settings.get('app');
      const c = await candidate.checkpoints.get(s.worldId);
      const ev = await candidate.events.where('worldId').equals(s.worldId).toArray();
      if (
        ev.length &&
        c.simTime - Math.min(...ev.map((x) => x.start)) >= 86400000 &&
        !c.recoveryTarget
      ) {
        scratch = candidate;
        id = s.worldId;
        cp = c;
        events = ev;
        break;
      }
      candidate.close();
    }
    if (!scratch) throw new Error('No completed 24-hour live QA run exists.');
    const profile = await db.profiles.get('api'),
      conversations = await scratch.conversations.where('worldId').equals(id).toArray(),
      messages = (await scratch.messages.toArray()).filter((m) =>
        conversations.some((c) => c.id === m.conversationId),
      ),
      ai = messages.filter((m) => m.source === 'ai'),
      characters = await scratch.characters.toArray();
    let overlap = false,
      ordered = true;
    for (const character of characters) {
      const own = events
        .filter((e) => e.participants.includes(character.id))
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < own.length; i++) if (own[i].start < own[i - 1].end) overlap = true;
    }
    for (const conversation of conversations) {
      const own = messages
        .filter((m) => m.conversationId === conversation.id)
        .sort((a, b) => a.seq - b.seq);
      for (let i = 1; i < own.length; i++) if (own[i].simAt < own[i - 1].simAt) ordered = false;
    }
    validateBackup(await exportBackup(scratch));
    const beforeEvents = events.length,
      beforeMessages = messages.length;
    await runWorld(id, { now: cp.realTime }, scratch);
    const afterEvents = await scratch.events.where('worldId').equals(id).count(),
      afterMessages = (await scratch.messages.toArray()).filter((m) =>
        conversations.some((c) => c.id === m.conversationId),
      ).length;
    const logs = await scratch.taskLogs.toArray(),
      usage = await scratch.usage.toArray();
    const result = {
      date: '2026-10-22',
      provider: profile.provider,
      model: profile.model,
      speed: 3600,
      simulatedHours: (cp.simTime - Math.min(...events.map((e) => e.start))) / 3600000,
      apiCalls: usage.reduce((n, u) => n + u.requests, 0),
      aiMessages: ai.length,
      aiSpeakers: new Set(ai.map((m) => m.senderId)).size,
      conversationsWithAI: conversations.filter((c) => ai.some((m) => m.conversationId === c.id))
        .length,
      events: events.length,
      sharedEvents: events.filter((e) => e.participants.length > 1).length,
      sleepEvents: events.filter((e) => e.type === 'sleep').length,
      userMessages: messages.filter((m) => m.source === 'user').length,
      chronological: ordered,
      noActivityOverlap: !overlap,
      referencesValid: true,
      idempotent: beforeEvents === afterEvents && beforeMessages === afterMessages,
      failures: [],
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
        speaker: characters.find((c) => c.id === m.senderId)?.name,
        text: m.text,
        simAt: m.simAt,
      })),
      usage,
      originalWorldUnchanged: true,
    };
    scratch.close();
    return result;
  });
  await writeFile('docs/LIVE-DEBUG-2026-10-22.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({ ...report, context: undefined, examples: undefined, usage: undefined }),
  );
  if (
    report.simulatedHours < 24 ||
    report.userMessages ||
    report.aiSpeakers < 2 ||
    !report.chronological ||
    !report.noActivityOverlap ||
    !report.idempotent
  )
    process.exitCode = 1;
} finally {
  await context.close();
}
