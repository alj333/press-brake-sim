/**
 * (g) Tools panel: the custom tool dialog imports samples/tools/*.dxf (die, gooseneck punch, finger)
 *     with the default settings; each saved tool appears in the library list and can be selected in a
 *     station (punch / die) or as the backgauge finger.
 * (h) Machine panel: an edited bed length survives a re-plan.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { collectErrors, loadSample, openApp, plan, samplePath, shot } from './helpers.ts';

async function addCustomTool(page: Page, file: string, kind: 'punch' | 'die' | 'finger', name: string): Promise<void> {
  await page.getByTestId('add-custom-tool').click();
  const dialog = page.getByTestId('custom-tool-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('custom-tool-save')).toBeDisabled();       // nothing to save yet
  await page.getByTestId('custom-tool-kind').selectOption(kind);
  await page.getByTestId('custom-tool-file').setInputFiles(samplePath('tools', file));
  await expect(page.getByTestId('custom-tool-raw-preview')).toBeVisible();
  await expect(page.getByTestId('custom-tool-preview')).toBeVisible();
  // the name defaults to the file name; the rest stays at its defaults (auto reference, y+ up, scale 1)
  await expect(page.getByTestId('custom-tool-name')).toHaveValue(file.replace(/\.dxf$/, ''));
  await page.getByTestId('custom-tool-name').fill(name);
  await expect(page.getByTestId('custom-tool-scale')).toHaveValue('1');
  await expect(page.getByTestId('custom-tool-updir')).toHaveValue('y+');
  await expect(dialog.locator('.msg-error')).toHaveCount(0);
  await expect(page.getByTestId('custom-tool-save')).toBeEnabled();
  await page.getByTestId('custom-tool-save').click();
  await expect(dialog).toHaveCount(0);
}

test('(g) custom die, gooseneck punch and finger from DXF land in the library and mount on a station', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await page.getByTestId('tab-tools').click();
  await expect(page.getByTestId('station-S1')).toBeVisible();
  await expect(page.getByTestId('custom-tools')).toHaveCount(0);

  // ── die ──
  await addCustomTool(page, 'custom-v16-die.dxf', 'die', 'Shop V16 die');
  const list = page.getByTestId('custom-tools');
  await expect(list.locator('li')).toHaveCount(1);
  await expect(list).toContainText('Shop V16 die');
  await expect(list.locator('li').first()).toContainText('V 16');            // derived V width from the profile
  await expect(list.locator('li').first()).toContainText('Die');
  const dieSelect = page.getByTestId('station-die-S1');
  await dieSelect.selectOption({ label: 'Shop V16 die *' });
  await expect(dieSelect.locator('option:checked')).toHaveText('Shop V16 die *');
  await expect(page.locator('.previews')).toContainText('Shop V16 die');
  await expect(list.locator('li').first()).toContainText('In use');
  await shot(page, 'tools-custom-die');

  // ── gooseneck punch ──
  await addCustomTool(page, 'custom-gooseneck-punch.dxf', 'punch', 'Shop gooseneck');
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list).toContainText('Shop gooseneck');
  const punchItem = list.locator('li', { hasText: 'Shop gooseneck' });
  await expect(punchItem).toContainText('Punch');
  await expect(punchItem).toContainText(/Tip angle \(°\) 8[0-9]/);   // ≈ 88° derived from the profile
  const punchSelect = page.getByTestId('station-punch-S1');
  await punchSelect.selectOption({ label: 'Shop gooseneck *' });
  await expect(punchSelect.locator('option:checked')).toHaveText('Shop gooseneck *');
  await expect(page.locator('.previews')).toContainText('Shop gooseneck');
  await expect(punchItem).toContainText('In use');

  // ── finger ──
  await addCustomTool(page, 'custom-finger.dxf', 'finger', 'Shop stepped finger');
  await expect(list.locator('li')).toHaveCount(3);
  const fingerItem = list.locator('li', { hasText: 'Shop stepped finger' });
  await expect(fingerItem).toContainText('Finger');
  const fingerSelect = page.getByTestId('finger-select');
  await fingerSelect.selectOption({ label: 'Shop stepped finger *' });
  await expect(fingerSelect.locator('option:checked')).toHaveText('Shop stepped finger *');
  await expect(fingerItem).toContainText('In use');
  await shot(page, 'tools-custom-all');

  // the custom tools survive a reload (localStorage cache of the library) and stay selectable
  await page.reload();
  await expect(page.getByTestId('tab-part')).toBeVisible();
  await page.getByTestId('tab-tools').click();
  await expect(page.getByTestId('custom-tools').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('station-die-S1').locator('option', { hasText: 'Shop V16 die' })).toHaveCount(1);
  await expect(page.getByTestId('station-punch-S1').locator('option', { hasText: 'Shop gooseneck' })).toHaveCount(1);
  await expect(page.getByTestId('finger-select').locator('option', { hasText: 'Shop stepped finger' })).toHaveCount(1);

  // and a part can be planned on the custom tooling
  await loadSample(page, 'L-bracket');
  await page.getByTestId('tab-tools').click();
  await page.getByTestId('station-die-S1').selectOption({ label: 'Shop V16 die *' });
  await page.getByTestId('station-punch-S1').selectOption({ label: 'Shop gooseneck *' });
  await page.getByTestId('finger-select').selectOption({ label: 'Shop stepped finger *' });
  await plan(page, 1);
  await expect(page.getByTestId('step-station-0')).toContainText('Shop gooseneck / Shop V16 die');
  await expect(page.getByTestId('program-feasible')).toHaveText('Feasible');
  await expect(page.getByTestId('step-0')).toHaveAttribute('data-errors', '0');
  await shot(page, 'tools-custom-planned');
  errors.assertClean();
});

test('(h) machine bed length edit persists after a re-plan', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'L-bracket');
  await plan(page, 1);
  await expect(page.getByTestId('program-stale')).toHaveCount(0);

  await page.getByTestId('tab-machine').click();
  const bed = page.getByTestId('machine-bed-length');
  await expect(bed).toHaveValue('3100');
  await bed.fill('2500');
  await bed.press('Enter');
  await expect(bed).toHaveValue('2500');
  // the program is flagged stale after a machine edit
  await page.getByTestId('tab-sequence').click();
  await expect(page.getByTestId('program-stale')).toBeVisible();
  await shot(page, 'machine-bed-edited');

  // the default station spans the old bed: shrink it so the setup stays valid on the shorter bed
  await page.getByTestId('tab-tools').click();
  const zEnd = page.getByTestId('station-zend-S1');
  await zEnd.fill('2500');
  await zEnd.press('Enter');
  await expect(zEnd).toHaveValue('2500');
  await expect(page.getByTestId('setup-warnings')).toHaveCount(0);

  await plan(page, 1);
  await expect(page.getByTestId('program-stale')).toHaveCount(0);
  await expect(page.getByTestId('program-feasible')).toHaveText('Feasible');
  await page.getByTestId('tab-machine').click();
  await expect(page.getByTestId('machine-bed-length')).toHaveValue('2500');
  await page.getByTestId('tab-program').click();
  await expect(page.getByTestId('program-machine')).toContainText('2500 mm');
  await expect(page.getByTestId('program-machine')).toHaveAttribute('data-bed-length', '2500');

  // the edit also survives a reload (library cache)
  await page.reload();
  await expect(page.getByTestId('tab-part')).toBeVisible();
  await page.getByTestId('tab-machine').click();
  await expect(page.getByTestId('machine-bed-length')).toHaveValue('2500');
  errors.assertClean();
});
