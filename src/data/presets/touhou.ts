import { calibratePerson, calibrateEdge } from './touhou-calibration';
import { db, type AquariumDB } from '../db';
import { type Character, type World, type Group, type Relationship } from '../../core/types';
import { emptyReports } from '../../core/focus-types';
import { TOUHOU_CATALOG, TOUHOU_AS_OF, touhouSources } from './touhou-sources';
import { touhouPeople } from './touhou-characters';
import { touhouLegacyPeople } from './touhou-legacy';
import { touhouPlaces, touhouLegacyPlaces } from './touhou-geography';
import { touhouGroups, touhouLegacyGroups } from './touhou-groups';
import { touhouEdges, touhouLegacyEdges } from './touhou-relations';
import { touhouTraits } from './touhou-traits';
import type { CanonPerson, CanonPlace, CanonGroup, CanonEdge } from './touhou-model';

export const TOUHOU_WORLD_ID = 'w-touhou-windows';
export const TOUHOU_LEGACY_ID = 'w-touhou-pc98';
export const TOUHOU_PRESET_VERSION = 2;
const characterId = (key: string) => `th:${key}`;
const groupId = (key: string) => `th-group:${key}`;
const commonRules = `本预设是非官方整理的原作事实资料，不是官方新剧情。只使用资料已确认事实；不引用二次创作、商业衍生手游、同人漫画或网络梗补足设定。
未记载的种族、年龄、生日、亲属、恋爱、口癖、爱好和住所保持未知。同姓不推导血缘，同住不推导主仆或恋爱。种族及能力的不确定性保留；能力不等于无条件全知全能。
锁定关系只代表明确的有向事实。亲近、信任等数值只是应用调度参数，不是原作对感情的量化；不从数值推导新的关系事实。历史从属不自动代表现在仍从属。
地域有边界：地上、旧地狱、现在的地狱、冥界、天界、畜生界、月都、梦境和外界不可随意互相瞬移；不得凭空增加穿越权限。不得解除封印、复活已故人物或让行踪不明者无因回归。
角色只掌握实际知晓的信息，不读观察者资料库。辉夜与永琳的过去、华扇的真实身份、锦上京的幕后等不成为全体共同知识。梦中经历和原作不同路线不能强行合成唯一历史。
聊天界面是观察记录的表现形式，不证明原作角色拥有手机、网络、公司通勤或现代群聊。观测历及作息、活跃度为软件参数，不是原作纪年或固定日程。尚未生成的事件均未发生；新生成的记录一律是模拟内容，不是正史。
禁止把红魔馆爆炸、美铃恒常被飞刀惩罚、幽香固定施虐、蕾米莉亚毫无威严、琪露诺完全无判断力等二创模板当作设定。不得确认神绮与爱丽丝的母女关系、梅莉与紫的同一身份、堇子与莲子的确切家谱、封兽魑魅与鵺的血缘。`;

function buildCharacter(person: CanonPerson, legacy: boolean): Character {
  const vampire = person.species === '吸血鬼';
  const traits = legacy ? undefined : touhouTraits[person.key];
  const knownSources = [
    ...new Set([person.source, ...(person.sources ?? []), ...(traits?.sources ?? [])]),
  ];
  return {
    id: characterId(person.key),
    name: person.name,
    gender: '',
    source: `东方Project · ${touhouSources[person.source].title}`,
    avatar: '',
    color: legacy ? '#c9bddb' : '#c8d4b6',
    entityMode: person.background ? 'background' : 'interactive',
    bio: `【已确认资料摘要】种族：${person.species}。能力／表现：${person.ability}。${person.fact}${person.notes ? `\n【范围与不确定性】${person.notes}` : ''}`,
    personality:
      person.traits ??
      traits?.traits ??
      '未在本条中归纳原作性格。仅按已确认身份及具体经历表达，不套用二创人格模板。',
    style:
      '不编造固定口癖、粉丝昵称或二创名台词；未确认的语言细节使用自然措辞，身份和知识边界保持稳定。',
    habits:
      '本条未确认的嗜好与日常作息不作为原作事实。活动起点用于调度，不保证是唯一或已确认住所。',
    tags: ['东方Project', legacy ? 'PC-98旧作' : 'Windows及官方书籍', person.species].slice(0, 20),
    initiative: 0.5,
    initiationMode: 'interval',
    topicIntervalMinutes: 180,
    replyChance: 0.65,
    phoneHabit: 0.6,
    wake: vampire ? 18 : 8,
    sleep: vampire ? 6 : 23,
    busyStart: 0,
    busyEnd: 0,
    locationAccess: {
      home: person.site,
      usual: [...new Set([person.site, ...(person.usual ?? [])])],
    },
    provenance: {
      catalogId: TOUHOU_CATALOG,
      sourceIds: knownSources,
      continuity: legacy ? 'pc98' : person.background ? 'reference' : 'windows',
      note: '资料为事实摘要，不是完整剧本；空白性别不推定。作息、活跃度和活动起点仅是调度参数。头像默认使用程序绘图，可在素材入口由用户自选下载并查看原图出处。',
    },
  };
}

