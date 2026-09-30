import type { SegmentInventoryItem, ToolBase } from '../types';

type StockFields = Pick<ToolBase, 'stockStatus'>;
type SegmentFields = Pick<ToolBase, 'segmentLengths' | 'segmentInventory'>;

/** Defensive ceiling for imported/runtime physical-piece counts. */
export const MAX_SEGMENT_INVENTORY_PIECES = 10_000;

const validLength = (value: number): boolean => Number.isFinite(value) && value > 0;
const validQuantity = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= MAX_SEGMENT_INVENTORY_PIECES;

/** Legacy/custom tools without an explicit status remain available. Unknown runtime values fail closed. */
export function isToolInStock(tool: StockFields): boolean {
  return tool.stockStatus === undefined || tool.stockStatus === 'in-stock';
}

/** True only when finite piece counts were supplied; an empty array is deliberately bounded. */
export function hasBoundedSegmentInventory(tool: SegmentFields): boolean {
  return tool.segmentInventory !== undefined;
}

/** Expand validated finite inventory into the piece list consumed by segment selection algorithms. */
export function expandSegmentInventory(inventory: readonly SegmentInventoryItem[]): number[] {
  const expanded: number[] = [];
  for (const item of inventory) {
    if (!validLength(item.length) || !validQuantity(item.quantity)) continue;
    if (expanded.length + item.quantity > MAX_SEGMENT_INVENTORY_PIECES) return [];
    for (let index = 0; index < item.quantity; index += 1) expanded.push(item.length);
  }
  return expanded;
}

/**
 * Physical pieces when inventory is bounded, otherwise the legacy list of reusable segment sizes.
 * Invalid runtime values are omitted defensively; migration normally sanitizes them first.
 */
export function availableSegmentLengths(tool: SegmentFields): number[] {
  return tool.segmentInventory === undefined
    ? tool.segmentLengths.filter(validLength)
    : expandSegmentInventory(tool.segmentInventory);
}
