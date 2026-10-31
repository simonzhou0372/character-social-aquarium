import { test, expect, type Page } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
});
async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /先看看演示世界|先读这份七日存档/ }).click();
}
async function nav(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) < 760)
    await page.getByRole('button', { name: '打开导航' }).click();
  await page.locator('.sidebar nav').getByRole('button', { name }).click();
}
async function api(page: Page) {
  await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const { db } = await import(p);
    await db.profiles.put({
      id: 'api',
      provider: '测试兼容接口',
      baseUrl: 'https://model.test.invalid/v1',
      model: 'fixture',
      persistKey: true,
      key: 'test-only-no-real-key',
      status: 'connected',
    });
  });
}
async function fakeAPI(page: Page) {
  await page.route('https://model.test.invalid/**', async (route) => {
    const input = route.request().postDataJSON(),
      system = input.messages[0].content,
      body = JSON.parse(input.messages[1].content);
    const speaker = system.match(/"speakerId":"([^"]+)"/)?.[1];
    let result: any = speaker
      ? { speakerId: speaker, messages: ['收到，晚点见。'] }
      : system.includes('"relationships"')
        ? {
            relationships: [
              {
                from: body.input.sources[0].id,
                to: body.input.targets.find((c: any) => c.id !== body.input.sources[0].id).id,
                label: '友好相识',
                closeness: 45,
              },
            ],
          }
        : {
            world: { name: '五人校园' },
            characters: Array.from({ length: 5 }, (_, i) => ({ name: '新同学' + (i + 1) })),
            groups: [],
          };
    await route.fulfill({
      json: {
        choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      },
    });
  });
}
test('minimal five-character draft and AI directed relation preview work without optional fields', async ({
  page,
}) => {
  await enter(page);
  await api(page);
  await fakeAPI(page);
  await nav(page, '世界与团体');
  await page.getByRole('button', { name: '添加世界观', exact: true }).click();
  await page.getByLabel('AI 生成约束').fill('创建五个性格不同的高中女生');
  await page.getByRole('button', { name: '生成世界观、团体和角色草稿' }).click();
  await expect(page.locator('.draft-character')).toHaveCount(5);
  await page.getByRole('button', { name: '采用草稿并继续编辑' }).click();
  await page.getByRole('button', { name: '保存世界', exact: true }).click();
  await expect(page.locator('.world-hud')).toContainText('五人校园');
  await nav(page, '关系网络');
  await page.getByRole('button', { name: 'AI 生成关系', exact: true }).click();
  await page.getByLabel('关系补充要求').fill('只有两三个人熟悉，关系是有向的');
  await page.getByRole('button', { name: '生成关系预览' }).click();
  await expect(page.getByLabel('建议关系类型').first()).toHaveValue('友好相识');
  await page.getByRole('button', { name: '接受全部建议' }).click();
  await expect(page.getByText(/已接受.*条关系/)).toBeVisible();
});
test('chat perspective, structured mentions, replies, emoji actors and read detail persist', async ({
  page,
}) => {
  await enter(page);
  await api(page);
  await fakeAPI(page);
  await nav(page, '聊天消息');
  await page.getByRole('button').filter({ hasText: '白昼集合点' }).click();
  await page.getByLabel('聊天身份').selectOption('user');
  await page.getByRole('button', { name: '@ 提及成员' }).click();
  await page.locator('.composer .check-list button').first().click();
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.message.self .mention')).toHaveCount(1);
  const metadata = await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const { db } = await import(p);
    return (await db.messages.where('conversationId').equals('conv-cafe').sortBy('seq')).find(
      (m: any) => m.mentionCharacterIds?.length,
    );
  });
  expect(metadata.mentionCharacterIds).toHaveLength(1);
  await page.locator('.message').first().getByRole('button', { name: '回复', exact: true }).click();
  await page.getByLabel('消息内容').fill('这是引用回复');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.message.self .quoted-message').last()).toBeVisible();
  const self = page.locator('.message.self').last();
  await self.getByRole('button', { name: '回应', exact: true }).click();
  await self.getByRole('button', { name: '👍', exact: true }).click();
  // Reactor names appear directly after the emoji; no viewer dialog is needed.
  await expect(self.locator('.reaction')).toContainText('👍');
  await expect(self.locator('.reaction')).toContainText('观察员');
  await expect(page.getByRole('dialog', { name: 'Emoji 回应者' })).toHaveCount(0);
  await self.getByRole('button', { name: /详情/ }).click();
  await expect(page.getByRole('dialog', { name: '消息阅读详情' })).toContainText(
    '观察者阅读不会改变虚拟角色',
  );
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  const idsBefore = await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const { db } = await import(p);
    return (await db.messages.where('conversationId').equals('conv-cafe').toArray()).map(
      (m: any) => [m.id, m.senderId],
    );
  });
  await page.getByLabel('聊天身份').selectOption('c-mio');
  await expect(page.locator('.message.self .message-label').first()).toContainText('森川 澪');
  await page.getByLabel('聊天身份').selectOption('c-nagi');
  await expect(page.locator('.message.self .message-label').first()).toContainText('凪 夏生');
  const idsAfter = await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const { db } = await import(p);
    return (await db.messages.where('conversationId').equals('conv-cafe').toArray()).map(
      (m: any) => [m.id, m.senderId],
    );
  });
  expect(idsAfter).toEqual(idsBefore);
});
test('unread jump loads original messages outside the default history window', async ({ page }) => {
  await enter(page);
  await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const { db } = await import(p);
    const cp = await db.checkpoints.get('w-harbor');
    const c =
      (await db.conversations.get('conv-nagi-mio')) ??
      (await db.conversations
        .where('worldId')
        .equals('w-harbor')
        .and((c: any) => c.kind === 'direct')
        .first());
    const old = await db.messages.where('conversationId').equals(c.id).sortBy('seq');
    let seq = old.at(-1)?.seq ?? 0;
    await db.messages.bulkPut(
      Array.from({ length: 240 }, (_, i) => ({
        id: 'unread-' + i,
        conversationId: c.id,
        senderId: c.participants[i % 2],
        seq: ++seq,
        text: '历史消息' + i,
        source: 'demo',
        realAt: Date.now(),
        simAt: cp.simTime + i,
      })),
    );
    await db.conversations.update(c.id, { lastAt: cp.simTime + 239 });
  });
  await nav(page, '聊天消息');
  await page.getByRole('button').filter({ hasText: '夏生 & 澪' }).click();
  await page.getByRole('button', { name: '跳转到第一条未读' }).click();
  await expect(page.locator('.unread-divider')).toBeVisible();
  await expect(page.locator('.message.highlight')).toBeVisible();
  expect(await page.locator('.message').count()).toBeLessThanOrEqual(160);
});
test('GIF upload, named library, user send and historical retention work on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await nav(page, '聊天消息');
  await page.getByRole('button').filter({ hasText: '夏生 & 澪' }).click();
  await page.getByLabel('聊天身份').selectOption('user');
  await page.getByRole('button', { name: 'GIF 表情' }).click();
  const modal = page.getByRole('dialog', { name: 'GIF 表情图库' });
  await modal.getByText('上传 GIF / 配置继承范围').click();
  await modal.getByLabel('新表情名称').fill('小小挥手');
  await modal.getByLabel('上传GIF').setInputFiles({
    name: 'wave.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
  });
  await modal.getByRole('button', { name: '发送表情 小小挥手' }).click();
  await expect(page.locator('.message.self .gif-image')).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: 'GIF 表情' }).click();
  await modal.getByRole('button', { name: '从图库移除' }).click();
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.message.self .gif-image')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-four-gif.png', fullPage: true });
});
test('thirty-day major-event history shows aggregated notifications and details', async ({
  page,
}) => {
  test.setTimeout(180000);
  await enter(page);
  await page.evaluate(async () => {
    const p = '/src/data/db.ts',
      e = '/src/core/engine.ts',
      m = '/src/core/major-events.ts';
    const { db } = await import(p);
    const { runWorld } = await import(e);
    const { nextMajorSchedule, defaultMajorSettings } = await import(m);
    const cp = await db.checkpoints.get('w-harbor');
    await db.worlds.update(cp.id, {
      majorEventSettings: { ...defaultMajorSettings, enabled: true, maximumIntervalDays: 7 },
    });
    await db.majorSchedules.put(nextMajorSchedule(cp.id, cp.simTime, 7));
    await db.settings.update('app', { activity: 'quiet', unlimitedUsage: true });
    await db.checkpoints.update(cp.id, { paused: false });
    await runWorld(cp.id, { now: cp.realTime + 30 * 86400000, maxSegments: 10000 });
    await db.checkpoints.update(cp.id, { paused: true });
  });
  await expect(page.locator('.major-banner')).toContainText('重大事件');
  await nav(page, '重大事件');
  await expect.poll(() => page.locator('.major-list article').count()).toBeGreaterThanOrEqual(4);
  await page
    .locator('.major-list article')
    .first()
    .getByRole('button', { name: '阅读事件' })
    .click();
  await expect(page.getByRole('dialog')).toContainText('已确认的后续影响');
  await page.screenshot({ path: 'test-results/desktop-major-event.png', fullPage: true });
});
test('clock keeps moving during a deliberately blocked AI request and freezes only on pause', async ({
  page,
}) => {
  await enter(page);
  await api(page);
  let unblock!: () => void;
  const gate = new Promise<void>((r) => (unblock = r));
  let called = false;
  await page.route('https://model.test.invalid/**', async (route) => {
    called = true;
    await gate;
    try {
      await route.fulfill({
        json: {
          choices: [{ message: { content: '{"speakerId":"c-mio","messages":["稍后见"]}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      });
    } catch {}
  });
  await page.evaluate(async () => {
    const p = '/src/data/db.ts';
    const { db } = await import(p);
    const cp = await db.checkpoints.get('w-harbor');
    await db.settings.update('app', {
      activity: 'lively',
      unlimitedUsage: true,
      sceneDailyBudget: 0,
    });
    await db.checkpoints.update(cp.id, {
      paused: false,
      mode: 'live',
      speed: 60,
      realTime: Date.now() - 600000,
    });
  });
  await expect.poll(() => called).toBe(true);
  const before = await page.locator('.world-hud time').innerText();
  await page.clock.fastForward(60000);
  await expect(page.locator('.world-hud time')).not.toHaveText(before);
  await expect(page.locator('.world-hud')).toContainText(/AI 等待|内容积压|任务积压/);
  await page.getByRole('button', { name: '暂停世界', exact: true }).click();
  await expect(page.locator('.world-hud')).toContainText('已暂停');
  const paused = await page.locator('.world-hud time').innerText();
  await page.clock.fastForward(60000);
  await expect(page.locator('.world-hud time')).toHaveText(paused);
  unblock();
});
