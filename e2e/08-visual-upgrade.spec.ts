import { expect, test } from '@playwright/test';
import { collectErrors, loadSample, openApp, plan, shot } from './helpers.ts';

test('visual upgrade: focus mode, camera refit and bilingual legend keep the bend in view', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'box-4-flange');
  await plan(page, 4);

  const viewport = page.getByTestId('sim-viewport');
  const legend = page.getByTestId('sim-visual-legend');
  await expect(viewport).toHaveAttribute('data-active-bend', 'B1');
  await expect(viewport).toHaveAttribute('data-collision-markers', '0');
  await expect(legend).toContainText('Sheet');
  await expect(legend).toContainText('Tooling');

  const before = await viewport.boundingBox();
  expect(before).not.toBeNull();
  await page.getByTestId('focus-3d').click();
  await expect(page.locator('.col-left')).toBeHidden();
  await expect(page.locator('.col-right')).toBeHidden();
  await expect(page.getByTestId('focus-3d')).toHaveAttribute('aria-pressed', 'true');
  const after = await viewport.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.width).toBeGreaterThan(before!.width * 1.5);

  await page.getByTestId('sim-camera-side').click();
  await page.getByTestId('sim-camera-fit').click();
  await page.getByTestId('sim-camera-iso').click();
  await page.waitForTimeout(500);
  await shot(page, 'visual-box-focus-3d');

  await page.getByTestId('language-toggle').click();
  await expect(legend).toContainText('เครื่องมือพับ');
  await expect(page.getByTestId('focus-3d')).toContainText('แสดงแผงข้อมูล');
  await page.getByTestId('project-name').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('focus-3d')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.col-left')).toBeVisible();
  errors.assertClean();
});

test('visual upgrade: hard collision exposes an exact 3D marker in every layout mode', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'hat-channel');
  await plan(page, 4);

  const errorSteps: number[] = [];
  for (let i = 0; i < 4; i++) {
    if ((await page.getByTestId(`step-${i}`).getAttribute('data-errors')) !== '0') errorSteps.push(i);
  }
  expect(errorSteps.length).toBeGreaterThan(0);
  await page.getByTestId(`step-${errorSteps[0]}`).click();
  await page.getByTestId('sim-speed').selectOption('4');
  await page.getByTestId('sim-play').click();
  await expect(page.getByTestId('sim-status')).toContainText('Paused on collision', { timeout: 60_000 });
  await expect(page.getByTestId('sim-viewport')).toHaveAttribute('data-collision-markers', /[1-9]/);
  await expect(page.getByTestId('sim-collisions')).toBeVisible();
  await expect(page.getByTestId('sim-collision-pin').first()).toBeVisible();

  await page.getByTestId('focus-3d').click();
  await page.getByTestId('sim-camera-side').click();
  await page.getByTestId('sim-camera-fit').click();
  await page.waitForTimeout(400);
  await shot(page, 'visual-hat-collision-focus-3d');
  errors.assertClean();
});

test('visual upgrade: compact layout has no page-width overflow and keeps touch controls usable', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);

  const sizes = await page.locator('.header-actions .btn').evaluateAll(elements => elements.map(el => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(sizes.length).toBe(4);
  expect(Math.min(...sizes.map(x => x.height))).toBeGreaterThanOrEqual(39);
  const overflow = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, 'visual-compact-390');
  errors.assertClean();
});
