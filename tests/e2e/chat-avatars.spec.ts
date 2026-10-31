import { prepareSmallWorld } from './helpers/small-world';
import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => prepareSmallWorld(page));
for (const width of [1440, 390])
  test(`conversation avatars and AI social actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: /先看看演示世界|先读这份七日存档/ }).click();
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      c.getContext('2d')!.fillRect(0, 0, 16, 16);
      return c.toDataURL();
    });
    await page.evaluate(async (avatar) => {
      const p = '/src/data/db.ts';
      const { db } = await import(p);
      await db.characters.update('c-nagi', { avatar });
      await db.characters.update('c-mio', { avatar });
      const c = await db.conversations.get('conv-cafe');
      const source = (await db.messages.where('conversationId').equals(c.id).sortBy('seq')).at(-1);
      const a = '/src/ai/orchestrator.ts',
        pr = '/src/ai/prompts.ts';
      const { generateDialogue, persistDialogue } = await import(a);
      const snapshot = (await import(pr)).defaultPrompts();
      const r = await generateDialogue(db, c, 'c-nagi', source.simAt + 1000, snapshot, {
        async complete() {
          return {
            content: JSON.stringify({
              speakerId: 'c-nagi',
              messages: ['@森川 澪 一会儿见。'],
              mentionTargets: [{ messageIndex: 0, characterId: 'c-mio' }],
              reactions: [{ messageId: source.id, emoji: '😂' }],
            }),
            inputTokens: 1,
            outputTokens: 1,
            estimated: false,
          };
        },
      });
      await persistDialogue(
        db,
        c.id,
        'c-nagi',
        r.messages,
        source.simAt + 1000,
        'ai',
        'avatar-social',
        undefined,
        r.offsets,
        r,
      );
    }, png);
    if (width < 760) await page.getByRole('button', { name: '打开导航' }).click();
    await page
      .locator('.sidebar nav')
      .getByRole('button', { name: '聊天消息', exact: true })
      .click();
    const direct = page.locator('.conversation-item').filter({ hasText: '夏生 & 澪' });
    await expect(direct.locator('.conversation-avatar.direct .avatar')).toHaveCount(2);
    await expect(direct.locator('.conversation-avatar.direct img')).toHaveCount(2);
    const group = page.locator('.conversation-item').filter({ hasText: '白昼集合点' });
    await expect(group.locator('.conversation-avatar.group .avatar')).toHaveCount(5);
    await direct.click();
    await expect(page.locator('.chat-header .conversation-avatar.direct')).toBeVisible();
    await expect(page.locator('.chat-header .avatar')).toHaveCount(2);
    if (width < 760) await page.getByRole('button', { name: '返回会话列表' }).click();
    await group.click();
    await expect(page.locator('.message .mention').filter({ hasText: '森川 澪' })).toBeVisible();
    await expect(page.locator('.message').filter({ hasText: '😂' }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(async (avatar) => {
      const p = '/src/data/db.ts';
      await (await import(p)).db.conversations.update('conv-cafe', { avatar });
    }, png);
    await expect(page.locator('.chat-header > .avatar img')).toHaveAttribute('src', png);
    await expect(page.locator('.chat-header .conversation-avatar')).toHaveCount(0);
    await page.reload();
    if (width < 760) await page.getByRole('button', { name: '打开导航' }).click();
    await page
      .locator('.sidebar nav')
      .getByRole('button', { name: '聊天消息', exact: true })
      .click();
    await group.click();
    await expect(page.locator('.chat-header > .avatar img')).toHaveAttribute('src', png);
    await page.evaluate(async () => {
      const p = '/src/data/db.ts';
      await (await import(p)).db.conversations.update('conv-cafe', { avatar: '' });
    });
    await expect(page.locator('.chat-header .conversation-avatar.group .avatar')).toHaveCount(5);
  });
