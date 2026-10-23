import { selectiveText } from './context';
import { z } from 'zod';
import { db, type AquariumDB } from '../data/db';
import { RelationshipSchema, uid, type Relationship } from '../core/types';
import { getPrompts, composePrompt } from './prompts';
import { budgetedCompletion, liveProvider } from './orchestrator';
import { parseStructuredJSON } from './structured';
import type { Provider } from './provider';
const Edge = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().max(100).default('相识'),
  closeness: z.number().min(0).max(100).default(30),
  trust: z.number().min(0).max(100).default(30),
  familiarity: z.number().min(0).max(100).default(30),
  nickname: z.string().max(500).default(''),
  attitude: z.string().max(1000).default(''),
  history: z.string().max(2000).default(''),
  boundaries: z.string().max(1000).default('遵守用户已确认设定'),
  stage: z.string().max(1000).default('关系建议，待确认'),
});
export async function relationshipDrafts(
  worldId: string,
  ids: string[],
  constraints: string,
  d: AquariumDB = db,
  provider?: Provider,
  signal?: AbortSignal,
) {
  const world = await d.worlds.get(worldId),
    members = await d.memberships.where('worldId').equals(worldId).toArray(),
    all = await d.characters.where('id').anyOf(ids).toArray(),
    groups = await d.groups.filter((g) => g.worldIds.includes(worldId)).toArray(),
    existing = await d.relationships.where('worldId').equals(worldId).toArray();
  if (
    !world ||
    world.deletedAt ||
    all.length !== new Set(ids).size ||
    !all.every((c) => !c.deletedAt && members.some((m) => m.characterId === c.id))
  )
    throw new Error('角色不属于该世界');
  const targets =
    ids.length === 1
      ? await d.characters
          .where('id')
          .anyOf(members.map((m) => m.characterId))
          .toArray()
      : all;
  const available = targets.filter((c) => !c.deletedAt);
  const aliases = new Map(available.map((c, i) => [c.id, `P${i + 1}`]));
  const resolve = (value: string) => {
    const key = value.trim();
    const exact = available.find((c) => c.id === key || aliases.get(c.id) === key);
    if (exact) return exact.id;
    const named = available.filter((c) => c.name === key);
    return named.length === 1 ? named[0].id : undefined;
  };
  const warnings: string[] = [];
  let validEndpoints = 0;
  const snapshot = await getPrompts(d),
    client = provider ?? (await liveProvider(d)),
    suggestions: Relationship[] = [];
  // Small directed source batches; cross-batch targets remain visible, so world-wide edges are possible.
  for (let start = 0; start < all.length; start += 4) {
    if (signal?.aborted) break;
    const sources = all.slice(start, start + 4);
    const r = await budgetedCompletion(
      d,
      client,
      composePrompt(
        'profile',
        snapshot,
        {
          world,
          relationships: existing.filter((e) => sources.some((c) => c.id === e.from)),
          input: {
            sources: sources.map((c) => ({
              id: aliases.get(c.id),
              characterId: c.id,
              name: c.name,
              source: c.source,
              bio: selectiveText(c.bio, 500),
              personality: selectiveText(c.personality, 250),
            })),
            targets: available.map((c) => ({
              id: aliases.get(c.id),
              characterId: c.id,
              name: c.name,
              source: c.source,
              bio: selectiveText(c.bio, 200),
            })),
            groups: groups.map((g) => ({ id: g.id, name: g.name, description: g.description })),
            constraints,
          },
        },
        '仅返回 JSON {"relationships":[{"from":"P1","to":"P2","label":"关系类型","closeness":30,"trust":30,"familiarity":30,"nickname":"称呼","attitude":"态度","history":"背景与共同经历建议"}]}。from/to 必须逐字复制本批 sources/targets 的 id 短编号（P1 等），不能填写姓名、团体或自行编造 ID。最多16条有向关系，from只能来源ID，to只能已给目标ID，双方感情不必相等；不生成自我关系，不覆盖已锁定关系。原作不确定信息与新共同经历都写明“推测/建议，尚未发生”，不得当作历史事实。',
      ),
      worldId,
      'profile',
      snapshot,
      signal,
      { outputBudget: 4000 },
    );
    const rows = z
      .object({ relationships: z.array(Edge).max(16) })
      .parse(parseStructuredJSON(r.content));
    for (const raw of rows.relationships) {
      const from = resolve(raw.from),
        to = resolve(raw.to);
      if (!from || !to || from === to || !sources.some((c) => c.id === from)) {
        warnings.push('已跳过一条无法唯一对应到本批角色的关系建议');
        continue;
      }
      const row = { ...raw, from, to };
      validEndpoints++;
      if (existing.some((e) => e.from === row.from && e.to === row.to && e.locked)) continue;
      if (suggestions.some((e) => e.from === row.from && e.to === row.to)) continue;
      suggestions.push(
        RelationshipSchema.parse({
          ...row,
          id: uid('relation'),
          worldId,
          locked: false,
          generationMetadata: { origin: 'ai', uncertain: true, at: Date.now() },
        }),
      );
    }
  }
  if (!validEndpoints && warnings.length)
    throw new Error('模型没有返回可用关系：端点必须对应所选角色短编号。请重试；未写入任何关系。');
  return Object.assign(suggestions, { warnings });
}
export async function acceptRelationships(rows: Relationship[], d: AquariumDB = db) {
  return d.transaction('rw', d.relationships, d.memberships, async () => {
    let count = 0;
    for (const row of rows) {
      const parsed = RelationshipSchema.parse(row),
        old = await d.relationships
          .where('[worldId+from+to]')
          .equals([row.worldId, row.from, row.to])
          .first();
      if (old?.locked) continue;
      const members = await d.memberships.where('worldId').equals(row.worldId).toArray();
      if (
        row.from === row.to ||
        ![row.from, row.to].every((id) => members.some((m) => m.characterId === id))
      )
        throw new Error('关系端点无效');
      await d.relationships.put({ ...parsed, id: old?.id ?? parsed.id });
      count++;
    }
    return count;
  });
}
