import { restartNovel } from '../core/novel-types';
import { normalizeNovel } from '../core/novel';
import { ObservationConfigSchema } from '../core/focus-types';
import { clockTarget } from '../core/time';
import { foregroundStart } from '../core/clock-presence';
import { realLocalDate } from '../core/calendar';
import { z } from 'zod';
import { db, type AquariumDB } from './db';
import {
  BackgroundKnowledgeSchema,
  CharacterSchema,
  WorldSchema,
  GroupSchema,
  GroupMemberSchema,
  MembershipSchema,
  RelationshipSchema,
  uid,
  type World,
} from '../core/types';
import { newCharacter } from './seed';
import { draftCharacter, type CharacterDraft } from '../ai/drafts';
export const WorldPackageSchema = z.object({
  observation: ObservationConfigSchema.optional(),
  backgroundKnowledge: z.array(BackgroundKnowledgeSchema).default([]),
  format: z.literal('aquarium-world'),
  version: z.literal(1),
  world: WorldSchema,
  characters: z.array(CharacterSchema).max(500),
  groups: z.array(GroupSchema).max(100),
  memberships: z.array(MembershipSchema).max(500),
  groupMembers: z.array(GroupMemberSchema).max(5000),
  relationships: z.array(RelationshipSchema).max(10000),
});
export type WorldPackage = z.infer<typeof WorldPackageSchema>;
export function validateWorldPackage(input: unknown) {
  const p = WorldPackageSchema.parse(input);
  const chars = new Set(p.characters.map((c) => c.id)),
    groups = new Set(p.groups.map((g) => g.id));
  const assert = (v: boolean) => {
    if (!v) throw new Error('世界观包包含重复编号或无效成员引用');
  };
  assert(chars.size === p.characters.length && groups.size === p.groups.length);
  if (p.observation)
    assert(
      p.observation.id === p.world.id &&
        p.observation.characterIds.every((id) => chars.has(id)) &&
        p.observation.groupIds.every((id) => groups.has(id)) &&
        p.observation.pairs.every(
          (pair) => pair[0] !== pair[1] && pair.every((id) => chars.has(id)),
        ),
    );
  assert(p.memberships.every((m) => m.worldId === p.world.id && chars.has(m.characterId)));
  assert(p.characters.every((c) => p.memberships.some((m) => m.characterId === c.id)));
  assert(p.groups.every((g) => g.worldIds.includes(p.world.id)));
  assert(
    p.groupMembers.every(
      (m) => m.worldId === p.world.id && chars.has(m.characterId) && groups.has(m.groupId),
    ),
  );
  assert(
    p.relationships.every(
      (r) => r.worldId === p.world.id && chars.has(r.from) && chars.has(r.to) && r.from !== r.to,
    ),
  );
  assert(
    p.backgroundKnowledge.every(
      (k) =>
        k.worldId === p.world.id &&
        chars.has(k.characterId) &&
        (chars.has(k.entityId) || groups.has(k.entityId)),
    ),
  );
  return p;
}
export async function exportWorld(worldId: string, d: AquariumDB = db): Promise<WorldPackage> {
  return d.transaction(
    'r',
    [
      d.worlds,
      d.characters,
      d.groups,
      d.memberships,
      d.groupMembers,
      d.relationships,
      d.backgroundKnowledge,
      d.observationConfigs,
    ],
    async () => {
      const world = await d.worlds.get(worldId);
      if (!world) throw new Error('世界不存在');
      const memberships = await d.memberships.where('worldId').equals(worldId).toArray();
      return validateWorldPackage({
        observation: await d.observationConfigs.get(worldId),
        backgroundKnowledge: await d.backgroundKnowledge.where('worldId').equals(worldId).toArray(),
        format: 'aquarium-world',
        version: 1,
        world,
        memberships,
        characters: await d.characters
          .where('id')
          .anyOf(memberships.map((m) => m.characterId))
          .toArray(),
        groups: await d.groups.filter((g) => g.worldIds.includes(worldId)).toArray(),
        groupMembers: await d.groupMembers.where('worldId').equals(worldId).toArray(),
        relationships: await d.relationships.where('worldId').equals(worldId).toArray(),
      });
    },
  );
}
export async function createWorld(
  world: World,
  characterIds: string[] = [],
  groupIds: string[] = [],
  names: string[] = [],
  groupLines: string[] = [],
  d: AquariumDB = db,
  drafts: CharacterDraft[] = [],
  groupDescriptions: Record<string, string> = {},
) {
  const tick = Date.now();
  const parsed = WorldSchema.parse({
    ...normalizeNovel(world, undefined, tick),
    era: world.era ?? 'AD',
    calendarSystem: 'gregorian',
    initialDate: world.initialDate ?? realLocalDate(tick, world.timezone),
    calendarAnchor: { tick, date: world.initialDate ?? realLocalDate(tick, world.timezone) },
  });
  new Intl.DateTimeFormat('zh-CN', { timeZone: parsed.timezone });
  return d.transaction('rw', d.tables, async () => {
    if (await d.worlds.get(parsed.id)) throw new Error('此世界已存在，请用编辑入口修改');
    const chosenGroups = await d.groups.where('id').anyOf(groupIds).toArray();
    if (chosenGroups.length !== new Set(groupIds).size) throw new Error('团体不存在');
    const sourceMembers = await d.groupMembers.where('groupId').anyOf(groupIds).toArray();
    const ids = [...new Set([...characterIds, ...sourceMembers.map((m) => m.characterId)])];
    const existing = await d.characters.where('id').anyOf(ids).toArray();
    if (existing.length !== ids.length) throw new Error('角色不存在');
    const uniqueNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (uniqueNames.some((n) => n.length > 60) || uniqueNames.length + ids.length > 500)
      throw new Error('角色名称过长或一次导入超过 500 人');
    const added = uniqueNames.map((name) => {
      const draft = drafts.find((c) => c.name === name);
      return CharacterSchema.parse(draft ? draftCharacter(draft) : newCharacter(name));
    });
    const characters = [...existing, ...added];
    const newGroups = groupLines
      .filter((l) => l.trim())
      .map((line) => {
        const match = line.match(/^([^:：]+)[:：](.+)$/);
        if (!match) throw new Error('团体格式：摄影社：小夏、小澪（每行一个）');
        const memberNames = match[2]
          .split(/[、，,]/)
          .map((n) => n.trim())
          .filter(Boolean);
        const members = memberNames.map((name) => {
          const found = characters.filter((c) => c.name === name);
          if (found.length !== 1)
            throw new Error(`团体成员「${name}」不存在或重名，请先核对角色名单`);
          return found[0].id;
        });
        if (new Set(members).size < 2) throw new Error('团体至少需要两位不同角色');
        return { id: uid('group'), name: match[1].trim(), members: [...new Set(members)] };
      });
    await d.worlds.add(parsed);
    await d.characters.bulkAdd(added);
    await d.memberships.bulkAdd(
      characters.map((c) => ({
        id: uid('member'),
        worldId: parsed.id,
        characterId: c.id,
        identity: '',
        bioOverride: '',
        styleOverride: '',
      })),
    );
    for (const g of chosenGroups) {
      await d.groups.update(g.id, { worldIds: [...new Set([...g.worldIds, parsed.id])] });
      const members = [
        ...new Set(sourceMembers.filter((m) => m.groupId === g.id).map((m) => m.characterId)),
      ];
      await addGroupConversation(g.id, g.name, members, parsed.id, d);
    }
    for (const g of newGroups) {
      await d.groups.add({
        id: g.id,
        name: g.name,
        description: groupDescriptions[g.name] ?? '',
        color: '#d9ef69',
        worldIds: [parsed.id],
      });
      await addGroupConversation(g.id, g.name, g.members, parsed.id, d);
    }
    await d.observationConfigs.put({
      id: parsed.id,
      mode: 'selective',
      characterIds: characters.map((c) => c.id),
      groupIds: [...chosenGroups.map((g) => g.id), ...newGroups.map((g) => g.id)],
      pairs: [],
      updatedAt: Date.now(),
    });
    await addCheckpoint(parsed.id, d);
    await d.settings.update('app', { worldId: parsed.id });
    return parsed.id;
  });
}
async function addCheckpoint(worldId: string, d: AquariumDB) {
  const now = Date.now();
  const world = await d.worlds.get(worldId);
  if (world && !world.calendarAnchor)
    await d.worlds.update(worldId, {
      era: world.era ?? 'AD',
      calendarSystem: 'gregorian',
      initialDate: world.initialDate ?? realLocalDate(now, world.timezone),
      calendarAnchor: { tick: now, date: world.initialDate ?? realLocalDate(now, world.timezone) },
    });
  await d.checkpoints.add({
    id: worldId,
    simTime: world?.calendarAnchor?.tick ?? now,
    realTime: now,
    seed: 929,
    lastEventAt: world?.calendarAnchor?.tick ?? now,
    nextAt: now + 300000,
    paused: true,
    speed: 30,
    timeMode: 'god',
    mode: 'demo',
    recoveryRequests: 0,
  });
}
async function addGroupConversation(
  groupId: string,
  name: string,
  members: string[],
  worldId: string,
  d: AquariumDB,
) {
  await d.groupMembers.bulkAdd(
    members.map((characterId) => ({
      id: uid('gm'),
      groupId,
      worldId,
      characterId,
      nickname: '',
      role: '成员',
    })),
  );
  const group = await d.groups.get(groupId);
  const chars = await d.characters.where('id').anyOf(members).toArray();
  members = members.filter((id) => chars.some((c) => c.id === id && c.entityMode !== 'background'));
  if (group?.entityMode !== 'background' && members.length >= 2)
    await d.conversations.add({
      id: uid('conv'),
      worldId,
      groupId,
      name,
      kind: 'group',
      participants: members,
      createdAt: Date.now(),
      lastAt: 0,
    });
}
export async function importWorld(input: unknown, d: AquariumDB = db) {
  const p = validateWorldPackage(input);
  return d.transaction('rw', d.tables, async () => {
    const id = uid('world'),
      cIds = new Map(p.characters.map((c) => [c.id, uid('char')])),
      gIds = new Map(p.groups.map((g) => [g.id, uid('group')]));
    await d.worlds.add({
      ...p.world,
      novel: restartNovel(p.world.novel, Date.now()),
      novelHistory: undefined,
      id,
    });
    await d.characters.bulkAdd(p.characters.map((c) => ({ ...c, id: cIds.get(c.id)! })));
    await d.memberships.bulkAdd(
      p.memberships.map((m) => ({
        ...m,
        id: uid('member'),
        life: undefined,
        worldId: id,
        characterId: cIds.get(m.characterId)!,
      })),
    );
    await d.groups.bulkAdd(
      p.groups.map((g) => ({
        ...g,
        predecessorGroupId: g.predecessorGroupId ? gIds.get(g.predecessorGroupId) : undefined,
        id: gIds.get(g.id)!,
        worldIds: [id],
      })),
    );
    for (const g of p.groups) {
      const members = [
        ...new Set(
          p.groupMembers.filter((m) => m.groupId === g.id).map((m) => cIds.get(m.characterId)!),
        ),
      ];
      await addGroupConversation(gIds.get(g.id)!, g.name, members, id, d);
    }
    await d.relationships.bulkAdd(
      p.relationships.map((r) => ({
        ...r,
        id: uid('relation'),
        worldId: id,
        from: cIds.get(r.from)!,
        to: cIds.get(r.to)!,
      })),
    );
    await d.backgroundKnowledge.bulkAdd(
      p.backgroundKnowledge.map((k) => ({
        ...k,
        id: uid('knowledge'),
        worldId: id,
        characterId: cIds.get(k.characterId)!,
        entityId: cIds.get(k.entityId) ?? gIds.get(k.entityId)!,
      })),
    );
    if (p.observation)
      await d.observationConfigs.put({
        ...p.observation,
        id,
        characterIds: p.observation.characterIds.map((c) => cIds.get(c)!),
        groupIds: p.observation.groupIds.map((g) => gIds.get(g)!),
        pairs: p.observation.pairs.map(
          (pair) => [cIds.get(pair[0])!, cIds.get(pair[1])!] as [string, string],
        ),
        updatedAt: Date.now(),
      });
    await addCheckpoint(id, d);
    await d.settings.update('app', { worldId: id });
    return id;
  });
}

