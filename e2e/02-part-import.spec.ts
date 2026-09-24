/**
 * (b) "Load sample" L-bracket → the bends table shows one 90° bend at thickness 2 (DXF + STEP).
 * (c) The L-bracket DXF alone through the file input → outline imported, bend line present.
 */
import { expect, test } from '@playwright/test';
import { collectErrors, loadSample, openApp, samplePath, shot } from './helpers.ts';

test('(b) L-bracket sample: one 90° bend, thickness 2, matched to the STEP model', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'L-bracket');

  const rows = page.getByTestId('bends-table').locator('tbody tr');
  await expect(rows).toHaveCount(1);
  const row = page.getByTestId('bend-row-B1');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('bend-angle-B1')).toHaveValue('90');
  await expect(page.getByTestId('bend-radius-B1')).toHaveValue('2');
  await expect(page.getByTestId('bend-dir-B1')).toContainText('Up');
  await expect(page.getByTestId('thickness-input')).toHaveValue('2');
  await expect(page.getByTestId('project-name')).toHaveValue('L-bracket');
  await expect(page.getByTestId('part-name')).toHaveValue('L-bracket');
  await expect(page.getByTestId('material-select')).toHaveValue('std:mild-steel');

  // angle / radius / direction come from the 3D model, the geometry from the DXF
  await expect(row).toContainText('STEP');
  await expect(row).toContainText('DXF');
  const summary = page.getByTestId('part-summary');
  await expect(summary).toHaveAttribute('data-flanges', '2');
  await expect(summary).toHaveAttribute('data-bends', '1');
  await expect(summary).toHaveAttribute('data-holes', '1');
  await expect(page.getByTestId('part-recognized')).toContainText('1 bends');
  await expect(page.getByTestId('part-recognized')).toContainText('Matched 1 of 1');

  // bend allowance column (BA = 4.52 for t2 ri2 k0.44 90°)
  await expect(row.locator('td').nth(7)).toHaveText('4.52');
  await expect(row.locator('td').nth(6)).toHaveText('80');

  await expect(page.getByTestId('sim-caption')).toBeVisible();   // idle preview of the part
  await shot(page, 'part-L-bracket');
  errors.assertClean();
});

test('(c) L-bracket DXF through the file input: outline imported, bend line present', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);

  await page.getByTestId('import-dxf').setInputFiles(samplePath('L-bracket', 'L-bracket-flat.dxf'));
  await expect(page.getByTestId('bend-row-B1')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('part-importing')).toBeHidden();

  // outline (2 flanges either side of the bend, the hole) and the bend line with DXF geometry
  const summary = page.getByTestId('part-summary');
  await expect(summary).toHaveAttribute('data-flanges', '2');
  await expect(summary).toHaveAttribute('data-bends', '1');
  await expect(summary).toHaveAttribute('data-holes', '1');
  await expect(summary).toContainText('96.5 × 80');
  await expect(page.getByTestId('part-name')).toHaveValue('L-bracket');   // "-flat" suffix stripped
  const row = page.getByTestId('bend-row-B1');
  await expect(row.locator('.cell-id')).toContainText('DXF');            // geometry source
  await expect(page.getByTestId('bend-angle-B1')).toHaveValue('90');     // default angle, marked Default
  await expect(row).toContainText('Default');
  await expect(page.getByTestId('bend-dir-B1')).toContainText('Up');
  await expect(row.locator('td').nth(6)).toHaveText('80');               // bend line spans the sheet
  await expect(page.getByTestId('part-recognized')).toHaveCount(0);      // no 3D model this time

  // the flat view canvas is drawn (not blank)
  const canvas = page.locator('.flatview canvas, canvas.flatview').first();
  if (await canvas.count()) {
    const painted = await canvas.evaluate(c => {
      // (typed structurally: the e2e tsconfig has no DOM lib)
      type Canvas2d = { width: number; height: number; getContext(kind: '2d'): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } | null };
      const el = c as unknown as Canvas2d;
      const ctx = el.getContext('2d');
      if (!ctx) return -1;
      const d = ctx.getImageData(0, 0, el.width, el.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i + 3]! > 0 && (d[i]! < 240 || d[i + 1]! < 240 || d[i + 2]! < 240)) n++;
      return n;
    });
    expect(painted).toBeGreaterThan(0);
  }

  // the planner accepts the DXF-only part
  await page.getByTestId('tab-sequence').click();
  await expect(page.getByTestId('plan-button')).toBeEnabled();
  await shot(page, 'part-dxf-only');
  errors.assertClean();
});
