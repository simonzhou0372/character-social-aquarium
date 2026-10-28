import { canParticipate, lethalCandidates } from '../src/core/narrative';
import { dialogueContext } from '../src/ai/orchestrator';
import { it, expect } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { DAY, HOUR, type ActivityEvent } from '../src/core/types';
import { NovelSchema } from '../src/core/novel-types';
import { LifeRulesSchema, type NarrativeProposal } from '../src/core/narrative-types';
import {
  applyNarrativeConsequences,
  canLiveAt,
  canGroupAt,
  assertConversationLife,
} from '../src/core/narrative';
import { resolveObservation } from '../src/core/selective-observation';
import { generateDialogue } from '../src/ai/orchestrator';
import { MockProvider } from '../src/ai/provider';
import { defaultPrompts } from '../src/ai/prompts';
import { exportBackup, importBackup, validateBackup } from '../src/data/backup';
import { rewindWorld } from '../src/core/time';
const NOW = Date.parse('2026-10-28T00:00:00Z'),
  W = 'w-harbor',
  ACTOR = 'c-nagi';
async function fixture() {
  const d = new AquariumDB('narrative-' + crypto.randomUUID());
  await seed(d, NOW);
  await d.worlds.update(W, {
    novel: NovelSchema.parse({
      enabled: true,
      goal: '经历危险后，幸存者重新理解彼此',
      allowGroupChanges: true,
      lifeRules: LifeRulesSchema.parse({
        allowDeath: true,
        resurrection: 'conditional',
        resurrectionRules: '在灯塔完成归魂仪式才可以复活',
        resurrectionRequirements: ['灯塔', '归魂仪式'],
      }),
    }),
  });
  await d.memberships
    .where('[worldId+characterId]')
    .equals([W, ACTOR])
    .modify({ allowAutomaticDeath: true });
  await d.checkpoints.update(W, { simTime: NOW + 10 * DAY, paused: true });
  return d;
}
async function event(
  d: AquariumDB,
  id: string,
  description: string,
  at = NOW,
): Promise<ActivityEvent> {
  const e: ActivityEvent = {
    id,
    worldId: W,
    start: at,
    end: at + HOUR,
    type: 'major',
    participants: [ACTOR, 'c-mio'],
    location: '灯塔',
    description,
    phone: 0.8,
    status: 'completed',
    lethalCandidateIds: [ACTOR],
    lethalReason: '危险事故',
  };
  await d.events.put(e);
  await d.majorEvents.put({
    id,
    eventId: id,
    worldId: W,
    title: id,
    timestamp: at,
    participantIds: e.participants,
    groupIds: ['g-cafe'],
    importance: 1,
    status: 'occurred',
    type: 'hazard',
    description,
    consequences: [],
  });
  await d.states.put({
    id: W + ':' + ACTOR,
    worldId: W,
    characterId: ACTOR,
    eventId: id,
    activity: '共同应对险情',
    location: e.location,
    phone: 0.8,
    mood: 0,
    lastAction: 0,
    lastPhone: 0,
  });
  return e;
}
function proposal(
  to: string,
  evidence: string,
  kind: 'character' | 'group' = 'character',
): NarrativeProposal {
  return {
    entityKind: kind,
    entityId: kind === 'character' ? ACTOR : 'g-cafe',
    to,
    reason: '真实事件引发长期后果',
    evidence,
    memberChanges: [],
    successors: [],
  };
}
it('death stops normal scheduling, dialogue and phone participation, retaining records and world isolation', async () => {
  const d = await fixture();
  try {
    const e = await event(d, 'fatal', '险情中伤势恶化，确认死亡。');
    const old = await d.messages.count();
    await applyNarrativeConsequences(W, e.id, [proposal('dead', '伤势恶化，确认死亡')], d);
    expect(await canLiveAt(W, ACTOR, e.end, d)).toBe(false);
    expect(await canLiveAt(W, ACTOR, e.start, d)).toBe(true);
    expect((await resolveObservation(W, d)).activeIds.has(ACTOR)).toBe(false);
    const c = (await d.conversations.toArray()).find(
      (c) => c.kind === 'direct' && c.participants.includes(ACTOR),
    )!;
    const p = new MockProvider();
    await expect(generateDialogue(d, c, ACTOR, e.end + 1, defaultPrompts(), p)).rejects.toThrow(
      '死亡',
    );
    expect(p.calls).toHaveLength(0);
    expect(await d.messages.count()).toBe(old);
    await d.memberships.put({
      id: 'other-member',
      worldId: 'other',
      characterId: ACTOR,
      identity: '',
      bioOverride: '',
      styleOverride: '',
    });
    expect(await canLiveAt('other', ACTOR, e.end, d)).toBe(true);
    expect(await d.narrativeChanges.count()).toBe(1);
    await applyNarrativeConsequences(W, e.id, [proposal('dead', '伤势恶化，确认死亡')], d);
    expect(await d.narrativeChanges.count()).toBe(1);
  } finally {
    await d.delete();
  }
});
it('protects old characters and rejects unplanned or unsupported deaths atomically', async () => {
  const d = await fixture();
  try {
    const e = await event(d, 'protected', '发生致命事故，确认死亡。');
    await d.memberships
      .where('[worldId+characterId]')
      .equals([W, ACTOR])
      .modify({ allowAutomaticDeath: false });
    await expect(
      applyNarrativeConsequences(W, e.id, [proposal('dead', '发生致命事故')], d),
    ).rejects.toThrow('保护');
    expect(await d.narrativeChanges.count()).toBe(0);
    await d.memberships
      .where('[worldId+characterId]')
      .equals([W, ACTOR])
      .modify({ allowAutomaticDeath: true });
    await d.events.update(e.id, { lethalCandidateIds: [] });
    await expect(
      applyNarrativeConsequences(W, e.id, [proposal('dead', '发生致命事故')], d),
    ).rejects.toThrow('候选');
    expect(await canLiveAt(W, ACTOR, e.end, d)).toBe(true);
  } finally {
    await d.delete();
  }
});
it('distinguishes missing, confirmed death, conditional resurrection and original identity', async () => {
  const d = await fixture();
  try {
    let e = await event(d, 'missing', '众人搜寻无果，暂时下落不明。');
    await applyNarrativeConsequences(W, e.id, [proposal('missing', '搜寻无果，暂时下落不明')], d);
    expect(
      (await d.memberships.where('[worldId+characterId]').equals([W, ACTOR]).first())?.life?.status,
    ).toBe('missing');
    e = await event(d, 'death', '救援失败，确认死亡。', NOW + DAY);
    await applyNarrativeConsequences(W, e.id, [proposal('dead', '救援失败，确认死亡')], d);
    e = await event(d, 'ritual', '亲友在灯塔完成归魂仪式，确认原身份归来。', NOW + 2 * DAY);
    const r = { ...proposal('resurrected', '在灯塔完成归魂仪式'), ruleQuote: '完成归魂仪式' };
    await expect(applyNarrativeConsequences(W, e.id, [r], d)).rejects.toThrow('用户确认');
    await applyNarrativeConsequences(W, e.id, [r], d, true);
    expect(await canLiveAt(W, ACTOR, e.end, d)).toBe(true);
    expect(await d.characters.get(ACTOR)).toBeDefined();
    expect(await d.narrativeChanges.count()).toBe(3);
    const backup = validateBackup(await exportBackup(d));
    await importBackup(backup, d);
    expect(await d.narrativeChanges.count()).toBe(3);
  } finally {
    await d.delete();
  }
});
it('forbidden resurrection cannot be bypassed by a user-confirmed outcome', async () => {
  const d = await fixture();
  try {
    let e = await event(d, 'fatal', '致命事故，确认死亡。');
    await applyNarrativeConsequences(W, e.id, [proposal('dead', '致命事故，确认死亡')], d);
    const w = (await d.worlds.get(W))!;
    await d.worlds.update(W, {
      novel: { ...w.novel!, lifeRules: { ...w.novel!.lifeRules!, resurrection: 'forbidden' } },
    });
    e = await event(d, 'false-revival', '在灯塔完成归魂仪式。', NOW + DAY);
    await expect(
      applyNarrativeConsequences(
        W,
        e.id,
        [{ ...proposal('resurrected', '在灯塔完成归魂仪式'), ruleQuote: '完成归魂仪式' }],
        d,
        true,
      ),
    ).rejects.toThrow('禁止复活');
    expect(await canLiveAt(W, ACTOR, e.end, d)).toBe(false);
  } finally {
    await d.delete();
  }
});
it('fracture and reconciliation change activity without deleting group, members or messages', async () => {
  const d = await fixture();
  try {
    let e = await event(d, 'fracture', '成员争吵导致正式决裂。');
    await applyNarrativeConsequences(
      W,
      e.id,
      [
        {
          ...proposal('fractured', '成员争吵导致正式决裂', 'group'),
          memberChanges: [{ characterId: ACTOR, action: 'leave' }],
          successors: [{ name: '新的咖啡角', description: '决裂后独立的组合', memberIds: [ACTOR] }],
        },
      ],
      d,
    );
    expect(await canGroupAt(W, 'g-cafe', e.end, d)).toBe(false);
    expect(await d.groups.get('g-cafe')).toBeDefined();
    expect(
      (await d.groups.filter((g) => g.predecessorGroupId === 'g-cafe').first())?.worldIds,
    ).toEqual([W]);
    e = await event(d, 'too-soon', '双方沟通并道歉。', NOW + DAY);
    await expect(
      applyNarrativeConsequences(W, e.id, [proposal('reunited', '双方沟通并道歉', 'group')], d),
    ).rejects.toThrow('过程');
    await applyNarrativeConsequences(
      W,
      e.id,
      [proposal('reconciling', '双方沟通并道歉', 'group')],
      d,
    );
    e = await event(d, 'reunited', '双方沟通决定重组并重新合作。', NOW + 2 * DAY);
    await applyNarrativeConsequences(
      W,
      e.id,
      [
        {
          ...proposal('reunited', '沟通决定重组并重新合作', 'group'),
          memberChanges: [{ characterId: ACTOR, action: 'rejoin' }],
        },
      ],
      d,
    );
    expect(await canGroupAt(W, 'g-cafe', e.end, d)).toBe(true);
    expect(
      (
        await d.groupMembers
          .where('worldId')
          .equals(W)
          .and((m) => m.characterId === ACTOR && m.groupId === 'g-cafe')
          .first()
      )?.departedAt,
    ).toBeUndefined();
    const fork = (await rewindWorld(W, NOW + DAY / 2, d))!;
    const historicalMember = await d.groupMembers
      .where('worldId')
      .equals(fork)
      .and((m) => m.groupId === 'g-cafe' && m.characterId === ACTOR)
      .first();
    expect(historicalMember?.departedAt).toBe(NOW + HOUR);
    const early = (await rewindWorld(W, NOW + HOUR / 2, d))!;
    const successor = await d.groups.filter((g) => g.predecessorGroupId === 'g-cafe').first();
    expect(successor?.worldIds).not.toContain(early);
    expect(
      await d.groupMembers
        .where('worldId')
        .equals(early)
        .and((m) => m.groupId === successor?.id)
        .count(),
    ).toBe(0);
  } finally {
    await d.delete();
  }
});

