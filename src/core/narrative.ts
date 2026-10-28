import Dexie from 'dexie';
import { db, type AquariumDB } from '../data/db';
import { uid, type Membership, type ActivityEvent, type World } from './types';
import {
  LifeRulesSchema,
  NarrativeProposalSchema,
  LifeStateSchema,
  lifeStates,
  groupStates,
  type NarrativeProposal,
  type LifeState,
} from './narrative-types';
export const ordinaryLife = (status?: string) =>
  !status || status === 'alive' || status === 'resurrected';
export const ordinaryGroup = (status?: string) =>
  !status || ['active', 'tension', 'reunited'].includes(status);
export async function narrativeStateAt(
  worldId: string,
  entityId: string,
  at: number,
  d: AquariumDB = db,
) {
  return d.narrativeChanges
    .where('[worldId+entityId+at]')
    .between([worldId, entityId, Dexie.minKey], [worldId, entityId, at], true, true)
    .reverse()
    .first();
}
export async function canLiveAt(worldId: string, id: string, at: number, d: AquariumDB = db) {
  const m = await d.memberships.where('[worldId+characterId]').equals([worldId, id]).first();
  if (!m || m.inactive) return false;
  if (!m.life) return true;
  if (m.life.since <= at) return ordinaryLife(m.life.status);
  const record = await narrativeStateAt(worldId, id, at, d);
  return ordinaryLife(record?.afterLife?.status);
}
export async function canGroupAt(worldId: string, id: string, at: number, d: AquariumDB = db) {
  const s = await d.organizationStates.get(worldId + ':' + id);
  if (!s || s.since <= at) return ordinaryGroup(s?.status);
  return ordinaryGroup((await narrativeStateAt(worldId, id, at, d))?.to);
}
/** Risk is local and stateful: crisis pressure, event scope, location and personal protection. */
export function lethalCandidates(
  world: World,
  event: ActivityEvent,
  members: Membership[],
  seed: number,
  options: { day?: number; pressure?: number } = {},
) {
  const rules = world.novel?.lifeRules;
  if (!world.novel?.enabled || !rules?.allowDeath) return [];
  const level = event.majorLevel ?? 'local';
  const hazardous =
    level === 'world' ||
    /险情|危险|事故|战斗|灾难|冲突|踩踏|火灾|爆炸|袭击|失控|坠|撞|病|伤/.test(event.description);
  if (!hazardous) return [];
  const day = options.day ?? Math.max(1, Math.floor((event.start - (world.novel.startedAt ?? event.start)) / 86400000) + 1);
  const pressure = options.pressure ?? Math.max(0, Math.min(1, (day - 1) / 6));
  const scopeBase = level === 'world' ? 0.42 : level === 'group' ? 0.26 : 0.15;
  const base =
    rules.risk === 'custom'
      ? Math.max(0, Math.min(1, rules.riskWeight))
      : Math.min(0.85, scopeBase * (1 + pressure * 1.45));
  const maxCount = level === 'world' ? 8 : level === 'group' ? 4 : 2;
  const scored = event.participants
    .map((id) => {
      const m = members.find((x) => x.characterId === id);
      if (!m || m.inactive || !ordinaryLife(m.life?.status) || m.allowAutomaticDeath !== true)
        return undefined;
      const h = (() => {
        let v = seed >>> 0;
        for (const c of id) v = (Math.imul(v, 31) + c.charCodeAt(0)) >>> 0;
        return v / 4294967296;
      })();
      // People already wounded/missing and people in the event's immediate location are more exposed.
      const health = m.life?.body === 'unknown' ? 0.05 : m.life?.status === 'missing' ? 0.02 : 0;
      const local = level === 'world' || event.location === '全球' ? 0 : 0.03;
      const personal = Math.min(0.55, base + health + local);
      return { id, risk: personal, roll: h };
    })
    .filter((x): x is { id: string; risk: number; roll: number } => !!x)
    .sort((a, b) => b.risk - a.risk || b.roll - a.roll);
  const selected = scored.filter((x) => x.roll < x.risk).slice(0, maxCount).map((x) => x.id);
  // A world-level catastrophe at high pressure always has at least one plausible victim,
  // but the victim is still chosen by location/health/risk, never by a global quota.
  if (!selected.length && level === 'world' && pressure > 0.55 && scored[0]) selected.push(scored[0].id);
  return selected;
}
export async function applyNarrativeConsequences(
  worldId: string,
  eventId: string,
  proposals: NarrativeProposal[],
  d: AquariumDB = db,
  confirmed = false,
) {
  return d.transaction('rw', d.tables, async () => {
    const world = await d.worlds.get(worldId),
      event = await d.events.get(eventId),
      major = await d.majorEvents.where('eventId').equals(eventId).first();
    if (
      !world?.novel?.enabled ||
      !event ||
      event.worldId !== worldId ||
      !major ||
      major.worldId !== worldId ||
      event.type !== 'major'
    )
      throw new Error('叙事后果必须引用本世界的小说重大事件');
    const unique = new Set<string>();
    for (const raw of proposals) {
      const p = NarrativeProposalSchema.parse(raw),
        key = p.entityKind + ':' + p.entityId,
        recordId = `narrative:${eventId}:${key}`;
      if (unique.has(key)) throw new Error('同一事件不能重复改变同一实体');
      unique.add(key);
      if (await d.narrativeChanges.get(recordId)) continue;
      if (!event.description.includes(p.evidence))
        throw new Error('后果依据不是主事件中的真实引文');
      const at = event.end;
      const cp = await d.checkpoints.get(worldId);
      if (confirmed && !cp?.paused) throw new Error('请先暂停世界，再确认长期状态变化');
      if (!cp || at > cp.simTime || major.status !== 'occurred')
        throw new Error('后果来源尚未真正发生');
      let from: string, beforeLife: LifeState | undefined, afterLife: LifeState | undefined;
      const successorGroupIds: string[] = [];
      if (p.entityKind === 'character') {
        if (!(lifeStates as readonly string[]).includes(p.to)) throw new Error('非法生命状态');
        const m = await d.memberships
          .where('[worldId+characterId]')
          .equals([worldId, p.entityId])
          .first();
        if (!m || m.inactive) throw new Error('人物不在当前世界');
        const rules = LifeRulesSchema.parse(world.novel.lifeRules ?? {});
        from = m.life?.status ?? 'alive';
        beforeLife = m.life;
        if (m.life && m.life.since > at) throw new Error('不能用较早事件覆盖较新生命状态');
        if (p.to === 'missing' && !event.participants.includes(p.entityId))
          throw new Error('失踪人物不属于来源事件');
        const transitions: Record<string, string[]> = {
          alive: ['missing', 'dead'],
          missing: ['alive', 'dead'],
          dead: ['resurrecting', 'resurrected'],
          resurrecting: ['dead', 'resurrected'],
          resurrected: ['missing', 'dead'],
        };
        if (!transitions[from].includes(p.to)) throw new Error('不允许的生命状态转换');
        if (p.to === 'dead' && !confirmed) {
          const character = await d.characters.get(p.entityId);
          const locked =
            /(全员|所有人|所有角色).{0,20}(必须存活|必须活着|不得死亡)/.test(world.novel.goal) ||
            world.novel.goal
              .split(/[。；\n]/)
              .some(
                (line) =>
                  !!character?.name &&
                  line.includes(character.name) &&
                  /(必须活着|必须存活|不得死亡|不能死|禁止死亡)/.test(line),
              );
          if (locked) throw new Error('死亡违反用户明确的存活目标约束');
        }
        if (p.to === 'dead') {
          if (
            !rules.allowDeath ||
            (!confirmed && m.allowAutomaticDeath !== true) ||
            !event.participants.includes(p.entityId)
          )
            throw new Error('世界或人物死亡保护拒绝该后果');
          if (!confirmed && !event.lethalCandidateIds?.includes(p.entityId))
            throw new Error('死亡缺少本地致死风险候选');
          const state = await d.states.get(`${worldId}:${p.entityId}`);
          const worldScope = event.majorLevel === 'world' || event.location === '全球';
          // A later planning tick may already have replaced the current state. The event's own
          // risk candidate list is the authoritative evidence that this person was exposed.
          const lethalAuthorized = event.type === 'major' && !!event.lethalCandidateIds?.includes(p.entityId);
          if (!state) throw new Error('死亡缺少人物当前状态');
          if (
            !worldScope &&
            !lethalAuthorized &&
            state.eventId !== eventId &&
            state.location !== event.location
          )
            throw new Error('死亡与人物所在位置或当前活动矛盾');
        }
        if (['resurrecting', 'resurrected'].includes(p.to)) {
          if (rules.resurrection === 'forbidden' || !rules.resurrectionRules.trim())
            throw new Error('本世界禁止复活或未配置复活规则');
          if (!p.ruleQuote?.trim() || !rules.resurrectionRules.includes(p.ruleQuote))
            throw new Error('复活缺少对应世界规则引文');
          if (!rules.resurrectionRequirements.every((rule) => event.description.includes(rule)))
            throw new Error('复活条件尚未在主事件中满足');
          if (
            p.to === 'resurrected' &&
            !confirmed &&
            (rules.resurrection === 'conditional' || !rules.resurrectionRequirements.length)
          )
            throw new Error('自然语言复活条件需要用户确认，不能由模型自行宣布满足');
        }
        if (p.spirit && !rules.spiritCommunication)
          throw new Error('世界没有开启明确的亡灵交流规则');
        afterLife = LifeStateSchema.parse({
          status: p.to,
          since: at,
          eventId,
          body: ['dead', 'resurrecting'].includes(p.to)
            ? 'dead'
            : p.to === 'missing'
              ? 'unknown'
              : 'living',
          consciousness: p.spirit || ordinaryLife(p.to) ? 'present' : 'unknown',
          canCommunicate: ordinaryLife(p.to) || !!p.spirit,
        });
        await d.memberships.update(m.id, { life: afterLife });
        if (p.to === 'dead') {
          // Scheduled content that has not actually happened must not continue as if the person were alive.
          const jobs = await d.contentJobs.where('worldId').equals(worldId).toArray();
          for (const job of jobs) {
            if (job.status === 'complete' || job.at <= at) continue;
            if (job.event.participants.includes(p.entityId) || job.speakerId === p.entityId) {
              await d.contentJobs.update(job.id, {
                status: 'failed',
                attempts: 3,
                error: '人物已确认死亡，预定内容取消；历史记录保留',
              });
              if (job.kind === 'major')
                await d.majorEvents
                  .where('eventId')
                  .equals(job.event.id)
                  .modify({ status: 'cancelled' });
            }
          }
        }
      } else {
        if (!world.novel.allowGroupChanges || !(groupStates as readonly string[]).includes(p.to))
          throw new Error('团体动态变化未启用或状态非法');
        const group = await d.groups.get(p.entityId),
          gm = await d.groupMembers
            .where('worldId')
            .equals(worldId)
            .and((m) => m.groupId === p.entityId)
            .toArray();
        if (
          !group?.worldIds.includes(worldId) ||
          gm.filter((m) => event.participants.includes(m.characterId)).length < 2
        )
          throw new Error('团体后果缺少本世界的共同参与者');
        const old = await d.organizationStates.get(`${worldId}:${p.entityId}`);
        from = old?.status ?? 'active';
        if (old && old.since > at) throw new Error('不能用过去事件覆盖当前组织状态');
        const transitions: Record<string, string[]> = {
          active: ['tension', 'fractured'],
          tension: ['active', 'fractured', 'reconciling'],
          fractured: ['disbanded', 'reconciling'],
          disbanded: ['reconciling'],
          reconciling: ['fractured', 'reunited'],
          reunited: ['tension', 'fractured'],
        };
        if (!transitions[from].includes(p.to)) throw new Error('团体状态变化缺少必要的过程');
        if (p.to === 'fractured' && from !== 'tension' && !/(冲突|决裂|争吵|背叛)/.test(p.evidence))
          throw new Error('决裂缺少冲突依据');
        if (
          ['reconciling', 'reunited'].includes(p.to) &&
          !/(和解|道歉|沟通|重组|合作|团聚)/.test(p.evidence)
        )
          throw new Error('和解缺少真实沟通过程');
        const memberIds = new Set<string>();
        for (const change of p.memberChanges) {
          const m = gm.find((m) => m.characterId === change.characterId);
          if (!m || memberIds.has(m.characterId)) throw new Error('离团或归队成员非法或重复');
          memberIds.add(m.characterId);
          if (change.action === 'rejoin' && !['reconciling', 'reunited', 'active'].includes(p.to))
            throw new Error('当前团体尚未恢复接纳成员');
          await d.groupMembers.update(m.id, {
            departedAt: change.action === 'leave' ? at : undefined,
          });
        }
        if (p.successors.length && !['fractured', 'disbanded'].includes(p.to))
          throw new Error('新组织只可由已分裂组织派生');
        for (const successor of p.successors) {
          if (
            new Set(successor.memberIds).size !== successor.memberIds.length ||
            successor.memberIds.some((id) => !gm.some((m) => m.characterId === id))
          )
            throw new Error('继承组织成员不属于原团体');
          const id = uid('group');
          successorGroupIds.push(id);
          await d.groups.add({
            id,
            predecessorGroupId: group.id,
            name: successor.name,
            description: successor.description,
            worldIds: [worldId],
            color: group.color,
          });
          for (const characterId of successor.memberIds)
            await d.groupMembers.add({
              id: uid('gm'),
              worldId,
              groupId: id,
              characterId,
              nickname: '',
              role: '成员',
            });
        }
        await d.organizationStates.put({
          id: `${worldId}:${p.entityId}`,
          worldId,
          groupId: p.entityId,
          status: p.to as (typeof groupStates)[number],
          since: at,
          eventId,
        });
        const members = await d.groupMembers
          .where('worldId')
          .equals(worldId)
          .and((m) => m.groupId === p.entityId && !m.departedAt)
          .toArray();
      }
      await d.worlds.update(worldId, {
        narrativeVersion: ((await d.worlds.get(worldId))?.narrativeVersion ?? 0) + 1,
      });
      await d.narrativeChanges.add({
        id: recordId,
        worldId,
        eventId,
        entityKind: p.entityKind,
        entityId: p.entityId,
        at,
        from,
        to: p.to,
        reason: p.reason,
        evidence: p.evidence,
        beforeLife,
        afterLife,
        memberChanges: p.memberChanges,
        successorGroupIds,
      });
      await d.notifications.put({
        id: 'notice:' + recordId,
        worldId,
        eventId: major.id,
        createdAt: Date.now(),
        recovery: false,
      });
      const latestMajor = (await d.majorEvents.get(major.id))!;
      await d.majorEvents.update(major.id, {
        consequences: [
          ...latestMajor.consequences,
          {
            kind: p.entityKind === 'character' ? ('life' as const) : ('organization' as const),
            from: p.entityId,
            description: `${from} → ${p.to}：${p.reason}`,
          },
        ].slice(-20),
      });
      await d.memories.put({
        id: 'memory:' + recordId,
        worldId,
        eventId,
        at,
        owners: event.participants,
        content: `${p.entityId}：${from} → ${p.to}。${p.reason}。依据：${p.evidence}`,
        keywords: [p.to],
        importance: 1,
        kind: 'episode',
      });
    }
  });
}

