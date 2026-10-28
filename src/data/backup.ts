import Dexie from 'dexie';
import { validateGif } from './gifs';
import { validateScene } from '../core/scenes';
import { realLocalDate } from '../core/calendar';
import { BackupSchema, type Backup } from '../core/types';
import { db, dataTables, type AquariumDB } from './db';
const names = [
  'usageLedger',
  'narrativeChanges',
  'organizationStates',
  'taskSnapshots',
  'expansionJobs',
  'observationConfigs',
  'observationCoverage',
  'backfillJobs',
  'evolutionRecords',
  'evolutionCursors',
  'worldReports',
  'reportCursors',
  'majorSchedules',
  'majorChains',
  'majorEvents',
  'notifications',
  'reactions',
  'readStates',
  'gifAssets',
  'resources',
  'contentJobs',
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
    for (const n of names) {
      const rows = await d.table(n).toArray();
      out[n] =
        n === 'resources'
          ? await Dexie.waitFor(
              Promise.all(
                rows.map(async (r) => {
                  const bytes = new Uint8Array(await r.blob.arrayBuffer());
                  let data = '';
                  for (let i = 0; i < bytes.length; i += 32768)
                    data += String.fromCharCode(...bytes.slice(i, i + 32768));
                  return {
                    id: r.id,
                    mime: r.mime,
                    size: r.size,
                    digest: r.digest,
                    data: btoa(data),
                  };
                }),
              ),
            )
          : rows;
    }
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
  b.narrativeChanges.forEach((r) =>
    assert(
      worlds.has(r.worldId) &&
        events.has(r.eventId) &&
        (r.entityKind === 'character' ? member(r.worldId, r.entityId) : groups.has(r.entityId)),
      '叙事后果',
    ),
  );
  b.organizationStates.forEach((r) =>
    assert(worlds.has(r.worldId) && groups.has(r.groupId) && events.has(r.eventId), '组织状态'),
  );
  b.expansionJobs.forEach((j) => assert(worlds.has(j.worldId), '世界扩展任务'));
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
        (x.kind === 'notes'
          ? x.participants.length === 1 &&
            x.participants[0] === 'user' &&
            !x.groupId &&
            !x.controlledId
          : x.participants.every((c) => member(x.worldId, c))) &&
        (!x.groupId ||
          b.groups.some((g) => g.id === x.groupId && g.worldIds.includes(x.worldId))) &&
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
  b.majorSchedules.forEach((s) =>
    assert(
      worlds.has(s.id) && s.nextDueAt > s.lastOccurredAt && s.plannedAt <= s.nextDueAt,
      '大型事件截止时间',
    ),
  );
  b.majorChains.forEach((c) =>
    assert(
      worlds.has(c.worldId) &&
        events.has(c.parentEventId) &&
        c.participantIds.every((id) => member(c.worldId, id)) &&
        (!c.groupId || groups.has(c.groupId)),
      '连锁事件',
    ),
  );
  b.majorEvents.forEach((m) =>
    assert(
      worlds.has(m.worldId) &&
        events.has(m.eventId) &&
        m.participantIds.every((id) => member(m.worldId, id)) &&
        m.groupIds.every((id) => groups.has(id)),
      '大型事件',
    ),
  );
  b.notifications.forEach((n) =>
    assert(
      b.majorEvents.some((m) => m.id === n.eventId && m.worldId === n.worldId),
      '事件通知',
    ),
  );
  const assets = new Set(b.gifAssets.map((a) => a.id)),
    resources = new Set(b.resources.map((r) => r.id)),
    messages = new Map(b.messages.map((m) => [m.id, m]));
  if (b.resources.reduce((n, r) => n + r.size, 0) > 100 * 1024 * 1024)
    throw new Error('资源备份超过100 MB');
  b.resources.forEach((r) => {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    } catch {
      throw new Error('资源编码损坏');
    }
    assert(bytes.length === r.size, '资源大小');
    validateGif(bytes);
  });
  b.gifAssets.forEach((a) =>
    assert(
      resources.has(a.resourceId) &&
        (a.scopeType === 'world'
          ? worlds.has(a.scopeId)
          : a.scopeType === 'group'
            ? groups.has(a.scopeId)
            : chars.has(a.scopeId)),
      '表情权限与资源',
    ),
  );
  b.reactions.forEach((r) => {
    const m = messages.get(r.messageId),
      c = m ? convs.get(m.conversationId) : undefined;
    assert(!!c && (r.actorId === 'user' || c.participants.includes(r.actorId)), '回应');
  });
  b.readStates.forEach((r) => {
    const m = messages.get(r.messageId),
      c = m ? convs.get(m.conversationId) : undefined;
    assert(
      !!c &&
        ((r.kind === 'observer' && r.readerId === 'observer') ||
          c.participants.includes(r.readerId)),
      '角色阅读记录',
    );
  });
  b.messages.forEach((m) => {
    const c = convs.get(m.conversationId)!;
    assert(!m.gifAssetId || assets.has(m.gifAssetId), '消息表情');
    assert(
      !m.replyToMessageId || messages.get(m.replyToMessageId)?.conversationId === m.conversationId,
      '回复引用',
    );
    assert(
      (m.mentionCharacterIds ?? []).every((id) => c.participants.includes(id)),
      '提及',
    );
  });
  b.contentJobs.forEach((j) =>
    assert(
      !j.snapshotId || b.taskSnapshots.some((s) => s.id === j.snapshotId),
      '生成任务提示词快照',
    ),
  );
  b.contentJobs.forEach((j) =>
    assert(
      events.has(j.event.id) &&
        worlds.has(j.worldId) &&
        (!j.conversation || convs.has(j.conversation.id)),
      '生成任务',
    ),
  );
  b.scenes.forEach((scene) => {
    const event = b.events.find((e) => e.id === scene.eventId);
    if (event) validateScene(scene, event, 1280, true, false);
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
  b.settings.forEach((x) =>
    assert(
      worlds.has(x.worldId) || (x.worldId === '' && b.worlds.every((w) => !!w.deletedAt)),
      '默认世界',
    ),
  );
  b.observationConfigs.forEach((c) =>
    assert(
      worlds.has(c.id) &&
        c.characterIds.every((id) => member(c.id, id)) &&
        c.groupIds.every((id) => b.groups.some((g) => g.id === id && g.worldIds.includes(c.id))) &&
        c.pairs.every((p) => p[0] !== p[1] && p.every((id) => member(c.id, id))),
      '观察配置',
    ),
  );
  b.observationCoverage.forEach((c) =>
    assert(worlds.has(c.worldId) && c.intervals.every(([a, e]) => a < e), '观察覆盖'),
  );
  b.backfillJobs.forEach((j) =>
    assert(
      worlds.has(j.worldId) &&
        j.start <= j.checkpoint &&
        j.checkpoint <= j.end &&
        j.characterIds.every((id) => member(j.worldId, id)),
      '回溯任务',
    ),
  );
  b.evolutionRecords.forEach((r) =>
    assert(
      member(r.worldId, r.characterId) &&
        r.sourceEventIds.every((id) =>
          b.events.some(
            (e) => e.id === id && e.worldId === r.worldId && e.participants.includes(r.characterId),
          ),
        ),
      '演化依据',
    ),
  );
  b.evolutionCursors.forEach((c) => assert(worlds.has(c.id), '演化检查点'));
  b.reportCursors.forEach((c) => assert(worlds.has(c.worldId), '报告检查点'));
  b.worldReports.forEach((r) =>
    assert(
      worlds.has(r.worldId) &&
        r.start < r.end &&
        r.sections.every((s) =>
          s.sourceIds.every((id) => r.sources.some((source) => source.id === id)),
        ),
      '报告引用',
    ),
  );
  b.worldReports.forEach((r) =>
    r.sources.forEach((source) =>
      assert(
        source.type === 'event'
          ? b.events.some((e) => e.id === source.id && e.worldId === r.worldId)
          : source.type === 'message'
            ? b.messages.some(
                (m) => m.id === source.id && convs.get(m.conversationId)?.worldId === r.worldId,
              )
            : source.type === 'scene'
              ? b.scenes.some((s) => s.id === source.id && s.worldId === r.worldId)
              : source.type === 'evolution'
                ? b.evolutionRecords.some((e) => e.id === source.id && e.worldId === r.worldId)
                : b.memories.some((m) => m.id === source.id && m.worldId === r.worldId),
        '报告原始事实',
      ),
    ),
  );

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
  for (const r of b.resources) {
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)),
        ),
      ),
      (n) => n.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== r.digest) throw new Error('GIF资源校验和不匹配');
  }
  await d.transaction('rw', d.tables, async () => {
    for (const n of names) {
      await d.table(n).clear();
      await d.table(n).bulkAdd(
        n === 'resources'
          ? b.resources.map(({ data, ...r }) => ({
              ...r,
              blob: new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
                type: r.mime,
              }),
            }))
          : b[n],
      );
    }
    await d.backfillJobs.toCollection().modify((j) => {
      if (j.status === 'running') j.status = 'pending';
    });
    await d.worldReports.toCollection().modify((r) => {
      if (r.status === 'generating') r.status = 'pending';
    });
    await d.contentJobs.toCollection().modify((j) => {
      if (j.status === 'running') j.status = 'pending';
      j.nextAttemptAt = 0;
    });
    await d.profiles.clear();
    await d.taskSnapshots.filter((s) => !s.id.startsWith('content:')).delete();
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
