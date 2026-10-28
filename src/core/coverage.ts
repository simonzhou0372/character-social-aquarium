import type { AquariumDB } from '../data/db';
import { db } from '../data/db';
import { ordinaryLife } from './narrative';
import type { Membership, Relationship } from './types';
export interface CoverageRow {
  id: string;
  name: string;
  alive: boolean;
  messages: number;
  scenes: number;
  majors: number;
  relationships: number;
  groups: number;
  lastAt: number;
  score: number;
  deficit: number;
}
export interface CoverageReport {
  worldId: string;
  at: number;
  day: number;
  rows: CoverageRow[];
  byId: Map<string, CoverageRow>;
  totals: { characters: number; withStory: number; withoutStory: number; dead: number; neverSpoke: number };
  top: CoverageRow[];
  bottom: CoverageRow[];
}
const cache = new Map<string, { at: number; report: CoverageReport }>();
export function invalidateCoverage(worldId?: string) {
  if (worldId) cache.delete(worldId);
  else cache.clear();
}
/** Read-only social participation census. No model call; safe to run at every checkpoint. */
export async function computeCoverage(
  worldId: string,
  d: AquariumDB = db,
  at?: number,
  force = false,
): Promise<CoverageReport> {
  const key = worldId;
  const cached = cache.get(key);
  const stamp = at ?? Date.now();
  if (!force && cached && Math.abs(stamp - cached.at) < 2 * 3600000) return cached.report;
  const [memberships, groups, groupMembers, relationships, conversations, scenes, majors, world] =
    await Promise.all([
      d.memberships.where('worldId').equals(worldId).toArray(),
      d.groups.filter((g) => g.worldIds.includes(worldId)).toArray(),
      d.groupMembers.where('worldId').equals(worldId).toArray(),
      d.relationships.where('worldId').equals(worldId).toArray(),
      d.conversations.where('worldId').equals(worldId).toArray(),
      d.scenes.where('worldId').equals(worldId).toArray(),
      d.majorEvents.where('worldId').equals(worldId).toArray(),
      d.worlds.get(worldId),
    ]);
  const chars = await d.characters.bulkGet(memberships.map((m) => m.characterId));
  const convIds = new Set(conversations.map((c) => c.id));
  const messages =
    convIds.size && d.messages
      ? await d.messages.where('conversationId').anyOf([...convIds]).toArray()
      : [];
  const rows = new Map<string, CoverageRow>();
  const relCount = new Map<string, number>();
  for (const r of relationships) {
    relCount.set(r.from, (relCount.get(r.from) ?? 0) + 1);
    relCount.set(r.to, (relCount.get(r.to) ?? 0) + 1);
  }
  const groupCount = new Map<string, number>();
  for (const gm of groupMembers) groupCount.set(gm.characterId, (groupCount.get(gm.characterId) ?? 0) + 1);
  for (const m of memberships) {
    const c = chars.find((x) => x?.id === m.characterId);
    rows.set(m.characterId, {
      id: m.characterId,
      name: c?.name ?? m.characterId,
      alive: !m.inactive && ordinaryLife(m.life?.status),
      messages: 0,
      scenes: 0,
      majors: 0,
      relationships: relCount.get(m.characterId) ?? 0,
      groups: groupCount.get(m.characterId) ?? 0,
      lastAt: 0,
      score: 0,
      deficit: 0,
    });
  }
  for (const msg of messages) {
    const row = rows.get(msg.senderId);
    if (!row) continue;
    row.messages++;
    row.lastAt = Math.max(row.lastAt, msg.simAt);
  }
  for (const scene of scenes) {
    for (const id of scene.participants) {
      const row = rows.get(id);
      if (!row) continue;
      row.scenes++;
      row.lastAt = Math.max(row.lastAt, scene.start);
    }
  }
  for (const major of majors) {
    for (const id of major.participantIds) {
      const row = rows.get(id);
      if (!row) continue;
      row.majors++;
      row.lastAt = Math.max(row.lastAt, major.timestamp);
    }
  }
  const day = world?.novel?.startedAt
    ? Math.max(1, Math.floor(((at ?? world.novel.startedAt) - world.novel.startedAt) / 86400000) + 1)
    : 1;
  const target = 6 + day * 2;
  for (const row of rows.values()) {
    row.score = row.messages + row.scenes * 4 + row.majors * 6;
    row.deficit = Math.max(0, target - row.score);
  }
  const list = [...rows.values()];
  const alive = list.filter((r) => r.alive);
  const report: CoverageReport = {
    worldId,
    at: stamp,
    day,
    rows: list,
    byId: rows,
    totals: {
      characters: list.length,
      withStory: list.filter((r) => r.messages + r.scenes + r.majors > 0).length,
      withoutStory: list.filter((r) => r.messages + r.scenes + r.majors === 0).length,
      dead: list.filter((r) => !r.alive).length,
      neverSpoke: list.filter((r) => r.messages === 0).length,
    },
    top: [...list].sort((a, b) => b.score - a.score).slice(0, 12),
    bottom: [...alive].sort((a, b) => a.score - b.score || a.lastAt - b.lastAt).slice(0, 20),
  };
  cache.set(key, { at: stamp, report });
  return report;
}
export async function recordCoverageCheckpoint(
  worldId: string,
  d: AquariumDB = db,
  at?: number,
): Promise<CoverageReport> {
  return computeCoverage(worldId, d, at, true);
}
export function coverageMarkdown(report: CoverageReport) {
  const t = report.totals;
  return [
    `# Character Coverage · Day ${report.day}`,
    '',
    `- 角色：${t.characters}`,
    `- 有剧情记录：${t.withStory}`,
    `- 只有基础资料：${t.withoutStory}`,
    `- 已死亡：${t.dead}`,
    `- 从未发言：${t.neverSpoke}`,
    '',
    '## 活跃度最低（仍存活）',
    '',
    '| 角色 | 消息 | 场景 | 重大事件 | 关系 | 最后出现 |',
    '|---|---:|---:|---:|---:|---|',
    ...report.bottom.map(
      (r) =>
        `| ${r.name} | ${r.messages} | ${r.scenes} | ${r.majors} | ${r.relationships} | ${r.lastAt ? new Date(r.lastAt).toISOString() : '—'} |`,
    ),
    '',
    '## 活跃度最高',
    '',
    '| 角色 | 消息 | 场景 | 重大事件 |',
    '|---|---:|---:|---:|',
    ...report.top.map((r) => `| ${r.name} | ${r.messages} | ${r.scenes} | ${r.majors} |`),
  ].join('\n');
}
