import { DAY, HOUR, type Membership, type World } from './types';
import { ordinaryLife } from './narrative';
export type CrisisBand =
  | 'truth'
  | 'trust'
  | 'order'
  | 'collapse'
  | 'structure'
  | 'terminal'
  | 'final';
export interface CrisisSnapshot {
  day: number;
  band: CrisisBand;
  label: string;
  /** 0 at the start of Day 1, 1 at the final hour. */
  pressure: number;
  infrastructure: number;
  trust: number;
  violence: number;
  services: string;
  publicMood: string;
  guidance: string;
}
const bands: Record<number, { band: CrisisBand; label: string; services: string; mood: string; guidance: string }> = {
  1: {
    band: 'truth',
    label: '真相公布',
    services: '互联网、航班、金融与物流仍运行，但严重拥堵；医院与警力正常。',
    mood: '争论、恐慌、否认与求证同时存在；多数人仍按原计划上班。',
    guidance: '事件以信息冲击、求证、家庭争论、机构表态和第一波囤积为主；死亡应罕见。',
  },
  2: {
    band: 'trust',
    label: '信任危机',
    services: '市场剧烈波动，边境与机场出现管制；局部抢购、谣言和罢工。',
    mood: '政府公信力下降，阴谋论扩散；有人开始离开城市，有人拒绝相信。',
    guidance: '事件以政策反复、企业恐慌、家庭分离、群体冲突和信任破裂为主；允许少量致命事故。',
  },
  3: {
    band: 'order',
    label: '秩序分化',
    services: '部分城市仍稳定，部分地区停电、断网、交通管制；医疗开始承压。',
    mood: '互助与暴力同时增长；社区组织、宗教团体和黑市扩张。',
    guidance: '局部与团体事件显著增加；基础设施故障、踩踏、抢劫和医疗挤兑可以造成死亡。',
  },
  4: {
    band: 'collapse',
    label: '全面危机',
    services: '跨洋航班基本停飞，供应链断裂；电网频率不稳，医院限电。',
    mood: '恐惧转为愤怒和宿命论；大规模逃离、暴力和自救组织出现。',
    guidance: '致命事故、冲突和重大关系变化显著增加；世界级事件应影响多个团体。',
  },
  5: {
    band: 'structure',
    label: '社会结构剧变',
    services: '区域电网间歇崩溃，通信退化；救援体系只能覆盖局部。',
    mood: '旧秩序部分崩解，新临时组织、武装自卫队和互助网络并存。',
    guidance: '团体分裂、背叛、解散与重组高发；死亡风险明显上升，重要人物也可能死。',
  },
  6: {
    band: 'terminal',
    label: '文明末期',
    services: '通信、医疗、交通进一步衰退；多数城市只剩本地电力和短波。',
    mood: '大规模绝望与少数的平静；人们处理遗言、告别和最后的责任。',
    guidance: '死亡风险高；事件应围绕最后的资源、告别、失控和牺牲；避免所有人都说煽情台词。',
  },
  7: {
    band: 'final',
    label: '最终24小时',
    services: '基础设施大面积失效；城市局部燃烧，收音机与面对面是主要信息渠道。',
    mood: '不可避免的结局；有人工作到最后一刻，有人独自等待，有人仍在逃。',
    guidance: '允许密集的终局事件和多人死亡；最终00:00 UTC终焉潮汐抹去一切生命。',
  },
};
export function crisisDay(world: World, at: number) {
  const start = world.novel?.startedAt ?? world.calendarAnchor?.tick ?? at;
  return Math.max(1, Math.floor((at - start) / DAY) + 1);
}
export function crisisAt(world: World, at: number): CrisisSnapshot {
  const day = crisisDay(world, at);
  const capped = Math.min(7, day);
  const meta = bands[capped] ?? bands[7];
  const withinDay = Math.max(0, Math.min(1, ((at - (world.novel?.startedAt ?? at)) % DAY) / DAY));
  const base = (capped - 1 + withinDay) / 6;
  const pressure = Math.max(0, Math.min(1, Math.pow(base, 1.18)));
  return {
    day,
    band: meta.band,
    label: meta.label,
    pressure,
    infrastructure: Math.max(0, 1 - pressure * 0.92),
    trust: Math.max(0, 1 - pressure * 0.78),
    violence: Math.min(1, pressure * 1.05),
    services: meta.services,
    publicMood: meta.mood,
    guidance: meta.guidance,
  };
}
export function crisisPrompt(world: World, at: number) {
  const c = crisisAt(world, at);
  return {
    day: c.day,
    band: c.label,
    pressure: Number(c.pressure.toFixed(3)),
    infrastructure: Number(c.infrastructure.toFixed(3)),
    publicTrust: Number(c.trust.toFixed(3)),
    violence: Number(c.violence.toFixed(3)),
    services: c.services,
    publicMood: c.publicMood,
    eventGuidance: c.guidance,
  };
}
/** Later days compress the cadence; this is a target, not a mechanical clock. */
export function crisisIntervalFactor(day: number) {
  return [1.35, 1.15, 1, 0.82, 0.72, 0.58, 0.42][Math.min(7, Math.max(1, day)) - 1];
}
export function eventLevelFor(
  day: number,
  sequence: number,
  settings?: NonNullable<World['majorEventSettings']>,
): 'local' | 'group' | 'world' {
  const levels = settings?.levels ?? { local: true, group: true, world: true };
  const allowed: ('local' | 'group' | 'world')[] = [];
  if (levels.local) allowed.push('local');
  if (levels.group) allowed.push('group');
  if (levels.world) allowed.push('world');
  if (!allowed.length) return 'local';
  let preferred: 'local' | 'group' | 'world';
  if (day <= 1) preferred = sequence % 4 === 0 ? 'group' : 'local';
  else if (day === 2) preferred = sequence % 2 === 0 ? 'group' : 'local';
  else if (day === 3 || day === 4) preferred = sequence % 4 === 0 ? 'world' : sequence % 2 === 0 ? 'group' : 'local';
  else if (day === 5 || day === 6) preferred = sequence % 3 === 0 ? 'world' : 'group';
  else preferred = sequence % 2 === 0 ? 'world' : 'group';
  return allowed.includes(preferred) ? preferred : allowed[0];
}
export function aliveMembers(members: Membership[]) {
  return members.filter((m) => !m.inactive && ordinaryLife(m.life?.status));
}
export function formatCrisisClock(world: World, at: number) {
  const start = world.novel?.startedAt ?? world.calendarAnchor?.tick ?? at;
  const remaining = Math.max(0, 7 * DAY - (at - start));
  const hours = Math.floor(remaining / HOUR);
  return `D${crisisDay(world, at)} · 剩余 ${hours} 小时`;
}