export async function assertConversationLife(
  c: import('./types').Conversation,
  at: number,
  d: AquariumDB = db,
) {
  if (c.groupId) {
    if (!(await canGroupAt(c.worldId, c.groupId, at, d)))
      throw new Error('团体已决裂、解散或正在和解，普通群聊暂停。');
    if (
      !(await Promise.all(c.participants.map((id) => actorAvailable(c, id, at, d)))).some(Boolean)
    )
      throw new Error('群聊没有可以参与的存活成员。');
    return;
  }
  for (const id of c.participants)
    if (!(await canLiveAt(c.worldId, id, at, d)))
      throw new Error('会话中存在死亡、失踪或复活中的人物；历史仍可查看。');
}
export async function actorAvailable(
  c: import('./types').Conversation,
  id: string,
  at: number,
  d: AquariumDB = db,
) {
  if (!c.participants.includes(id) || !(await canLiveAt(c.worldId, id, at, d))) return false;
  if (!c.groupId) return true;
  const member = await d.groupMembers
    .where('worldId')
    .equals(c.worldId)
    .and((m) => m.groupId === c.groupId && m.characterId === id)
    .first();
  if (!member) return false;
  const change = await d.narrativeChanges
    .where('[worldId+entityId+at]')
    .between([c.worldId, c.groupId, Dexie.minKey], [c.worldId, c.groupId, at], true, true)
    .reverse()
    .filter((r) => r.memberChanges.some((m) => m.characterId === id))
    .first();
  const action = change?.memberChanges.find((m) => m.characterId === id)?.action;
  return action ? action === 'rejoin' : !member.departedAt || member.departedAt > at;
}
export async function canParticipate(
  event: ActivityEvent,
  id: string,
  at: number,
  d: AquariumDB = db,
) {
  if (await canLiveAt(event.worldId, id, at, d)) return true;
  if (event.type !== 'major' || !event.spiritParticipantIds?.includes(id)) return false;
  const world = await d.worlds.get(event.worldId),
    m = await d.memberships.where('[worldId+characterId]').equals([event.worldId, id]).first();
  return (
    world?.novel?.lifeRules?.spiritCommunication === true &&
    m?.life?.status === 'dead' &&
    m.life.canCommunicate
  );
}
