/**
 * Loads the occt-import-js WASM module in either the browser (Vite) or Node (vitest).
 * Cached after the first call.
 */
import type { OcctModule } from 'occt-import-js';

let cached: Promise<OcctModule> | null = null;

// Node (vitest / tsx) is detected positively so that a browser module Worker — which has neither
// `window` nor `document` — takes the browser path.
const isNode = typeof process !== 'undefined' && typeof process.versions === 'object' && typeof process.versions.node === 'string';

export function loadOcct(): Promise<OcctModule> {
  if (cached) return cached;
  cached = (async () => {
    if (!isNode) {
      const [{ default: occtimportjs }, { default: wasmUrl }] = await Promise.all([
        import('occt-import-js'),
        import('occt-import-js/dist/occt-import-js.wasm?url'),
      ]);
      return occtimportjs({ locateFile: () => wasmUrl });
    }
    // Node (tests): CommonJS entry, wasm resolved next to the js file by emscripten.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const occtimportjs = require('occt-import-js') as (o?: unknown) => Promise<OcctModule>;
    return occtimportjs();
  })();
  return cached;
}

export const OCCT_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.05,
  angularDeflection: 0.2,
} as const;
