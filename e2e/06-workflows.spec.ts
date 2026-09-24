/**
 * Cross-panel workflows beyond the basic checklist:
 *  - acute bracket: infeasible on the 88° default station, feasible once the acute tools are mounted;
 *  - editing a bend in the table invalidates the program and the re-plan follows the new angle;
 *  - drag-reordering the steps fixes the order (and "Auto" restores the planner's order);
 *  - save project → new project → load project restores part, program and name.
 */
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { SHOT_DIR, collectErrors, loadSample, openApp, plan, shot } from './helpers.ts';

test('acute bracket: 88° tools are rejected, the acute station makes it feasible', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'acute-bracket');
  await expect(page.getByTestId('bend-angle-B1')).toHaveValue('135');
  await expect(page.getByTestId('thickness-input')).toHaveValue('1.5');

  await plan(page, 1);
  await expect(page.getByTestId('program-feasible')).toHaveText('Not feasible');
  await expect(page.getByTestId('step-0')).toContainText('do not fit the loaded angle');
  await expect(page.getByTestId('step-angle-0')).toContainText('45°');

  // mount the acute tools on S1
  await page.getByTestId('tab-tools').click();
  await page.getByTestId('station-punch-S1').selectOption('std:punch-acute-30-r0.8');
  await page.getByTestId('station-die-S1').selectOption('std:die-v12-30');
  await expect(page.getByTestId('program-stale')).toBeVisible();
  await plan(page, 1);
  await expect(page.getByTestId('program-feasible')).toHaveText('Feasible');
  await expect(page.getByTestId('step-station-0')).toContainText('Acute punch 30°');
  await expect(page.getByTestId('step-0')).not.toContainText('do not fit');
  const depth = Number(await page.getByTestId('step-ramdepth-0').getAttribute('data-ram-depth'));
  expect(depth).toBeGreaterThan(6);     // truth ≈ 7.9 (sharp shoulder), acute bend goes deep
  expect(depth).toBeLessThan(11);
  await page.getByTestId('sim-step-forward').click();   // gauge
  await page.getByTestId('sim-step-forward').click();   // approach
  await page.getByTestId('sim-step-forward').click();   // bend
  await page.getByTestId('sim-step-forward').click();   // release: fully bent on the acute tools
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-phase', 'release');
  await page.getByTestId('sim-section').click();
  await page.waitForTimeout(400);
  await shot(page, 'acute-bracket-bent');
  errors.assertClean();
});

test('editing a bend clears the program; the re-plan follows the new angle', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'L-bracket');
  await plan(page, 1);
  await expect(page.getByTestId('step-angle-0')).toContainText('90°');

  const angle = page.getByTestId('bend-angle-B1');
  await angle.fill('120');
  await angle.press('Enter');
  await expect(angle).toHaveValue('120');
  await expect(page.getByTestId('bend-row-B1')).toContainText('User');    // source badge
  await expect(page.getByTestId('steps')).toHaveCount(0);                  // program cleared
  await expect(page.getByTestId('sim-play')).toBeDisabled();
  // the flat view label follows the edit
  await expect(page.getByTestId('bend-row-B1').locator('td').nth(7)).not.toHaveText('4.52');

  await plan(page, 1);
  await expect(page.getByTestId('step-angle-0')).toContainText('60°');    // included = 180 − 120
  await expect(page.getByTestId('program-feasible')).toHaveText('Not feasible');   // 60° included needs acute tools
  // direction toggle → program cleared again
  await page.getByTestId('bend-dir-B1').click();
  await expect(page.getByTestId('bend-dir-B1')).toContainText('Down');
  await expect(page.getByTestId('steps')).toHaveCount(0);
  errors.assertClean();
});

test('drag-reordering the steps fixes the order and Auto restores it', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'box-4-flange');
  await plan(page, 4);
  const before: string[] = [];
  for (let i = 0; i < 4; i++) before.push((await page.getByTestId(`step-${i}`).getAttribute('data-bend-id')) ?? '');

  await page.getByTestId('step-1').dragTo(page.getByTestId('step-0'));
  await expect(page.getByTestId('plan-progress')).toBeHidden({ timeout: 120_000 });
  await expect(page.getByTestId('order-auto')).toBeVisible();           // fixed-order badge + Auto button
  await expect(page.locator('.sequence-panel')).toContainText('Fixed order');
  await expect(page.getByTestId('step-0')).toHaveAttribute('data-bend-id', before[1]!);
  await expect(page.getByTestId('step-1')).toHaveAttribute('data-bend-id', before[0]!);
  await expect(page.getByTestId('steps').locator('[role="listitem"]')).toHaveCount(4);

  await page.getByTestId('order-auto').click();
  await expect(page.getByTestId('plan-progress')).toBeHidden({ timeout: 120_000 });
  await expect(page.getByTestId('order-auto')).toHaveCount(0);
  for (let i = 0; i < 4; i++) await expect(page.getByTestId(`step-${i}`)).toHaveAttribute('data-bend-id', before[i]!);
  errors.assertClean();
});

test('save project → new → load project restores the part and the program', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'Z-bracket');
  await plan(page, 2);
  await page.getByTestId('project-name').fill('Bracket job 42');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-project').click()]);
  expect(download.suggestedFilename()).toBe('Bracket-job-42.pbsim.json');
  const file = resolve(SHOT_DIR, 'Bracket-job-42.pbsim.json');
  await download.saveAs(file);

  page.once('dialog', d => { void d.accept(); });      // "Discard the current project?"
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('bends-table')).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toHaveValue('');
  await expect(page.getByTestId('sim-play')).toBeDisabled();

  await page.getByTestId('load-project').setInputFiles(file);
  await expect(page.getByTestId('project-name')).toHaveValue('Bracket job 42');
  await expect(page.getByTestId('bend-row-B2')).toBeVisible();
  await expect(page.getByTestId('bend-dir-B2')).toContainText('Down');
  await expect(page.getByTestId('bend-angle-B1')).toHaveValue('90');
  await page.getByTestId('tab-sequence').click();
  await expect(page.getByTestId('steps').locator('[role="listitem"]')).toHaveCount(2);
  await expect(page.getByTestId('program-feasible')).toHaveText('Feasible');
  await expect(page.getByTestId('program-stale')).toHaveCount(0);
  await expect(page.getByTestId('sim-play')).toBeEnabled();              // timeline rebuilt
  await expect(page.getByTestId('sim-time')).toHaveAttribute('data-duration-s', /^[1-9]\d*\./);
  await page.getByTestId('tab-program').click();
  await expect(page.getByTestId('program-table').locator('tbody tr')).toHaveCount(2);
  await expect(page.getByTestId('program-part')).toContainText('Bracket job 42');
  errors.assertClean();
});
