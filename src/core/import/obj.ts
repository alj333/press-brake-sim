/** Wavefront OBJ reader (positions + faces only), pure TS. Polygons are fan-triangulated. */
import { ImportError } from './errors';
import type { RawMesh } from './stl';

export function parseObj(text: string): RawMesh {
  const verts: number[] = [];
  const idx: number[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln]!;
    const line = raw.indexOf('#') >= 0 ? raw.slice(0, raw.indexOf('#')) : raw;
    const trimmed = line.trim();
    if (trimmed.length < 2) continue;
    const c0 = trimmed.charCodeAt(0), c1 = trimmed.charCodeAt(1);
    if (c0 === 118 /* v */ && (c1 === 32 || c1 === 9)) {
      const parts = trimmed.split(/\s+/);
      const x = Number(parts[1]), y = Number(parts[2]), z = Number(parts[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new ImportError('errors.import.objInvalid', { line: ln + 1 }, `line ${ln + 1}: bad vertex`);
      }
      verts.push(x, y, z);
    } else if (c0 === 102 /* f */ && (c1 === 32 || c1 === 9)) {
      const parts = trimmed.split(/\s+/).slice(1);
      const face: number[] = [];
      const nv = verts.length / 3;
      for (const p of parts) {
        const tok = p.split('/')[0]!;
        let i = Number(tok);
        if (!Number.isInteger(i) || i === 0) throw new ImportError('errors.import.objInvalid', { line: ln + 1 }, `line ${ln + 1}: bad face index "${tok}"`);
        i = i < 0 ? nv + i : i - 1;
        if (i < 0 || i >= nv) throw new ImportError('errors.import.objInvalid', { line: ln + 1 }, `line ${ln + 1}: index out of range`);
        face.push(i);
      }
      if (face.length < 3) continue;
      for (let k = 1; k + 1 < face.length; k++) idx.push(face[0]!, face[k]!, face[k + 1]!);
    }
    // vn, vt, o, g, s, usemtl, mtllib, l, p … are ignored
  }
  return { positions: Float32Array.from(verts), indices: Uint32Array.from(idx) };
}
