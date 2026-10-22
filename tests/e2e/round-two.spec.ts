import { test, expect, type Page } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
});
async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '先看看演示世界' }).click();
}
async function nav(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) <= 760) {
    await page.getByRole('button', { name: '打开导航' }).click();
  }
  await page.locator('.sidebar nav').getByRole('button', { name }).click();
}
async function simulation(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) <= 760)
    await page
      .locator('.mobile-bottom-nav')
      .getByRole('button', { name: '设置', exact: true })
      .click();
  else await page.locator('.settings-nav').click();
  await page.getByRole('button', { name: '模拟器', exact: true }).click();
}
test('desktop fictional year, free gender, background mode and prompt migration persist', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await enter(page);
  await nav(page, '世界与团体');
  await page.getByRole('button', { name: '添加世界观', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '世界观设定' });
  await dialog.getByLabel('世界名称', { exact: true }).fill('星历观察站');
  await dialog.getByLabel('纪年名称').fill('星历');
  const date = dialog.locator('.world-date-editor');
  await date.getByLabel('年', { exact: true }).fill('999999');
  await date.getByLabel('月', { exact: true }).fill('1');
  await date.getByLabel('日', { exact: true }).fill('1');
  await dialog.getByRole('button', { name: '保存世界' }).click();
  await expect(page.locator('.world-hud')).toContainText('星历 999999/01/01');
  await nav(page, '角色图鉴');
  await page.getByRole('button', { name: '添加角色', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).fill('第三性旅人');
  await page.getByLabel('性别（自由文本，可留空）').fill('星族第三性');
  await page.getByLabel('实体模式').selectOption('background');
  await page.getByRole('button', { name: '保存角色' }).click();
  await expect(page.locator('.character-card')).toContainText('星族第三性');
  await expect(page.locator('.character-card')).toContainText('背景人物');
  await page.reload();
  await expect(page.locator('.world-hud')).toContainText('星历 999999/01/01');
  await nav(page, '生活时间轴');
  await expect(page.getByLabel('年', { exact: true })).toHaveValue('999999');
  expect(errors).toEqual([]);
});
test('mobile HUD remains usable, pause survives reload, and unlimited usage retains limits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await expect(page.getByLabel('快捷世界速度')).toBeVisible();
  await page.getByLabel('快捷世界速度').selectOption('3600');
  await page.getByRole('button', { name: '继续世界', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停世界', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停世界', exact: true }).click();
  await page.reload();
  await expect(page.locator('.world-hud')).toContainText('已暂停');
  await expect(page.getByLabel('快捷世界速度')).toHaveValue('3600');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await simulation(page);
  await page.getByRole('switch', { name: '不限制模型用量' }).check();
  await expect(
    page.getByText('不限制应用内部的模型请求和 Token 总预算', { exact: false }),
  ).toBeVisible();
  await page.reload();
  await simulation(page);
  await expect(page.getByRole('switch', { name: '不限制模型用量' })).toBeChecked();
  await page.screenshot({ path: 'test-results/mobile-round-two-settings.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('user avatar validates decoding, crops, persists and appears on the right sender', async ({
  page,
}) => {
  await enter(page);
  await simulation(page);
  const upload = page.locator('.avatar-upload');
  await upload
    .locator('input[type=file]')
    .setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(upload).toContainText('图片无法解码');
  await upload.locator('input[type=file]').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 32;
        c.height = 32;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#c0db7f';
        ctx.fillRect(0, 0, 32, 32);
        return c.toDataURL('image/png').split(',')[1];
      }),
      'base64',
    ),
  });
  const crop = page.getByRole('dialog', { name: '裁剪头像' });
  await expect(crop).toBeVisible();
  await crop.getByRole('button', { name: '保存头像' }).click();
  await expect(upload.locator('img')).toHaveAttribute('src', /^data:image\/webp/);
  await page.reload();
  await simulation(page);
  await expect(page.locator('.avatar-upload img')).toHaveAttribute('src', /^data:image\/webp/);
  await nav(page, '聊天消息');
  await page.getByRole('button').filter({ hasText: '夏生 & 澪' }).click();
  await page.getByLabel('聊天身份').selectOption('user');
  await page.getByLabel('消息内容').fill('这是观察员的消息。');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.message.self').last().locator('img')).toHaveAttribute(
    'src',
    /^data:image\/webp/,
  );
  await page.getByLabel('聊天身份').selectOption('c-nagi');
  await page.getByLabel('消息内容').fill('现在扮演夏生。');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.message.self').last()).toContainText('凪 夏生');
  await expect(page.locator('.message.self').last().locator('img')).toHaveCount(0);
});
test('scene archive renders real structured records, all-person filters and timeline links on mobile', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await page.evaluate(async () => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    const cp = await db.checkpoints.get('w-harbor');
    const start = cp.simTime - 3600000,
      end = cp.simTime;
    const participants = ['c-nagi', 'c-mio'];
    await db.events.put({
      id: 'qa-shared',
      worldId: 'w-harbor',
      type: 'social',
      start,
      end,
      participants,
      location: '白昼咖啡',
      description: '两人一起喝咖啡',
      phone: 0.08,
      status: 'completed',
    });
    await db.scenes.put({
      id: 'qa-scene',
      worldId: 'w-harbor',
      eventId: 'qa-shared',
      title: '窗边的下午',
      location: '白昼咖啡',
      type: 'meal',
      participants,
      start,
      end,
      promptVersion: 1,
      phases: [
        {
          id: 'phase-qa-1',
          title: '入店',
          start,
          end: start + 1800000,
          participants,
          entries: [
            { kind: 'activity', at: start, text: '两人坐到窗边。' },
            { kind: 'dialogue', at: start + 1000, speakerId: 'c-nagi', text: '这里安静。' },
          ],
        },
        {
          id: 'phase-qa-2',
          title: '交谈',
          start: start + 1800000,
          end,
          participants,
          entries: [
            { kind: 'dialogue', at: start + 1801000, speakerId: 'c-mio', text: '饮品到了。' },
          ],
        },
      ],
    });
  });
  await nav(page, '线下观察');
  await expect(page.locator('.scene-card')).toContainText('窗边的下午');
  await page.locator('.check-list').getByLabel('凪 夏生').check();
  await page.locator('.check-list').getByLabel('森川 澪').check();
  await expect(page.locator('.scene-card')).toHaveCount(1);
  await page.locator('.check-list').getByLabel('白石 透').check();
  await expect(page.locator('.scene-card')).toHaveCount(0);
  await page.getByLabel('角色匹配方式').selectOption('any');
  await expect(page.locator('.scene-card')).toHaveCount(1);
  await page.locator('.scene-card').click();
  await expect(page.locator('.scene-dialogue')).toHaveCount(2);
  await expect(page.locator('.scene-action')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/mobile-scene-detail.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await nav(page, '生活时间轴');
  await page.locator('.life-log-event').filter({ hasText: '两人一起喝咖啡' }).click();
  await expect(page.getByRole('dialog', { name: '窗边的下午' })).toBeVisible();
  expect(errors).toEqual([]);
});