export async function saveGroupMembers(
  group: z.infer<typeof GroupSchema>,
  worldId: string,
  participantIds: string[],
  names: string[],
  drafts: CharacterDraft[],
  confirmedOutside: string[],
  d: AquariumDB = db,
) {
  const g = GroupSchema.parse(group);
  return d.transaction('rw', d.tables, async () => {
    if (!(await d.worlds.get(worldId))) throw new Error('世界不存在');
    const ids = [...new Set(participantIds)];
    const selected = await d.characters.where('id').anyOf(ids).toArray();
    if (selected.length !== ids.length) throw new Error('部分角色不存在');
    const memberships = await d.memberships.where('worldId').equals(worldId).toArray();
    const outside = ids.filter(
      (id) => !memberships.some((m) => !m.inactive && m.characterId === id),
    );
    if (outside.some((id) => !confirmedOutside.includes(id)))
      throw new Error('请确认世界外角色会同时加入世界观');
    const uniqueNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (uniqueNames.length > 50 || uniqueNames.some((n) => n.length > 60))
      throw new Error('一次新增角色最多 50 人，名字最多 60 字');
    if (uniqueNames.some((n) => selected.some((c) => c.name === n)))
      throw new Error('新增角色与所选成员重名');
    const added = uniqueNames.map((name) => {
      const draft = drafts.find((c) => c.name === name);
      return CharacterSchema.parse(draft ? draftCharacter(draft) : newCharacter(name));
    });
    const participants = [...ids, ...added.map((c) => c.id)];
    if ((g.entityMode !== 'background' && participants.length < 2) || participants.length > 50)
      throw new Error('团体需要 2～50 位成员');
    const conv = await d.conversations
      .where('groupId')
      .equals(g.id)
      .and((c) => c.worldId === worldId)
      .first();
    if (conv) {
      const old = await d.messages.where('conversationId').equals(conv.id).toArray();
      if (old.some((m) => m.senderId !== 'user' && !participants.includes(m.senderId)))
        throw new Error('有历史消息的成员无法移除，请创建新的团体');
    }
    await d.characters.bulkAdd(added);
    for (const id of outside) {
      const previous = memberships.find((m) => m.characterId === id);
      if (previous) await d.memberships.update(previous.id, { inactive: false });
    }
    await d.memberships.bulkAdd(
      [
        ...outside.filter((id) => !memberships.some((m) => m.characterId === id)),
        ...added.map((c) => c.id),
      ].map((characterId) => ({
        id: uid('member'),
        worldId,
        characterId,
        identity: '',
        bioOverride: '',
        styleOverride: '',
      })),
    );
    await d.groups.put({ ...g, worldIds: [...new Set([...g.worldIds, worldId])] });
    await d.groupMembers
      .where('groupId')
      .equals(g.id)
      .and((m) => m.worldId === worldId)
      .delete();
    await d.groupMembers.bulkAdd(
      participants.map((characterId) => ({
        id: uid('gm'),
        groupId: g.id,
        worldId,
        characterId,
        nickname: '',
        role: '成员',
      })),
    );
    const interactive = [...selected, ...added]
      .filter((c) => c.entityMode !== 'background')
      .map((c) => c.id);
    const historic = conv
      ? (await d.messages.where('conversationId').equals(conv.id).toArray())
          .filter((m) => m.senderId !== 'user')
          .map((m) => m.senderId)
      : [];
    const chatParticipants = [...new Set([...interactive, ...historic])];
    const cp = await d.checkpoints.get(worldId);
    const joinedAt = cp ? clockTarget(cp, Date.now(), foregroundStart()) : Date.now();
    if (conv)
      await d.conversations.update(conv.id, {
        participantJoinedAt: {
          ...conv.participantJoinedAt,
          ...Object.fromEntries(
            interactive.filter((id) => !conv.participants.includes(id)).map((id) => [id, joinedAt]),
          ),
        },
        name: conv.titleMode === 'custom' ? conv.name : g.name,
        participants: chatParticipants.length ? chatParticipants : conv.participants,
        controlledId:
          conv.controlledId && participants.includes(conv.controlledId)
            ? conv.controlledId
            : undefined,
      });
    else if (g.entityMode !== 'background' && interactive.length >= 2)
      await d.conversations.add({
        id: uid('conv'),
        worldId,
        groupId: g.id,
        name: g.name,
        kind: 'group',
        participants: interactive,
        createdAt: Date.now(),
        lastAt: 0,
      });
    return participants;
  });
}
