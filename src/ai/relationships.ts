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
  if (!all.every((c) => members.some((m) => m.characterId === c.id)))
    throw new Error('角色不属于该世界');
  const targets =
    ids.length === 1
      ? await d.characters
          .where('id')
          .anyOf(members.map((m) => m.characterId))
          .toArray()
      : all;
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
              id: c.id,
              name: c.name,
              source: c.source,
              bio: selectiveText(c.bio, 500),
              personality: selectiveText(c.personality, 250),
            })),
            targets: targets.map((c) => ({
              id: c.id,
              name: c.name,
              source: c.source,
              bio: selectiveText(c.bio, 200),
            })),
            groups: groups.map((g) => ({ id: g.id, name: g.name, description: g.description })),
            constraints,
          },
        },
        '仅返回 JSON {"relationships":[{"from":"来源ID","to":"目标ID","label":"关系类型","closeness":30,"trust":30,"familiarity":30,"nickname":"称呼","attitude":"态度","history":"背景与共同经历建议"}]}。最多16条有向关系，from只能来源ID，to只能已给目标ID，双方感情不必相等；不生成自我关系，不覆盖已锁定关系。原作不确定信息与新共同经历都写明“推测/建议，尚未发生”，不得当作历史事实。',
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
    for (const row of rows.relationships) {
      if (
        row.from === row.to ||
        !sources.some((c) => c.id === row.from) ||
        !targets.some((c) => c.id === row.to)
      )
        throw new Error('关系草稿含非法端点');
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
  return suggestions;
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
