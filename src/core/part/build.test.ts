import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth } from '../testing/fixtures';
import type { FlatPattern } from '../types';
import { area } from '../geom';
import { buildPartModel } from './build';

const EXPECTED_FLANGES: Record<string, number> = {
  'L-bracket': 2, 'U-channel': 3, 'Z-bracket': 3, 'hat-channel': 5, 'acute-bracket': 2, 'box-4-flange': 5, 'tabbed-plate': 2,
};

describe('buildPartModel on the samples', () => {
  for (const name of SAMPLE_NAMES) {
    it(`${name}: flange count, tree, allowances, no unexpected warnings`, () => {
      const truth = loadTruth(name);
      const part = buildPartModel(truth.flat);
      expect(part.flanges.length).toBe(EXPECTED_FLANGES[name]);
      expect(part.flanges.length).toBe(truth.expected.flangeCount);
      expect(part.links.length).toBe(truth.flat.bends.length);
      expect(part.warnings).toEqual([]);
      for (const b of truth.flat.bends) expect(part.bendAllowance[b.id]).toBeCloseTo(truth.expected.bendAllowance[b.id]!, 9);
      // every flange reachable, root is the largest
      const root = part.flanges.find(f => f.id === part.rootFlangeId)!;
      for (const f of part.flanges) expect(root.area).toBeGreaterThanOrEqual(f.area);
      const reached = new Set([part.rootFlangeId, ...part.links.map(l => l.childFlangeId)]);
      expect(reached.size).toBe(part.flanges.length);
      // total flange area = outline area − holes − zones
      const zones = truth.flat.bends.reduce((s, b) => s + part.bendAllowance[b.id]! * Math.hypot(b.p1.x - b.p0.x, b.p1.y - b.p0.y), 0);
      const holes = truth.flat.holes.reduce((s, h) => s + area(h), 0);
      const total = part.flanges.reduce((s, f) => s + f.area, 0);
      expect(total).toBeCloseTo(area(truth.flat.outline) - holes - zones, 3);
      expect(part.flatBounds.max.x - part.flatBounds.min.x).toBeCloseTo(truth.expected.flatBounds.w, 5);
      // holes all assigned
      const holeCount = part.flanges.reduce((s, f) => s + f.regions.reduce((q, r) => q + r.holes.length, 0), 0);
      expect(holeCount).toBe(truth.expected.holeCount);
    });
  }

  it('L-bracket: root is the 56 mm leg with the hole, child is the 36 mm leg', () => {
    const truth = loadTruth('L-bracket');
    const part = buildPartModel(truth.flat);
    const root = part.flanges.find(f => f.id === part.rootFlangeId)!;
    expect(root.regions.length).toBe(1);
    expect(root.regions[0]!.holes.length).toBe(1);
    expect(root.area).toBeCloseTo(56 * 80 - Math.PI * 25, 0);
    const child = part.flanges.find(f => f.id !== part.rootFlangeId)!;
    expect(child.area).toBeCloseTo(36 * 80, 3);
    expect(part.links).toEqual([{ bendId: 'B1', parentFlangeId: root.id, childFlangeId: child.id }]);
    expect(root.bendIds).toEqual(['B1']);
  });

  it('tabbed-plate: the plate beside the tab stays in the root flange (ONE merged region), tab is the child', () => {
    const truth = loadTruth('tabbed-plate');
    const part = buildPartModel(truth.flat);
    const root = part.flanges.find(f => f.id === part.rootFlangeId)!;
    const ba = part.bendAllowance['B1']!;
    const zoneInPlate = (120 - (118 - ba / 2)) * 30;             // strip part inside the plate outline
    const holeArea = area(truth.flat.holes[0]!);
    const plateArea = 120 * 80 - 2 * ((120 - (118 - ba / 2 - 1)) * 2) - zoneInPlate - holeArea;
    expect(root.area).toBeCloseTo(plateArea, 3);
    // the artificial split lines (y = 25, y = 55, x = 118 ± BA/2) leave no seams: one polygon
    expect(root.regions.length).toBe(1);
    const poly = root.regions[0]!.polygon;
    expect(poly.length).toBe(12);
    expect(root.regions[0]!.holes.length).toBe(1);
    // the zone side line is an edge of the plate polygon between the relief notches
    const xs = poly.filter(p => Math.abs(p.x - (118 - ba / 2)) < 1e-6).map(p => p.y).sort((a, b) => a - b);
    expect(xs).toEqual([25, 55]);
    const child = part.flanges.find(f => f.id !== part.rootFlangeId)!;
    expect(child.area).toBeCloseTo(21 * 30, 3);
    expect(child.regions.length).toBe(1);
    expect(part.links[0]).toEqual({ bendId: 'B1', parentFlangeId: root.id, childFlangeId: child.id });
  });

  it('box: root is the centre rectangle with 4 children', () => {
    const truth = loadTruth('box-4-flange');
    const part = buildPartModel(truth.flat);
    const root = part.flanges.find(f => f.id === part.rootFlangeId)!;
    expect(root.area).toBeCloseTo(192 * 142, 3);
    expect(root.regions.length).toBe(1);
    expect(part.links.every(l => l.parentFlangeId === root.id)).toBe(true);
    expect(part.links.length).toBe(4);
    const childAreas = part.links.map(l => part.flanges.find(f => f.id === l.childFlangeId)!.area).sort((a, b) => a - b);
    expect(childAreas[0]).toBeCloseTo(26 * 142, 3);
    expect(childAreas[3]).toBeCloseTo(26 * 192, 3);
  });

  it('hat-channel: chain of 5 with the wide top as root', () => {
    const truth = loadTruth('hat-channel');
    const part = buildPartModel(truth.flat);
    const root = part.flanges.find(f => f.id === part.rootFlangeId)!;
    expect(root.area).toBeCloseTo(42 * 100, 3);
    // root has two children (the walls), each wall has one child (the brim)
    const fromRoot = part.links.filter(l => l.parentFlangeId === root.id);
    expect(fromRoot.length).toBe(2);
    for (const l of fromRoot) expect(part.links.filter(m => m.parentFlangeId === l.childFlangeId).length).toBe(1);
  });

  it('a flat without bends is a single root flange; CW outline and CCW holes are normalised', () => {
    const flat: FlatPattern = {
      id: 'p', name: 'p', thickness: 1, materialId: 'std:mild-steel',
      outline: [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 0 }],           // CW
      holes: [[{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }]],           // CCW
      bends: [],
    };
    const part = buildPartModel(flat);
    expect(part.flanges.length).toBe(1);
    expect(part.rootFlangeId).toBe('F1');
    expect(part.links).toEqual([]);
    expect(part.flanges[0]!.area).toBeCloseTo(5000 - 100, 9);
    expect(part.flanges[0]!.regions[0]!.holes.length).toBe(1);
    expect(part.warnings).toEqual([]);
  });

  it('warnings: dangling bend line outside the material, hole across a zone', () => {
    const flat: FlatPattern = {
      id: 'x', name: 'x', thickness: 2, materialId: 'std:mild-steel',
      outline: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }],
      holes: [[{ x: 52, y: 25 }, { x: 52, y: 20 }, { x: 48, y: 20 }, { x: 48, y: 25 }]],
      bends: [
        { id: 'B1', p0: { x: 50, y: 0 }, p1: { x: 50, y: 50 }, direction: 'up', angle: 90, innerRadius: 2, kFactor: 0.44, sources: { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' } },
        { id: 'B2', p0: { x: 200, y: 0 }, p1: { x: 200, y: 50 }, direction: 'up', angle: 90, innerRadius: 2, kFactor: 0.44, sources: { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' } },
      ],
    };
    const part = buildPartModel(flat);
    expect(part.flanges.length).toBe(2);
    expect(part.links.length).toBe(1);
    expect(part.warnings.some(w => w.key === 'warnings.part.holeDropped')).toBe(true);
    expect(part.warnings.some(w => w.key === 'warnings.part.bendNoMaterial' && w.params?.bendId === 'B2')).toBe(true);
  });
});
