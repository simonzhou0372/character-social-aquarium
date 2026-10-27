import { test, expect, type Page } from '@playwright/test';

async function enter(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const demo = page.getByRole('button', { name: '先看看演示世界' });
  if (await demo.isVisible().catch(() => false)) await demo.click();
  else await demo.waitFor({ state: 'visible' }).then(() => demo.click());
}

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: '世界设置' }).click();
  await page.getByRole('button', { name: '外观与动效', exact: true }).click();
}

test('game and classic interfaces can be switched and both persist', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await enter(page);
  await expect(page.locator('.app-shell')).toHaveClass(/game-ui/);
  await expect(page.getByRole('heading', { name: '世界在转，他们也在生活' })).toBeVisible();
  await expect(page.locator('.game-backdrop')).toBeVisible();

  await openAppearance(page);
  await page.getByRole('button', { name: /经典界面/ }).click();
  await expect(page.locator('.app-shell')).toHaveClass(/classic-ui/);
  await expect(page.locator('.game-backdrop')).toBeHidden();
  await page.getByRole('button', { name: '今日观察', exact: true }).click();
  await expect(page.getByRole('heading', { name: '世界在转，他们也在生活' })).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.app-shell')).toHaveClass(/classic-ui/);
  await openAppearance(page);
  await page.getByRole('button', { name: /游戏界面/ }).click();
  await expect(page.locator('.app-shell')).toHaveClass(/game-ui/);
  await expect(page.locator('.game-backdrop')).toBeVisible();
  expect(errors).toEqual([]);
});

test('visual levels persist and off mode stops decorative animation', async ({ page }) => {
  await enter(page);
  await openAppearance(page);
  const running = () =>
    page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  await page.getByRole('radio', { name: /关闭/ }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', 'off');
  await page.waitForTimeout(100);
  const offAnimations = await running();
  expect(offAnimations).toBe(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('.game-backdrop')).toBeVisible();
  await expect(page.getByRole('heading', { name: '世界在转，他们也在生活' })).toBeVisible();
});

test('five activity levels are selectable without generating content', async ({ page }) => {
  await enter(page);
  const before = await page.evaluate(async () => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    return {
      jobs: await db.contentJobs.count(),
      simTime: (await db.checkpoints.get('w-harbor'))?.simTime,
    };
  });
  await page.getByRole('button', { name: '世界设置' }).click();
  await page.getByRole('button', { name: '模拟器', exact: true }).click();
  const presets = page.locator('.game-activity-presets [data-activity]');
  await expect(presets).toHaveCount(5);
  await page.locator('[data-activity="carnival"]').click();
  await expect(page.locator('[data-activity="carnival"]')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(350);
  const after = await page.evaluate(async () => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    return {
      jobs: await db.contentJobs.count(),
      simTime: (await db.checkpoints.get('w-harbor'))?.simTime,
      activity: (await db.settings.get('app'))?.activity,
    };
  });
  expect(after.activity).toBe('carnival');
  expect(after.jobs).toBe(before.jobs);
  expect(after.simTime).toBe(before.simTime);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '世界设置' }).click();
  await page.getByRole('button', { name: '模拟器', exact: true }).click();
  await expect(page.locator('[data-activity="carnival"]')).toHaveAttribute('aria-pressed', 'true');
});
