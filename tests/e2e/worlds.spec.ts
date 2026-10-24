import { test, expect, type Page } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
});
async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '先看看演示世界' }).click();
}
async function worlds(page: Page) {
  await page.getByRole('button', { name: '世界与团体' }).click();
}
async function fixtureProfile(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/data/db.ts';
    const { db } = await import(path);
    await db.profiles.put({
      id: 'api',
      provider: 'fixture',
      baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture',
      persistKey: true,
      key: 'fixture-not-a-secret',
      status: 'connected',
    });
  });
}
test('world page creates and edits characters, creates a world suite, and confirms external group members', async ({
  page,
}) => {
  await enter(page);
  await worlds(page);
  await page.getByRole('tab', { name: '世界人物', exact: true }).click();
  await page.getByRole('button', { name: '添加角色', exact: true }).click();
  await page.getByRole('button', { name: '创建新角色', exact: true }).click();
  await page.getByRole('button', { name: '打开角色创建器', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).fill('世界页新角色');
  await page.getByRole('button', { name: '保存角色' }).click();
  await page
    .getByRole('dialog', { name: '添加内容' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(page.locator('.world-character-list')).toContainText('世界页新角色');
  await page.locator('.world-character-list button').filter({ hasText: '世界页新角色' }).click();
  await page.getByLabel('角色名称', { exact: true }).fill('世界页已编辑');
  await page.getByRole('button', { name: '保存角色' }).click();
  await expect(page.locator('.world-character-list')).toContainText('世界页已编辑');
  await page.getByRole('button', { name: '添加世界观', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '世界观设定' });
  await dialog.getByLabel('世界名称', { exact: true }).fill('新世界验收');
  await dialog.getByRole('checkbox', { name: '晚潮乐队', exact: true }).check();
  await dialog.getByLabel('批量新增角色（每行一个名字）', { exact: true }).fill('新人甲\n新人乙');
  await dialog
    .getByLabel('批量新增团体（每行：团体名：角色名、角色名）', { exact: true })
    .fill('摄影社：新人甲、新人乙');
  await dialog.getByRole('button', { name: '保存世界' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.world-character-list')).toContainText('新人甲');
  await page.getByRole('tab', { name: '世界团体', exact: true }).click();
  await expect(page.locator('.group-grid')).toContainText('摄影社');
  await expect(page.locator('.group-grid')).toContainText('晚潮乐队');
  await page.getByRole('tab', { name: '世界团体', exact: true }).click();
  await page.getByRole('button', { name: '创建团体' }).click();
  const group = page.getByRole('dialog', { name: '团体与成员' });
  await group.getByLabel('团体名称', { exact: true }).fill('跨世界团体');
  await group.locator('label.in-world').filter({ hasText: '新人甲' }).getByRole('checkbox').check();
  await group
    .locator('label.outside-world')
    .filter({ hasText: '白石 透' })
    .getByRole('checkbox')
    .click();
  const warning = page.getByRole('dialog', { name: '同时加入当前世界观？' });
  await expect(warning).toContainText('保存团体时');
  await warning.getByRole('button', { name: '确认同时加入' }).click();
  await group.getByLabel('新增角色（每行一个名字）', { exact: true }).fill('新增队友');
  await group.getByRole('button', { name: '保存团体' }).click();
  await expect(group).not.toBeVisible();
  await page.getByRole('tab', { name: '世界人物', exact: true }).click();
  await expect(page.locator('.world-character-list')).toContainText('白石 透');
  await expect(page.locator('.world-character-list')).toContainText('新增队友');
});
test('world and group AI generation keeps constraints and previews before saving', async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route('https://fixture.invalid/v1/chat/completions', async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body.messages.map((m: { content: string }) => m.content).join(' '));
    const isWorld = body.messages[0].content.includes('一套世界观');
    const draft = {
      ...(isWorld
        ? {
            world: {
              name: 'AI 世界草稿',
              description: '原创日常',
              rules: '不能使用魔法',
              locations: ['学校'],
              timezone: 'Asia/Shanghai',
              tone: '轻松',
            },
          }
        : {}),
      characters: [
        {
          name: isWorld ? 'AI 角色甲' : 'AI 角色乙',
          source: '原创',
          bio: 'AI 草稿保留的具体身份',
          personality: '冷静',
          style: '简短',
          habits: '散步',
        },
      ],
      groups: [
        {
          name: isWorld ? 'AI 摄影社' : 'AI 乐队',
          description: '共享日常',
          memberNames: isWorld ? ['凪 夏生', 'AI 角色甲'] : ['AI 角色甲', 'AI 角色乙'],
        },
      ],
      uncertain: '原创补充，待确认',
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
    });
  });
  await enter(page);
  await fixtureProfile(page);
  await worlds(page);
  await page.getByRole('button', { name: '添加世界观', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '世界观设定' });
  await dialog.getByLabel('世界名称', { exact: true }).fill('预填 AU');
  await dialog.getByRole('checkbox', { name: '凪 夏生', exact: true }).check();
  await dialog.getByLabel('AI 生成约束').fill('普通学校，不要超能力，尊重人物边界');
  await dialog.getByRole('button', { name: '生成世界观、团体和角色草稿' }).click();
  await expect(dialog).toContainText('原创补充，待确认');
  expect(
    await page.evaluate(async () => {
      const p = '/src/data/db.ts';
      return (await import(p)).db.worlds.count();
    }),
  ).toBe(3);
  await dialog.getByRole('button', { name: '采用草稿并继续编辑' }).click();
  await expect(dialog.getByLabel('世界名称', { exact: true })).toHaveValue('AI 世界草稿');
  await dialog.getByRole('button', { name: '保存世界' }).click();
  await expect(dialog).not.toBeVisible();
  expect(calls[0]).toContain('普通学校');
  await page.getByRole('tab', { name: '世界人物', exact: true }).click();
  await page.locator('.world-character-list button').filter({ hasText: 'AI 角色甲' }).click();
  await expect(page.getByLabel('人设简介与身份', { exact: true })).toHaveValue(
    'AI 草稿保留的具体身份',
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: '世界团体', exact: true }).click();
  await page.getByRole('button', { name: '创建团体' }).click();
  dialog = page.getByRole('dialog', { name: '团体与成员' });
  await dialog
    .locator('label.in-world')
    .filter({ hasText: 'AI 角色甲' })
    .getByRole('checkbox')
    .check();
  await dialog.getByLabel('AI 生成约束').fill('加入一个鼓手，不要修改已有角色');
  await dialog.getByRole('button', { name: '生成团体和角色草稿' }).click();
  await expect(dialog).toContainText('AI 角色乙');
  await dialog.getByRole('button', { name: '采用草稿并继续编辑' }).click();
  await dialog.getByRole('button', { name: '保存团体' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.group-grid')).toContainText('AI 乐队');
  await page.getByRole('tab', { name: '世界人物', exact: true }).click();
  await expect(page.locator('.world-character-list')).toContainText('AI 角色乙');
});
test('time mode controls, acceleration and rewind preserve the original world', async ({
  page,
}) => {
  await enter(page);
  await worlds(page);
  await page.getByRole('tab', { name: '运行与知识', exact: true }).click();
  await page.locator('.time-controls summary').click();
  await page.getByLabel('前台时间加速倍率', { exact: true }).selectOption('3600');
  await expect(page.locator('.sidebar .speed')).toHaveText('3600×');
  await page.getByRole('button', { name: '真实世界模式' }).click();
  await expect(page.locator('.time-controls')).toContainText('很多时候需要等待');
  await expect(page.getByLabel('前台时间加速倍率', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '上帝模式' }).click();
  const yesterday = await page.evaluate(() =>
    new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
  );
  const dateParts = yesterday.split('-');
  const editor = page.locator('.rewind-controls .world-date-editor');
  await editor.getByLabel('年', { exact: true }).fill(dateParts[0]);
  await editor.getByLabel('月', { exact: true }).fill(String(Number(dateParts[1])));
  await editor.getByLabel('日', { exact: true }).fill(String(Number(dateParts[2])));
  await editor.getByLabel('时', { exact: true }).fill('0');
  await editor.getByLabel('分', { exact: true }).fill('0');
  await page.getByRole('button', { name: '回到这一天', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '回到过去，保留原时间线？' });
  await confirm.getByRole('button', { name: '回到这一天', exact: true }).click();
  await expect(confirm).not.toBeVisible();
  await page.getByRole('tab', { name: '世界总览', exact: true }).click();
  await expect(page.locator('.world-card')).toHaveCount(4);
  await expect(page.locator('.world-card').filter({ hasText: '海盐市' })).toHaveCount(2);
});
test('life timeline is newest-first and follows accelerated world date', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: '生活时间轴', exact: true }).click();
  await page.getByLabel('时间轴展示').selectOption('all');
  await expect(page.locator('.life-log-event').first()).toBeVisible();
  const times = await page
    .locator('.life-log-event')
    .evaluateAll((nodes) => nodes.map((n) => Number(n.getAttribute('data-start'))));
  expect(times.length).toBeGreaterThan(1);
  expect(times).toEqual([...times].sort((a, b) => b - a));
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();
});
test('truncated output is recovered once without duplicate user messages or malformed bubbles', async ({
  page,
}) => {
  const calls: number[] = [];
  await page.route('https://fixture.invalid/v1/chat/completions', async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body.max_tokens);
    const speaker = body.messages[0].content.match(/"speakerId":"([^"]+)"/)?.[1];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [
          {
            finish_reason: calls.length === 1 ? 'length' : 'stop',
            message: {
              content:
                calls.length === 1
                  ? null
                  : JSON.stringify({ speakerId: speaker, messages: ['恢复后的完整回复。'] }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: calls.length === 1 ? 2048 : 20 },
      }),
    });
  });
  await enter(page);
  await fixtureProfile(page);
  await page.getByRole('button', { name: '聊天消息' }).click();
  await page.getByRole('button').filter({ hasText: '夏生 & 澪' }).click();
  await page.getByLabel('聊天身份').selectOption('c-mio');
  await page.getByLabel('消息内容').fill('这条用户消息只能出现一次。');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.message-bubble')).toHaveCount(4);
  await expect(page.locator('.message-bubble').last()).toHaveText('恢复后的完整回复。');
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBeGreaterThan(calls[0]);
});

