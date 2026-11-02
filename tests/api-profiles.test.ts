import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import {
  activeProfile,
  activeProfileId,
  profileLabel,
  setActiveProfile,
  uniqueProfileName,
  updateActiveProfile,
} from '../src/data/api-profiles';
import { getKey, setSessionKey } from '../src/ai/provider';
import type { ApiProfile } from '../src/core/types';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const profile = (id: string, name: string, model = `${id}-model`): ApiProfile => ({
  id,
  name,
  provider: 'fixture',
  baseUrl: 'https://fixture.invalid/v1',
  model,
  persistKey: false,
  status: 'connected',
});

let d: AquariumDB;
beforeEach(async () => {
  d = new AquariumDB('api-profiles-' + crypto.randomUUID());
  await seed(d, NOW);
});
afterEach(async () => {
  await d.delete();
});

describe('multiple API profiles', () => {
  it('defaults to the legacy api row and switches to the selected profile', async () => {
    await d.profiles.bulkPut([profile('api', '默认接口'), profile('api-backup', '备用接口')]);
    expect(await activeProfileId(d)).toBe('api');
    expect((await activeProfile(d))?.name).toBe('默认接口');

    await setActiveProfile('api-backup', d);
    expect((await d.settings.get('app'))?.apiProfileId).toBe('api-backup');
    expect(await activeProfileId(d)).toBe('api-backup');
    expect((await activeProfile(d))?.model).toBe('api-backup-model');
  });

  it('updates only the active profile and falls back when its pointer is stale', async () => {
    await d.profiles.bulkPut([profile('api', '默认接口'), profile('api-backup', '备用接口')]);
    await setActiveProfile('api-backup', d);
    await updateActiveProfile({ outputBudgetTokens: 4096 }, d);
    expect((await d.profiles.get('api-backup'))?.outputBudgetTokens).toBe(4096);
    expect((await d.profiles.get('api'))?.outputBudgetTokens).toBeUndefined();

    await d.profiles.delete('api-backup');
    expect(await activeProfileId(d)).toBe('api');
    expect((await activeProfile(d))?.name).toBe('默认接口');
  });

  it('keeps session-only keys separate per profile', () => {
    const a = profile('session-a', 'A');
    const b = profile('session-b', 'B');
    setSessionKey('secret-a', a.id);
    setSessionKey('secret-b', b.id);
    expect(getKey(a)).toBe('secret-a');
    expect(getKey(b)).toBe('secret-b');
    expect(getKey({ ...a, key: 'persisted-a' })).toBe('secret-a');
    expect(getKey({ ...profile('session-c', 'C'), key: 'persisted-c' })).toBe('persisted-c');
  });

  it('builds readable, unique profile labels and names', () => {
    expect(profileLabel({ name: '  ', provider: 'DeepSeek' })).toBe('DeepSeek');
    expect(profileLabel(undefined)).toBe('未命名接口');
    expect(uniqueProfileName('备用接口', [])).toBe('备用接口');
    expect(uniqueProfileName('备用接口', ['备用接口'])).toBe('备用接口（副本 2）');
    expect(uniqueProfileName('备用接口', ['备用接口', '备用接口（副本 2）'])).toBe(
      '备用接口（副本 3）',
    );
  });
});
