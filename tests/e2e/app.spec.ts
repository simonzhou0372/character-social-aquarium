import { test, expect, type Page } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
});
async function enter(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '先看看演示世界' }).click();
}
async function prompts(page: Page) {
  await page.getByRole('button', { name: '世界设置' }).click();
  await page.getByRole('button', { name: '提示词管理', exact: true }).click();
}
test('first launch, prompt editing, preview reset, refresh persistence and versioning', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await enter(page);
  await expect(page.getByRole('heading', { name: '世界在转，他们也在生活' })).toBeVisible();
  await prompts(page);
  const editor = page.getByRole('textbox', { name: '角色行为与语言规范', exact: true });
  await expect(editor).toHaveValue(/独立人格/);
  await editor.fill('只用简短的日语交流。');
  const card = page.locator('.prompt-card').first();
  await card.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByText('配置版本 v2')).toBeVisible();
  await page.reload();
  await prompts(page);
  await expect(editor).toHaveValue('只用简短的日语交流。');
  await card.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('默认提示词预览');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toHaveValue('只用简短的日语交流。');
  await card.getByRole('button', { name: '恢复默认', exact: true }).click();
  await page.getByRole('button', { name: '确认恢复' }).click();
  await expect(editor).toHaveValue(/独立人格/);
  expect(errors).toEqual([]);
});
test('prompt JSON export/import and six toggles', async ({ page }) => {
  await enter(page);
  await prompts(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出提示词' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('aquarium-prompts.json');
  const card = page.locator('.prompt-card').nth(2);
  await card.getByRole('switch').uncheck();
  await card.getByRole('button', { name: '保存修改' }).click();
  await expect(card.getByRole('switch')).not.toBeChecked();
  await page.reload();
  await prompts(page);
  await expect(page.locator('.prompt-card').nth(2).getByRole('switch')).not.toBeChecked();
});
test('chat unread remains separate from virtual readers and roleplay messages preserve identity', async ({
  page,
}) => {
  await enter(page);
  await page.getByRole('button', { name: '聊天消息' }).click();
  await page.getByRole('button').filter({ hasText: '夏生 & 澪' }).click();
  await expect(page.locator('.message-bubble')).toHaveCount(2);
  await page.getByLabel('聊天身份').selectOption('c-nagi');
  await page.getByLabel('消息内容').fill('这句话是用户控制的夏生说的。');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.message.self .message-bubble')).toContainText(
    '这句话是用户控制的夏生说的。',
  );
  await expect(page.locator('.message.self .message-label')).toContainText('凪 夏生');
  await page.reload();
  await page.getByRole('button', { name: '聊天消息' }).click();
  await page.getByRole('button').filter({ hasText: '夏生 & 澪' }).click();
  await expect(page.locator('.message-bubble')).toHaveCount(3);
});
test('desktop management, navigation and screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enter(page);
  await page.screenshot({ path: 'test-results/desktop-home.png', fullPage: true });
  await page.getByRole('button', { name: '角色图鉴', exact: true }).first().click();
  await page.getByRole('button', { name: '添加角色' }).click();
  await page.getByRole('textbox', { name: '角色名称', exact: true }).fill('测试访客');
  await page.getByRole('button', { name: '保存角色' }).click();
  await expect(page.getByRole('heading', { name: '测试访客' })).toBeVisible();
  await page.getByRole('button', { name: '关系网络' }).click();
  await expect(page.getByRole('img', { name: '有向人物关系图' })).toBeVisible();
  await page.getByRole('button', { name: '生活时间轴' }).click();
  await page.getByLabel('时间轴展示').selectOption('all');
  await expect(page.locator('.life-log-event').first()).toBeVisible();
  await prompts(page);
  await expect(page.locator('.prompt-card')).toHaveCount(7);
  await page.screenshot({ path: 'test-results/desktop-prompts.png', fullPage: true });
});
test('mobile single-column navigation, prompt editor, chat and no horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await page.screenshot({ path: 'test-results/mobile-home.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.mobile-bottom-nav').getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '提示词管理', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: '角色行为与语言规范', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-prompts.png', fullPage: true });
  await page.locator('.mobile-bottom-nav').getByRole('button', { name: '聊天消息' }).click();
  await page.getByRole('button').filter({ hasText: '白昼集合点' }).click();
  await expect(page.locator('.chat-main')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-chat.png', fullPage: true });
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await expect(page.locator('.conversation-list')).toBeVisible();
});
test('compatible API protocol uses latest global prompt and emits separate validated bubbles', async ({
  page,
}) => {
  const seen: string[] = [];
  await page.route('https://fixture.invalid/v1/chat/completions', async (route) => {
    const req = route.request().postDataJSON();
    seen.push(req.messages[0].content);
    const speaker = req.messages[0].content.match(/"speakerId":"([^"]+)"/)?.[1];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: speaker
                ? JSON.stringify({
                    speakerId: speaker,
                    messages: ['風が強いね。', '上着を持ってきた。'],
                    offsets: [0, 3],
                  })
                : 'OK',
            },
          },
        ],
        usage: { prompt_tokens: 60, completion_tokens: 20 },
      }),
    });
  });
  await enter(page);
  await page.getByRole('button', { name: '世界设置' }).click();
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-model');
  await page.getByLabel('API Key', { exact: true }).fill('test-fixture-not-a-secret');
  await page
    .getByRole('textbox', { name: 'API Base URL', exact: true })
    .fill('https://fixture.invalid/v1');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByText('连接成功，可以使用角色 AI 功能。')).toBeVisible();
  await page.getByRole('button', { name: '保存配置' }).click();
  await page.getByRole('button', { name: '提示词管理', exact: true }).click();
  await page
    .getByRole('textbox', { name: '角色行为与语言规范', exact: true })
    .fill('只能使用日语，回复简短。');
  await page.locator('.prompt-card').first().getByRole('button', { name: '保存修改' }).click();
  await page.getByRole('button', { name: '聊天消息' }).click();
  await page.getByRole('button').filter({ hasText: '夏生 & 澪' }).click();
  await page.getByLabel('聊天身份').selectOption('c-mio');
  await page.getByLabel('消息内容').fill('外面冷吗？');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.message-bubble')).toHaveCount(5);
  await expect(page.locator('.message-bubble').nth(3)).toHaveText('風が強いね。');
  await expect(page.locator('.message-bubble').nth(4)).toHaveText('上着を持ってきた。');
  expect(seen.at(-1)).toContain('只能使用日语');
  expect(seen.at(-1)).toContain('内部结构始终返回有效 JSON');
});
test('prompt import previews changes before replacement, global reset is confirmed', async ({
  page,
}) => {
  await enter(page);
  await prompts(page);
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出提示词' }).click();
  const downloaded = await waiting;
  const path = await downloaded.path();
  await page.locator('.prompt-manager input[type=file]').setInputFiles(path!);
  await expect(page.getByRole('dialog', { name: '导入并替换全局提示词？' })).toBeVisible();
  await page.getByRole('button', { name: '确认恢复' }).click();
  await expect(page.getByText('提示词导入完成，后续请求采用新版本。')).toBeVisible();
  await page.getByRole('button', { name: '恢复全部默认' }).click();
  await expect(page.getByRole('dialog')).toContainText('自定义提示词');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.prompt-card')).toHaveCount(7);
});
test('two tabs share persistence, exclusive work releases on close and recovery is idempotent', async ({
  page,
  context,
}) => {
  await enter(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('heading', { name: '世界在转，他们也在生活' })).toBeVisible();
  const target = await page.evaluate(async () => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    const cp = await db.checkpoints.get('w-harbor');
    await db.checkpoints.update('w-harbor', { realTime: Date.now() - 3600000, paused: false });
    return cp.simTime + 3599000;
  });
  await page.close();
  await expect
    .poll(
      async () =>
        second.evaluate(async () => {
          const p = '/src/data/db.ts',
            e = '/src/core/engine.ts';
          const { db } = await import(p);
          const { runWorld } = await import(e);
          await runWorld('w-harbor', { now: Date.now() });
          return (await db.checkpoints.get('w-harbor')).simTime;
        }),
      { timeout: 15000 },
    )
    .toBeGreaterThanOrEqual(target);
  const result = await second.evaluate(async () => {
    const p = '/src/data/db.ts',
      e = '/src/core/engine.ts';
    const { db } = await import(p);
    const { runWorld } = await import(e);
    await db.checkpoints.update('w-harbor', { paused: true });
    const before = await db.events.count();
    await runWorld('w-harbor', { now: Date.now() });
    return { before, after: await db.events.count(), events: await db.events.toArray() };
  });
  expect(result.before).toBeGreaterThan(9);
  expect(result.after).toBe(result.before);
  expect(new Set(result.events.map((e: { id: string }) => e.id)).size).toBe(result.events.length);
});

test('explicit pause freezes the checkpoint and abandons unfinished future work', async ({
  page,
}) => {
  await enter(page);
  const result = await page.evaluate(async () => {
    const p = '/src/data/db.ts',
      e = '/src/core/engine.ts';
    const { db, withWorldLock } = await import(p);
    const { setRunning } = await import(e);
    const cp = await db.checkpoints.get('w-harbor');
    await db.checkpoints.update('w-harbor', {
      recoveryStart: cp.simTime,
      recoveryTarget: cp.simTime + 3600000,
    });
    const hold = withWorldLock(
      'w-harbor',
      () => new Promise((resolve) => setTimeout(resolve, 200)),
      true,
    );
    const at = performance.now();
    await setRunning('w-harbor', false, 'demo');
    await hold;
    return { elapsed: performance.now() - at, cp: await db.checkpoints.get('w-harbor') };
  });
  expect(result.elapsed).toBeGreaterThanOrEqual(170);
  expect(result.cp.paused).toBe(true);
  expect(result.cp.recoveryTarget).toBeUndefined();
});
