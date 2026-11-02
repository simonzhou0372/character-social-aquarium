import { test, expect, type Page } from '@playwright/test';

async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /先看看演示世界|先读这份七日存档/ }).click();
}

async function settingsValue(page: Page, key: 'apiProfileId' | 'nickname') {
  return page.evaluate(async (key) => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    return (await db.settings.get('app'))?.[key];
  }, key);
}

test('switches between saved API profiles without mixing their keys or models', async ({
  page,
}) => {
  await enter(page);
  await page.evaluate(async () => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    await db.profiles.bulkPut([
      {
        id: 'p-a',
        name: '日常接口',
        provider: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        persistKey: false,
        status: 'connected',
      },
      {
        id: 'p-b',
        name: '备用接口',
        provider: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        persistKey: false,
        status: 'untested',
      },
    ]);
    await db.settings.update('app', { apiProfileId: 'p-a' });
  });

  await page.getByLabel('打开 AI 设置').click();
  await expect(page.locator('.api-profile-chip')).toHaveCount(2);
  await expect(page.locator('.api-profile-chip.selected')).toContainText('日常接口');

  await page.locator('.api-profile-chip', { hasText: '备用接口' }).click();
  await expect.poll(() => settingsValue(page, 'apiProfileId')).toBe('p-b');
  await expect(page.getByLabel('模型名称')).toHaveValue('gpt-4o-mini');

  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByLabel('配置名称').fill('本地接口');
  await page.getByLabel('模型名称').fill('local-model');
  await page.getByLabel('API Key').fill('fixture-local-key');
  await page.getByLabel('请求超时（秒）').fill('600');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.locator('.api-profile-chip')).toHaveCount(3);
  await expect(page.locator('.api-profile-chip.selected')).toContainText('本地接口');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/src/data/db.ts';
        const { db } = await import(path);
        const settings = await db.settings.get('app');
        const profile = await db.profiles.get(settings?.apiProfileId ?? '');
        return profile?.requestTimeoutSeconds;
      }),
    )
    .toBe(600);
});

test('keeps Chinese IME composition local in user profile before committing', async ({ page }) => {
  await enter(page);
  await page.getByLabel('打开 AI 设置').click();
  const dismiss = page.getByRole('button', { name: '收起提示' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
  await page.getByRole('button', { name: '用户资料', exact: true }).click({ force: true });
  const nickname = page.getByLabel('你的昵称');
  await nickname.fill('旧昵称');
  await expect.poll(() => settingsValue(page, 'nickname')).toBe('旧昵称');

  await nickname.evaluate((el) =>
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })),
  );
  await nickname.fill('nihao');
  // The intermediate candidate is visible but must not touch the database yet.
  await expect(nickname).toHaveValue('nihao');
  expect(await settingsValue(page, 'nickname')).toBe('旧昵称');

  await nickname.fill('你好世界');
  await nickname.evaluate((el) =>
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好世界' })),
  );
  await expect.poll(() => settingsValue(page, 'nickname')).toBe('你好世界');
  await expect(nickname).toHaveValue('你好世界');
});

test('copies a world into an independent, paused new world', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: '世界与团体' }).first().click();
  const card = page.locator('.world-card').filter({ hasText: '海盐市 · 平行日常' }).first();
  const before = await page.evaluate(async () => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    return db.worlds.count();
  });
  await card.getByRole('button', { name: '复制世界' }).click();
  const dialog = page.getByRole('dialog', { name: '复制该世界？' });
  await expect(dialog).toContainText('聊天记录、生活事件与时间进度不会复制');
  await dialog.getByRole('button', { name: '复制并进入' }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/src/data/db.ts';
        const { db } = await import(path);
        const settings = await db.settings.get('app');
        return (await db.worlds.get(settings?.worldId ?? ''))?.name;
      }),
    )
    .toBe('海盐市 · 平行日常（副本）');
  expect(
    await page.evaluate(async () => {
      const path = '/src/data/db.ts';
      const { db } = await import(path);
      return db.worlds.count();
    }),
  ).toBe(before + 1);
});
