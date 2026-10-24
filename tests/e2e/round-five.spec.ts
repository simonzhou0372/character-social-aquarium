import { test, expect, type Page } from '@playwright/test';
async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '先看看演示世界' }).click();
}
async function nav(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 760)
    await page.getByRole('button', { name: '打开导航' }).click();
  await page
    .locator('.sidebar nav')
    .getByRole('button', { name: '世界与团体', exact: true })
    .click();
}
for (const width of [1440, 390])
  test(`management, 100-person import and isolated removal at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await enter(page);
    await page.evaluate(async () => {
      const path = '/src/data/db.ts',
        seedPath = '/src/data/seed.ts';
      const { db } = await import(path);
      const { newCharacter } = await import(seedPath);
      await db.characters.bulkAdd(
        Array.from({ length: 100 }, (_, i) => ({
          ...newCharacter('候选' + String(i).padStart(3, '0')),
          id: 'candidate' + i,
          source: '测试作品',
        })),
      );
    });
    await nav(page);
    await page.getByRole('tab', { name: '世界人物', exact: true }).click();
    await page.getByRole('button', { name: '添加角色', exact: true }).click();
    await page.getByRole('button', { name: '从角色池导入', exact: true }).click();
    await page.getByLabel('来源作品').selectOption('测试作品');
    const select = page.getByRole('region', { name: '角色池', exact: true });
    await select.getByRole('button', { name: '全选全部', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认导入 100 名角色' })).toBeVisible();
    await select.getByLabel('搜索角色池').fill('候选00');
    await select.getByRole('button', { name: '反选当前结果' }).click();
    await expect(page.getByRole('button', { name: '确认导入 90 名角色' })).toBeVisible();
    await page.screenshot({ path: `test-results/five-import-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: '确认导入 90 名角色' }).click();
    await expect(page.getByText('已加入当前世界，全局资料与其他世界覆盖保持原样。')).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    const member = page.locator('.world-character-list > div').filter({ hasText: '候选010' });
    await member.getByRole('button', { name: '从当前世界移除', exact: true }).click();
    await page.getByRole('button', { name: '确认移除关联' }).click();
    await expect(member).toHaveCount(0);
    await page.reload();
    await nav(page);
    await page.getByRole('tab', { name: '世界人物', exact: true }).click();
    await expect(page.locator('.world-character-list')).not.toContainText('候选010');
  });
test('incremental expansion adds twenty characters only after preview acceptance and survives reload', async ({
  page,
}) => {
  await enter(page);
  await page.evaluate(async () => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    await db.profiles.put({
      id: 'api',
      provider: 'fixture',
      baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture',
      persistKey: true,
      key: 'fixture-test-not-secret',
      status: 'connected',
    });
  });
  let i = 0;
  await page.route('https://fixture.invalid/v1/chat/completions', async (route) => {
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                characters: Array.from({ length: 5 }, () => ({
                  name: '扩展角色' + ++i,
                  source: '原创',
                  bio: '新来的学生',
                })),
                groups: [],
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 100 },
      },
    });
  });
  await nav(page);
  await page.getByRole('button', { name: '添加内容', exact: true }).click();
  await page.getByRole('button', { name: 'AI 扩展世界', exact: true }).click();
  await page.getByLabel('希望增加什么？').fill('增加二十名原创学生');
  await page.getByRole('button', { name: '创建并分批生成' }).click();
  await expect(page.getByText('完整人物草稿 20 / 20 · 未写入世界')).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const p = '/src/data/db.ts';
      return (await import(p)).db.characters
        .filter((c: any) => c.name.startsWith('扩展角色'))
        .count();
    }),
  ).toBe(0);
  await page.reload();
  await nav(page);
  await page.getByRole('button', { name: '添加内容', exact: true }).click();
  await page.getByRole('button', { name: 'AI 扩展世界', exact: true }).click();
  await expect(page.getByText('完整人物草稿 20 / 20 · 未写入世界')).toBeVisible();
  await page.getByRole('button', { name: '确认应用当前草稿' }).click();
  await expect(page.getByText(/已增量保存/)).toBeVisible();
  expect(i).toBe(20);
});
test('novel mode requires an ending and persists enforced dependencies without altering world time', async ({
  page,
}) => {
  await enter(page);
  await nav(page);
  await page.getByRole('button', { name: '世界设定 / 小说模式', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '世界观设定' });
  await dialog.getByRole('switch', { name: '启用小说模式（保存时结局目标必填）' }).check();
  await dialog.getByRole('button', { name: '保存世界', exact: true }).click();
  await expect(dialog).toContainText('小说模式必须填写结局目标');
  await dialog
    .getByLabel('你希望这个世界最终走向怎样的结局？')
    .fill('乐队在经历磨合后完成一次合奏');
  await dialog.getByRole('button', { name: '保存世界', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.story-progress')).toContainText('乐队在经历磨合后完成一次合奏');
  const config = await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const w = await (await import(p)).db.worlds.get('w-harbor');
    return {
      major: w.majorEventSettings.enabled,
      evolution: w.evolutionSettings.enabled,
      ending: w.novel.ending,
    };
  });
  expect(config).toEqual({ major: true, evolution: true, ending: undefined });
});

for (const width of [1440, 390])
  test(`Touhou rebuild is visible above world cards and needs both confirmations at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await enter(page);
    await page.evaluate(async () => {
      const path = '/src/data/db.ts',
        presetPath = '/src/data/presets/touhou.ts';
      const { db } = await import(path),
        { TOUHOU_WORLD_ID } = await import(presetPath);
      const old = (await db.events.toArray())[0];
      await db.events.put({
        ...old,
        id: 'old-touhou-history',
        worldId: TOUHOU_WORLD_ID,
        participants: ['th:reimu'],
      });
      await db.settings.update('app', { worldId: TOUHOU_WORLD_ID });
    });
    await nav(page);
    const maintenance = page.getByRole('region', { name: '东方预设维护', exact: true });
    await expect(
      maintenance.getByRole('button', { name: '删除旧东方历史并重建此世界', exact: true }),
    ).toBeVisible();
    expect(
      await maintenance.evaluate(
        (el) =>
          el.getBoundingClientRect().top <
          document.querySelector('.world-grid')!.getBoundingClientRect().top,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: '删除旧东方历史并重建此世界', exact: true }).click();
    await page.getByRole('button', { name: '继续确认', exact: true }).click();
    const remains = () =>
      page.evaluate(async () => {
        const path = '/src/data/db.ts';
        return !!(await (await import(path)).db.events.get('old-touhou-history'));
      });
    expect(await remains()).toBe(true);
    await page.getByRole('button', { name: '确认永久清除并重建', exact: true }).click();
    await expect(
      page.getByText('已重建为 v2 预设，当前暂停；其他世界保留。', { exact: true }),
    ).toBeVisible();
    expect(await remains()).toBe(false);
    expect(
      await page.evaluate(async () => {
        const path = '/src/data/db.ts';
        return (
          (await (await import(path)).db.events.where('worldId').equals('w-harbor').count()) > 0
        );
      }),
    ).toBe(true);
  });
