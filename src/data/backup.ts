import { validateScene } from '../core/scenes';
import { realLocalDate } from '../core/calendar';
import { BackupSchema, type Backup } from '../core/types';
import { db, dataTables, type AquariumDB } from './db';
const names = [
  'scenes',
  'backgroundKnowledge',
  'characters',
  'worlds',
  'memberships',
  'groups',
  'groupMembers',
  'relationships',
  'conversations',
  'messages',
  'cursors',
  'events',
  'states',
  'memories',
  'checkpoints',
  'settings',
  'usage',
  'promptConfigs',
] as const;
export async function exportBackup(d: AquariumDB = db): Promise<Backup> {
  return d.transaction('r', dataTables(d), async () => {
    const out: Record<string, unknown> = { format: 'aquarium', version: 1, exportedAt: Date.now() };
    for (const n of names) out[n] = await d.table(n).toArray();
    return BackupSchema.parse(out);
  });
}
export function validateBackup(input: unknown): Backup {
  const b = BackupSchema.parse(input),
    chars = new Set(b.characters.map((x) => x.id)),
    worlds = new Set(b.worlds.map((x) => x.id)),
    convs = new Map(b.conversations.map((x) => [x.id, x])),
    groups = new Set(b.groups.map((x) => x.id)),
    events = new Set(b.events.map((x) => x.id));
  const assert = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`备份引用不完整：${what}`);
  };
  for (const n of names) {
    const ids = b[n].map((x) => x.id);
    assert(new Set(ids).size === ids.length, `${n} 包含重复 ID`);
  }
  const member = (w: string, c: string) =>
    b.memberships.some((m) => m.worldId === w && m.characterId === c);
  b.memberships.forEach((x) =>
    assert(chars.has(x.characterId) && worlds.has(x.worldId), '角色世界成员'),
  );
  b.groups.forEach((x) =>
    assert(
      x.worldIds.every((w) => worlds.has(w)),
      '团体世界',
    ),
  );
  b.groupMembers.forEach((x) =>
    assert(
      groups.has(x.groupId) &&
        member(x.worldId, x.characterId) &&
        b.groups.find((g) => g.id === x.groupId)!.worldIds.includes(x.worldId),
      '团体成员',
    ),
  );
  b.relationships.forEach((x) =>
    assert(member(x.worldId, x.from) && member(x.worldId, x.to) && x.from !== x.to, '人物关系'),
  );
  b.conversations.forEach((x) =>
    assert(
      worlds.has(x.worldId) &&
        x.participants.every((c) => member(x.worldId, c)) &&
        (!x.groupId || groups.has(x.groupId)) &&
        (!x.controlledId || x.participants.includes(x.controlledId)),
      '会话成员',
    ),
  );
  const seqs = new Set<string>();
  b.messages.forEach((x) => {
    const c = convs.get(x.conversationId),
      key = `${x.conversationId}:${x.seq}`;
    assert(
      !!c &&
        (x.senderId === 'user' || c.participants.includes(x.senderId)) &&
        (!x.eventId || events.has(x.eventId)) &&
        !seqs.has(key),
      '消息',
    );
    seqs.add(key);
  });
  b.cursors.forEach((x) =>
    assert(
      convs.has(x.conversationId) &&
        (x.kind === 'observer' || convs.get(x.conversationId)!.participants.includes(x.readerId)),
      '阅读位置',
    ),
  );
  b.events.forEach((x) =>
    assert(
      worlds.has(x.worldId) &&
        x.end > x.start &&
        x.participants.every((c) => member(x.worldId, c)) &&
        (!x.dependsOn || events.has(x.dependsOn)),
      '生活事件',
    ),
  );
  b.states.forEach((x) =>
    assert(member(x.worldId, x.characterId) && events.has(x.eventId), '角色状态'),
  );
  b.memories.forEach((x) =>
    assert(
      worlds.has(x.worldId) &&
        x.owners.every((c) => member(x.worldId, c)) &&
        (!x.eventId || events.has(x.eventId)) &&
        (!x.conversationId || convs.has(x.conversationId)),
      '记忆',
    ),
  );
  b.scenes.forEach((scene) => {
    const event = b.events.find((e) => e.id === scene.eventId);
    if (event) validateScene(scene, event, 320, true, false);
    assert(
      !!event &&
        event.worldId === scene.worldId &&
        scene.start === event.start &&
        scene.end === event.end &&
        scene.participants.every((c) => event.participants.includes(c)),
      '线下场景事件',
    );
    for (const phase of scene.phases) {
      assert(
        phase.start >= scene.start &&
          phase.end <= scene.end &&
          phase.end > phase.start &&
          phase.participants.every((c) => scene.participants.includes(c)),
        '场景阶段',
      );
      for (const entry of phase.entries)
        assert(
          entry.at >= phase.start &&
            entry.at <= phase.end &&
            (entry.kind !== 'dialogue' ||
              (!!entry.speakerId && phase.participants.includes(entry.speakerId))),
          '场景发言',
        );
    }
  });
  b.backgroundKnowledge.forEach((k) =>
    assert(
      worlds.has(k.worldId) &&
        member(k.worldId, k.characterId) &&
        (member(k.worldId, k.entityId) ||
          b.groups.some((g) => g.id === k.entityId && g.worldIds.includes(k.worldId))),
      '背景认知',
    ),
  );
  b.checkpoints.forEach((x) => assert(worlds.has(x.id), '模拟检查点'));
  b.settings.forEach((x) => assert(worlds.has(x.worldId), '默认世界'));
  for (const w of b.worlds) {
    const cp = b.checkpoints.find((c) => c.id === w.id);
    const tick = cp?.simTime ?? b.exportedAt;
    w.era ??= 'AD';
    w.calendarSystem ??= 'gregorian';
    w.calendarAnchor ??= { tick, date: realLocalDate(tick, w.timezone) };
    w.initialDate ??= realLocalDate(
      b.events.filter((e) => e.worldId === w.id).reduce((n, e) => Math.min(n, e.start), tick),
      w.timezone,
    );
  }
  return b;
}
export async function importBackup(input: unknown, d: AquariumDB = db) {
  const b = validateBackup(input);
  await d.transaction('rw', d.tables, async () => {
    for (const n of names) {
      await d.table(n).clear();
      await d.table(n).bulkAdd(b[n]);
    }
    await d.profiles.clear();
    await d.taskSnapshots.clear();
    await d.taskLogs.clear();
    await d.checkpoints.toCollection().modify({
      paused: true,
      recoveryTarget: undefined,
      recoveryStart: undefined,
      recoveryRealTarget: undefined,
      recoveryKind: undefined,
      recoveryRequests: 0,
    });
  });
}
export function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
