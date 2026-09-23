/**
 * Structural validation of a `ToolLibrary` JSON body (see src/core/types.ts) for the
 * `PUT /api/library` endpoint. Deliberately self-contained (no import from src/) so the
 * runtime image only needs `server/` + `dist/`. The client still runs `migrateLibrary` on
 * whatever the server returns, so this only rejects bodies that are not a library at all.
 */

export interface LibraryShape {
  version: number;
  revision: number;
  updatedAt: string;
  punches: unknown[];
  dies: unknown[];
  fingers: unknown[];
  materials: unknown[];
  machines: unknown[];
}

export type ShapeResult = { ok: true; library: LibraryShape } | { ok: false; errors: string[] };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Max number of items per collection and max profile vertices — guards against abuse, not real data. */
export const LIMITS = { items: 5000, profilePoints: 20000 } as const;

function checkProfile(item: Rec, where: string, errors: string[]): void {
  const profile = item['profile'];
  const points = isRec(profile) ? profile['points'] : undefined;
  if (!Array.isArray(points)) { errors.push(`${where}: profile.points must be an array`); return; }
  if (points.length < 3) { errors.push(`${where}: profile needs at least 3 points`); return; }
  if (points.length > LIMITS.profilePoints) { errors.push(`${where}: profile has too many points`); return; }
  for (let i = 0; i < points.length; i++) {
    const p: unknown = points[i];
    const ok = (isRec(p) && fin(p['x']) && fin(p['y'])) || (Array.isArray(p) && fin(p[0]) && fin(p[1]));
    if (!ok) { errors.push(`${where}: profile.points[${i}] is not a finite {x, y}`); return; }
  }
}

function checkCollection(
  lib: Rec, key: keyof LibraryShape, errors: string[], each: (item: Rec, where: string, errors: string[]) => void,
): void {
  const arr = lib[key];
  if (!Array.isArray(arr)) { errors.push(`${key} must be an array`); return; }
  if (arr.length > LIMITS.items) { errors.push(`${key}: too many items (${arr.length})`); return; }
  const ids = new Set<string>();
  arr.forEach((item: unknown, i) => {
    const where = `${key}[${i}]`;
    if (!isRec(item)) { errors.push(`${where}: not an object`); return; }
    if (!nonEmpty(item['id'])) { errors.push(`${where}: missing id`); return; }
    if (ids.has(item['id'])) errors.push(`${where}: duplicate id '${item['id']}'`);
    ids.add(item['id']);
    if (item['name'] !== undefined && typeof item['name'] !== 'string') errors.push(`${where}: name must be a string`);
    each(item, where, errors);
  });
}

const toolChecker = (kind: 'punch' | 'die' | 'finger') => (item: Rec, where: string, errors: string[]): void => {
  if (item['kind'] !== undefined && item['kind'] !== kind) errors.push(`${where}: kind must be '${kind}'`);
  checkProfile(item, where, errors);
  for (const f of ['height', 'maxLoadPerMeter']) {
    if (item[f] !== undefined && !fin(item[f])) errors.push(`${where}: ${f} must be a finite number`);
  }
};

function materialChecker(item: Rec, where: string, errors: string[]): void {
  for (const f of ['tensileStrength', 'kFactor', 'springbackDeg', 'minInnerRadiusFactor']) {
    if (item[f] !== undefined && !fin(item[f])) errors.push(`${where}: ${f} must be a finite number`);
  }
}

function machineChecker(item: Rec, where: string, errors: string[]): void {
  for (const f of ['bedLength', 'capacity', 'stroke', 'daylight']) {
    if (item[f] !== undefined && !fin(item[f])) errors.push(`${where}: ${f} must be a finite number`);
  }
  for (const f of ['ram', 'table', 'backgauge']) {
    if (item[f] !== undefined && !isRec(item[f])) errors.push(`${where}: ${f} must be an object`);
  }
}

/** Validate a parsed JSON body. On success the returned object has version / revision / updatedAt filled in. */
export function validateLibraryShape(body: unknown): ShapeResult {
  const errors: string[] = [];
  if (!isRec(body)) return { ok: false, errors: ['body must be a JSON object'] };
  if (body['version'] !== undefined && !(fin(body['version']) && body['version'] >= 0)) errors.push('version must be a non-negative number');
  if (body['revision'] !== undefined && !(fin(body['revision']) && Number.isInteger(body['revision']) && body['revision'] >= 0)) {
    errors.push('revision must be a non-negative integer');
  }
  if (body['updatedAt'] !== undefined && typeof body['updatedAt'] !== 'string') errors.push('updatedAt must be a string');
  checkCollection(body, 'punches', errors, toolChecker('punch'));
  checkCollection(body, 'dies', errors, toolChecker('die'));
  checkCollection(body, 'fingers', errors, toolChecker('finger'));
  checkCollection(body, 'materials', errors, materialChecker);
  checkCollection(body, 'machines', errors, machineChecker);
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 20) };
  return {
    ok: true,
    library: {
      ...body,
      version: fin(body['version']) ? body['version'] : 1,
      revision: fin(body['revision']) ? body['revision'] : 0,
      updatedAt: typeof body['updatedAt'] === 'string' ? body['updatedAt'] : new Date().toISOString(),
      punches: body['punches'] as unknown[],
      dies: body['dies'] as unknown[],
      fingers: body['fingers'] as unknown[],
      materials: body['materials'] as unknown[],
      machines: body['machines'] as unknown[],
    },
  };
}
