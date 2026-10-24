import { test, expect, type Page } from '@playwright/test';
async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '先看看演示世界' }).click();
}
async function nav(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) < 760)
    await page.getByRole('button', { name: '打开导航' }).click();
  await page.locator('.sidebar nav').getByRole('button', { name, exact: true }).click();
}
test('world and group deletion are reversible and permanent deletion needs two confirmations', async ({
  page,
}) => {
  await enter(page);
  await nav(page, '世界与团体');
  await page.getByRole('button', { name: '删除海盐市 · 平行日常', exact: true }).click();
  await page.getByRole('button', { name: '确认移入回收站', exact: true }).click();
  await expect(page.locator('.world-card')).toHaveCount(2);
  await nav(page, '回收站');
  await expect(page.getByRole('heading', { name: '海盐市 · 平行日常', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复世界', exact: true }).click();
  await nav(page, '世界与团体');
  await expect(page.locator('.world-card')).toHaveCount(3);
  await page
    .locator('.world-card')
    .filter({ hasText: '海盐市 · 平行日常' })
    .getByRole('button', { name: '进入世界', exact: true })
    .click();
  await page.getByRole('tab', { name: '世界团体', exact: true }).click();
  await page.getByRole('button', { name: '删除晚潮乐队', exact: true }).click();
  await page.getByRole('button', { name: '确认移入回收站', exact: true }).click();
  await nav(page, '回收站');
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('下一步仍需再次确认');
  await page.getByRole('button', { name: '继续确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('这是第二次确认');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: '晚潮乐队', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await page.getByRole('button', { name: '继续确认', exact: true }).click();
  await page.getByRole('button', { name: '我确认永久删除', exact: true }).click();
  await expect(page.getByRole('heading', { name: '晚潮乐队', exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const p = '/src/data/db.ts';
      const { db } = await import(p);
      return !!(await db.characters.get('c-mio'));
    }),
  ).toBe(true);
});
test('character editor exposes recoverable deletion and restores the same identity', async ({
  page,
}) => {
  await enter(page);
  await nav(page, '角色图鉴');
  await page.getByRole('button', { name: '查看 / 编辑', exact: true }).first().click();
  const name = await page.getByLabel('角色名称', { exact: true }).inputValue();
  await page.getByRole('button', { name: `删除${name}`, exact: true }).click();
  await page.getByRole('button', { name: '确认移入回收站', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await nav(page, '回收站');
  await page.getByRole('button', { name: '恢复角色', exact: true }).click();
  await nav(page, '角色图鉴');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
});
test('mobile self notes persist without AI and reading can freeze incoming messages', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await nav(page, '聊天消息');
  await page.getByRole('button', { name: /我的备忘/ }).click();
  await expect(page.getByLabel('聊天身份')).toHaveValue('user');
  await page.getByLabel('消息内容').fill('今天先记录到这里');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message-bubble', { hasText: '今天先记录到这里' })).toBeVisible();
  await page.reload();
  await nav(page, '聊天消息');
  await page.getByRole('button', { name: /我的备忘/ }).click();
  await expect(page.locator('.message-bubble', { hasText: '今天先记录到这里' })).toBeVisible();
  await page.getByRole('button', { name: '暂停跟随新消息', exact: true }).click();
  await page.evaluate(async () => {
    const p = '/src/data/db.ts',
      q = '/src/data/chat.ts';
    const { db } = await import(p);
    const c = await db.conversations.filter((c: any) => c.kind === 'notes').first();
    await (await import(q)).saveNote(c.id, '稍后再看的新备注');
  });
  await expect(page.locator('.message-bubble', { hasText: '稍后再看的新备注' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '继续显示新消息（1）', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '继续显示新消息（1）', exact: true }).click();
  await expect(page.locator('.message-bubble', { hasText: '稍后再看的新备注' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-private-notes.png', fullPage: true });
});
