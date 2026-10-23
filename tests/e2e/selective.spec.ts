import { test, expect, type Page } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
});
async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '先看看演示世界' }).click();
}
async function observation(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 760)
    await page
      .locator('.mobile-bottom-nav')
      .getByRole('button', { name: '设置', exact: true })
      .click();
  else await page.locator('.settings-nav').click();
  await page.getByRole('button', { name: '观察管理', exact: true }).click();
}
async function nav(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) < 760)
    await page.getByRole('button', { name: '打开导航' }).click();
  await page.locator('.sidebar nav').getByRole('button', { name }).click();
}
test('selective scope actually persists from the settings editor on mobile without overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await observation(page);
  await page.getByLabel('观察模式').selectOption('selective');
  await page.getByRole('checkbox', { name: /凪 夏生/ }).check();
  await page.getByRole('button', { name: '保存观察范围', exact: true }).click();
  await expect(page.getByText('观察范围已保存，已覆盖的历史不会重复补全。')).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const p = '/src/data/db.ts';
      return (await (await import(p)).db.observationConfigs.get('w-harbor')).characterIds;
    }),
  ).toEqual(['c-nagi']);
  await page.reload();
  await expect(page.locator('.observation-summary')).toContainText('静默 4 名角色');
  await observation(page);
  await expect(page.getByLabel('观察模式')).toHaveValue('selective');
  await expect(page.getByRole('checkbox', { name: /凪 夏生/ })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-selective-observation.png', fullPage: true });
});
test('newly observed characters recover three virtual days with durable visible progress', async ({
  page,
}) => {
  await enter(page);
  await page.evaluate(async () => {
    const dp = '/src/data/db.ts',
      op = '/src/core/selective-observation.ts';
    const { db } = await import(dp),
      { saveObservation, fullObservation } = await import(op);
    await saveObservation({ ...fullObservation('w-harbor'), mode: 'selective' });
    const cp = await db.checkpoints.get('w-harbor');
    await db.checkpoints.update(cp.id, {
      simTime: cp.simTime + 5 * 86400000,
      clockAnchor: { simTime: cp.simTime + 5 * 86400000, realTime: Date.now() },
    });
  });
  await observation(page);
  await page.getByRole('checkbox', { name: /凪 夏生/ }).check();
  await page.getByRole('button', { name: '保存观察范围', exact: true }).click();
  await expect(page.getByText('已保存，历史补全已排队。')).toBeVisible();
  await expect(
    page.getByText('世界当前已暂停，回溯任务会等待继续运行。', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: '继续世界', exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const p = '/src/data/db.ts';
          return (await (await import(p)).db.backfillJobs.toArray())[0]?.status;
        }),
      { timeout: 15000 },
    )
    .toBe('complete');
  await expect(page.getByText('历史补全完成', { exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const { db } = await import(p);
    const job = (await db.backfillJobs.toArray())[0];
    return {
      length: job.end - job.start,
      events: job.eventCount,
      intervals: job.completedIntervals.length,
    };
  });
  expect(result.length).toBe(3 * 86400000);
  expect(result.events).toBeGreaterThan(0);
  expect(result.intervals).toBe(3);
});
test('fictional yearly reports expose real facts and safe links with independent toggles', async ({
  page,
}) => {
  await enter(page);
  await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const { db } = await import(p);
    const cp = await db.checkpoints.get('w-harbor');
    await db.worlds.update(cp.id, {
      calendarAnchor: {
        tick: cp.simTime,
        date: { year: 23456, month: 12, day: 30, hour: 0, minute: 0 },
      },
      era: '帝国历',
    });
  });
  await nav(page, '世界报告');
  await page.getByText('海盐市 · 平行日常 · 定期报告开关').click();
  await page.getByRole('switch', { name: '启用日报', exact: true }).check();
  await page.getByRole('switch', { name: '启用年报', exact: true }).check();
  await expect(page.getByRole('switch', { name: '启用周报', exact: true })).not.toBeChecked();
  await page.evaluate(async () => {
    const p = '/src/data/db.ts',
      rp = '/src/core/reports.ts';
    const { db } = await import(p);
    const cp = await db.checkpoints.get('w-harbor');
    await db.events.put({
      id: 'report-fixture-event',
      worldId: cp.id,
      type: 'social',
      start: cp.simTime + 3600000,
      end: cp.simTime + 7200000,
      participants: ['c-nagi', 'c-mio'],
      location: '咖啡店',
      description: '两人一起确认了摄影展的计划。',
      phone: 0.3,
      status: 'completed',
      importance: 0.95,
    });
    await db.checkpoints.update(cp.id, {
      simTime: cp.simTime + 4 * 86400000,
      clockAnchor: { simTime: cp.simTime + 4 * 86400000, realTime: Date.now() },
      paused: false,
    });
    await (await import(rp)).archiveReports(cp.id);
  });
  await page.getByLabel('报告类型').selectOption('yearly');
  await expect(page.locator('.report-card')).toHaveCount(1);
  await page.locator('.report-card').getByRole('button', { name: '查看报告' }).click();
  await expect(page.getByRole('dialog')).toContainText('摄影展的计划');
  await expect(page.getByRole('dialog')).toContainText('帝国历 23456');
  await page.getByRole('dialog').getByRole('button', { name: '查看原始记录' }).click();
  await expect(page.getByRole('heading', { name: /没有被看见的时间/ })).toBeVisible();
});
test('world-scoped evolution locks and dependent undo are usable from the character editor', async ({
  page,
}) => {
  await enter(page);
  await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const { db } = await import(p);
    await db.worlds.update('w-harbor', {
      evolutionSettings: { enabled: true, rules: '只允许有依据的缓慢变化' },
    });
  });
  await nav(page, '角色图鉴');
  await page
    .locator('.character-card')
    .filter({ hasText: '凪 夏生' })
    .getByRole('button', { name: '查看 / 编辑', exact: true })
    .click();
  await page.getByText('人物变化记录与设定锁定 · 当前世界').click();
  await page.getByRole('checkbox', { name: '允许自然演化：社交主动倾向', exact: true }).check();
  await page.evaluate(async () => {
    const p = '/src/data/db.ts',
      ep = '/src/core/evolution.ts';
    const { db } = await import(p);
    const cp = await db.checkpoints.get('w-harbor'),
      c = await db.characters.get('c-nagi');
    await db.checkpoints.update(cp.id, { simTime: cp.simTime + 86400000 });
    const ids = ['one', 'two', 'three'];
    await db.events.bulkPut(
      ids.map((id, i) => ({
        id: 'ui-growth-' + id,
        worldId: cp.id,
        type: 'social',
        start: cp.simTime + i * 3600000,
        end: cp.simTime + (i + 1) * 3600000,
        participants: [c.id, 'c-mio'],
        location: '活动室',
        description: '持续共同完成摄影活动',
        phone: 0.2,
        status: 'completed',
        importance: 0.8,
      })),
    );
    await (
      await import(ep)
    ).applyEvolution(cp.id, {
      characterId: c.id,
      field: 'initiative',
      newValue: c.initiative + 0.03,
      sourceEventIds: ids.map((id) => 'ui-growth-' + id),
      reason: '连续合作使主动性缓慢增加',
    });
  });
  await expect(page.getByRole('dialog')).toContainText('连续合作使主动性缓慢增加');
  await page.getByRole('button', { name: '撤销此次变化', exact: true }).click();
  await page
    .getByRole('dialog', { name: '撤销人物变化' })
    .getByRole('button', { name: '确认撤销', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: '编辑角色资料' })).toContainText('已撤销');
});
