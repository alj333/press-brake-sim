import { expect, test } from '@playwright/test';
import { collectErrors, loadSample, openApp, plan, shot } from './helpers.ts';

test('hat-channel: advisor proves a narrow-body setup and draws the required change', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'hat-channel');
  await plan(page, 4);

  await expect(page.getByTestId('program-feasible')).toHaveText('Not feasible');
  const assistant = page.getByTestId('feasibility-assistant');
  await expect(assistant).toBeVisible();
  await expect(assistant).toContainText('2 blocking collisions');
  await expect(page.locator('[data-testid^="feasibility-issue-"][data-obstacle="die"]')).toHaveCount(2);

  await page.getByTestId('feasibility-analyse').click();
  await expect(page.getByTestId('feasibility-progress')).toBeVisible();
  await expect(page.getByTestId('feasibility-recommendations')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('feasibility-no-solution')).toContainText('No stocked punch or die');

  const preferred = page.getByTestId('recommendation-card-custom-angle-margin-S1');
  await expect(preferred).toBeVisible();
  await expect(preferred).toHaveAttribute('data-outcome', 'custom-required');
  await expect(preferred).toHaveAttribute('data-tested', 'true');
  await expect(preferred).toContainText('Straight punch 85°');
  await expect(preferred).toContainText('Concept V16 85° narrow body 48 mm');
  await expect(preferred).toContainText('≥ 149.1 kN/m');
  await expect(preferred).toContainText('backgauge retract of at least 5 mm');
  await expect(preferred.getByTestId('guidance-graphic')).toBeVisible();
  await expect(preferred.getByTestId('graphic-current-profile')).toBeVisible();
  await expect(preferred.getByTestId('graphic-proposed-profile')).toBeVisible();
  await expect(preferred.getByTestId('graphic-collision-marker')).toBeVisible();
  await expect(preferred.getByTestId('graphic-dimension-body-width')).toContainText('60 mm');
  await expect(preferred.getByTestId('graphic-dimension-body-width')).toContainText('48 mm');
  await expect(preferred.locator('[data-testid^="recommendation-apply-"]')).toHaveCount(0);
  await shot(page, 'hat-feasibility-advisor');

  await preferred.getByRole('button', { name: 'View profile change' }).click();
  const dialog = page.getByTestId('recommendation-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Every bend and sequence was re-run');
  await expect(dialog.getByTestId('guidance-graphic')).toBeVisible();
  await shot(page, 'hat-feasibility-profile-comparison');
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();

  // A geometry hypothesis navigates to the import flow but never mutates or mounts a virtual tool.
  await preferred.getByRole('button', { name: 'Open Tools / import profile' }).click();
  await expect(page.getByTestId('tab-tools')).toHaveClass(/tab-active/);
  await expect(page.getByTestId('station-die-S1')).toHaveValue('std:die-v16-88');

  await page.getByTestId('language-toggle').click();
  await expect(preferred).toContainText('ระยะเผื่อมุมที่แนะนำ');
  await expect(preferred).not.toContainText('feasibility.');
  errors.assertClean();
});

test('feasible box does not show unnecessary setup guidance', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'box-4-flange');
  await plan(page, 4);
  await expect(page.getByTestId('program-feasible')).toHaveText('Feasible');
  await expect(page.getByTestId('feasibility-assistant')).toHaveCount(0);
  errors.assertClean();
});
