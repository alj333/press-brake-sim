/**
 * (d) U-channel → Plan → 2 steps with backgauge X > 0 and ram depths; the Program panel shows the rows.
 * (e) box-4-flange → Plan → 4 feasible steps without error collisions; play ~3 s (time advances, no
 *     console errors); step ▶ through the phases; screenshots of the iso view, a mid-bend section and
 *     the program table.
 * (f) hat-channel → Plan → at least one turn that is a flip.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { collectErrors, loadSample, openApp, plan, shot } from './helpers.ts';

const PHASES = ['position', 'gauge', 'approach', 'bend', 'release', 'retract', 'reposition'];

async function simTime(page: Page): Promise<number> {
  return Number(await page.getByTestId('sim-time').getAttribute('data-time-s'));
}

async function simPhase(page: Page): Promise<string> {
  return (await page.getByTestId('sim-status').getAttribute('data-phase')) ?? '';
}

/** Drags the transport scrubber to `timeS` (React listens to the range input's `input` event). */
async function seekTo(page: Page, timeS: number): Promise<void> {
  await page.getByTestId('sim-scrubber').evaluate((el, v) => {
    type RangeInput = { value: string; dispatchEvent(e: Event): boolean };
    const input = el as unknown as RangeInput;
    const proto = Object.getPrototypeOf(input) as object;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, String(v)); else input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, timeS);
  await expect.poll(() => simTime(page)).toBeCloseTo(timeS, 1);
}

test('(d) U-channel: 2 steps with backgauge X > 0, ram depth, program rows', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'U-channel');
  await plan(page, 2);

  await expect(page.getByTestId('program-feasible')).toHaveText('Feasible');
  for (const i of [0, 1]) {
    const finger = page.getByTestId(`step-finger-${i}-0`);
    await expect(finger).toBeVisible();
    const x = Number(await finger.getAttribute('data-x'));
    expect(x, `step ${i} backgauge X`).toBeGreaterThan(0);
    expect(x).toBeLessThan(750);
    await expect(page.getByTestId(`step-backgauge-${i}`)).toHaveAttribute('data-contact', /cut-edge|flange-face/);
    const depth = Number(await page.getByTestId(`step-ramdepth-${i}`).getAttribute('data-ram-depth'));
    expect(Number.isFinite(depth), `step ${i} ram depth`).toBe(true);
    expect(depth).toBeGreaterThan(2);      // truth: 4.26 sharp-shoulder, ± the fillet
    expect(depth).toBeLessThan(7);
    const force = Number(await page.getByTestId(`step-force-${i}`).getAttribute('data-force-kn'));
    expect(force).toBeGreaterThan(15);     // truth: 17.9 kN
    expect(force).toBeLessThan(21);
    await expect(page.getByTestId(`step-angle-${i}`)).toContainText('90°');
    await expect(page.getByTestId(`step-station-${i}`)).toContainText('V16');
  }
  // both bends are 'up': no flip between them (truth expectedFlips = 0)
  await expect(page.getByTestId('step-1')).not.toHaveAttribute('data-turn', /flip/);
  // the two fingers of the standard machine
  await expect(page.getByTestId('step-finger-0-1')).toBeVisible();

  // the Program panel lists both rows with the backgauge values and the machine header
  await page.getByTestId('tab-program').click();
  await expect(page.getByTestId('program-table')).toBeVisible();
  await expect(page.getByTestId('program-table').locator('tbody tr')).toHaveCount(2);
  await expect(page.getByTestId('program-row-0')).toContainText('F1: X');
  await expect(page.getByTestId('program-row-1')).toContainText('kN');
  await expect(page.getByTestId('program-machine')).toContainText('3100 mm');
  await expect(page.getByTestId('program-part')).toContainText('U-channel');
  await shot(page, 'program-U-channel');
  errors.assertClean();
});

