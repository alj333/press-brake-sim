/** STL reader (binary + ASCII), pure TS. Output is an unshared triangle soup. */
import { ImportError } from './errors';

export interface RawMesh { positions: Float32Array; indices: Uint32Array }

const BINARY_HEADER = 84;
const BINARY_TRIANGLE = 50;

function looksAscii(buffer: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, Math.min(buffer.length, 512))).replace(/^﻿/, '').trimStart();
  return /^solid\b/i.test(head) && /\b(facet|vertex|endsolid)\b/i.test(new TextDecoder().decode(buffer.subarray(0, Math.min(buffer.length, 4096))));
}

export function parseStl(buffer: Uint8Array): RawMesh {
  if (buffer.length >= BINARY_HEADER) {
    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const n = dv.getUint32(80, true);
    if (buffer.length === BINARY_HEADER + BINARY_TRIANGLE * n) return parseBinary(dv, n);
    // some writers append junk: accept when the declared count fits and the file is not ASCII
    if (n > 0 && BINARY_HEADER + BINARY_TRIANGLE * n <= buffer.length && !looksAscii(buffer)) return parseBinary(dv, n);
  }
  if (looksAscii(buffer)) return parseAscii(new TextDecoder('utf-8', { fatal: false }).decode(buffer));
  throw new ImportError('errors.import.stlInvalid', { detail: 'not a binary or ASCII STL' }, 'not a binary or ASCII STL');
}

function parseBinary(dv: DataView, n: number): RawMesh {
  const positions = new Float32Array(n * 9);
  const indices = new Uint32Array(n * 3);
  let off = BINARY_HEADER;
  for (let t = 0; t < n; t++) {
    off += 12;                                   // facet normal
    for (let k = 0; k < 9; k++) { positions[t * 9 + k] = dv.getFloat32(off, true); off += 4; }
    off += 2;                                    // attribute byte count
    indices[t * 3] = t * 3; indices[t * 3 + 1] = t * 3 + 1; indices[t * 3 + 2] = t * 3 + 2;
  }
  return { positions, indices };
}

const VERTEX_RE = /\bvertex\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)/g;

function parseAscii(text: string): RawMesh {
  const vals: number[] = [];
  for (const m of text.matchAll(VERTEX_RE)) {
    const x = Number(m[1]), y = Number(m[2]), z = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new ImportError('errors.import.stlInvalid', { detail: `bad vertex "${m[0]}"` }, 'bad vertex');
    }
    vals.push(x, y, z);
  }
  const nv = vals.length / 3;
  if (nv === 0 || nv % 3 !== 0) {
    throw new ImportError('errors.import.stlInvalid', { detail: `${nv} vertices (not a multiple of 3)` }, 'vertex count');
  }
  const positions = Float32Array.from(vals);
  const indices = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) indices[i] = i;
  return { positions, indices };
}
