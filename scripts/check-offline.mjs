import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:4183/');
  await page.getByRole('button', { name: '先看看演示世界' }).click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByRole('button', { name: '世界设置' }).click();
  await page.getByRole('button', { name: '提示词管理', exact: true }).click();
  await page
    .getByRole('textbox', { name: '角色行为与语言规范', exact: true })
    .fill('离线保留的自定义提示词');
  await page.locator('.prompt-card').first().getByRole('button', { name: '保存修改' }).click();
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: '世界设置' }).click();
  await page.getByRole('button', { name: '提示词管理', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: '角色行为与语言规范', exact: true }).inputValue(),
    '离线保留的自定义提示词',
  );
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
  console.log(
    'PASS: production offline reload, service worker, custom prompt persistence; no page errors.',
  );
} finally {
  await browser.close();
}
