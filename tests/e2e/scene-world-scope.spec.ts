import { test, expect } from '@playwright/test';
for (const width of [1440, 390]) {
  test(`scene participant choices follow local and global world switches at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: '先看看演示世界' }).click();
    await page.evaluate(async () => {
      const path = '/src/data/db.ts',
        seedPath = '/src/data/seed.ts';
      const { db } = await import(path),
        { newCharacter } = await import(seedPath);
      const original = await db.worlds.get('w-harbor');
      await db.worlds.add({ ...original, id: 'scope-other', name: '筛选测试世界' });
      await db.characters.bulkAdd([
        { ...newCharacter('另一世界专属'), id: 'scope-other-person' },
        { ...newCharacter('历史在场角色'), id: 'scope-former-person' },
        { ...newCharacter('未加入世界的角色'), id: 'scope-unassigned' },
        { ...newCharacter('已移除且无场景'), id: 'scope-inactive' },
        { ...newCharacter('已回收角色'), id: 'scope-deleted', deletedAt: Date.now() },
      ]);
      await db.memberships.bulkAdd([
        {
          id: 'scope-other-member',
          worldId: 'scope-other',
          characterId: 'scope-other-person',
          identity: '',
          bioOverride: '',
          styleOverride: '',
        },
        {
          id: 'scope-shared-member',
          worldId: 'scope-other',
          characterId: 'c-nagi',
          identity: '',
          bioOverride: '',
          styleOverride: '',
        },
        {
          id: 'scope-inactive-member',
          worldId: 'w-harbor',
          characterId: 'scope-inactive',
          inactive: true,
          identity: '',
          bioOverride: '',
          styleOverride: '',
        },
        {
          id: 'scope-deleted-member',
          worldId: 'w-harbor',
          characterId: 'scope-deleted',
          identity: '',
          bioOverride: '',
          styleOverride: '',
        },
      ]);
      const at = (await db.checkpoints.get('w-harbor')).simTime;
      await db.scenes.put({
        id: 'scope-history',
        worldId: 'w-harbor',
        eventId: 'scope-event',
        title: '历史共同活动',
        location: '旧书店',
        type: 'social',
        participants: ['scope-former-person', 'c-nagi'],
        start: at - 60000,
        end: at,
        phases: [],
        promptVersion: 1,
      });
    });
    if (width < 760) await page.getByRole('button', { name: '打开导航' }).click();
    await page
      .locator('.sidebar nav')
      .getByRole('button', { name: '线下观察', exact: true })
      .click();
    const choices = page.getByRole('region', { name: '场景参与者', exact: true });
    const person = (name: string) => choices.getByRole('checkbox', { name, exact: true });
    await expect(person('凪 夏生')).toBeVisible();
    await expect(person('森川 澪')).toBeVisible();
    await expect(person('另一世界专属')).toHaveCount(0);
    await expect(person('未加入世界的角色')).toHaveCount(0);
    await expect(person('已移除且无场景')).toHaveCount(0);
    await expect(person('已回收角色')).toHaveCount(0);
    await person('历史在场角色').check();
    await expect(page.locator('.scene-card')).toContainText('历史共同活动');
    await page.getByLabel('世界观', { exact: true }).selectOption('scope-other');
    await expect(person('另一世界专属')).toBeVisible();
    await expect(person('凪 夏生')).toHaveCount(1);
    await expect(person('森川 澪')).toHaveCount(0);
    await expect(person('历史在场角色')).toHaveCount(0);
    await expect(choices).toContainText('已选 0 / 2');
    await person('另一世界专属').check();
    await page.getByLabel('世界观', { exact: true }).selectOption('');
    await expect(person('森川 澪')).toBeVisible();
    await expect(person('另一世界专属')).toBeVisible();
    await expect(person('另一世界专属')).not.toBeChecked();
    if (width < 760) await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByLabel('切换世界').selectOption('scope-other');
    if (width < 760) await page.getByRole('button', { name: '关闭导航' }).click();
    await expect(page.getByLabel('世界观', { exact: true })).toHaveValue('scope-other');
    await expect(person('森川 澪')).toHaveCount(0);
    await expect(person('另一世界专属')).toBeVisible();
  });
}
