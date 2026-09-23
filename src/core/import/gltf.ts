/**
 * glTF normalisation (pure TS): turn a .gltf (JSON, embedded data-URI buffers) or a .glb into a
 * single self-contained GLB with ONE binary chunk and no materials / textures / skins, so that
 * three's GLTFLoader.parse() never has to fetch anything (works identically in Node and in the
 * browser). External buffer references cannot be resolved from a single file → ImportError.
 */
import { ImportError } from './errors';

const GLB_MAGIC = 0x46546c67;      // 'glTF'
const CHUNK_JSON = 0x4e4f534a;     // 'JSON'
const CHUNK_BIN = 0x004e4942;      // 'BIN\0'

interface GltfJson {
  asset?: { version?: string };
  buffers?: Array<{ byteLength: number; uri?: string }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number }>;
  meshes?: Array<{ primitives?: Array<{ material?: number; [k: string]: unknown }> }>;
  nodes?: Array<{ skin?: number; [k: string]: unknown }>;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [k: string]: unknown;
}

const TEXTURE_EXTENSIONS = /^(KHR_texture_|KHR_materials_|EXT_texture_|KHR_lights_)/;

function fail(detail: string): ImportError {
  return new ImportError('errors.import.gltfUnsupported', { detail }, detail);
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (comma < 0) throw fail('malformed data URI');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64$/i.test(meta)) {
    const bin = atob(payload);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

function pad4(n: number): number { return (n + 3) & ~3; }

/** Split a GLB into its JSON text and optional BIN chunk. */
export function readGlbChunks(bytes: Uint8Array): { json: string; bin: Uint8Array | null } {
  if (bytes.length < 20) throw fail('file too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw fail('not a GLB (bad magic)');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw fail(`GLB version ${version}`);
  const total = Math.min(dv.getUint32(8, true), bytes.length);
  let off = 12;
  let json: string | null = null;
  let bin: Uint8Array | null = null;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (start + len > total) throw fail('truncated chunk');
    if (type === CHUNK_JSON) json = new TextDecoder('utf-8').decode(bytes.subarray(start, start + len));
    else if (type === CHUNK_BIN && bin === null) bin = bytes.subarray(start, start + len);
    off = start + pad4(len);
  }
  if (json === null) throw fail('no JSON chunk');
  return { json, bin };
}

/** Build a GLB from JSON text and a binary payload. */
export function writeGlb(jsonText: string, bin: Uint8Array): ArrayBuffer {
  let text = jsonText;
  while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const jsonLen = pad4(jsonBytes.length);
  const binLen = pad4(bin.length);
  const total = 12 + 8 + jsonLen + (binLen > 0 ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  for (let i = 20 + jsonBytes.length; i < 20 + jsonLen; i++) out[i] = 0x20;
  if (binLen > 0) {
    const o = 20 + jsonLen;
    dv.setUint32(o, binLen, true); dv.setUint32(o + 4, CHUNK_BIN, true);
    out.set(bin, o + 8);
  }
  return out.buffer;
}

/**
 * Normalise to a self-contained GLB: every buffer merged into the BIN chunk (bufferViews
 * re-based), materials / textures / images / samplers / skins / animations removed.
 */
export function normalizeGltf(bytes: Uint8Array, ext: 'glb' | 'gltf'): ArrayBuffer {
  let jsonText: string;
  let bin: Uint8Array | null = null;
  if (ext === 'glb') ({ json: jsonText, bin } = readGlbChunks(bytes));
  else jsonText = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  let json: GltfJson;
  try { json = JSON.parse(jsonText) as GltfJson; } catch { throw fail('invalid JSON'); }
  if (!json || typeof json !== 'object') throw fail('invalid JSON');
  const version = json.asset?.version ?? '';
  if (!/^2(\.|$)/.test(version)) throw fail(`glTF version "${version}"`);

  // Buffers → one payload
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let total = 0;
  const buffers = json.buffers ?? [];
  buffers.forEach((b, i) => {
    let data: Uint8Array;
    if (b.uri === undefined) {
      if (i !== 0 || !bin) throw fail(`buffer ${i} has no data`);
      data = bin;
    } else if (b.uri.startsWith('data:')) {
      data = decodeDataUri(b.uri);
    } else {
      throw fail(`external buffer "${b.uri}"`);
    }
    offsets.push(total);
    chunks.push(data);
    total += pad4(data.length);
  });
  const payload = new Uint8Array(total);
  chunks.forEach((c, i) => payload.set(c, offsets[i]!));
  for (const bv of json.bufferViews ?? []) {
    const idx = bv.buffer ?? 0;
    if (idx < 0 || idx >= offsets.length) throw fail(`bufferView refers to buffer ${idx}`);
    bv.byteOffset = (bv.byteOffset ?? 0) + offsets[idx]!;
    bv.buffer = 0;
  }
  json.buffers = total > 0 ? [{ byteLength: total }] : [];

  // Geometry only
  delete json['materials']; delete json['textures']; delete json['images']; delete json['samplers'];
  delete json['skins']; delete json['animations'];
  for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) delete p.material;
  for (const n of json.nodes ?? []) delete n.skin;
  if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter(e => !TEXTURE_EXTENSIONS.test(e));
  if (json.extensionsRequired) json.extensionsRequired = json.extensionsRequired.filter(e => !TEXTURE_EXTENSIONS.test(e));

  return writeGlb(JSON.stringify(json), payload);
}
