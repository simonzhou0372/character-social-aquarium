import { afterEach, beforeEach, expect, it } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { buildTouhouPreset, ensureTouhouPresets } from '../src/data/presets/touhou';
import {
  touhouPortraits,
  PORTRAIT_PACK,
  type PortraitEntry,
  type PortraitCandidate,
} from '../src/data/presets/touhou-portraits';
import { downloadPortraits, removePortraits, portraitMime } from '../src/data/portraits';
import { exportBackup, importBackup, validateBackup } from '../src/data/backup';
const now = Date.parse('2026-10-24T10:00:00Z');
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3r0AAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
const image = () => new Response(png, { headers: { 'content-type': 'image/png' } });
const decode = async () => {};
const twilight: PortraitCandidate = {
  id: 'tw',
  kind: 'twilight',
  work: '绯想天',
  artist: 'alphes',
  fileTitle: '文件:博丽灵梦（绯想天立绘）.png',
  sourcePage: 'https://thwiki.cc/File:Reimu',
  url: 'https://upload.thbwiki.cc/reimu.png',
  bytes: png.length,
};
const zun: PortraitCandidate = {
  ...twilight,
  id: 'zun',
  kind: 'zun',
  work: '红魔乡',
  artist: 'ZUN',
  url: 'https://upload.thbwiki.cc/reimu-zun.png',
};
const catalog: PortraitEntry[] = [
  { characterId: 'th:reimu', name: '博丽灵梦', continuity: 'windows', candidates: [twilight, zun] },
];
let d: AquariumDB;
beforeEach(async () => {
  d = new AquariumDB('portraits-' + crypto.randomUUID());
  await seed(d, now);
  await ensureTouhouPresets(d, now);
});
afterEach(async () => {
  await d.delete();
});
it('catalog covers all preset identities and never substitutes modern portraits for PC-98 or the second Reisen', () => {
  const characters = [false, true].flatMap((legacy) => buildTouhouPreset(legacy, now).characters);
  expect(touhouPortraits).toHaveLength(characters.length);
  expect(new Set(touhouPortraits.map((e) => e.characterId))).toEqual(
    new Set(characters.map((c) => c.id)),
  );
  expect(touhouPortraits.find((e) => e.characterId === 'th:reimu')?.candidates[0]).toMatchObject({
    kind: 'twilight',
    artist: 'alphes',
  });
  expect(touhouPortraits.find((e) => e.characterId === 'th:rumia')?.candidates[0]).toMatchObject({
    kind: 'zun',
    artist: 'ZUN',
  });
  for (const e of touhouPortraits) {
    for (const c of e.candidates) {
      expect(['upload.thwiki.cc', 'upload.thbwiki.cc']).toContain(new URL(c.url).hostname);
      expect(c.sourcePage).toMatch(/^https:\/\/thwiki.cc\//);
      expect(c.fileTitle).toContain('立绘');
      if (e.continuity === 'pc98') expect(c.work).toMatch(/灵异传|封魔录|梦时空|幻想乡|怪绮谈/);
      if (c.kind === 'zun') expect(c.artist).toBe('ZUN');
    }
    if (!e.candidates.length) expect(e.missingReason).toBeTruthy();
  }
  expect(touhouPortraits.find((e) => e.characterId === 'th:reisen-moon')?.candidates).toEqual([]);
  expect(touhouPortraits.find((e) => e.characterId === 'th:myouren')?.candidates).toEqual([]);
  expect(touhouPortraits.find((e) => e.characterId === 'th:sunny')?.candidates).toEqual([]);
});
it('installing presets and choosing zero downloads never fetches images', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return image();
  };
  await downloadPortraits([], { database: d, catalog, fetcher, decode });
  expect(requests).toBe(0);
  expect((await d.characters.get('th:reimu'))?.avatar).toBe('');
});
it('falls back from a failed Twilight image to ZUN, stores a local image and preserves other data across backup', async () => {
  const urls: string[] = [],
    beforeMessages = await d.messages.count(),
    profiles = await d.profiles.toArray();
  const fetcher: typeof fetch = async (input, init) => {
    urls.push(String(input));
    expect(init?.credentials).toBe('omit');
    expect(init?.headers).toBeUndefined();
    return String(input) === twilight.url ? new Response('<html>not an image</html>') : image();
  };
  const result = await downloadPortraits(['th:reimu', 'th:reimu'], {
    database: d,
    catalog,
    fetcher,
    decode,
  });
  expect(result).toMatchObject({ total: 1, installed: 1, failed: 0 });
  expect(urls).toEqual([twilight.url, zun.url]);
  const c = (await d.characters.get('th:reimu'))!;
  expect(c.avatar).toMatch(/^data:image\/png;base64,/);
  expect(c.avatarSource?.kind).toBe('zun');
  const backup = validateBackup(await exportBackup(d));
  await importBackup(backup, d);
  expect((await d.characters.get(c.id))?.avatar).toBe(c.avatar);
  expect((await d.characters.get(c.id))?.avatarSource).toEqual(c.avatarSource);
  expect(await d.messages.count()).toBe(beforeMessages);
  expect(await d.profiles.toArray()).toEqual(profiles);
});
it('keeps user uploads and never overwrites a new upload that arrived during download', async () => {
  await d.characters.update('th:reimu', { avatar: 'data:image/png;base64,custom' });
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return image();
  };
  expect(
    (
      await downloadPortraits(['th:reimu'], {
        database: d,
        catalog,
        fetcher,
        decode,
        replaceDownloaded: true,
      })
    ).skipped,
  ).toBe(1);
  expect(requests).toBe(0);
  await d.characters.update('th:reimu', { avatar: '' });
  const concurrent: typeof fetch = async () => {
    await d.characters.update('th:reimu', { avatar: 'new-user-upload' });
    return image();
  };
  const result = await downloadPortraits(['th:reimu'], {
    database: d,
    catalog,
    fetcher: concurrent,
    decode,
  });
  expect(result.skipped).toBe(1);
  expect((await d.characters.get('th:reimu'))?.avatar).toBe('new-user-upload');
});
it('clears only unchanged managed images, preserving changed uploads even with stale metadata', async () => {
  await downloadPortraits(['th:reimu'], {
    database: d,
    catalog,
    fetcher: async () => image(),
    decode,
  });
  expect((await d.characters.get('th:reimu'))?.avatarSource?.pack).toBe(PORTRAIT_PACK);
  await d.characters.update('th:reimu', { avatar: 'user-upload' });
  expect(await removePortraits(d)).toBe(0);
  expect((await d.characters.get('th:reimu'))?.avatar).toBe('user-upload');
  await d.characters.update('th:reimu', { avatar: '' });
  await downloadPortraits(['th:reimu'], {
    database: d,
    catalog,
    fetcher: async () => image(),
    decode,
  });
  expect(await removePortraits(d)).toBe(1);
  expect((await d.characters.get('th:reimu'))?.avatar).toBe('');
});
it('bounds parallel downloads at two and resumes after cancellation without redownloading saved images', async () => {
  const ids = ['th:reimu', 'th:marisa', 'th:rumia', 'th:chen'];
  const entries = ids.map((id) => ({ ...catalog[0], characterId: id, candidates: [twilight] }));
  const abort = new AbortController();
  let active = 0,
    peak = 0,
    requests = 0;
  const fetcher: typeof fetch = async () => {
    active++;
    requests++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return image();
  };
  const first = await downloadPortraits(ids, {
    database: d,
    catalog: entries,
    fetcher,
    decode,
    signal: abort.signal,
    onProgress: (p) => {
      if (p.installed) abort.abort();
    },
  });
  expect(first.installed).toBeGreaterThan(0);
  expect(first.installed).toBeLessThan(ids.length);
  expect(peak).toBeLessThanOrEqual(2);
  const before = requests;
  const second = await downloadPortraits(ids, { database: d, catalog: entries, fetcher, decode });
  expect(second.installed + first.installed).toBe(ids.length);
  expect(requests - before).toBe(second.installed);
});
it('rejects unsafe hosts, malformed image bodies and oversized responses', async () => {
  expect(() => portraitMime(new TextEncoder().encode('<html>blocked body</html>'))).toThrow();
  expect(() => portraitMime(new Uint8Array(1024 * 1024 + 1))).toThrow();
  let requests = 0;
  const unsafe = [
    { ...catalog[0], candidates: [{ ...twilight, url: 'https://unrelated.invalid/a.png' }] },
  ];
  const result = await downloadPortraits(['th:reimu'], {
    database: d,
    catalog: unsafe,
    fetcher: async () => {
      requests++;
      return image();
    },
    decode,
  });
  expect(result.failed).toBe(1);
  expect(requests).toBe(0);
  const tooBig = await downloadPortraits(['th:reimu'], {
    database: d,
    catalog,
    fetcher: async () =>
      new Response(png, { headers: { 'content-length': String(2 * 1024 * 1024) } }),
    decode,
  });
  expect(tooBig.failed).toBe(1);
  expect((await d.characters.get('th:reimu'))?.avatar).toBe('');
});
