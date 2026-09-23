import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadOcct, OCCT_PARAMS } from './occt-loader';

describe('occt loader (node)', () => {
  it('reads the L-bracket STEP', async () => {
    const occt = await loadOcct();
    const buf = readFileSync('samples/L-bracket/L-bracket.step');
    const r = occt.ReadStepFile(new Uint8Array(buf), OCCT_PARAMS);
    expect(r.success).toBe(true);
    expect(r.meshes[0].brep_faces.length).toBe(11);
  });
});