export function buildTouhouPreset(legacy: boolean, now: number, version = TOUHOU_PRESET_VERSION) {
  const id = legacy ? TOUHOU_LEGACY_ID : TOUHOU_WORLD_ID;
  const people: CanonPerson[] = legacy ? touhouLegacyPeople : touhouPeople;
  const places: CanonPlace[] = legacy ? touhouLegacyPlaces : touhouPlaces;
  const circles: CanonGroup[] = legacy ? touhouLegacyGroups : touhouGroups;
  const edges: CanonEdge[] = legacy ? touhouLegacyEdges : touhouEdges;
  const date = { year: 1, month: 1, day: 1, hour: 9, minute: 0 };
  const characters = people.map((p) =>
    version >= 2 ? calibratePerson(p, buildCharacter(p, legacy)) : buildCharacter(p, legacy),
  );
  const world: World = {
    id,
    name: legacy ? '东方Project · PC-98旧作档案' : '东方Project · 幻想乡原设资料',
    description: legacy
      ? '灵异传至怪绮谈的独立档案。旧作人物、地点与关系保留，不自动与后作连续性合并。'
      : '收录红魔乡至锦上京、黄昏合作作与主要官方书籍的角色、地点和有出处的关系；秘封、月都与已故人物保留边界。',
    rules:
      commonRules +
      (legacy
        ? '\n这是 PC-98 旧作独立观察档案，不断言旧作与 Windows 完全无关，也不自动将后作能力、人物与经历注入旧作。少量缺乏对话的人物只保留背景资料。'
        : '\n以各条有出处的稳定身份与关系为资料范围，不给不同作品事件强行指定唯一当下日期。PC-98 档案另存世界；秘封音乐CD的未来外界不与堇子的时代自动合并。'),
    locations: places.map((p) => p.name),
    locationDetails: places,
    era: '观测历',
    calendarSystem: 'gregorian',
    initialDate: date,
    calendarAnchor: { tick: now, date },
    timezone: 'Asia/Shanghai',
    tone: '遵守原作事实与秘密边界的观察模拟；生成内容不是官方正史',
    color: legacy ? '#cab7d5' : '#d9ef69',
    evolutionSettings: { enabled: false, rules: '不自动改写原设身份、性格或有出处的锁定关系。' },
    reportSettings: { ...emptyReports },
    presetVersion: version,
    provenance: {
      catalogId: TOUHOU_CATALOG,
      continuity: legacy ? 'pc98' : 'windows',
      sourceIds: legacy
        ? ['th01', 'th02', 'th03', 'th03manual', 'th04', 'th05']
        : Object.keys(touhouSources).filter((key) => !/^th0[1-5]/.test(key)),
      note: `资料整理日期 ${TOUHOU_AS_OF}。非官方原设资料预设，不是官方授权新作。包含剧情相关信息；无原作图像、音乐、剧本或结局全文。不能保证穷尽全部连载和匿名角色，未核对内容不补写。`,
    },
  };
  const groups: Group[] = circles.map((g) => ({
    id: groupId(g.key),
    name: g.name,
    worldIds: [id],
    color: world.color,
    entityMode: g.background || g.kind === '观察分组' ? 'background' : 'interactive',
    description: `【${g.kind}】${g.description}${g.kind === '观察分组' ? ' 此为资料整理分组，默认不自动创建群聊，不代表原作存在同名社团。' : ''}`,
    provenance: {
      catalogId: TOUHOU_CATALOG,
      sourceIds: [g.source],
      continuity: legacy ? 'pc98' : 'windows',
      note: `${g.kind}；成员角色原设分别保留，不从同组推定亲密关系。`,
    },
  }));
  const relationships: Relationship[] = edges.map((r) => ({
    id: `th-edge:${legacy ? 'old' : 'win'}:${r.from}:${r.to}`,
    worldId: id,
    from: characterId(r.from),
    to: characterId(r.to),
    label: r.label,
    closeness: 50,
    trust: 50,
    familiarity: 50,
    stage: '有出处的关系；数值只是软件调度参数',
    nickname: '',
    attitude: '不由数值推断未确认感情',
    history: r.fact,
    locked: true,
    boundaries: '不擅自改变血缘、主从、师徒或历史事实，不推定恋爱。已故、失踪和过去时态保留。',
    provenance: {
      catalogId: TOUHOU_CATALOG,
      sourceIds: [r.source],
      continuity: legacy ? 'pc98' : 'windows',
      note: '有向原设资料摘要；不补对方心理，不将观察者资料自动共享。',
    },
  }));
  return {
    world,
    characters,
    groups,
    relationships:
      version >= 2 ? relationships.map((r, i) => calibrateEdge(edges[i], r)) : relationships,
    memberships: characters.map((c) => ({
      id: `${id}:${c.id}`,
      worldId: id,
      characterId: c.id,
      identity: c.bio,
      bioOverride: '',
      styleOverride: '',
      evolutionFields: [],
    })),
    groupMembers: circles.flatMap((g) =>
      g.members.map(([key, role]) => ({
        id: `${id}:${groupId(g.key)}:${characterId(key)}`,
        worldId: id,
        groupId: groupId(g.key),
        characterId: characterId(key),
        role,
        nickname: '',
      })),
    ),
  };
}

