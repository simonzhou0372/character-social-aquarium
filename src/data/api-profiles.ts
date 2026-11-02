import type { ApiProfile } from '../core/types';
import { db, type AquariumDB } from './db';

/** Display label for a saved API profile. */
export function profileLabel(profile?: Partial<ApiProfile>) {
  const label = profile?.name?.trim() || profile?.provider?.trim() || profile?.model?.trim();
  return label || '未命名接口';
}

/**
 * Resolve the profile the user selected in settings.
 *
 * Older databases only knew the single `api` row, so it stays the fallback.
 * If even that row is missing (fresh install / restored backup), use the first
 * saved profile instead of silently disabling AI.
 */
export async function activeProfileId(d: AquariumDB = db): Promise<string | undefined> {
  const settings = await d.settings.get('app');
  if (settings?.apiProfileId && (await d.profiles.get(settings.apiProfileId)))
    return settings.apiProfileId;
  if (await d.profiles.get('api')) return 'api';
  const first = await d.profiles.orderBy('id').first();
  return first?.id;
}

export async function activeProfile(d: AquariumDB = db): Promise<ApiProfile | undefined> {
  const id = await activeProfileId(d);
  return id ? d.profiles.get(id) : undefined;
}

export async function updateActiveProfile(patch: Partial<ApiProfile>, d: AquariumDB = db) {
  const id = await activeProfileId(d);
  if (!id) return;
  await d.profiles.update(id, patch);
}

export async function setActiveProfile(id: string, d: AquariumDB = db) {
  if (!(await d.profiles.get(id))) throw new Error('接口配置不存在');
  await d.settings.update('app', { apiProfileId: id });
}

/** A unique name such as "OpenAI（副本 2）" for duplicate actions. */
export function uniqueProfileName(base: string, existing: Iterable<string>, max = 60) {
  const used = new Set([...existing].map((name) => name.trim()));
  const trimmed = base.trim().slice(0, max) || '新接口';
  if (!used.has(trimmed)) return trimmed;
  for (let n = 2; n < 1000; n++) {
    const suffix = `（副本 ${n}）`;
    const candidate = `${base.trim().slice(0, Math.max(1, max - suffix.length))}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return trimmed;
}
