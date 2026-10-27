import type { AppSettings } from './types';

export type ActivityMode = AppSettings['activity'];

export interface ActivityConfig {
  /** How many scheduler opportunities fit in one simulated hour. */
  onlineSlots: number;
  opportunity: number;
  cooldownMinutes: number;
  threshold: number;
  topicScale: number;
  replyContinuation: number;
  naturalEndChance: number;
  directWeight: number;
  groupWeight: number;
  /** Independent social openings the scheduler may produce in one segment. */
  simultaneous: number;
  /** Probability of each additional opening after the first. */
  burstChance: number;
  /** Extra scheduling preference for groups with more participants. */
  groupCrowdBonus: number;
  /** Extra simulated delay before a reply is written. */
  replyDelayMinutes: number;
}

// Rates are opportunities per simulated hour, independent of wall-clock scanning.
// The three original presets deliberately keep their previous values.
export const activityConfig = {
  quiet: {
    onlineSlots: 1,
    opportunity: 0.8,
    cooldownMinutes: 30,
    threshold: 0.12,
    topicScale: 1,
    replyContinuation: 0.65,
    naturalEndChance: 0.2,
    directWeight: 1,
    groupWeight: 0.8,
    simultaneous: 1,
    burstChance: 0,
    groupCrowdBonus: 0,
    replyDelayMinutes: 0,
  },
  standard: {
    onlineSlots: 3,
    opportunity: 0.8,
    cooldownMinutes: 15,
    threshold: 0.08,
    topicScale: 0.5,
    replyContinuation: 0.82,
    naturalEndChance: 0.13,
    directWeight: 1,
    groupWeight: 1,
    simultaneous: 1,
    burstChance: 0,
    groupCrowdBonus: 0,
    replyDelayMinutes: 0,
  },
  lively: {
    onlineSlots: 6,
    opportunity: 0.8,
    cooldownMinutes: 8,
    threshold: 0.055,
    topicScale: 0.25,
    replyContinuation: 0.94,
    naturalEndChance: 0.09,
    directWeight: 1,
    groupWeight: 1.15,
    simultaneous: 1,
    burstChance: 0,
    groupCrowdBonus: 0,
    replyDelayMinutes: 0,
  },
  boiling: {
    onlineSlots: 8,
    opportunity: 0.94,
    cooldownMinutes: 5,
    threshold: 0.044,
    topicScale: 0.16,
    replyContinuation: 0.965,
    naturalEndChance: 0.065,
    directWeight: 1.08,
    groupWeight: 1.32,
    simultaneous: 2,
    burstChance: 0.22,
    groupCrowdBonus: 0.05,
    replyDelayMinutes: 0.8,
  },
  carnival: {
    onlineSlots: 10,
    opportunity: 1,
    cooldownMinutes: 3,
    threshold: 0.033,
    topicScale: 0.1,
    replyContinuation: 0.98,
    naturalEndChance: 0.045,
    directWeight: 1.14,
    groupWeight: 1.55,
    simultaneous: 3,
    burstChance: 0.3,
    groupCrowdBonus: 0.09,
    replyDelayMinutes: 0.4,
  },
} as const satisfies Record<ActivityMode, ActivityConfig>;

export const activityModes: {
  mode: ActivityMode;
  label: string;
  short: string;
  description: string;
  glyph: string;
  level: number;
}[] = [
  {
    mode: 'quiet',
    label: '安静',
    short: '让沉默也有位置',
    description: '很少主动开启话题，适合慢慢读已经发生的事。',
    glyph: '☾',
    level: 1,
  },
  {
    mode: 'standard',
    label: '标准',
    short: '刚刚好的日常',
    description: '保留角色原有节奏，偶尔有新的对话出现。',
    glyph: '◒',
    level: 2,
  },
  {
    mode: 'lively',
    label: '热闹',
    short: '多一些相遇',
    description: '更频繁的私聊与群聊，打开列表常能看到新内容。',
    glyph: '☀',
    level: 3,
  },
  {
    mode: 'boiling',
    label: '沸腾',
    short: '话题正冒着热气',
    description: '熟人更愿意接话，日常分享与多人讨论明显增加。',
    glyph: '♨',
    level: 4,
  },
  {
    mode: 'carnival',
    label: '狂欢',
    short: '整座城市都在说话',
    description: '多个会话同时活跃，但仍遵守作息、关系和话题边界。',
    glyph: '✺',
    level: 5,
  },
];

export const activityFor = (mode: ActivityMode) => activityConfig[mode];
export function onlineStep(mode: ActivityMode) {
  return 3600000 / activityConfig[mode].onlineSlots;
}
