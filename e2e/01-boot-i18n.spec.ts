/**
 * (a) The production build boots with no console / page errors; the language toggle switches the
 * UI to Thai (known labels) and back to English.
 */
import { expect, test } from '@playwright/test';
import { collectErrors, openApp, shot } from './helpers.ts';

test('boots with no console errors and toggles EN ↔ TH', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);

  // shell: three left tabs, two right tabs, transport bar, 3D canvas
  await expect(page.getByTestId('tab-part')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-tools')).toBeVisible();
  await expect(page.getByTestId('tab-machine')).toBeVisible();
  await expect(page.getByTestId('tab-sequence')).toBeVisible();
  await expect(page.getByTestId('tab-program')).toBeVisible();
  await expect(page.getByTestId('sim-play')).toBeDisabled();       // no timeline yet
  await expect(page.getByTestId('sample-menu')).toContainText('Load sample');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.brand-name')).toHaveText('Press Brake Simulator');

  // → Thai
  await page.getByTestId('language-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  await expect(page.getByTestId('tab-part')).toHaveText('ชิ้นงาน');
  await expect(page.getByTestId('tab-program')).toContainText('โปรแกรมพับ');
  await expect(page.getByTestId('sample-menu')).toContainText('โหลดชิ้นงานตัวอย่าง');
  await expect(page.getByTestId('plan-button')).toHaveText('วางแผน');
  await expect(page.locator('.brand-name')).toHaveText('โปรแกรมจำลองเครื่องพับ');
  await shot(page, 'boot-th');

  // → back to English
  await page.getByTestId('language-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('tab-part')).toHaveText('Part');
  await expect(page.getByTestId('plan-button')).toHaveText('Plan');
  await expect(page.getByTestId('sample-menu')).toContainText('Load sample');

  // the language choice is remembered for the next visit
  await page.reload();
  await expect(page.getByTestId('tab-part')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await shot(page, 'boot-en');
  errors.assertClean();
});
