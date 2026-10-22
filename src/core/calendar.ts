import { z } from 'zod';
import type { World } from './types';
export const WorldDateTimeSchema = z
  .object({
    year: z.number().int().min(1).max(999999),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .refine((d) => d.day <= daysInMonth(d.year, d.month), '日期不存在');
export type WorldDateTime = z.infer<typeof WorldDateTimeSchema>;
export const leapYear = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
export const daysInMonth = (y: number, m: number) =>
  [31, leapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
export function dayOrdinal(d: Pick<WorldDateTime, 'year' | 'month' | 'day'>) {
  const y = d.year - 1;
  let n = 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
  for (let m = 1; m < d.month; m++) n += daysInMonth(d.year, m);
  return n + d.day - 1;
}
export function fromOrdinal(n: number): WorldDateTime {
  if (!Number.isInteger(n) || n < 0 || n > dayOrdinal({ year: 999999, month: 12, day: 31 }))
    throw new Error('世界日期超出 1～999999 年范围');
  let lo = 1,
    hi = 999999;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (dayOrdinal({ year: mid, month: 1, day: 1 }) <= n) lo = mid;
    else hi = mid - 1;
  }
  let left = n - dayOrdinal({ year: lo, month: 1, day: 1 }),
    month = 1;
  while (left >= daysInMonth(lo, month)) left -= daysInMonth(lo, month++);
  return { year: lo, month, day: left + 1, hour: 0, minute: 0 };
}
export function addMinutes(date: WorldDateTime, delta: number): WorldDateTime {
  WorldDateTimeSchema.parse(date);
  const total = date.hour * 60 + date.minute + Math.floor(delta),
    days = Math.floor(total / 1440),
    minute = ((total % 1440) + 1440) % 1440;
  return {
    ...fromOrdinal(dayOrdinal(date) + days),
    hour: Math.floor(minute / 60),
    minute: minute % 60,
  };
}
export function realLocalDate(at: number, timezone: string): WorldDateTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const v = (key: string) => Number(parts.find((p) => p.type === key)!.value);
  return {
    year: v('year'),
    month: v('month'),
    day: v('day'),
    hour: v('hour'),
    minute: v('minute'),
  };
}
// Logical ticks keep old saves intact. Calendar arithmetic uses integer days/minutes,
// never a giant Unix timestamp or browser parsing for fictional years.
export function worldTime(world: World, at: number): WorldDateTime {
  return world.calendarAnchor
    ? addMinutes(world.calendarAnchor.date, Math.floor((at - world.calendarAnchor.tick) / 60000))
    : realLocalDate(at, world.timezone);
}
export function calendarTick(world: World, date: WorldDateTime) {
  WorldDateTimeSchema.parse(date);
  if (!world.calendarAnchor) throw new Error('请先迁移世界历法');
  const a = world.calendarAnchor;
  const minutes =
    (dayOrdinal(date) - dayOrdinal(a.date)) * 1440 +
    date.hour * 60 +
    date.minute -
    a.date.hour * 60 -
    a.date.minute;
  const at = a.tick + minutes * 60000;
  if (!Number.isSafeInteger(at) || at < 0)
    throw new Error('该日期超出此时间线历史范围，请创建新世界并设置初始日期');
  return at;
}
export function calendarDate(world: World, at: number) {
  const d = worldTime(world, at);
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
export function formatWorldTime(world: World, at: number) {
  const d = worldTime(world, at);
  return `${world.era ?? 'AD'} ${d.year}/${String(d.month).padStart(2, '0')}/${String(d.day).padStart(2, '0')} ${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}`;
}

export function calendarLimit(world: World) {
  if (!world.calendarAnchor) return Number.MAX_SAFE_INTEGER;
  const a = world.calendarAnchor;
  const minutes =
    (dayOrdinal({ year: 999999, month: 12, day: 31 }) - dayOrdinal(a.date)) * 1440 +
    1439 -
    a.date.hour * 60 -
    a.date.minute;
  return Math.min(Number.MAX_SAFE_INTEGER, a.tick + minutes * 60000);
}

export function nextWorldHour(world: World, at: number) {
  if (!world.calendarAnchor) return at + (60 - worldTime(world, at).minute) * 60000 - (at % 60000);
  const base = world.calendarAnchor.tick - world.calendarAnchor.date.minute * 60000;
  return base + (Math.floor((at - base) / 3600000) + 1) * 3600000;
}
export function formatWorldClock(world: World, at: number) {
  const d = worldTime(world, at);
  return `${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}`;
}