it('revival preserves pre-death memories while hiding messages sent during death', async () => {
  const d = await fixture();
  try {
    let e = await event(d, 'death-gap', '致命事故，确认死亡。');
    await applyNarrativeConsequences(W, e.id, [proposal('dead', '致命事故，确认死亡')], d);
    const c = (await d.conversations.get('conv-cafe'))!;
    await d.messages.put({
      id: 'gap-secret',
      conversationId: c.id,
      senderId: 'c-mio',
      text: '死亡期间不应自动知道的秘密',
      simAt: NOW + 2 * HOUR,
      realAt: NOW,
      seq: 999,
      source: 'ai',
    });
    e = await event(d, 'return-gap', '在灯塔完成归魂仪式，确认归来。', NOW + DAY);
    await applyNarrativeConsequences(
      W,
      e.id,
      [{ ...proposal('resurrected', '在灯塔完成归魂仪式'), ruleQuote: '完成归魂仪式' }],
      d,
      true,
    );
    const context = await dialogueContext(d, c, ACTOR, e.end + 1);
    expect(JSON.stringify(context.history)).not.toContain('死亡期间不应自动知道的秘密');
  } finally {
    await d.delete();
  }
});
it('a spirit requires a special major event and never enters ordinary life', async () => {
  const d = await fixture();
  try {
    const w = (await d.worlds.get(W))!;
    await d.worlds.update(W, {
      novel: { ...w.novel!, lifeRules: { ...w.novel!.lifeRules!, spiritCommunication: true } },
    });
    let e = await event(d, 'spirit-death', '致命事故，确认死亡，灵魂依照规则存在。');
    await applyNarrativeConsequences(
      W,
      e.id,
      [{ ...proposal('dead', '致命事故，确认死亡'), spirit: true }],
      d,
    );
    e = await event(d, 'spirit-contact', '亡灵依照世界规则向亲友传达消息。', NOW + DAY);
    expect(await canParticipate(e, ACTOR, e.end, d)).toBe(false);
    e.spiritParticipantIds = [ACTOR];
    expect(await canParticipate(e, ACTOR, e.end, d)).toBe(true);
    expect(await canLiveAt(W, ACTOR, e.end, d)).toBe(false);
    expect((await resolveObservation(W, d)).activeIds.has(ACTOR)).toBe(false);
  } finally {
    await d.delete();
  }
});
it('only locally dangerous events and unprotected characters become lethal candidates', async () => {
  const d = await fixture();
  try {
    const w = (await d.worlds.get(W))!;
    w.rules = '在末日灾难中求生';
    w.novel!.lifeRules = { ...w.novel!.lifeRules!, risk: 'custom', riskWeight: 1 };
    const e = await event(d, 'risk', '发生一次险情，结果尚待确认。');
    const members = await d.memberships.where('worldId').equals(W).toArray();
    expect(lethalCandidates(w, e, members, 42)).toEqual([ACTOR]);
    expect(lethalCandidates(w, { ...e, description: '收到演出邀请' }, members, 42)).toEqual([]);
    expect(
      lethalCandidates(
        w,
        e,
        members.map((m) => ({ ...m, allowAutomaticDeath: false })),
        42,
      ),
    ).toEqual([]);
  } finally {
    await d.delete();
  }
});
it('past timeline branches copy only historical life and group consequences with remapped event IDs', async () => {
  const d = await fixture();
  try {
    let e = await event(d, 'branch-death', '致命事故，确认死亡。');
    await applyNarrativeConsequences(W, e.id, [proposal('dead', '致命事故，确认死亡')], d);
    e = await event(d, 'branch-revival', '在灯塔完成归魂仪式，确认归来。', NOW + 2 * DAY);
    await applyNarrativeConsequences(
      W,
      e.id,
      [{ ...proposal('resurrected', '在灯塔完成归魂仪式'), ruleQuote: '完成归魂仪式' }],
      d,
      true,
    );
    const id = await rewindWorld(W, NOW + DAY, d);
    expect(id).toBeTruthy();
    const m = await d.memberships.where('[worldId+characterId]').equals([id!, ACTOR]).first();
    expect(m?.life?.status).toBe('dead');
    expect(m?.life?.eventId).not.toBe('branch-death');
    const changed = await d.narrativeChanges.where('worldId').equals(id!).toArray();
    expect(changed).toHaveLength(1);
    expect(changed[0].eventId).toBe(m?.life?.eventId);
    validateBackup(await exportBackup(d));
  } finally {
    await d.delete();
  }
});
it('commits a director death proposal, story node, memories and ledger outcome as one event', async () => {
  const { generateMajor, applyMajor } = await import('../src/ai/major-events');
  const d = await fixture();
  try {
    const e = await event(d, 'director-fatal', '灯塔发生险情，救援正在进行。');
    await d.majorEvents.update(e.id, { status: 'contentPending' });
    const provider = new MockProvider({
      title: '灯塔救援的结果',
      description: '险情中伤势恶化，确认死亡。幸存者记下了救援经过。',
      followUp: '幸存者商议如何面对失去同伴的生活。',
      narrative: [proposal('dead', '伤势恶化，确认死亡')],
      story: {
        stage: 'development',
        conditions: [
          { id: 'understand', description: '幸存者理解彼此', evidence: [] },
          { id: 'live', description: '幸存者找到继续生活的方向', evidence: [] },
        ],
        unresolved: ['如何面对失去同伴'],
        milestone: '救援结果成为幸存者共同经历',
      },
    });
    const job = {
      id: 'director-job',
      worldId: W,
      event: e,
      snapshot: defaultPrompts(NOW),
      attempts: 0,
    } as any;
    const result = await generateMajor(d, job, provider);
    await applyMajor(d, job, result!);
    expect(
      (await d.memberships.where('[worldId+characterId]').equals([W, ACTOR]).first())?.life?.status,
    ).toBe('dead');
    expect((await d.worlds.get(W))?.novel?.milestones[0].eventId).toBe(e.id);
    expect((await d.majorEvents.get(e.id))?.consequences.some((c) => c.kind === 'life')).toBe(true);
    expect((await d.usageLedger.toArray())[0]).toMatchObject({
      events: 1,
      validationStatus: 'accepted',
      task: 'novel',
    });
    expect(await d.memories.filter((m) => m.eventId === e.id).count()).toBeGreaterThanOrEqual(2);
    await applyMajor(d, job, result!);
    expect(await d.narrativeChanges.count()).toBe(1);
    expect((await d.usageLedger.toArray())[0].events).toBe(1);
  } finally {
    await d.delete();
  }
});
