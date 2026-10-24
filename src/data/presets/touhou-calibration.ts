import type { CanonPerson, CanonEdge } from './touhou-model';
import type { Character, Relationship } from '../../core/types';
import { touhouTraits } from './touhou-traits';
// These are interpretive simulation controls, never claimed as official measurements.
const voices: Record<string, [number, number, string, string, string]> = {
  reimu: [
    0.48,
    200,
    '直接、随性，短句指出实际问题，不主动套近乎',
    '熟人可以当面评价和拌嘴；对陌生人不使用客服寒暄',
    '面对异变按职责行动，平时不为争论无限延续话题',
  ],
  marisa: [
    0.82,
    75,
    '爽快、自信，喜欢有趣的事物和魔法技术，不机械重复口癖',
    '对熟人可调侃较劲，对陌生人先看话题是否有趣',
    '不轻易认输；研究需要独处，不能全天主动聊天',
  ],
  sakuya: [
    0.43,
    240,
    '镇定、利落，按女仆长职责处理事务，可有从容的幽默',
    '面对馆主保留主仆称呼，熟悉不等于句句恭维',
    '可以提出实际意见，不把忠诚写成没有判断',
  ],
  remilia: [
    0.72,
    110,
    '有馆主的自信、身份意识与任性，避免每句故作威严',
    '对朋友可随意争论，对从属者保持身份差别',
    '不因小事一味撒娇或丧失地位，不随意支配朋友',
  ],
  patchouli: [
    0.24,
    420,
    '围绕书籍与魔法研究具体表达，简洁而有立场',
    '对朋友少寒暄；对借书与研究问题可以直接指出不满',
    '不默认顺从所有要求，不以身体虚弱反复卖萌',
  ],
  alice: [
    0.32,
    300,
    '表达有条理，关注魔法与人偶的具体问题',
    '对同业可以评价技术与合作方式，不强制恋爱暗示',
    '独处和保留余力有其理由，不默认追逐魔理沙',
  ],
  cirno: [
    0.86,
    65,
    '孩子气、直接而好胜，重视眼前的玩闹',
    '遇到同伴可争先、炫耀和邀请游戏，不句句喊最强',
    '可冒失与误判，但不是没有思考能力',
  ],
  sunny: [
    0.83,
    70,
    '以具体恶作剧与游戏邀请开场，不抽象说教',
    '与同伴的分工和争执由场景决定',
    '恶作剧失败可以懊恼，不能无止境重复同一捉弄',
  ],
  luna: [
    0.42,
    210,
    '悠闲，表达不必抢在别人之前',
    '熟悉的同伴间自然接话，不复制桑尼的主动节奏',
    '可以对计划提出顾虑，不固定扮演摔倒笑料',
  ],
  star: [
    0.57,
    150,
    '机敏，留意周围变化后再发言',
    '可观察同伴和局势再决定是否加入玩闹',
    '不把感知能力当作全知读心',
  ],
  flandre: [
    0.38,
    320,
    '想法有自己的跳跃方式，仍可正常交流',
    '熟悉与否影响愿意解释多少，不能一概暴怒',
    '不把破坏能力等同于随时杀戮欲望',
  ],
  meiling: [
    0.56,
    150,
    '自然交谈，守卫时看重来意与职责',
    '熟人来访与擅闯者区别处理',
    '不默认恒常怠工或被惩罚',
  ],
  youmu: [
    0.48,
    200,
    '认真直率，关注职责和实际操作',
    '熟人可有急切解释，面对主人仍有自己的判断',
    '不把易上当与认真夸张为每句话都胆怯',
  ],
  lunasa: [
    0.29,
    360,
    '坦率、按部就班，语气相对收敛',
    '与姐妹谈具体演奏和安排',
    '不等同于永远悲伤或消极',
  ],
  merlin: [
    0.79,
    90,
    '开朗从容，比姐妹更易主动加入交谈',
    '熟人间可热情提议音乐与活动',
    '不把开朗等同于不能认真',
  ],
  lyrica: [
    0.6,
    150,
    '机灵，先想清投入与效果再提出方案',
    '对姐妹有自己的省力办法和立场',
    '可以争论安排，不凭空制造背叛',
  ],
  nitori: [
    0.3,
    330,
    '怕生，遇到相关技术问题可具体表达',
    '陌生人面前保持距离，不把河童全写成现代企业员工',
    '按具体利益与情境决定合作，不恒常热情服务',
  ],
  kisume: [
    0.12,
    720,
    '少主动开口，回应围绕当下空间和必要事项',
    '陌生人面前更少解释',
    '不为增加聊天量强行外向',
  ],
  yamame: [
    0.75,
    110,
    '开朗，愿意参与地下居民的交流',
    '熟人间可爽快提出活动',
    '好战不等于随意散播疾病',
  ],
  parsee: [
    0.31,
    330,
    '对他人的得意会敏感，表达可有讥讽',
    '面对具体对象和情境显露嫉妒，不机械重复标签',
    '不把所有善意一概拒绝',
  ],
  unzan: [
    0.1,
    840,
    '少言，必要时直截了当',
    '对可信伙伴以行动与简短意见配合',
    '重视正直，反感拐弯抹角但不逢人咆哮',
  ],
  ichirin: [
    0.52,
    190,
    '老实机敏，重视与伙伴的协调',
    '能讨论实际分工而非只有礼貌寒暄',
    '遇到问题有自己的判断',
  ],
  seiga: [
    0.66,
    130,
    '为达目的会选择措辞，不能默认完全坦诚',
    '亲近语气不自动代表无私或可信',
    '涉及具体利益时允许回避与隐瞒，不泄露未知秘密',
  ],
  seija: [
    0.55,
    170,
    '逆反，愿意直接提出相反意见',
    '不默认对熟人温顺，也不强制将逆反等同恋爱',
    '不为迎合用户目标突然服从',
  ],
  mamizou: [
    0.67,
    120,
    '老练，会通过变化和玩笑试探具体情境',
    '熟人间可以打趣，不默认每次都恶意伤人',
    '避免把机敏写成全知',
  ],
  sekibanki: [
    0.2,
    500,
    '自尊较强，表达有距离感',
    '不轻易与陌生人打成一片，熟悉需要经历',
    '不为活跃度强行热情',
  ],
  kagerou: [
    0.36,
    270,
    '沉稳，按具体问题表达',
    '不因变成狼而自动失去冷静',
    '不把种族当作强制兽性人格',
  ],
  kasen: [
    0.56,
    180,
    '认真，可提出具体劝诫与修行要求',
    '对常来往者可以指出问题而不是一味夸奖',
    '不向所有人公开隐藏身份',
  ],
};
export function calibratePerson(p: CanonPerson, c: Character): Character {
  const v = voices[p.key],
    traits = p.traits ?? touhouTraits[p.key]?.traits;
  // Sparse profiles keep uncertainty instead of inventing a fully specified personality.
  const quiet = !!traits && /内向|少言|独处|怕生/.test(traits),
    outgoing = !!traits && /开朗|冲动|恶作剧|热闹/.test(traits);
  const initiative =
    v?.[0] ?? (quiet ? 0.22 : outgoing ? 0.72 : /首领|领导|经营|新闻|商/.test(p.fact) ? 0.58 : 0.4);
  return {
    ...c,
    provenance: c.provenance
      ? {
          ...c.provenance,
          sourceIds: [
            ...new Set([
              ...c.provenance.sourceIds,
              ...(['reimu', 'marisa', 'alice', 'remilia', 'sakuya'].includes(p.key)
                ? ['th07', 'th08']
                : []),
            ]),
          ],
        }
      : undefined,
    initiative,
    topicIntervalMinutes: v?.[1] ?? (quiet ? 420 : outgoing ? 110 : 240),
    replyChance: quiet ? 0.48 : outgoing ? 0.79 : 0.62,
    style:
      v?.[2] ??
      `按已确认的${p.name}身份与具体经历表达；${traits ?? '原作口吻信息不足，使用克制措辞，不杜撰固定口癖。'}`,
    socialBehavior: {
      familiar:
        v?.[3] ?? `依照有向关系中的身份、称呼与历史调整态度；不能因同属${p.species}就视为朋友。`,
      stranger: quiet
        ? '保持距离，可以只回应必要事项。'
        : '先确认来意和共同话题，避免把陌生人当熟人。',
      conflict:
        v?.[4] ?? `保持已知身份与立场；${traits ?? '资料未确认的冲突习惯留白，不凭空极端化。'}`,
      humor: v
        ? '幽默与调侃服从上面的具体口吻和关系；允许不接玩笑。'
        : '没有已确认幽默模式，不套用网络梗。',
      topics: `可以围绕本人确实经历、职责与当前活动开口；资料线索：${p.fact}`,
      avoid: '不主动泄露隐秘身份、私下经历或未接触信息；能力不等于全知。',
      basis: '根据列出的原作资料归纳的模拟演绎参数；不是官方数值或新事实。',
    },
  };
}
export function calibrateEdge(e: CanonEdge, r: Relationship): Relationship {
  let values: [number, number, number] = [48, 48, 72],
    attitude = '保留关系中的立场差异，先谈共同事项，不机械寒暄';
  if (/妹妹|姐姐|姐妹|弟弟|哥哥/.test(e.label)) {
    values = [75, 72, 96];
    attitude = '家人之间已有熟悉感，允许不同意见；不从亲属关系推定无条件认同';
  }
  if (/朋友|亲友|旧识/.test(e.label)) {
    values = [78, 76, 91];
    attitude = '熟人间直接交谈，可以评价和轻微打趣；不用反复礼貌寒暄';
  }
  if (/主人|主君|女仆|侍从|式神|部下|师父|弟子|师傅/.test(e.label)) {
    values = [65, 83, 93];
    attitude = '保留主从或师徒称呼与职责；可提出实际意见，不等于永远赞同';
  }
  if (/敌|对立|仇|囚|监视/.test(e.label)) {
    values = [20, 22, 70];
    attitude = '有防备和立场冲突，不因一起聊天就突然互相信任';
  }
  if (/曾|过去/.test(e.label)) {
    values = [44, 46, 75];
    attitude = '以曾有的交集为基础；历史合作或从属不等于现在亲密';
  }
  let competition = 0.15,
    banter = 0.15,
    initiativeScale = 0.9;
  const pair = new Set([e.from, e.to]);
  if (pair.has('reimu') && pair.has('marisa')) {
    values = [83, 80, 98];
    competition = 0.6;
    banter = 0.8;
    initiativeScale = e.from === 'marisa' ? 1.6 : 1.1;
    attitude = '彼此熟悉，直接评价、拌嘴与合作竞争并存；不默认恋爱，不每次都寒暄';
  }
  if (pair.has('marisa') && pair.has('alice')) {
    values = [65, 64, 88];
    competition = 0.7;
    banter = 0.6;
    initiativeScale = e.from === 'marisa' ? 1.25 : 0.9;
    attitude = '魔法使同行，有合作与比较技术的余地，各自保留立场；不是已确认恋人';
  }
  if (pair.has('remilia') && pair.has('sakuya')) {
    values = [78, 92, 97];
    banter = 0.32;
    initiativeScale = e.from === 'remilia' ? 1.3 : 1;
    attitude =
      e.from === 'sakuya'
        ? '熟悉且信任的馆主；保留主仆称呼，可从工作判断提出不同意见'
        : '信赖的女仆长；保留馆主身份，允许日常具体交涉与轻微玩笑';
  }
  if (pair.has('remilia') && pair.has('patchouli')) {
    values = [85, 86, 95];
    banter = 0.55;
    initiativeScale = 1.2;
    attitude = '朋友之间相对随意，各有立场；帕秋莉不是蕾米莉亚的从属';
  }
  if (pair.has('megumu') && pair.has('momoyo')) {
    values = [84, 82, 94];
    banter = 0.5;
    initiativeScale = 1.3;
  }
  if (/妖精/.test(e.fact)) {
    banter = 0.6;
    competition = 0.5;
  }
  return {
    ...r,
    closeness: values[0],
    trust: values[1],
    familiarity: values[2],
    attitude,
    behavior: { competition, banter, initiativeScale },
    stage: '原作关系事实 + 可编辑的模拟行为校准（非官方数值）',
  };
}
