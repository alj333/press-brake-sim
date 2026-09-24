/**
 * (i) Program panel: Export JSON downloads a file with the steps (and CSV a bilingual table); the print
 *     view renders — window.print() is called with the print class on <body>, and under print media
 *     only the program (bilingual headers, every row) is visible.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { SHOT_DIR, collectErrors, loadSample, openApp, plan, shot } from './helpers.ts';

test('(i) export JSON / CSV download the program and the print view renders', async ({ page }) => {
  const errors = collectErrors(page);
  // record window.print() calls instead of opening a dialog
  await page.addInitScript(() => {
    // (typed through globalThis: the e2e tsconfig has no DOM lib)
    const w = globalThis as unknown as { __printCalls: number; print: () => void };
    w.__printCalls = 0;
    w.print = () => { w.__printCalls++; };
  });
  await openApp(page);
  await loadSample(page, 'Z-bracket');
  await plan(page, 2);

  await page.getByTestId('tab-program').click();
  await expect(page.getByTestId('program-table')).toBeVisible();
  await expect(page.getByTestId('program-table').locator('tbody tr')).toHaveCount(2);
  // bilingual headers
  const firstHeader = page.getByTestId('program-table').locator('thead th').first();
  await expect(firstHeader.locator('.th-en')).toHaveText('Step');
  await expect(firstHeader.locator('.th-th')).toHaveText('ขั้นตอน');

  // ── JSON export ──
  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-json').click(),
  ]);
  expect(jsonDownload.suggestedFilename()).toBe('Z-bracket-program.json');
  const jsonPath = resolve(SHOT_DIR, 'Z-bracket-program.json');
  await jsonDownload.saveAs(jsonPath);
  const exported = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
    app: string; part: { name: string; thickness: number }; machine: { bedLength: number }; feasible: boolean; maxForce: number;
    steps: Array<{ index: number; bendId: string; ramDepth: number; force: number; backgauge: Array<{ x: number }>; includedAngle: number; manipulation: { turn: string } }>;
  };
  expect(exported.steps).toHaveLength(2);
  expect(exported.part.name).toBe('Z-bracket');
  expect(exported.part.thickness).toBe(2);
  expect(exported.machine.bedLength).toBe(3100);
  expect(exported.feasible).toBe(true);
  expect(exported.maxForce).toBeGreaterThan(10);
  for (const [i, step] of exported.steps.entries()) {
    expect(step.index).toBe(i);
    expect(step.bendId).toMatch(/^B[12]$/);
    expect(step.includedAngle).toBeCloseTo(90, 1);
    expect(Number.isFinite(step.ramDepth)).toBe(true);
    expect(step.force).toBeGreaterThan(10);
    expect(step.backgauge.length).toBeGreaterThan(0);
    expect(step.backgauge[0]!.x).toBeGreaterThan(0);
  }
  // the Z-bracket (one up, one down bend) needs exactly one flip (truth expectedFlips = 1)
  expect(exported.steps.filter(s => s.manipulation.turn.startsWith('flip'))).toHaveLength(1);

  // ── CSV export ──
  const [csvDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-csv').click(),
  ]);
  expect(csvDownload.suggestedFilename()).toBe('Z-bracket-program.csv');
  const csvPath = resolve(SHOT_DIR, 'Z-bracket-program.csv');
  await csvDownload.saveAs(csvPath);
  const csv = readFileSync(csvPath, 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);                 // UTF-8 BOM for Excel
  expect(csv).not.toContain('{{');                        // every header label is a plain (bilingual) label
  const lines = csv.slice(1).trim().split(/\r?\n/);
  const headerAt = lines.findIndex(l => l.startsWith('Step / ขั้นตอน,'));
  expect(headerAt, 'bilingual column header row').toBeGreaterThanOrEqual(0);
  expect(lines[0]).toContain('Z-bracket');                // meta block: part, machine, material, thickness, max force
  expect(lines.slice(0, headerAt).join('\n')).toContain('Mild steel');
  expect(lines[headerAt]).toContain('Springback (°) / สปริงแบ็ก (°)');
  expect(lines[headerAt]).toContain('Ram depth / ระยะกดลง');
  const rows = lines.slice(headerAt + 1);
  expect(rows).toHaveLength(2);                           // one row per step
  expect(rows[0]!.startsWith('1,B')).toBe(true);
  expect(rows[1]!.startsWith('2,B')).toBe(true);
  expect(rows[0]!.split(',').length).toBeGreaterThanOrEqual(lines[headerAt]!.split(',').length);

  // ── print ──
  await page.getByTestId('print-program').click();
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __printCalls: number }).__printCalls)).toBe(1);
  // the print class is set while printing (and cleared afterwards by the afterprint fallback)
  await expect(page.locator('body')).not.toHaveClass(/printing-program/, { timeout: 5000 });

  // A4 landscape with 10 mm margins ≈ 277 mm ≈ 1047 CSS px of printable width
  await page.setViewportSize({ width: 1047, height: 740 });
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('program-table')).toBeVisible();
  await expect(page.getByTestId('program-row-1')).toBeVisible();
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(page.locator('.col-left')).toBeHidden();
  await expect(page.locator('.col-centre')).toBeHidden();
  await expect(page.getByTestId('print-program')).toBeHidden();   // the no-print toolbar
  await expect(page.locator('.program-title')).toContainText('Bend program');
  await expect(page.locator('.program-title')).toContainText('โปรแกรมพับ');
  // every column fits the page: the table is not wider than the printable width, nothing is clipped
  const box = await page.getByTestId('program-table').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width, 'table right edge within the page').toBeLessThanOrEqual(1047 + 1);
  const notes = page.getByTestId('program-row-1').locator('.notes-cell');
  const notesBox = await notes.boundingBox();
  expect(notesBox!.x + notesBox!.width).toBeLessThanOrEqual(1047 + 1);
  expect(notesBox!.width).toBeGreaterThan(40);
  const pageBg = await page.evaluate(() => {
    const g = globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string }; document: { documentElement: unknown } };
    return g.getComputedStyle(g.document.documentElement).backgroundColor;
  });
  expect(pageBg).toMatch(/rgb\(255, 255, 255\)|rgba\(0, 0, 0, 0\)/);
  await shot(page, 'program-print-view');
  await page.pdf({ path: resolve(SHOT_DIR, 'program-print.pdf'), format: 'A4', landscape: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.app-header')).toBeVisible();
  errors.assertClean();
});
