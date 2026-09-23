import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth, flatsEquivalent } from './fixtures';

describe('fixtures', () => {
  it('loads every sample truth as a FlatPattern with goldens', () => {
    for (const name of SAMPLE_NAMES) {
      const t = loadTruth(name);
      expect(t.flat.outline.length).toBeGreaterThanOrEqual(4);
      expect(t.flat.bends.length).toBe(t.expected.bendCount);
      for (const b of t.flat.bends) expect(t.expected.perBend[b.id]).toBeDefined();
    }
  });
  it('flatsEquivalent detects mirrored copies', () => {
    const t = loadTruth('U-channel');
    const mirrored = {
      ...t.flat,
      outline: t.flat.outline.map(p => ({ x: -p.x, y: p.y })),
      bends: t.flat.bends.map(b => ({ ...b, p0: { x: -b.p0.x, y: b.p0.y }, p1: { x: -b.p1.x, y: b.p1.y }, direction: b.direction === 'up' ? 'down' as const : 'up' as const })),
    };
    const r = flatsEquivalent(t.flat, mirrored);
    expect(r.equivalent).toBe(true);
    expect(r.mirrored).toBe(true);
  });
});
