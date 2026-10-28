import { db, withWorldLock, type AquariumDB } from '../data/db';
import { DAY, uid, type Character } from './types';
import { EvolutionRecordSchema, evolutionFields, type EvolutionField } from './focus-types';
import { resolveObservation } from './selective-observation';
import { composePrompt, getPrompts } from '../ai/prompts';
import { budgetedCompletion } from '../ai/orchestrator';
import { parseStructuredJSON } from '../ai/structured';
import type { Provider } from '../ai/provider';
import { z } from 'zod';
const Values = z.union([z.number(), z.string().max(1200)]);
const Proposal = z.object({
  characterId: z.string(),
  field: z.enum(evolutionFields),
  newValue: Values,
  sourceEventIds: z.array(z.string()).min(1).max(8),
  reason: z.string().min(1).max(1500),
});
export async function applyEvolution(worldId: string, input: unknown, d: AquariumDB = db) {
  const p = Proposal.parse(input);
  return d.transaction(
    'rw',
    [d.worlds, d.memberships, d.characters, d.events, d.checkpoints, d.evolutionRecords],
    async () => {
      const world = await d.worlds.get(worldId);
      if (world?.deletedAt || !world?.evolutionSettings?.enabled)
        throw new Error('此世界关闭了人物演化');
      const m = await d.memberships
          .where('[worldId+characterId]')
          .equals([worldId, p.characterId])
          .first(),
        character = await d.characters.get(p.characterId);
      if (!m || m.inactive || !character || character.deletedAt || !m.evolutionFields?.includes(p.field))
        throw new Error('此字段已锁定或角色不属于此世界');
      const checkpoint = await d.checkpoints.get(worldId);
      const sources = await d.events.bulkGet(p.sourceEventIds);
      if (
        sources.some(
          (e) =>
            !e ||
            e.worldId !== worldId ||
            !e.participants.includes(p.characterId) ||
            e.status === 'cancelled' ||
            (checkpoint && e.end > checkpoint.simTime),
        )
      )
        throw new Error('演化依据缺失或不属于角色经历');
      const events = sources as NonNullable<(typeof sources)[number]>[];
      if (events.length < 2 && !events.some((e) => (e.importance ?? 0) >= 0.8))
        throw new Error('长期变化需要至少两段经历或一次明确重大事件');
      const previous = (m.evolved as Record<string, unknown> | undefined)?.[p.field] ?? (character as unknown as Record<string, unknown>)[p.field];
      if (
        p.field === 'initiative' &&
        (typeof p.newValue !== 'number' ||
          Math.abs(p.newValue - Number(previous)) > 0.1500001 ||
          p.newValue < 0 ||
          p.newValue > 1)
      )
        throw new Error('主动性每次演化最多变化0.15');
      if (p.field !== 'initiative' && (typeof p.newValue !== 'string' || !p.newValue.trim()))
        throw new Error('演化文本无效');
      if (p.newValue === previous) return undefined;
      const at = Math.max(...events.map((e) => e.end));
      const existing = await d.evolutionRecords
        .where('worldId')
        .equals(worldId)
        .and(
          (r) =>
            r.characterId === p.characterId &&
            r.field === p.field &&
            r.sourceEventIds.some((id) => p.sourceEventIds.includes(id)),
        )
        .first();
      if (existing) return existing.id;
      const prior = (
        await d.evolutionRecords
          .where('worldId')
          .equals(worldId)
          .and(
            (r) => r.characterId === p.characterId && r.field === p.field && r.status === 'applied',
          )
          .sortBy('at')
      ).at(-1);
      const record = EvolutionRecordSchema.parse({
        id: uid('evolution'),
        worldId,
        characterId: p.characterId,
        at,
        field: p.field,
        previousValue: previous,
        newValue: p.newValue,
        sourceEventIds: p.sourceEventIds,
        reason: p.reason,
        status: 'applied',
        dependsOn: prior?.id,
      });
      await d.evolutionRecords.add(record);
      await d.memberships.update(m.id, { evolved: { ...m.evolved, [p.field]: p.newValue } });
      return record.id;
    },
  );
}
export async function revertEvolution(recordId: string, cascade: boolean, d: AquariumDB = db) {
  return d.transaction('rw', d.evolutionRecords, d.memberships, async () => {
    const record = await d.evolutionRecords.get(recordId);
    if (!record || record.status === 'reverted') return;
    const records = await d.evolutionRecords
      .where('worldId')
      .equals(record.worldId)
      .and(
        (r) =>
          r.characterId === record.characterId &&
          r.field === record.field &&
          r.status === 'applied',
      )
      .sortBy('at');
    const affected = records.slice(records.findIndex((r) => r.id === record.id));
    if (affected.length > 1 && !cascade)
      throw new Error('此变化有后续依赖；需确认同时撤销后续同字段变化');
    const m = await d.memberships
      .where('[worldId+characterId]')
      .equals([record.worldId, record.characterId])
      .first();
    if (!m) return;
    const evolved = { ...m.evolved },
      current = evolved[record.field];
    if (current !== affected.at(-1)?.newValue)
      throw new Error('当前动态设定已被其他操作修改，不能直接覆盖');
    await d.memberships.update(m.id, {
      evolved: { ...evolved, [record.field]: record.previousValue },
    });
    for (const item of affected) await d.evolutionRecords.update(item.id, { status: 'reverted' });
  });
}
/** Daily, event-driven assessment; high-pressure worlds get rapid but evidence-bound change. */
export async function evaluateEvolution(worldId: string, d: AquariumDB = db, provider?: Provider) {
  return withWorldLock('evolution:' + worldId, async () => {
    const world = await d.worlds.get(worldId),
      cp = await d.checkpoints.get(worldId);
    if (world?.deletedAt || !world?.evolutionSettings?.enabled || !cp || cp.paused) return;
    const cursor = await d.evolutionCursors.get(worldId),
      since = cursor?.lastAt ?? world.novel?.startedAt ?? world.calendarAnchor?.tick ?? cp.simTime;
    if (cp.simTime - since < DAY) return;
    const scope = await resolveObservation(worldId, d);
    const events = await d.events
      .where('[worldId+start]')
      .between([worldId, since], [worldId, cp.simTime], true, false)
      .and((e) => (e.importance ?? 0) >= 0.62 && scope.allowsEvent(e))
      .toArray();
    const members = await d.memberships.where('worldId').equals(worldId).toArray();
    const alive = new Set(
      members.filter((m) => !m.inactive && (m.life?.status ?? 'alive') !== 'dead').map((m) => m.characterId),
    );
    const candidates = [...new Set(events.flatMap((e) => e.participants))].filter(
      (id) => scope.activeIds.has(id) && alive.has(id),
    );
    // Rotate away from whoever changed most recently, so coverage is not monopolised.
    const records = await d.evolutionRecords.where('worldId').equals(worldId).toArray();
    const lastChange = new Map<string, number>();
    for (const r of records) lastChange.set(r.characterId, Math.max(lastChange.get(r.characterId) ?? 0, r.at));
    candidates.sort((a, b) => (lastChange.get(a) ?? 0) - (lastChange.get(b) ?? 0));
    // Persist assessment cadence before network work, so failures cannot turn this into per-tick polling.
    await d.evolutionCursors.put({ id: worldId, lastAt: cp.simTime });
    const day = Math.max(1, Math.floor((cp.simTime - (world.novel?.startedAt ?? cp.simTime)) / DAY) + 1);
    const dailyCap = Math.max(1, Math.min(100, world.evolutionSettings.maxPerDay ?? 28));
    for (const id of candidates.slice(0, dailyCap)) {
      const membership = members.find((m) => m.characterId === id),
        character = await d.characters.get(id);
      if (!character || !membership?.evolutionFields?.length) continue;
      const evidence = events.filter((e) => e.participants.includes(id)).slice(-10);
      if (evidence.length < 2 && !evidence.some((e) => (e.importance ?? 0) >= 0.85)) continue;
      let proposal: unknown;
      if (provider) {
        const snap = await getPrompts(d);
        const response = await budgetedCompletion(
          d,
          provider,
          composePrompt(
            'evolution',
            snap,
            {
              world: {
                rules: world.rules,
                evolutionRules: world.evolutionSettings.rules,
                day,
                crisisPressure: Math.min(1, (day - 1) / 6),
              },
              character: {
                id,
                name: character.name,
                personality: character.personality,
                style: character.style,
                habits: character.habits,
                values: character.values,
                goal: character.goal,
                fear: character.fear,
                initiative: character.initiative,
                evolved: membership.evolved,
              },
              input: { allowedFields: membership.evolutionFields, evidence, day },
            },
            '仅返回 JSON {"proposal":null} 或 {"proposal":{"characterId":"ID","field":"允许的字段","newValue":"新值或主动性数值","sourceEventIds":["已有事件ID"],"reason":"变化依据"}}。这是极高压力末日社会：允许价值观崩溃、信念反转、目标彻底改变、从怯懦变勇敢、从善良变冷酷、从傲慢变谦卑、从理性变冲动、从孤僻变依赖；也允许人物在压力下异常稳定或反复矛盾。但每次变化必须由 evidence 中实际发生的事件支撑，写清触发过程与后续行为影响，不能只换形容词。initiative 每次变化不超过0.15；不得修改姓名、年龄、国籍、已发生历史与世界规则。不足以支持变化则 proposal 为 null。',
          ),
          worldId,
          'evolution',
          snap,
          undefined,
          { outputBudget: 2200 },
        );
        proposal = z
          .object({ proposal: Proposal.nullable() })
          .parse(parseStructuredJSON(response.content)).proposal;
      } else if (membership.evolutionFields.includes('initiative')) {
        const previous = membership.evolved?.initiative ?? character.initiative,
          negative = evidence.some((e) => /冲突|失败|争吵|死亡|背叛|灾难/.test(e.description));
        proposal = {
          characterId: id,
          field: 'initiative',
          newValue: Math.max(0, Math.min(1, previous + (negative ? -0.06 : 0.06))),
          sourceEventIds: evidence.map((e) => e.id),
          reason: negative
            ? '多次高压力事件中的挫折与失去，社交主动倾向发生可见变化。'
            : '多次重要共同经历，使社交主动倾向发生可见变化。',
        };
      }
      const latest = await d.checkpoints.get(worldId);
      if (latest?.paused || latest?.controlVersion !== cp.controlVersion) return;
      if (proposal) {
        const parsed = Proposal.parse(proposal);
        if (
          parsed.characterId !== id ||
          parsed.sourceEventIds.some((id) => !evidence.some((e) => e.id === id))
        )
          throw new Error('演化建议引用了未提供的人物或经历');
        try {
          await applyEvolution(worldId, parsed, d);
        } catch (e) {
          // One under-supported proposal must not abort the daily census for everyone else.
          console.warn('evolution skipped', parsed.characterId, String(e).slice(0, 160));
        }
      }
    }
    await d.evolutionCursors.put({ id: worldId, lastAt: cp.simTime });
  });
}