/** Install once per browser; never overwrite edited presets or resurrect recycled/purged ones. */
export async function ensureTouhouPresets(d: AquariumDB = db, now = Date.now()) {
  await d.transaction('rw', d.tables, async () => {
    const settings = await d.settings.get('app');
    if (!settings || settings.installedPresets?.[TOUHOU_CATALOG]) return;
    for (const legacy of [false, true]) {
      const preset = buildTouhouPreset(legacy, now),
        id = preset.world.id;
      if (await d.worlds.get(id)) continue;
      await d.worlds.add(preset.world);
      await d.characters.bulkAdd(preset.characters);
      await d.memberships.bulkAdd(preset.memberships);
      await d.groups.bulkAdd(preset.groups);
      await d.groupMembers.bulkAdd(preset.groupMembers);
      await d.relationships.bulkAdd(preset.relationships);
      // No synthetic messages, events, memories or invented common knowledge are seeded.
      await d.checkpoints.add({
        id,
        simTime: now,
        realTime: now,
        clockAnchor: { simTime: now, realTime: now },
        seed: 524287,
        lastEventAt: now,
        nextAt: now + 300000,
        paused: true,
        speed: 1,
        timeMode: 'god',
        mode: 'live',
        recoveryRequests: 0,
      });
      await d.observationConfigs.put({
        id,
        mode: 'selective',
        characterIds: legacy
          ? [characterId('old-reimu'), characterId('old-marisa')]
          : [characterId('reimu'), characterId('marisa')],
        groupIds: [],
        pairs: [],
        updatedAt: now,
      });
    }
    await d.settings.update('app', {
      installedPresets: { ...settings.installedPresets, [TOUHOU_CATALOG]: TOUHOU_PRESET_VERSION },
    });
  });
}
