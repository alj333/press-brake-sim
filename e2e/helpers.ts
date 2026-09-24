/**
 * Shared helpers for the Playwright e2e suite: console / page error collection (with the one
 * expected failure — the shared-library GET that has no API server behind the preview proxy —
 * filtered out), sample loading, planning and screenshots into scratch/e2e/.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export const ROOT = resolve(import.meta.dirname, '..');
export const SHOT_DIR = resolve(ROOT, 'scratch/e2e');
export const SAMPLES_DIR = resolve(ROOT, 'samples');

/** Sample bend ids (B1…Bn) as the DXF flats name them. */
export const SAMPLE_BENDS: Record<string, number> = {
  'L-bracket': 1, 'U-channel': 2, 'Z-bracket': 2, 'hat-channel': 4, 'acute-bracket': 1, 'box-4-flange': 4, 'tabbed-plate': 1,
};

export interface ErrorLog {
  console: string[];
  page: string[];
  /** Expected / tolerated noise (reported, never failed on). */
  ignored: string[];
  /** Fails the test when any unexpected console or page error was logged. */
  assertClean(): void;
}

/** GET /api/library goes through the preview proxy to :8080 — without the API server the browser logs one
 *  failed resource load (a 404 with the server, 500 / connection error without). Expected by design. */
function isExpectedNoise(text: string, url: string): boolean {
  if (/\/api\/library/.test(url) || /\/api\/library/.test(text)) return true;
  // SwiftShader / headless GL warnings arrive as console errors on some builds
  if (/GPU stall due to ReadPixels|SwiftShader|GroupMarkerNotSet|WebGL: too many errors/.test(text)) return true;
  return false;
}

export function collectErrors(page: Page): ErrorLog {
  const log: ErrorLog = {
    console: [], page: [], ignored: [],
    assertClean() {
      expect(log.page, 'page errors').toEqual([]);
      expect(log.console, 'console errors').toEqual([]);
    },
  };
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text().slice(0, 500);
    const url = m.location().url ?? '';
    if (isExpectedNoise(text, url)) log.ignored.push(`${text} @ ${url}`);
    else log.console.push(`${text} @ ${url}`);
  });
  page.on('pageerror', e => log.page.push(String(e.message).slice(0, 500)));
  page.on('requestfailed', r => {
    const url = r.url();
    const text = `request failed: ${url} ${r.failure()?.errorText ?? ''}`;
    if (isExpectedNoise(text, url)) log.ignored.push(text);
    else log.console.push(text);
  });
  return log;
}

/** Opens the app and waits for the shell + the 3D canvas. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('tab-part')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
}

/** Loads a bundled sample through the sample menu and waits for every bend row (DXF + STEP worker). */
export async function loadSample(page: Page, name: keyof typeof SAMPLE_BENDS): Promise<void> {
  await page.getByTestId('tab-part').click();
  await page.getByTestId('sample-menu').click();
  await page.getByTestId(`sample-${name}`).click();
  const n = SAMPLE_BENDS[name] ?? 1;
  await expect(page.getByTestId(`bend-row-B${n}`)).toBeVisible({ timeout: 90_000 });
  // the STEP recognition finishes after the DXF: wait for the "recognised" line so the bends carry STEP sources
  await expect(page.getByTestId('part-recognized')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('part-importing')).toBeHidden({ timeout: 90_000 });
}

/** Clicks Plan and waits for the program (all `steps` step cards) to appear. */
export async function plan(page: Page, steps: number): Promise<void> {
  await page.getByTestId('tab-sequence').click();
  const button = page.getByTestId('plan-button');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('plan-progress')).toBeHidden({ timeout: 120_000 });
  await expect(page.getByTestId('program-feasible')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('steps').locator('[role="listitem"]')).toHaveCount(steps);
  await expect(page.getByTestId(`step-${steps - 1}`)).toBeVisible();
}

export async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const path = resolve(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

/** Reads the numeric content of a locator (first number found, e.g. "12.5 mm" → 12.5). */
export async function numberOf(locator: Locator): Promise<number> {
  const text = (await locator.textContent()) ?? '';
  const m = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  expect(m, `number in "${text}"`).not.toBeNull();
  return Number(m![0]);
}

export function samplePath(...parts: string[]): string {
  return resolve(SAMPLES_DIR, ...parts);
}
