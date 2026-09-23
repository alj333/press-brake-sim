/**
 * Playwright e2e of the PRODUCTION build (`npm run build` first): serves dist/ with `vite preview`
 * (its /api proxy points at :8080 — start `npm run serve` for the shared-library round trip, otherwise the
 * app runs with its defaults and the first GET /api/library fails, which the app treats as "use defaults").
 *
 * Browser: `/opt/pw-browsers/chromium` (the CI image), overridable with `PW_CHROMIUM=/path/to/chromium`;
 * unset both (PW_CHROMIUM=) to use the browser installed by `npx playwright install chromium`.
 * Software GL (SwiftShader) so the three.js viewport renders on machines without a GPU.
 */
import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const DEFAULT_CHROMIUM = '/opt/pw-browsers/chromium';
const envPath = process.env['PW_CHROMIUM'];
const executablePath = envPath !== undefined ? (envPath || undefined) : (existsSync(DEFAULT_CHROMIUM) ? DEFAULT_CHROMIUM : undefined);

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './scratch/e2e/test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 900 },
    headless: true,
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      // software GL so the three.js viewport renders on machines without a GPU (CI, NAS)
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
