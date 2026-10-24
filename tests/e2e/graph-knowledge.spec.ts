import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
async function enter(page: Page, width: number) {
  await page.setViewportSize({ width, height: 960 });
  await page.goto('/');
  await page.getByRole('button', { name: '先看看演示世界' }).click();
}
async function nav(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) < 760)
    await page.getByRole('button', { name: '打开导航' }).click();
  await page.locator('.sidebar nav').getByRole('button', { name, exact: true }).click();
}
for (const width of [1440, 390]) {
  test(`complete nonoverlapping graph, camera and whole-image export at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await enter(page, width);
    await nav(page, '关系网络');
    const graph = page.getByRole('region', { name: '可交互关系网络' });
    await expect(graph.locator('[data-node]')).toHaveCount(5);
    if (process.env.CAPTURE_README && width === 1440) {
      await mkdir('docs/images', { recursive: true });
      await graph.getByRole('button', { name: '适应全部节点' }).click();
      await graph.screenshot({ path: 'docs/images/relationship-graph.png' });
    }
    await page.evaluate(async () => {
      const p = '/src/data/db.ts',
        s = '/src/data/seed.ts';
      const { db } = await import(p),
        { newCharacter } = await import(s);
      await db.characters.bulkPut(
        Array.from({ length: 100 }, (_, i) => ({
          ...newCharacter('孤立节点' + i + (i % 9 === 0 ? '很长的姓名用于完整显示测试' : '')),
          id: 'isolated-' + i,
        })),
      );
      await db.memberships.bulkPut(
        Array.from({ length: 100 }, (_, i) => ({
          id: 'isolated-member-' + i,
          worldId: 'w-harbor',
          characterId: 'isolated-' + i,
        })),
      );
    });
    await expect(graph.locator('[data-node]')).toHaveCount(105);
    for (const mode of ['compact', 'readable']) {
      await graph.getByLabel('关系网布局算法').selectOption(mode);
      await graph.getByRole('button', { name: '适应全部节点' }).click();
      expect(
        await graph.locator('[data-node]').evaluateAll((nodes) => {
          const boxes = nodes.map((n) => ({
            x: Number(n.getAttribute('data-x')),
            y: Number(n.getAttribute('data-y')),
            w: Number(n.getAttribute('data-width')),
            h: Number(n.getAttribute('data-height')),
          }));
          return boxes.every((a, i) =>
            boxes
              .slice(i + 1)
              .every(
                (b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
              ),
          );
        }),
      ).toBe(true);
      const svg = graph.getByRole('img'),
        camera = graph.locator('[data-camera]');
      const before = await camera.getAttribute('transform');
      await graph.getByRole('button', { name: '放大关系网' }).click();
      await expect(camera).not.toHaveAttribute('transform', before!);
      await graph.getByRole('button', { name: '缩小关系网' }).click();
      await svg.scrollIntoViewIfNeeded();
      const box = (await svg.boundingBox())!;
      const at = await camera.getAttribute('transform');
      await page.mouse.move(box.x + 20, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(box.x + 75, box.y + 55, { steps: 5 });
      await page.mouse.up();
      await expect(camera).not.toHaveAttribute('transform', at!);
      const pan = await camera.getAttribute('transform');
      await page.mouse.wheel(0, -150);
      await expect(camera).not.toHaveAttribute('transform', pan!);
      await graph.getByRole('button', { name: '适应全部节点' }).click();
      expect(
        await graph.locator('[data-node]').evaluateAll((nodes) => {
          const viewport = nodes[0].closest('svg')!.getBoundingClientRect();
          return nodes.every((n) => {
            const b = n.getBoundingClientRect();
            return (
              b.left >= viewport.left - 1 &&
              b.right <= viewport.right + 1 &&
              b.top >= viewport.top - 1 &&
              b.bottom <= viewport.bottom + 1
            );
          });
        }),
      ).toBe(true);
    }
    // Keyboard activation must work independently of mouse or touch navigation.
    await graph.locator('[data-node]').first().press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    if (width === 390) {
      const svg = graph.getByRole('img');
      await svg.scrollIntoViewIfNeeded();
      const box = (await svg.boundingBox())!,
        camera = graph.locator('[data-camera]');
      const before = await camera.getAttribute('transform');
      const cdp = await page.context().newCDPSession(page);
      const points = (d: number) => [
        { x: box.x + box.width / 2 - d, y: Math.max(100, box.y + 180), id: 1 },
        { x: box.x + box.width / 2 + d, y: Math.max(100, box.y + 180), id: 2 },
      ];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(35) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(65) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(camera).not.toHaveAttribute('transform', before!);
      await cdp.detach();
    }
    for (const format of ['SVG', 'PNG']) {
      const downloading = page.waitForEvent('download');
      await graph.getByRole('button', { name: '导出 ' + format }).click();
      const file = await downloading,
        data = await readFile((await file.path())!);
      if (format === 'SVG') {
        const xml = data.toString();
        expect(xml.match(/data-node=/g)?.length).toBe(105);
        expect(xml).not.toContain('transform="translate');
      } else {
        expect(data.subarray(1, 4).toString()).toBe('PNG');
        expect(data.readUInt32BE(16)).toBeGreaterThan(500);
        expect(data.readUInt32BE(20)).toBeGreaterThan(500);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await graph.getByRole('button', { name: '适应全部节点' }).click();
    await graph.locator('[data-node]').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    // A group filter from the previous world must not hide the new world's nodes.
    await page.getByLabel('关系团体筛选').selectOption({ label: '白昼集合点' });
    await page.evaluate(async () => {
      const p = '/src/data/db.ts';
      await (await import(p)).db.settings.update('app', { worldId: 'w-touhou-windows' });
    });
    await expect(graph.locator('[data-node]')).toHaveCount(143);
    await expect(page.getByLabel('关系团体筛选')).toHaveValue('');
  });
  test(`existing background information loads, edits in place and survives reload at ${width}px`, async ({
    page,
  }) => {
    await enter(page, width);
    await page.evaluate(async () => {
      const p = '/src/data/db.ts';
      const { db } = await import(p);
      await db.characters.update('c-nagi', { entityMode: 'background' });
      await db.backgroundKnowledge.put({
        id: 'known-fixture',
        worldId: 'w-harbor',
        entityId: 'c-nagi',
        characterId: 'c-mio',
        level: 'familiar',
        knownAt: 10,
        items: [{ kind: 'rumor', content: '待核实的演出消息', source: '旧唱片店', learnedAt: 11 }],
      });
    });
    await nav(page, '世界与团体');
    await page.getByRole('tab', { name: '运行与知识' }).click();
    const editor = page.getByTestId('background-knowledge');
    await editor.locator('summary').click();
    await expect(editor.getByRole('region', { name: '已有认知记录' })).toContainText('旧唱片店');
    await editor.getByRole('button', { name: '编辑此信息' }).click();
    await expect(editor.getByLabel('信息内容')).toHaveValue('待核实的演出消息');
    await expect(editor.getByLabel('认知程度')).toHaveValue('familiar');
    await expect(editor.getByRole('article', { name: '背景对象已有资料' })).toContainText('建筑系');
    await editor.getByLabel('信息内容').fill('已核实：周末参加演出');
    await editor.getByLabel('信息性质').selectOption('fact');
    await editor.getByLabel('来源', { exact: true }).fill('本人告知');
    await editor.getByRole('button', { name: '保存信息修改' }).click();
    await expect(editor.getByRole('region', { name: '已有认知记录' })).toContainText('本人告知');
    const record = await page.evaluate(async () => {
      const p = '/src/data/db.ts';
      return (await import(p)).db.backgroundKnowledge.get('known-fixture');
    });
    expect(record.items).toEqual([
      { kind: 'fact', content: '已核实：周末参加演出', source: '本人告知', learnedAt: 11 },
    ]);
    expect(record.knownAt).toBe(10);
    await page.reload();
    await nav(page, '世界与团体');
    await page.getByRole('tab', { name: '运行与知识' }).click();
    await editor.locator('summary').click();
    await expect(editor.getByRole('region', { name: '已有认知记录' })).toContainText(
      '已核实：周末参加演出',
    );
    if (process.env.CAPTURE_README && width === 1440) {
      await editor.getByRole('button', { name: '查看 / 编辑认知程度' }).click();
      await editor.screenshot({ path: 'docs/images/background-knowledge.png' });
    }
  });
}

if (process.env.CAPTURE_README)
  test('capture product overview and chat', async ({ page }) => {
    await enter(page, 1440);
    await mkdir('docs/images', { recursive: true });
    await page.screenshot({ path: 'docs/images/overview.png' });
    await nav(page, '聊天消息');
    await page.getByRole('button').filter({ hasText: '夏生 & 澪' }).click();
    await page.screenshot({ path: 'docs/images/chat.png' });
  });
