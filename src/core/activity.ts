import type { AppSettings } from './types';
// Rates are opportunities per simulated hour, independent of wall-clock scanning.
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
  },
} as const;
export const activityFor = (mode: AppSettings['activity']) => activityConfig[mode];
export function onlineStep(mode: AppSettings['activity']) {
  return 3600000 / activityConfig[mode].onlineSlots;
}
