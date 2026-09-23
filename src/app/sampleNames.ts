/** ui — the bundled sample parts served from /samples/<name>/ (mirrors src/core/testing/fixtures.ts, which is Node-only). */
export const SAMPLE_NAMES = [
  'L-bracket', 'U-channel', 'Z-bracket', 'hat-channel', 'acute-bracket', 'box-4-flange', 'tabbed-plate',
] as const;
export type SampleName = (typeof SAMPLE_NAMES)[number];