test('(e) box-4-flange: 4 feasible steps, playback advances, phases step through', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'box-4-flange');
  await plan(page, 4);

  await expect(page.getByTestId('program-feasible')).toHaveText('Feasible');
  for (let i = 0; i < 4; i++) {
    await expect(page.getByTestId(`step-${i}`)).toHaveAttribute('data-errors', '0');
    await expect(page.getByTestId(`step-collisions-${i}`)).toHaveCount(0);
    await expect(page.getByTestId(`step-finger-${i}-0`)).toBeVisible();
  }
  await expect(page.getByTestId('step-0')).toHaveClass(/card-active/);   // step 0 selected after planning
  await expect(page.getByTestId('sim-caption')).toContainText('Step 1');
  await expect(page.getByTestId('sim-collisions')).toHaveCount(0);
  await page.getByTestId('sim-camera-iso').click();
  await page.waitForTimeout(500);
  await shot(page, 'box-iso-after-plan');

  // play ~3 s of simulation
  const duration = Number(await page.getByTestId('sim-time').getAttribute('data-duration-s'));
  expect(duration).toBeGreaterThan(10);
  const t0 = await simTime(page);
  await page.getByTestId('sim-play').click();
  await expect(page.getByTestId('sim-play')).toHaveAttribute('data-playing', 'true');
  await page.waitForTimeout(3000);
  await page.getByTestId('sim-play').click();
  await expect(page.getByTestId('sim-play')).toHaveAttribute('data-playing', 'false');
  const t1 = await simTime(page);
  expect(t1, 'time advances while playing').toBeGreaterThan(t0 + 1);
  expect(t1).toBeLessThan(duration);
  await expect(page.getByTestId('sim-collisions')).toHaveCount(0);
  await expect(page.getByTestId('sim-status')).not.toContainText('Paused on collision');

  // step ▶ through the phases from the start of step 1
  await page.getByTestId('step-0').click();
  await expect.poll(() => simPhase(page)).toBe('position');
  const seen: string[] = ['position'];
  const times: number[] = [await simTime(page)];
  for (let i = 0; i < 12 && seen.length < 8; i++) {
    await page.getByTestId('sim-step-forward').click();
    await page.waitForTimeout(100);
    const phase = await simPhase(page);
    const t = await simTime(page);
    expect(PHASES, `phase ${phase}`).toContain(phase);
    expect(t).toBeGreaterThanOrEqual(times[times.length - 1]!);
    seen.push(phase);
    times.push(t);
  }
  // every core phase of step 1 was visited in order before step 2 starts
  const order = ['position', 'gauge', 'approach', 'bend', 'release', 'retract'];
  let last = -1;
  for (const p of order) {
    const idx = seen.indexOf(p);
    expect(idx, `phase ${p} visited`).toBeGreaterThan(last);
    last = idx;
  }
  await expect(page.getByTestId('sim-status')).toContainText('Step 2');

  // section view in the middle of the first bend phase
  await page.getByTestId('step-0').click();
  const bendStart = times[seen.indexOf('bend')]!;
  const bendEnd = times[seen.indexOf('release')]!;
  expect(bendEnd).toBeGreaterThan(bendStart);
  await page.getByTestId('sim-section').click();
  await expect(page.getByTestId('section-view')).toBeVisible();
  await seekTo(page, (bendStart + bendEnd) / 2);
  await expect.poll(() => simPhase(page)).toBe('bend');
  await page.waitForTimeout(500);
  await shot(page, 'box-section-mid-bend');
  await page.getByTestId('sim-camera-front').click();
  await page.waitForTimeout(400);
  await shot(page, 'box-front-mid-bend');
  await page.getByTestId('sim-section').click();
  await expect(page.getByTestId('section-view')).toHaveCount(0);

  // keyboard: ← goes to the start of the current phase, a second ← to the previous phase
  // (focus on the page body, not an input)
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => simTime(page)).toBeCloseTo(bendStart, 2);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => simPhase(page)).toBe('approach');
  // Space toggles playback
  await page.keyboard.press('Space');
  await expect(page.getByTestId('sim-play')).toHaveAttribute('data-playing', 'true');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('sim-play')).toHaveAttribute('data-playing', 'false');

  // program table
  await page.getByTestId('tab-program').click();
  await expect(page.getByTestId('program-table').locator('tbody tr')).toHaveCount(4);
  await shot(page, 'box-program-table');
  errors.assertClean();
});

test('(f) hat-channel: the plan needs at least one flip', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await loadSample(page, 'hat-channel');
  await plan(page, 4);

  const turns: string[] = [];
  for (let i = 0; i < 4; i++) turns.push((await page.getByTestId(`step-${i}`).getAttribute('data-turn')) ?? '');
  expect(turns.some(t => t.startsWith('flip')), `turns ${turns.join(', ')}`).toBe(true);
  expect(turns.filter(t => t.startsWith('flip')).length, 'at most 2 flips (truth maxFlips)').toBeLessThanOrEqual(2);
  const flipIndex = turns.findIndex(t => t.startsWith('flip'));
  await expect(page.getByTestId(`step-turn-${flipIndex}`)).toContainText('Flip');

  // the reposition phase exists for the flipped step
  await page.getByTestId(`step-${flipIndex}`).click();
  await expect(page.getByTestId('sim-status')).toContainText(`Step ${flipIndex + 1}`);
  await page.waitForTimeout(400);
  await shot(page, 'hat-channel-plan');

  // the brim lands inside the standard 60 mm die body (ARCHITECTURE): an error collision makes the
  // program infeasible, and playback pauses on it unless "continue on collision" is set
  await expect(page.getByTestId('program-feasible')).toHaveText('Not feasible');
  const errorSteps: number[] = [];
  for (let i = 0; i < 4; i++) if ((await page.getByTestId(`step-${i}`).getAttribute('data-errors')) !== '0') errorSteps.push(i);
  expect(errorSteps.length, 'a step with an error collision').toBeGreaterThan(0);
  const firstError = errorSteps[0]!;
  await expect(page.getByTestId(`step-collisions-${firstError}`)).toContainText('hits the die');
  await page.getByTestId(`step-${firstError}`).click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-step-index', String(firstError));
  await page.getByTestId('sim-speed').selectOption('4');
  await page.getByTestId('sim-play').click();
  await expect(page.getByTestId('sim-status')).toContainText('Paused on collision', { timeout: 60_000 });
  await expect(page.getByTestId('sim-play')).toHaveAttribute('data-playing', 'false');
  await expect(page.getByTestId('sim-collisions')).toBeVisible();
  await expect(page.getByTestId('sim-collisions')).toContainText('die');
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-step-index', String(firstError));
  await page.getByTestId('sim-section').click();
  await page.waitForTimeout(400);
  await shot(page, 'hat-channel-collision');

  // Thai rendering of the step card (turn / collision text through the dictionary)
  await page.getByTestId('language-toggle').click();
  await expect(page.getByTestId(`step-turn-${flipIndex}`)).toContainText('พลิกชิ้นงาน');
  await expect(page.getByTestId('program-feasible')).toHaveText('พับไม่ได้');
  await expect(page.getByTestId('sim-status')).toContainText('หยุดเพราะเกิดการชน');
  await page.getByTestId('language-toggle').click();
  errors.assertClean();
});
