/**
 * DXF tool-profile importer: the single closed loop of a punch / die / finger cross-section
 * drawing → CCW points in mm. Orientation / reference point are chosen later in the UI
 * (`normalizeProfile` in src/core/tools/custom.ts). See docs/specs/import-files.md §3.
 */
import type { Polygon2, Message } from '../types';
import { ensureCCW, simplifyCollinear } from '../geom';
import { ImportError, warn } from './errors';
import { parseDxf, chainLoops } from './dxf-common';
import type { DxfUnits, ParseDxfOptions } from './dxf-common';

export interface ToolProfileImport {
  /** Closed CCW profile, mm, no duplicate / collinear vertices. */
  points: Polygon2;
  /** Units detected in the file (points are already converted to mm). */
  units: DxfUnits;
  warnings: Message[];
}

export function importToolProfileDxf(text: string, options: ParseDxfOptions = {}): ToolProfileImport {
  const doc = parseDxf(text, options);
  const warnings: Message[] = [...doc.warnings];
  const geometry = doc.paths.filter(p => p.cls !== 'ignore');
  const chained = chainLoops(geometry);
  warnings.push(...chained.warnings);
  if (chained.loops.length === 0) throw new ImportError('errors.import.dxfNoProfile');
  let best = chained.loops[0]!;
  for (const l of chained.loops) if (l.area > best.area) best = l;
  if (chained.loops.length > 1) warnings.push(warn('warnings.dxf.multipleProfiles', { count: chained.loops.length }));
  const points = ensureCCW(simplifyCollinear(best.points, 1e-6));
  if (points.length < 3) throw new ImportError('errors.import.dxfNoProfile');
  return { points, units: doc.units, warnings };
}
