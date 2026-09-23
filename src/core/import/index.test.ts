import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadTruth, readSampleBytes, samplePath } from '../testing/fixtures';
import { importFile, splitFileName, ImportError } from './index';
import * as barrel from './index';
import { binaryStl, cubeSoup, makeGlb } from './mesh.test';

const OPTS = { thickness: 2, materialId: 'std:mild-steel' };

describe('barrel', () => {
  it('exports the public API names from ARCHITECTURE', () => {
    for (const name of ['importDxfFlat', 'importToolProfileDxf', 'importMesh', 'importStep', 'importFile', 'ImportError', 'weldMesh', 'loadOcct', 'OCCT_PARAMS']) {
      expect(typeof (barrel as Record<string, unknown>)[name], name).not.toBe('undefined');
    }
  });
  it('splitFileName', () => {
    expect(splitFileName('C:\\parts\\L-bracket-flat.DXF')).toEqual({ base: 'L-bracket-flat', ext: 'dxf' });
    expect(splitFileName('dir/part.v2.step')).toEqual({ base: 'part.v2', ext: 'step' });
    expect(splitFileName('noext')).toEqual({ base: 'noext', ext: '' });
    expect(splitFileName('.hidden')).toEqual({ base: '.hidden', ext: '' });
  });
});

describe('importFile', () => {
  it('dxf → flat pattern named after the file', async () => {
    const bytes = new Uint8Array(readFileSync(samplePath('U-channel', 'dxf')));
    const res = await importFile({ name: 'U-channel-flat.dxf', bytes }, OPTS);
    expect(res.flat).toBeDefined();
    expect(res.mesh).toBeUndefined();
    expect(res.flat!.name).toBe('U-channel-flat');
    expect(res.flat!.bends.length).toBe(2);
    expect(res.warnings).toBe(res.flat!.warnings);
    const named = await importFile({ name: 'U-channel-flat.dxf', bytes }, { ...OPTS, name: 'My part', defaultAngle: 95 });
    expect(named.flat!.name).toBe('My part');
    expect(named.flat!.bends[0]!.angle).toBe(95);
  });

  it('stl / obj / glb → mesh (TriangleMesh without the warnings field), warnings on the result', async () => {
    const truth = loadTruth('Z-bracket');
    const res = await importFile({ name: 'Z-bracket.STL', bytes: readSampleBytes('Z-bracket', 'stl') }, OPTS);
    expect(res.flat).toBeUndefined();
    expect(res.mesh).toBeDefined();
    expect(res.mesh!.name).toBe('Z-bracket');
    expect('warnings' in res.mesh!).toBe(false);
    expect(res.mesh!.positions.length / 3).toBeGreaterThan(8);
    const dims = truth.expected.foldedBounds;
    expect(res.mesh!.positions.length).toBeGreaterThan(0);
    expect(dims.x).toBe(78);
    const small = await importFile({ name: 'tiny.stl', bytes: binaryStl(cubeSoup(0.05).positions) }, OPTS);
    expect(small.warnings.map(w => w.key)).toEqual(['warnings.mesh.unitsScaled']);
    const forced = await importFile({ name: 'tiny.stl', bytes: binaryStl(cubeSoup(0.05).positions) }, { ...OPTS, meshUnits: 'mm' });
    expect(forced.warnings).toEqual([]);
    const obj = await importFile({ name: 'tri.obj', bytes: new TextEncoder().encode('v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n') }, OPTS);
    expect(obj.mesh!.indices.length).toBe(3);
    const glb = await importFile({ name: 'quad.glb', bytes: makeGlb([0, 0, 0, 100, 0, 0, 100, 50, 0, 0, 50, 0], [0, 1, 2, 0, 2, 3]) }, OPTS);
    expect(glb.mesh!.indices.length).toBe(6);
    expect(glb.warnings).toEqual([]);
  });

  it('step / stp → mesh with face groups', async () => {
    const res = await importFile({ name: 'acute-bracket.stp', bytes: readSampleBytes('acute-bracket', 'step') }, OPTS);
    expect(res.mesh!.faceGroups!.length).toBeGreaterThan(0);
    expect(res.mesh!.name).toBe('acute-bracket');
    expect(res.warnings).toEqual([]);
  });

  it('unknown extension → ImportError', async () => {
    await expect(importFile({ name: 'part.pdf', bytes: new Uint8Array(4) }, OPTS)).rejects.toMatchObject({ key: 'errors.import.unsupportedExtension', params: { ext: 'pdf' } });
    await expect(importFile({ name: 'part', bytes: new Uint8Array(4) }, OPTS)).rejects.toBeInstanceOf(ImportError);
  });
});
