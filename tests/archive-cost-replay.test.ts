import { it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compactChatRequest, expandCompactChat } from '../src/ai/compact-protocol';
import { composePrompt } from '../src/ai/prompts';
import { dialogueContract } from '../src/ai/provider';
import { estimateTokens } from '../src/ai/prompts';
const root = resolve(process.env.AQUARIUM_ARCHIVE_PATH ?? 'LastSevenDays_Archive');
const available = existsSync(resolve(root, 'online-conversations.json'));
// Private experimental records are optional in CI; no synthetic text substitutes for missing archived responses.
it.runIf(available)(
  'replays the real 100-person, seven-day archive through the lossless codec without regenerating messages',
  () => {
    const read = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
    const conversations = read('online-conversations.json'),
      scenes = read('inperson-scenes.json'),
      chars = read('characters.json'),
      groups = read('groups.json'),
      jobs = read('data/content-jobs.json'),
      prompts = read('data/prompt-config.json')[0];
    expect(chars).toHaveLength(100);
    expect(groups).toHaveLength(24);
    expect(scenes).toHaveLength(8);
    let count = 0,
      batches = 0,
      originalBytes = 0,
      compactBytes = 0,
      originalTokenEstimate = 0,
      compactTokenEstimate = 0,
      originalContractTokenEstimate = 0,
      compactContractTokenEstimate = 0;
    const signatures: any[] = [];
    for (const c of conversations) {
      const grouped = new Map<string, any[]>();
      for (const m of c.messages) {
        const key = m.id.replace(/:\d+$/, '') + '|' + m.senderId;
        const list = grouped.get(key) ?? [];
        list.push(m);
        grouped.set(key, list);
      }
      for (const messages of grouped.values()) {
        messages.sort((a, b) => a.seq - b.seq);
        const speaker = messages[0].senderId;
        const original = { speakerId: speaker, messages: messages.map((m) => m.text) };
        const compact = { m: original.messages };
        const restored = JSON.parse(expandCompactChat(JSON.stringify(compact), speaker));
        expect(restored).toEqual(original);
        count += messages.length;
        batches++;
        const before = JSON.stringify(original),
          after = JSON.stringify(compact);
        originalBytes += Buffer.byteLength(before);
        compactBytes += Buffer.byteLength(after);
        originalTokenEstimate += estimateTokens(before);
        compactTokenEstimate += estimateTokens(after);
        const request = composePrompt('chat', prompts, {}, dialogueContract(speaker, prompts));
        const wire = compactChatRequest(request, 'chat')!;
        const marker = '【不可覆盖的输出契约】\n';
        originalContractTokenEstimate += estimateTokens(request[0].content.split(marker)[1]);
        compactContractTokenEstimate += estimateTokens(wire.messages[0].content.split(marker)[1]);
        signatures.push(...messages.map((m) => [c.id, m.id, m.senderId, m.simAt, m.text]));
      }
    }
    const dialogue = scenes
      .flatMap((s: any) => s.phases.flatMap((p: any) => p.entries))
      .filter((e: any) => e.kind === 'dialogue').length;
    expect(count).toBe(3538);
    expect(jobs.filter((j: any) => j.kind === 'chat')).toHaveLength(2304);
    expect(compactBytes).toBeLessThan(originalBytes);
    expect(new Set(signatures.map((s) => s[1])).size).toBe(count);
    const report = {
      source:
        'Read-only replay of the user-provided real archive; no paid calls, no new text, no replacement fixtures',
      characters: chars.length,
      groups: groups.length,
      virtualDays: 7,
      messages: count,
      dialogue,
      scenes: scenes.length,
      majorEvents: read('data/major-events.json').length,
      serializedBatches: batches,
      originalBytes,
      compactBytes,
      originalTokenEstimate,
      compactTokenEstimate,
      originalContractTokenEstimate,
      compactContractTokenEstimate,
      textIdentity:
        'all persisted message strings, sender IDs, conversation IDs and timestamps unchanged',
      billing:
        'Byte counts are exact for reconstructed communication objects; token values use the local estimator and are not measured provider usage or invoice savings. Original response extras and full original wire requests were not retained.',
    };
    console.log('Real archive protocol replay', JSON.stringify(report));
    if (process.env.AQUARIUM_ARCHIVE_AUDIT_FILE)
      writeFileSync(
        process.env.AQUARIUM_ARCHIVE_AUDIT_FILE,
        JSON.stringify(report, null, 2) + '\n',
      );
  },
);
