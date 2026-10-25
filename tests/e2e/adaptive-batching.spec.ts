import { test, expect } from '@playwright/test';
for (const width of [1440, 390])
  test(`adaptive queued work, diagnostics and persisted pause at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    let calls = 0;
    await page.route('https://fixture.invalid/v1/chat/completions', async (route) => {
      calls++;
      const request = route.request().postDataJSON(),
        payload = JSON.parse(request.messages[1].content);
      const response = payload.batchId
        ? {
            batchId: payload.batchId,
            results: payload.tasks.map((t: any) => ({
              taskId: t.taskId,
              result: { description: '按既定安排共同行动。' },
            })),
          }
        : { description: '按既定安排共同行动。' };
      await route.fulfill({
        json: {
          choices: [{ message: { content: JSON.stringify(response) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 60 },
        },
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: '先看看演示世界' }).click();
    await page.evaluate(async () => {
      const p = '/src/data/db.ts',
        s = '/src/ai/prompts.ts',
        b = '/src/core/adaptive-batching.ts';
      const { db } = await import(p),
        { defaultPrompts } = await import(s),
        { contentPlan } = await import(b);
      const at = Date.now(),
        snapshot = defaultPrompts(at);
      await db.profiles.put({
        id: 'api',
        provider: 'fixture',
        baseUrl: 'https://fixture.invalid/v1',
        model: 'fixture',
        persistKey: true,
        key: 'fixture-not-secret',
        status: 'connected',
        contextBudgetTokens: 32000,
        outputBudgetTokens: 8192,
      });
      await db.settings.update('app', { unlimitedUsage: true });
      for (let i = 0; i < 3; i++) {
        const event = {
          id: 'adaptive-e-' + i,
          worldId: 'w-harbor',
          start: at - 3600000,
          end: at - 1000,
          type: 'social',
          participants: ['c-nagi', 'c-mio'],
          location: '咖啡馆',
          description: '共同活动',
          phone: 0.3,
          status: 'completed',
        };
        await db.events.put(event);
        await db.contentJobs.put({
          id: 'adaptive-j-' + i,
          worldId: 'w-harbor',
          kind: 'life',
          event,
          at: event.start,
          snapshot,
          recovery: false,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: 0,
          plan: contentPlan('life', 1, snapshot, event),
        });
      }
      await db.checkpoints.update('w-harbor', {
        mode: 'live',
        paused: false,
        speed: 1000,
        simTime: at,
        realTime: at + 86400000,
        clockAnchor: { simTime: at, realTime: at + 86400000 },
      });
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const p = '/src/data/db.ts';
          return (await import(p)).db.contentJobs
            .filter((j: any) => j.id.startsWith('adaptive-j-') && j.status === 'complete')
            .count();
        }),
      )
      .toBe(3);
    expect(calls).toBe(1);
    if (width < 760) await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByRole('button', { name: '世界设置' }).click();
    await page.getByRole('button', { name: '模拟器', exact: true }).click();
    await page.getByText('AI 生成性能 · 高级诊断', { exact: true }).click();
    await expect(page.getByRole('switch', { name: '自动优化高倍速生成' })).toBeChecked();
    await expect(page.getByText(/高倍速自适应批处理/)).toBeVisible();
    await page.getByRole('switch', { name: '自动优化高倍速生成' }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const p = '/src/data/db.ts';
          return (await (await import(p)).db.settings.get('app')).adaptiveBatching;
        }),
      )
      .toBe(false);
    await page.locator('.world-hud').getByRole('button', { name: /暂停/ }).click();
    await page.reload();
    await expect(page.locator('.world-hud')).toContainText('已暂停');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
