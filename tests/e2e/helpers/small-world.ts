import type { Page } from '@playwright/test';
/** Keep chat regression fixtures at the original five-character world. */
export async function prepareSmallWorld(page: Page) {
  await page.route('**/src/data/presets/last-seven-days.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'export async function ensureLastSevenDaysPreset() { return false; }',
    }),
  );
}
