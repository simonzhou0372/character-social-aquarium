import { test, expect, type Page } from '@playwright/test';
async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '先看看演示世界' }).click();
}
async function settings(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 760)
    await page
      .locator('.mobile-bottom-nav')
      .getByRole('button', { name: '设置', exact: true })
      .click();
  else await page.getByRole('button', { name: '世界设置' }).click();
}
async function nav(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1440) < 760)
    await page.getByRole('button', { name: '打开导航' }).click();
  await page.locator('.sidebar nav').getByRole('button', { name, exact: true }).click();
}
for (const width of [1440, 390]) {
  test(`usage ledger, confirmed prices and budget persist at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    let calls = 0;
    await page.route('https://fixture.invalid/v1/chat/completions', async (route) => {
      calls++;
      await route.fulfill({
        json: {
          choices: [
            { message: { content: '{"description":"继续原有活动。"}' }, finish_reason: 'stop' },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
    });
    await enter(page);
    await page.evaluate(async () => {
      const path = '/src/data/db.ts';
      const { db } = await import(path);
      await db.profiles.put({
        id: 'api',
        provider: 'fixture',
        model: 'deepseek-flash',
        baseUrl: 'https://fixture.invalid/v1',
        persistKey: true,
        key: 'fixture-not-secret',
        status: 'connected',
        deepSeekCompatible: true,
      });
    });
    await settings(page);
    await page.getByRole('button', { name: '用量分析', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'AI 用量分析' })).toBeVisible();
    await page.getByRole('button', { name: '预填当前官方模型参考价' }).click();
    await expect(page.getByLabel('定价模型', { exact: true })).toHaveValue('deepseek-flash');
    await page.getByRole('button', { name: '保存定价前确认' }).click();
    await page
      .getByRole('dialog', { name: '确认当前模型计费配置' })
      .getByRole('button', { name: '确认保存定价' })
      .click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = '/src/data/db.ts';
          return (await (await import(path)).db.settings.get('app')).costControls.prices.length;
        }),
      )
      .toBe(1);
    await page.evaluate(async () => {
      const dpath = '/src/data/db.ts',
        ppath = '/src/ai/provider.ts',
        opath = '/src/ai/orchestrator.ts',
        spath = '/src/ai/prompts.ts';
      const { db } = await import(dpath),
        { CompatibleProvider } = await import(ppath),
        { budgetedCompletion } = await import(opath),
        { getPrompts } = await import(spath);
      const profile = await db.profiles.get('api');
      await budgetedCompletion(
        db,
        new CompatibleProvider(profile),
        [{ role: 'user', content: '只返回 JSON 活动描述' }],
        'w-harbor',
        'life',
        await getPrompts(db),
      );
    });
    expect(calls).toBe(1);
    await expect(page.getByText(/缓存命中率\s*80\.0%/)).toBeVisible();
    await page.getByLabel('AI推理策略').selectOption('user');
    await page.getByLabel('人民币预算周期').selectOption('virtualDay');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = '/src/data/db.ts';
          return (await (await import(path)).db.settings.get('app')).costControls.budget.period;
        }),
      )
      .toBe('virtualDay');
    await page.getByLabel('人民币预算上限').fill('1');
    await page.reload();
    await settings(page);
    await page.getByRole('button', { name: '用量分析', exact: true }).click();
    await expect(page.getByLabel('AI推理策略')).toHaveValue('user');
    await expect(page.getByLabel('人民币预算周期')).toHaveValue('virtualDay');
    await expect(page.getByText(/缓存命中率\s*80\.0%/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
  test(`confirmed death changes the world and keeps archive visible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await enter(page);
    await page.evaluate(async () => {
      const dpath = '/src/data/db.ts',
        npath = '/src/core/novel-types.ts',
        rpath = '/src/core/narrative-types.ts';
      const { db } = await import(dpath),
        { NovelSchema } = await import(npath),
        { LifeRulesSchema } = await import(rpath);
      const now = Date.now();
      await db.worlds.update('w-harbor', {
        novel: NovelSchema.parse({
          enabled: true,
          goal: '在险情之后重新理解生活',
          lifeRules: LifeRulesSchema.parse({ allowDeath: true }),
        }),
      });
      const e = {
        id: 'browser-fatal',
        worldId: 'w-harbor',
        type: 'major',
        start: now - 3600000,
        end: now - 1000,
        participants: ['c-nagi', 'c-mio'],
        location: '灯塔',
        description: '险情中伤势恶化，确认死亡。',
        phone: 0.8,
        status: 'completed',
        lethalCandidateIds: ['c-nagi'],
      };
      await db.events.put(e);
      await db.majorEvents.put({
        id: e.id,
        eventId: e.id,
        worldId: e.worldId,
        title: '灯塔险情',
        timestamp: e.start,
        participantIds: e.participants,
        groupIds: [],
        importance: 1,
        status: 'occurred',
        type: 'hazard',
        description: e.description,
        consequences: [],
      });
      await db.states.put({
        id: 'w-harbor:c-nagi',
        worldId: 'w-harbor',
        characterId: 'c-nagi',
        eventId: e.id,
        activity: '共同应对险情',
        location: e.location,
        phone: 0.8,
        mood: 0,
        lastAction: 0,
        lastPhone: 0,
      });
      await db.checkpoints.update('w-harbor', { paused: true, simTime: now });
    });
    await nav(page, '世界与团体');
    const panel = page.locator('.narrative-panel');
    await panel.getByText('按已发生的重大事件确认状态变化', { exact: true }).click();
    await panel.getByLabel('状态变化对象', { exact: true }).selectOption('c-nagi');
    await panel.getByLabel('目标状态').selectOption('dead');
    await panel.getByLabel('变化来源重大事件').selectOption('browser-fatal');
    await panel.getByLabel('事件原文依据（至少4字）').fill('伤势恶化，确认死亡');
    await panel.getByLabel('变化原因').fill('险情中的伤势和现场救援结果已经确认。');
    await panel.getByRole('button', { name: '预览并确认变化' }).click();
    await page
      .getByRole('dialog', { name: '确认记录具有长期后果的变化' })
      .getByRole('button', { name: '确认记录变化' })
      .click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = '/src/data/db.ts';
          return (
            await (await import(path)).db.memberships
              .where('[worldId+characterId]')
              .equals(['w-harbor', 'c-nagi'])
              .first()
          ).life?.status;
        }),
      )
      .toBe('dead');
    await expect(panel.getByText(/凪 夏生：确认死亡/)).toBeVisible();
    await page.reload();
    await nav(page, '角色图鉴');
    const card = page
      .locator('.character-card')
      .filter({ has: page.getByRole('heading', { name: '凪 夏生', exact: true }) });
    await expect(card.locator('.tiny-status')).toHaveText('确认死亡');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
