import { prepareSmallWorld } from './helpers/small-world';
import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => prepareSmallWorld(page));
for (const width of [1440, 844])
  test(`bounded history, indexed navigation and local export ${width}`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: width === 844 ? 390 : 900 });
    await page.goto('/');
    await page.getByRole('button', { name: /先看看演示世界|先读这份七日存档/ }).click();
    await page.evaluate(async () => {
      const path = '/src/data/db.ts';
      const { db } = await import(path);
      await db.checkpoints.toCollection().modify({ paused: true });
      const c = await db.conversations.get('conv-cafe');
      await db.messages.where('conversationId').equals(c.id).delete();
      for (let start = 0; start < 50000; start += 1000)
        await db.messages.bulkPut(
          Array.from({ length: 1000 }, (_, j) => ({
            id: `long-${String(start + j).padStart(6, '0')}`,
            conversationId: c.id,
            senderId: 'c-nagi',
            text: `历史消息 ${start + j} ` + '测试动态高度。'.repeat(j % 8),
            simAt: c.createdAt + Math.floor((start + j) / 3) * 1000,
            realAt: 1,
            seq: start + j + 1,
            source: 'ai',
          })),
        );
    });
    const nav = page.getByRole('button', { name: '打开导航' });
    if (await nav.isVisible()) await nav.click();
    await page
      .locator('.sidebar nav')
      .getByRole('button', { name: '聊天消息', exact: true })
      .click();
    await page.locator('.conversation-item').filter({ hasText: '白昼集合点' }).click();
    await expect(page.locator('[data-message-id="long-049999"]')).toBeAttached();
    expect(await page.locator('[data-message-id]').count()).toBeLessThan(45);
    const feed = page.locator('.message-feed');
    await feed.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(500);
    const earliest = await page
      .locator('[data-message-id]')
      .first()
      .getAttribute('data-message-id');
    expect(earliest! < 'long-049960').toBe(true);
    const anchor = await feed.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const row = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (r) => r.getBoundingClientRect().top >= box.top,
      );
      return row ? { id: row.dataset.messageId!, top: row.getBoundingClientRect().top } : undefined;
    });
    await page.evaluate(async () => {
      const path = '/src/data/db.ts';
      const { db } = await import(path);
      const m = await db.messages.get('long-049999');
      await db.messages.put({
        ...m,
        id: 'long-new',
        seq: 50001,
        simAt: m.simAt + 1000,
        text: '刚到的新消息',
      });
    });
    await page.waitForTimeout(350);
    if (anchor)
      expect(
        Math.abs(
          (await page.locator(`[data-message-id="${anchor.id}"]`).boundingBox())!.y - anchor.top,
        ),
      ).toBeLessThan(8);
    expect(await page.locator('[data-message-id]').count()).toBeLessThan(45);
    if (width === 1440 && anchor) {
      await page.locator('.conversation-item').filter({ hasText: '夏生 & 澪' }).click();
      await page.locator('.conversation-item').filter({ hasText: '白昼集合点' }).click();
      await page.waitForTimeout(350);
      await expect(page.locator(`[data-message-id="${anchor.id}"]`)).toBeAttached();
      expect(
        Math.abs(
          (await page.locator(`[data-message-id="${anchor.id}"]`).boundingBox())!.y - anchor.top,
        ),
      ).toBeLessThan(8);
    }
    const dimensions = await feed.boundingBox();
    expect(dimensions!.height).toBeGreaterThan(80);
    console.log('BOUNDED CHAT', {
      width,
      dom: await page.locator('[data-message-id]').count(),
      feedHeight: dimensions!.height,
    });
    await page.getByRole('button', { name: '历史导航', exact: true }).click();
    await page.getByRole('button', { name: '回到最顶', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-message-id="long-000000"]')).toBeAttached();
    await page.getByRole('button', { name: '选择消息', exact: true }).click();
    await page.getByRole('checkbox', { name: '选择消息 long-000000', exact: true }).check();
    await page.getByRole('button', { name: '导出选中消息', exact: true }).click();
    await expect(page.getByText('已完成 · 1 条消息 · 1 张图片')).toBeVisible({ timeout: 30000 });
    await expect(page.getByAltText('聊天导出第 1 页，点击放大')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 ZIP', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.zip$/);
    await page.getByRole('button', { name: '删除临时结果并关闭' }).click();
    await page.screenshot({ path: `test-results/chat-history-${width}.png` });
  });

test('offline scene starts in performance mode and resumes saved dialogue without API', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /先看看演示世界|先读这份七日存档/ }).click();
  await page.evaluate(async () => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    const c = await db.conversations.get('conv-cafe');
    await db.checkpoints.toCollection().modify({ paused: true });
    const start = c.createdAt;
    await db.scenes.put({
      id: 'performance-test',
      worldId: c.worldId,
      eventId: 'offline-fixture',
      title: '保存的演出',
      start,
      end: start + 60000,
      participants: c.participants,
      location: '咖啡店',
      type: 'social',
      promptVersion: 1,
      generationStatus: 'complete',
      phases: [
        {
          id: 'phase',
          title: '相聚',
          start,
          end: start + 60000,
          participants: c.participants,
          entries: [
            { kind: 'dialogue', speakerId: c.participants[0], at: start, text: '第一句保存对白' },
            {
              kind: 'dialogue',
              speakerId: c.participants[1],
              at: start + 1000,
              text: '第二句保存对白',
            },
          ],
        },
      ],
    });
  });
  let requests = 0;
  page.on('request', (r) => {
    if (/chat\/completions/.test(r.url())) requests++;
  });
  await page.locator('.sidebar nav').getByRole('button', { name: '线下观察', exact: true }).click();
  await page.getByText('保存的演出', { exact: true }).click();
  await expect(page.getByRole('tab', { name: '演出阅读' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.stage-line')).toContainText('第一句保存对白');
  await page.getByRole('button', { name: '下一句', exact: true }).click();
  await expect(page.locator('.stage-line')).toContainText('第二句保存对白');
  await page.keyboard.press('Escape');
  await page.getByText('保存的演出', { exact: true }).click();
  await page.getByRole('button', { name: '继续上次位置' }).click();
  await expect(page.locator('.stage-line')).toContainText('第二句保存对白');
  expect(requests).toBe(0);
});

for (const [width, height] of [
  [1440, 810],
  [2560, 1080],
  [390, 844],
])
  test(`chat viewport layout ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByRole('button', { name: /先看看演示世界|先读这份七日存档/ }).click();
    if (await page.getByRole('button', { name: '打开导航' }).isVisible())
      await page.getByRole('button', { name: '打开导航' }).click();
    await page
      .locator('.sidebar nav')
      .getByRole('button', { name: '聊天消息', exact: true })
      .click();
    await page.locator('.conversation-item').filter({ hasText: '白昼集合点' }).click();
    const feed = await page.locator('.message-feed').boundingBox(),
      composer = await page.locator('.composer').boundingBox();
    expect(feed!.height).toBeGreaterThan(100);
    await expect
      .poll(async () => {
        const box = await page.locator('.composer').boundingBox();
        return box!.y + box!.height;
      })
      .toBeLessThanOrEqual(height - (width < 760 ? 64 : 0));
    await page.screenshot({ path: `test-results/chat-viewport-${width}.png` });
  });
