import { test, expect } from '@playwright/test';
for (const width of [1440, 390])
  test(`optional portraits preserve uploads and survive reload at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: '先看看演示世界' }).click();
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
      return canvas.toDataURL();
    });
    await page.evaluate(async (avatar) => {
      const path = '/src/data/db.ts';
      const { db } = await import(path);
      await db.settings.update('app', { worldId: 'w-touhou-windows' });
      await db.characters.update('th:marisa', { avatar });
    }, png);
    let requests = 0;
    await page.route(/https:\/\/upload\.th(b)?wiki\.cc\//, async (route) => {
      requests++;
      await route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(png.split(',')[1], 'base64'),
      });
    });
    async function open() {
      if (width < 760) await page.getByRole('button', { name: '打开导航' }).click();
      await page
        .locator('.sidebar nav')
        .getByRole('button', { name: '世界与团体', exact: true })
        .click();
      await page.getByRole('button', { name: '东方头像素材（可选下载）', exact: true }).click();
    }
    await open();
    const dialog = page.getByRole('dialog', { name: '东方头像素材', exact: true });
    const choices = dialog.getByRole('region', { name: '东方头像角色', exact: true });
    await expect(choices.getByRole('checkbox', { name: '雾雨魔理沙', exact: true })).toBeDisabled();
    await choices.getByRole('checkbox', { name: '博丽灵梦', exact: true }).check();
    await choices.getByRole('checkbox', { name: '露米娅', exact: true }).check();
    expect(requests).toBe(0);
    await dialog.getByRole('button', { name: '下载并应用 2 张头像', exact: true }).click();
    await expect(
      dialog.getByText('下载完成：应用 2 张，跳过 0 项，失败 0 项。失败项可重新下载。'),
    ).toBeVisible();
    expect(requests).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.reload();
    await open();
    await expect(dialog.getByText('已下载 · 黄昏', { exact: false }).first()).toBeVisible();
    expect(requests).toBe(2);
    const read = () =>
      page.evaluate(async () => {
        const path = '/src/data/db.ts';
        const { db } = await import(path);
        const chars = await db.characters.bulkGet(['th:reimu', 'th:rumia', 'th:marisa']);
        return chars.map((c: any) => ({ avatar: c.avatar, kind: c.avatarSource?.kind }));
      });
    const saved = await read();
    expect(saved[0].kind).toBe('twilight');
    expect(saved[1].kind).toBe('zun');
    expect(saved.every((c: { avatar: string }) => c.avatar === png)).toBe(true);
    await dialog.getByRole('button', { name: '清除已下载的东方头像', exact: true }).click();
    await page.getByRole('button', { name: '确认清除素材', exact: true }).click();
    await expect(dialog.getByText('已清除 2 张下载头像；自行上传的头像保留。')).toBeVisible();
    const cleared = await read();
    expect(cleared.map((c: { avatar: string }) => c.avatar)).toEqual(['', '', png]);
  });
