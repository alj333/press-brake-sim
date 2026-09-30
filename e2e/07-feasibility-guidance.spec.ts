import { expect, test } from '@playwright/test';
import {
  REFERENCE_DIE_ID,
  REFERENCE_PUNCH_ID,
  collectErrors,
  loadSample,
  openApp,
  plan,
  selectReferenceTooling,
  shot,
} from './helpers.ts';

test('hat-channel: advisor proves and applies a stocked MotionX multi-V groove', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'hat-channel');
  await selectReferenceTooling(page);
  await plan(page, 4);

  await expect(page.getByTestId('program-feasible')).toHaveText('Not feasible');
  const assistant = page.getByTestId('feasibility-assistant');
  await expect(assistant).toBeVisible();
  await expect(assistant).toContainText('2 blocking collisions');
  await expect(page.locator('[data-testid^="feasibility-issue-"][data-obstacle="die"]')).toHaveCount(2);

  await page.getByTestId('feasibility-analyse').click();
  await expect(page.getByTestId('feasibility-progress')).toBeVisible();
  await expect(page.getByTestId('feasibility-recommendations')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('feasibility-no-solution')).toHaveCount(0);

  const preferred = page.locator('[data-testid^="recommendation-card-die-S1-std-motionx-core-die-"]').first();
  await expect(preferred).toBeVisible();
  await expect(preferred).toHaveAttribute('data-outcome', 'feasible');
  await expect(preferred).toHaveAttribute('data-tested', 'true');
  await expect(preferred).toContainText('Verified library setup');
  await expect(preferred).toContainText('MotionX multi-V die');
  await expect(preferred).toContainText(/2\s*→\s*0/);
  await expect(preferred.getByRole('button', { name: 'Apply & re-plan' })).toBeVisible();
  await shot(page, 'hat-feasibility-advisor-stocked');

  await preferred.getByRole('button', { name: 'Apply & re-plan' }).click();
  await expect(page.getByTestId('plan-progress')).toBeHidden({ timeout: 120_000 });
  await expect(page.getByTestId('program-feasible')).toHaveText('Feasible');
  await expect(page.getByTestId('feasibility-assistant')).toHaveCount(0);
  await page.getByTestId('tab-tools').click();
  await expect(page.getByTestId('station-die-S1')).toHaveValue(/^std:motionx-core-die-r1-slot-/);
  errors.assertClean();
});

test('hat-channel: a physical-slot conflict keeps custom profile guidance non-applicable', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'hat-channel');
  await selectReferenceTooling(page);

  // Reserve the one physical MotionX multi-V die on a deliberately short second station. The
  // advisor may still explain a hypothetical profile change, but must not mount that concept or
  // recommend a second groove orientation of the same physical die at the same time.
  await page.getByTestId('tab-tools').click();
  for (const [testId, value] of [['station-zstart-S1', '1400'], ['station-zend-S1', '1700']] as const) {
    const field = page.getByTestId(testId);
    await field.fill(value);
    await field.press('Enter');
  }
  await page.getByTestId('add-station').click();
  await expect(page.getByTestId('station-S2')).toBeVisible();
  for (const [testId, value] of [['station-zstart-S2', '0'], ['station-zend-S2', '50']] as const) {
    const field = page.getByTestId(testId);
    await field.fill(value);
    await field.press('Enter');
  }
  await page.getByTestId('station-punch-S2').selectOption(REFERENCE_PUNCH_ID);
  await page.getByTestId('station-die-S2').selectOption('std:motionx-core-die-r1-slot-2');

  await plan(page, 4);
  await expect(page.getByTestId('program-feasible')).toHaveText('Not feasible');
  await page.getByTestId('feasibility-analyse').click();
  await expect(page.getByTestId('feasibility-recommendations')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('feasibility-no-solution')).toContainText('No stocked punch or die');

  const concept = page.getByTestId('recommendation-card-custom-minimal-change-S1');
  await expect(concept).toBeVisible();
  await expect(concept).toHaveAttribute('data-outcome', 'custom-required');
  await expect(concept).toHaveAttribute('data-tested', 'true');
  await expect(concept).toContainText('Concept V16 88° narrow body 48 mm');
  await expect(concept.getByTestId('guidance-graphic')).toBeVisible();
  await expect(concept.getByTestId('graphic-current-profile')).toBeVisible();
  await expect(concept.getByTestId('graphic-proposed-profile')).toBeVisible();
  await expect(concept.getByTestId('graphic-collision-marker')).toBeVisible();
  await expect(concept.getByTestId('graphic-dimension-body-width')).toContainText('60 mm');
  await expect(concept.getByTestId('graphic-dimension-body-width')).toContainText('48 mm');
  await expect(concept.locator('[data-testid^="recommendation-apply-"]')).toHaveCount(0);
  await shot(page, 'hat-feasibility-advisor-custom-conflict');

  await concept.getByRole('button', { name: 'View profile change' }).click();
  const dialog = page.getByTestId('recommendation-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Every bend and sequence was re-run');
  await expect(dialog.getByTestId('guidance-graphic')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();

  await concept.getByRole('button', { name: 'Open Tools / import profile' }).click();
  await expect(page.getByTestId('tab-tools')).toHaveClass(/tab-active/);
  await expect(page.getByTestId('station-die-S1')).toHaveValue(REFERENCE_DIE_ID);
  await expect(page.getByTestId('station-die-S2')).toHaveValue('std:motionx-core-die-r1-slot-2');

  await page.getByTestId('language-toggle').click();
  await expect(concept).toContainText('เปลี่ยนน้อยที่สุด');
  await expect(concept).not.toContainText('feasibility.');
  errors.assertClean();
});

test('feasible box does not show unnecessary setup guidance', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'box-4-flange');
  await selectReferenceTooling(page);
  await plan(page, 4);
  await expect(page.getByTestId('program-feasible')).toHaveText('Feasible');
  await expect(page.getByTestId('feasibility-assistant')).toHaveCount(0);
  errors.assertClean();
});