test('manual retry preserves the original user message after bounded automatic failure', async ({
  page,
}) => {
  let calls = 0;
  await page.route('https://fixture.invalid/v1/chat/completions', async (route) => {
    calls++;
    const body = route.request().postDataJSON(),
      speaker = body.messages[0].content.match(/"speakerId":"([^"]+)"/)?.[1];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [
          {
            finish_reason: calls < 3 ? 'length' : 'stop',
            message: {
              content:
                calls < 3 ? '' : JSON.stringify({ speakerId: speaker, messages: ['重新接上了。'] }),
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 30 },
      }),
    });
  });
  await enter(page);
  await fixtureProfile(page);
  await page.getByRole('button', { name: '聊天消息' }).click();
  await page.getByRole('button').filter({ hasText: '夏生 & 澪' }).click();
  await page.getByLabel('聊天身份').selectOption('c-mio');
  await page.getByLabel('消息内容').fill('保留这一条，不要重发。');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByRole('button', { name: '重试回复（不重发你的消息）' }).click();
  await expect(page.locator('.message-bubble')).toHaveCount(4);
  await expect(page.locator('.message-bubble').last()).toHaveText('重新接上了。');
  expect(calls).toBe(3);
});
test('mobile world creation and time settings do not overflow the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await page.getByRole('button', { name: '打开导航' }).click();
  await worlds(page);
  await page.getByRole('button', { name: '添加世界观', exact: true }).click();
  await expect(page.getByLabel('AI 生成约束')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-world-wizard.png', fullPage: true });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('tab', { name: '运行与知识', exact: true }).click();
  await page.locator('.time-controls summary').click();
  await expect(page.getByLabel('前台时间加速倍率', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('foreground acceleration stops while offline and does not multiply offline elapsed time', async ({
  page,
  context,
}) => {
  await enter(page);
  const start = await page.evaluate(async () => {
    const dp = '/src/data/db.ts',
      tp = '/src/core/time.ts',
      ep = '/src/core/engine.ts';
    const { db } = await import(dp),
      { configureTime } = await import(tp),
      { setRunning } = await import(ep);
    const cp = await db.checkpoints.get('w-harbor');
    await configureTime(cp.id, 'god', 3600);
    await setRunning(cp.id, true, 'demo');
    return cp.simTime;
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const p = '/src/data/db.ts';
          return (await (await import(p)).db.checkpoints.get('w-harbor')).simTime;
        }),
      { timeout: 10000 },
    )
    .toBeGreaterThan(start + 1800000);
  await page.evaluate(async () => {
    const ep = '/src/core/engine.ts';
    await (await import(ep)).setRunning('w-harbor', false, 'demo');
  });
  await context.setOffline(true);
  const offlineStart = await page.evaluate(async () => {
    const dp = '/src/data/db.ts',
      ep = '/src/core/engine.ts',
      tp = '/src/core/time.ts',
      fp = '/src/core/clock-presence.ts';
    const { db } = await import(dp),
      { clockTarget } = await import(tp),
      { foregroundStart } = await import(fp);
    await (await import(ep)).setRunning('w-harbor', true, 'demo');
    return clockTarget(await db.checkpoints.get('w-harbor'), Date.now(), foregroundStart());
  });
  await page.waitForTimeout(2200);
  const after = await page.evaluate(async () => {
    const dp = '/src/data/db.ts',
      tp = '/src/core/time.ts',
      fp = '/src/core/clock-presence.ts';
    const { db } = await import(dp),
      { clockTarget } = await import(tp),
      { foregroundStart } = await import(fp);
    return clockTarget(await db.checkpoints.get('w-harbor'), Date.now(), foregroundStart());
  });
  expect(after - offlineStart).toBeGreaterThanOrEqual(2000);
  expect(after - offlineStart).toBeLessThan(10000);
  await context.setOffline(false);
});
