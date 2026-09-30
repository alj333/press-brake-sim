import { describe, expect, it } from 'vitest';
import type { ToolBase } from '../types';
import { availableSegmentLengths, expandSegmentInventory, hasBoundedSegmentInventory, isToolInStock } from './stock';

type StockFixture = Pick<ToolBase, 'stockStatus' | 'segmentLengths' | 'segmentInventory'>;

const fixture = (overrides: Partial<StockFixture> = {}): StockFixture => ({ segmentLengths: [50, 100], ...overrides });

describe('tool stock helpers', () => {
  it('treats missing legacy status as in stock and unknown runtime values as unavailable', () => {
    expect(isToolInStock(fixture())).toBe(true);
    expect(isToolInStock(fixture({ stockStatus: 'in-stock' }))).toBe(true);
    expect(isToolInStock(fixture({ stockStatus: 'not-in-stock' }))).toBe(false);
    expect(isToolInStock({ stockStatus: 'unexpected' } as unknown as StockFixture)).toBe(false);
  });

  it('uses the reusable legacy sizes only when finite inventory is absent', () => {
    const legacy = fixture({ segmentLengths: [50, -1, Number.NaN, 100] });
    expect(hasBoundedSegmentInventory(legacy)).toBe(false);
    expect(availableSegmentLengths(legacy)).toEqual([50, 100]);

    const bounded = fixture({ segmentInventory: [{ length: 40, quantity: 2 }, { length: 25, quantity: 1 }] });
    expect(hasBoundedSegmentInventory(bounded)).toBe(true);
    expect(availableSegmentLengths(bounded)).toEqual([40, 40, 25]);
  });

  it('preserves an explicitly empty bounded inventory and ignores malformed runtime entries', () => {
    const empty = fixture({ segmentInventory: [] });
    expect(hasBoundedSegmentInventory(empty)).toBe(true);
    expect(availableSegmentLengths(empty)).toEqual([]);
    expect(expandSegmentInventory([
      { length: 100, quantity: 2 },
      { length: -5, quantity: 1 },
      { length: 50, quantity: 1.5 },
      { length: 25, quantity: 0 },
    ])).toEqual([100, 100]);
    expect(expandSegmentInventory([{ length: 100, quantity: Number.MAX_SAFE_INTEGER }])).toEqual([]);
    expect(expandSegmentInventory([{ length: 100, quantity: 6_000 }, { length: 50, quantity: 6_000 }])).toEqual([]);
  });
});
