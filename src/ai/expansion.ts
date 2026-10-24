import { db, withWorldLock, type AquariumDB } from '../data/db';
import {
  ExpansionJobSchema,
  ExpansionCharacterSchema,
  ExpansionGroupSchema,
  type ExpansionJob,
} from '../core/expansion-types';
import { uid, CharacterSchema, GroupSchema } from '../core/types';
import { getPrompts, composePrompt } from './prompts';
import { budgetedCompletion, liveProvider } from './orchestrator';
import { parseStructuredJSON, completedField } from './structured';
import { newCharacter } from '../data/seed';
import type { Provider } from './provider';
export const normalizedName = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·・.（()）_\-]/g, '');
const canonicalAliases = [
  ['博丽灵梦', '博麗霊夢', 'Reimu Hakurei', 'Hakurei Reimu'],
  ['雾雨魔理沙', '霧雨魔理沙', 'Marisa Kirisame', 'Kirisame Marisa'],
  ['蕾米莉亚·斯卡蕾特', 'レミリア・スカーレット', 'Remilia Scarlet'],
  ['十六夜咲夜', 'Sakuya Izayoi'],
  ['帕秋莉·诺蕾姬', 'パチュリー・ノーレッジ', 'Patchouli Knowledge'],
  ['爱丽丝·玛格特洛依德', 'アリス・マーガトロイド', 'Alice Margatroid'],
  ['琪露诺', 'チルノ', 'Cirno'],
  ['八云紫', '八雲紫', 'Yukari Yakumo'],
];
export function possibleMatches(
  name: string,
  aliases: string[],
  characters: { id: string; name: string; aliases?: string[] }[],
) {
  const names = new Set([name, ...aliases].map(normalizedName));
  for (const family of canonicalAliases)
    if (family.some((n) => names.has(normalizedName(n))))
      family.forEach((n) => names.add(normalizedName(n)));
  return characters.filter((c) =>
    [c.name, ...(c.aliases ?? [])].some((n) => names.has(normalizedName(n))),
  );
}
export async function createExpansion(
  worldId: string,
  constraints: string,
  target: number,
  d: AquariumDB = db,
) {
  const w = await d.worlds.get(worldId);
  if (!w || w.deletedAt) throw new Error('世界不可用');
  const job = ExpansionJobSchema.parse({
    id: uid('expand'),
    worldId,
    constraints,
    target,
    characters: [],
    groups: [],
    status: 'draft',
    snapshot: await getPrompts(d),
    createdAt: Date.now(),
  });
  await d.expansionJobs.add(job);
  return job;
}
export async function runExpansion(
  id: string,
  d: AquariumDB = db,
  provider?: Provider,
  signal?: AbortSignal,
) {
  return withWorldLock('expansion:' + id, async () => {
    let job = await d.expansionJobs.get(id);
    if (!job || job.status === 'applied') return;
    await d.expansionJobs.update(id, { status: 'generating', error: undefined });
    try {
      const client = provider ?? (await liveProvider(d));
      // This job uses one immutable prompt snapshot across every batch and retry.
      while (job.characters.length < job.target) {
        if (signal?.aborted) throw new Error('已取消，完整批次保留，可继续');
        const world = await d.worlds.get(job.worldId);
        if (!world || world.deletedAt) throw new Error('世界不可用');
        const members = await d.memberships.where('worldId').equals(job.worldId).toArray();
        const pool = await d.characters.filter((c) => !c.deletedAt).toArray();
        const groups = await d.groups
          .filter((g) => !g.deletedAt && g.worldIds.includes(job!.worldId))
          .toArray();
        const count = Math.min(5, job.target - job.characters.length);
        const response = await budgetedCompletion(
          d,
          client,
          composePrompt(
            'expansion',
            job.snapshot,
            {
              world: { name: world.name, rules: world.rules, description: world.description },
              input: {
                constraints: job.constraints,
                count,
                existingWorldNames: pool
                  .filter((c) => members.some((m) => m.characterId === c.id))
                  .map((c) => c.name),
                globalPoolNames: pool.map((c) => c.name),
                groups: groups.map((g) => ({
                  name: g.name,
                  description: g.description.slice(0, 120),
                })),
                previous: job.characters.map((c) => c.name),
              },
            },
            `只返回 JSON {"characters":[{"name":"姓名","source":"来源","aliases":[],"bio":"事实和不确定信息","personality":"具体性格","style":"说话习惯","habits":"行为"}],"groups":[{"name":"团体名","description":"介绍","memberNames":["姓名"]}]}。本批最多${count}人，每人每字段简短，不重复previous，不改已有世界。不要一次输出全部人数；团体可引用已存在角色或草稿角色。`,
          ),
          job.worldId,
          'expansion',
          job.snapshot,
          signal,
          { outputBudget: 5000 },
        );
        let raw: any;
        try {
          raw = parseStructuredJSON(response.content);
        } catch {
          raw = {
            characters: completedField(response.content, 'characters'),
            groups: completedField(response.content, 'groups'),
          };
        }
        const accepted: ExpansionJob['characters'] = [];
        for (const row of (Array.isArray(raw.characters) ? raw.characters : []).slice(0, count)) {
          const parsed = ExpansionCharacterSchema.safeParse(row);
          if (
            parsed.success &&
            !job.characters.some(
              (c) => normalizedName(c.name) === normalizedName(parsed.data.name),
            ) &&
            !accepted.some((c) => normalizedName(c.name) === normalizedName(parsed.data.name))
          )
            accepted.push(parsed.data);
        }
        if (!accepted.length) throw new Error('本批未获得有效新人物。之前的草稿已保留，可继续。');
        const addedGroups = (Array.isArray(raw.groups) ? raw.groups : []).flatMap((g: unknown) => {
          const parsed = ExpansionGroupSchema.safeParse(g);
          return parsed.success ? [parsed.data] : [];
        });
        job = {
          ...job,
          characters: [...job.characters, ...accepted],
          groups: [
            ...job.groups,
            ...addedGroups.filter(
              (g: ExpansionJob['groups'][number]) =>
                !job!.groups.some((old) => normalizedName(old.name) === normalizedName(g.name)),
            ),
          ],
          status: 'generating',
        };
        const current = await d.expansionJobs.get(id);
        if (!current || current.status === 'cancelled') return;
        await d.expansionJobs.put(job);
      }
      await d.expansionJobs.update(id, { status: 'draft' });
    } catch (e) {
      await d.expansionJobs.update(id, {
        status: signal?.aborted ? 'cancelled' : 'draft',
        error: String(e),
      });
    }
  });
}
export async function acceptExpansion(id: string, d: AquariumDB = db) {
  return d.transaction('rw', d.tables, async () => {
    const j = await d.expansionJobs.get(id);
    if (!j || j.status === 'applied' || j.status === 'generating') throw new Error('草稿不可应用');
    const world = await d.worlds.get(j.worldId);
    if (!world || world.deletedAt) throw new Error('世界不可用');
    const pool = await d.characters.filter((c) => !c.deletedAt).toArray(),
      nameIds = new Map<string, string>();
    const members = await d.memberships.where('worldId').equals(j.worldId).toArray();
    for (const m of members) {
      const c = pool.find((c) => c.id === m.characterId);
      if (c) {
        nameIds.set(c.name, c.id);
        for (const alias of c.aliases ?? []) nameIds.set(alias, c.id);
      }
    }
    const newIds: string[] = [];
    for (const [index, row] of j.characters.entries()) {
      const matches = possibleMatches(row.name, row.aliases, pool),
        decision = j.decisions[String(index)];
      if (matches.length && !decision)
        throw new Error(`${row.name} 可能重复，请确认使用已有、合并、独立创建或跳过`);
      if (decision?.action === 'skip') continue;
      let characterId: string;
      if (decision?.action === 'use' || decision?.action === 'merge') {
        const c = pool.find((c) => c.id === decision.characterId);
        if (!c) throw new Error('选中的已有角色不可用');
        characterId = c.id;
      } else {
        const c = CharacterSchema.parse({ ...newCharacter(row.name), ...row });
        await d.characters.add(c);
        pool.push(c);
        characterId = c.id;
        newIds.push(c.id);
      }
      const old = await d.memberships
        .where('[worldId+characterId]')
        .equals([j.worldId, characterId])
        .first();
      await d.memberships.put({
        ...old,
        id: old?.id ?? uid('member'),
        worldId: j.worldId,
        characterId,
        inactive: false,
        identity: old?.identity ?? '',
        bioOverride: decision?.action === 'merge' ? row.bio : (old?.bioOverride ?? ''),
        styleOverride: decision?.action === 'merge' ? row.style : (old?.styleOverride ?? ''),
      });
      nameIds.set(row.name, characterId);
      row.aliases.forEach((a) => nameIds.set(a, characterId));
    }
    for (const row of j.groups) {
      const ids = [...new Set(row.memberNames.map((n) => nameIds.get(n)))];
      if (ids.some((id) => !id) || ids.length < 2)
        throw new Error(`团体 ${row.name} 含未确认成员，请修正或删除该团体草稿`);
      const existing = await d.groups
        .filter(
          (g) =>
            !g.deletedAt &&
            g.worldIds.includes(j.worldId) &&
            normalizedName(g.name) === normalizedName(row.name),
        )
        .first();
      if (existing) throw new Error(`团体 ${row.name} 已存在，请修改名称或删除重复草稿`);
      const group = GroupSchema.parse({
        id: uid('group'),
        name: row.name,
        description: row.description,
        worldIds: [j.worldId],
        color: world.color,
      });
      await d.groups.add(group);
      await d.groupMembers.bulkAdd(
        (ids as string[]).map((characterId) => ({
          id: uid('gm'),
          worldId: j.worldId,
          groupId: group.id,
          characterId,
          nickname: '',
          role: '成员',
        })),
      );
      await d.conversations.add({
        id: uid('conv'),
        worldId: j.worldId,
        groupId: group.id,
        name: group.name,
        kind: 'group',
        participants: ids as string[],
        createdAt: Date.now(),
        lastAt: 0,
      });
    }
    await d.expansionJobs.update(id, { status: 'applied' });
    return newIds;
  });
}
