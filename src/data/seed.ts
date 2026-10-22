import { realLocalDate } from '../core/calendar';
import { planSegment } from '../core/simulation';
import { db, type AquariumDB } from './db';
import { type Character, type AppSettings, HOUR } from '../core/types';
export const defaultSettings: AppSettings = {
  id: 'app',
  worldId: 'w-harbor',
  activity: 'standard',
  dailyRequests: 80,
  dailyTokens: 120000,
  dailyMessages: 160,
  recoveryBudget: 12,
  nickname: '观察员',
  userBio: '刚搬来海盐市的新朋友',
  onboarded: false,
  theme: 'light',
};
export function newCharacter(name = '未命名角色'): Character {
  return {
    id: crypto.randomUUID(),
    name,
    gender: '',
    entityMode: 'interactive',
    source: '原创',
    avatar: '',
    color: '#a9c2df',
    bio: '',
    personality: '温和，慢热，有自己的主见',
    style: '自然简短，不刻意总结',
    habits: '喜欢散步和音乐',
    tags: [],
    initiative: 0.5,
    initiationMode: 'interval',
    topicIntervalMinutes: 120,
    replyChance: 0.65,
    phoneHabit: 0.65,
    wake: 8,
    sleep: 23,
    busyStart: 9,
    busyEnd: 17,
  };
}
export async function seed(d: AquariumDB = db, now = Date.now()) {
  await d.transaction('rw', d.tables, async () => {
    if (await d.settings.get('app')) return;
    const characters = [
      {
        ...newCharacter('凪 夏生'),
        id: 'c-nagi',
        color: '#b9cadf',
        bio: '海盐大学建筑系二年级。随身带着速写本，正在记录这座城市的屋顶。',
        personality: '安静、敏锐，有一点不动声色的幽默',
        habits: '傍晚在海边画画，偶尔去旧唱片店',
        tags: ['速写本不离身', '慢热'],
        busyStart: 9,
        busyEnd: 16,
      },
      {
        ...newCharacter('森川 澪'),
        id: 'c-mio',
        color: '#efc5ad',
        bio: '独立乐队的键盘手，在白昼咖啡兼职。相信好喝的咖啡能拯救糟糕的一天。',
        personality: '直率、热情，偶尔嘴硬心软',
        habits: '练琴、做咖啡，收集奇怪的杯子',
        tags: ['键盘手', '咖啡续命'],
        initiative: 0.85,
        topicIntervalMinutes: 45,
        busyStart: 14,
        busyEnd: 18,
      },
      {
        ...newCharacter('白石 透'),
        id: 'c-toru',
        color: '#bfcdb0',
        bio: '旧书店的店员。总能从书架角落找出你正在寻找的那本书。',
        personality: '温柔、理性，喜欢用提问代替建议',
        habits: '读书、养植物，午后给朋友分享书摘',
        tags: ['书店店员', '绿植控'],
        initiative: 0.35,
        topicIntervalMinutes: 240,
      },
      {
        ...newCharacter('橘 由奈'),
        id: 'c-yuna',
        color: '#d7bbd9',
        bio: '摄影社的行动派。周末不是在赶海，就是在寻找下一个取景地。',
        personality: '好奇、随性，想到什么就去做',
        habits: '摄影、骑车，喜欢邀请朋友一起出门',
        tags: ['摄影社', '行动派'],
        initiative: 0.9,
        topicIntervalMinutes: 30,
        busyEnd: 15,
      },
      {
        ...newCharacter('雨宫 律'),
        id: 'c-ritsu',
        color: '#e4d294',
        bio: '乐队的鼓手，也是海盐电台深夜节目的常客。',
        personality: '懒散外表下很可靠，话不多但很会接梗',
        habits: '打鼓、夜跑，喜欢便利店关东煮',
        tags: ['鼓手', '夜猫子'],
        wake: 10,
        sleep: 2,
        busyStart: 14,
        busyEnd: 18,
      },
    ];
    await d.characters.bulkAdd(characters);
    await d.worlds.add({
      era: 'AD',
      calendarSystem: 'gregorian',
      initialDate: realLocalDate(now, 'Asia/Shanghai'),
      calendarAnchor: { tick: now, date: realLocalDate(now, 'Asia/Shanghai') },
      id: 'w-harbor',
      name: '海盐市 · 平行日常',
      description: '离海很近，离日常也很近。五个年轻人和一座慢慢醒来的海滨小城。',
      rules: '现代现实世界，无超自然能力。尊重角色边界，关系缓慢发展。',
      locations: ['白昼咖啡', '海盐大学', '旧书店', '海滨步道', '排练室'],
      timezone: 'Asia/Shanghai',
      tone: '轻松日常、温柔群像',
      color: '#d9ef69',
    });
    await d.memberships.bulkAdd(
      characters.map((c) => ({
        id: `w-harbor:${c.id}`,
        worldId: 'w-harbor',
        characterId: c.id,
        identity: c.bio,
        bioOverride: '',
        styleOverride: '',
      })),
    );
    await d.groups.bulkAdd([
      {
        id: 'g-cafe',
        name: '白昼集合点',
        description: '一杯咖啡的时间，什么都可以聊。',
        worldIds: ['w-harbor'],
        color: '#d9ef69',
      },
      {
        id: 'g-band',
        name: '晚潮乐队',
        description: '今天也在努力把音符拼在一起。',
        worldIds: ['w-harbor'],
        color: '#d7bbd9',
      },
    ]);
    await d.groupMembers.bulkAdd(
      characters
        .map((c) => ({
          id: `g-cafe:${c.id}`,
          groupId: 'g-cafe',
          worldId: 'w-harbor',
          characterId: c.id,
          nickname: c.name.split(' ')[1],
          role: '朋友',
        }))
        .concat(
          ['c-mio', 'c-ritsu'].map((characterId) => ({
            id: `g-band:${characterId}`,
            groupId: 'g-band',
            worldId: 'w-harbor',
            characterId,
            nickname: '',
            role: '乐队成员',
          })),
        ),
    );
    await d.relationships.bulkAdd(
      [
        ['c-nagi', 'c-mio', '老朋友', 72],
        ['c-mio', 'c-nagi', '老朋友', 78],
        ['c-mio', 'c-ritsu', '队友', 65],
        ['c-yuna', 'c-nagi', '同学', 58],
        ['c-toru', 'c-yuna', '朋友', 55],
      ].map(([from, to, label, closeness], i) => ({
        id: `r-${i}`,
        worldId: 'w-harbor',
        from: String(from),
        to: String(to),
        label: String(label),
        closeness: Number(closeness),
        trust: 65,
        familiarity: 70,
        stage: '熟悉',
        nickname: '',
        attitude: '自然相处',
        history: '在海盐市结识的朋友',
        locked: true,
        boundaries: '尊重个人空间，不擅自发展亲密关系',
      })),
    );
    await d.conversations.bulkAdd([
      {
        id: 'conv-cafe',
        worldId: 'w-harbor',
        groupId: 'g-cafe',
        name: '白昼集合点',
        kind: 'group',
        participants: characters.map((c) => c.id),
        createdAt: now - HOUR,
        lastAt: now - 300000,
      },
      {
        id: 'conv-nm',
        worldId: 'w-harbor',
        name: '夏生 & 澪',
        kind: 'direct',
        participants: ['c-nagi', 'c-mio'],
        createdAt: now - HOUR,
        lastAt: now - 600000,
      },
      {
        id: 'conv-band',
        worldId: 'w-harbor',
        groupId: 'g-band',
        name: '晚潮乐队',
        kind: 'group',
        participants: ['c-mio', 'c-ritsu'],
        createdAt: now - HOUR,
        lastAt: now - 1200000,
      },
    ]);
    const demo = [
      ['conv-cafe', 'c-yuna', '海边的光现在特别好。有人要出来走走吗？'],
      ['conv-cafe', 'c-toru', '我还在书店。替我看看今天的海吧。'],
      ['conv-cafe', 'c-nagi', '带了速写本。十分钟后到。'],
      ['conv-cafe', 'c-mio', '等我下班！先帮我留一片夕阳。'],
      ['conv-nm', 'c-nagi', '你上次说的那家唱片店，我找到了。'],
      ['conv-nm', 'c-mio', '真的？下次一起去。'],
      ['conv-band', 'c-ritsu', '鼓棒落在排练室了。'],
      ['conv-band', 'c-mio', '在我包里，明天带给你。'],
    ];
    const counts: Record<string, number> = {};
    await d.messages.bulkAdd(
      demo.map(([conversationId, senderId, text], i) => ({
        id: `demo-${i}`,
        conversationId,
        senderId,
        text,
        seq: (counts[conversationId] = (counts[conversationId] || 0) + 1),
        realAt: now,
        simAt: now - (10 - i) * 120000,
        source: 'demo' as const,
      })),
    );
    await d.checkpoints.add({
      id: 'w-harbor',
      simTime: now,
      realTime: now,
      seed: 88213,
      lastEventAt: now,
      nextAt: now + 300000,
      paused: true,
      speed: 30,
      timeMode: 'god',
      mode: 'demo',
      recoveryRequests: 0,
    });
    const w = (await d.worlds.get('w-harbor'))!;
    const cp = (await d.checkpoints.get('w-harbor'))!;
    const initial = planSegment(
      w,
      characters,
      await d.relationships.toArray(),
      { ...cp, simTime: now - HOUR },
      now,
    );
    await d.events.bulkAdd(initial.events);
    await d.states.bulkAdd(initial.states);
    await d.settings.add(defaultSettings);
  });
}
