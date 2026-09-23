/**
 * Boot test of the built app: mount, load the L-bracket sample (DXF + STEP through the module worker),
 * plan the program through the planner worker, switch to Thai. Fails on any page error.
 */
import { expect, test } from '@playwright/test';

test('boots, imports the L-bracket sample and plans it', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto('/');
  await expect(page.getByTestId('tab-part')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();

  await page.getByTestId('sample-menu').click();
  await page.getByTestId('sample-L-bracket').click();
  await expect(page.getByTestId('bend-row-B1')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('bend-angle-B1')).toHaveValue('90');
  await expect(page.getByTestId('bend-row-B1')).toContainText('STEP'); // angle / radius / direction matched from the 3D model

  await page.getByTestId('plan-button').click();
  await expect(page.getByTestId('step-0')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('program-feasible')).toBeVisible();

  await page.getByTestId('language-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  await expect(page.getByTestId('tab-program')).toContainText('โปรแกรม');

  expect(pageErrors).toEqual([]);
});
