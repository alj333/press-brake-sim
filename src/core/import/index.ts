/**
 * import-files barrel: DXF flat patterns, DXF tool profiles, meshes (STL/OBJ/GLB/GLTF), STEP,
 * and `importFile` dispatching by extension. See docs/specs/import-files.md.
 */
import type { ImportResult } from '../types';
import { ImportError } from './errors';
import { importDxfFlat } from './dxf-flat';
import type { DxfFlatOptions } from './dxf-flat';
import { decodeDxfText } from './dxf-common';
import { importMesh } from './mesh';
import type { MeshExt, MeshUnits } from './mesh';
import { importStep } from './step';

export { ImportError } from './errors';
export type { ImportErrorParams } from './errors';
export { importDxfFlat, parseBendNote, defaultInnerRadius } from './dxf-flat';
export type { DxfFlatOptions, BendNote } from './dxf-flat';
export { importToolProfileDxf } from './dxf-profile';
export type { ToolProfileImport } from './dxf-profile';
export { classifyLayer, parseDxf, chainLoops, decodeDxfText } from './dxf-common';
export type { DxfUnits, LayerClass, DxfPath, DxfLoop, DxfDocument, ParseDxfOptions } from './dxf-common';
export { importMesh, finishMesh, METRES_EXTENT_LIMIT } from './mesh';
export type { MeshExt, MeshUnits, MeshOptions, ImportedMesh } from './mesh';
export { parseStl } from './stl';
export { parseObj } from './obj';
export { normalizeGltf } from './gltf';
export { weldMesh, positionsBounds, WELD_TOL } from './weld';
export type { FaceGroup, WeldResult } from './weld';
export { importStep, readStepHere } from './step';
export { mergeOcctMeshes } from './step-merge';
export type { MergedStep } from './step-merge';
export { loadOcct, OCCT_PARAMS } from './occt-loader';

export interface ImportFileInput { name: string; bytes: Uint8Array }

export interface ImportFileOptions extends Omit<DxfFlatOptions, 'name' | 'thickness' | 'materialId'> {
  /** Sheet thickness (mm) — required for a DXF (errors.import.badThickness otherwise), unused for meshes. */
  thickness?: number;
  /** Material id for a DXF flat pattern (FlatPattern.materialId; '' when omitted), unused for meshes. */
  materialId?: string;
  /** Part / mesh name; default = the file name without extension. */
  name?: string;
  /** Mesh source units override (STL/OBJ/GLB/GLTF); default 'auto'. */
  meshUnits?: MeshUnits;
}

const MESH_EXTS: ReadonlySet<string> = new Set<MeshExt>(['stl', 'obj', 'glb', 'gltf']);

/** File extension (lower case, without the dot) and base name. */
export function splitFileName(name: string): { base: string; ext: string } {
  const file = name.split(/[\\/]/).pop() ?? name;
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return { base: file, ext: '' };
  return { base: file.slice(0, dot), ext: file.slice(dot + 1).toLowerCase() };
}

/** Import any supported file by extension: dxf → flat pattern; stl/obj/glb/gltf/step/stp → mesh. */
export async function importFile(file: ImportFileInput, opts: ImportFileOptions): Promise<ImportResult> {
  const { base, ext } = splitFileName(file.name);
  const name = opts.name ?? base;
  if (ext === 'dxf') {
    const { name: _n, meshUnits: _u, thickness, materialId, ...dxfOpts } = opts;
    return importDxfFlat(decodeDxfText(file.bytes), { ...dxfOpts, name, thickness: thickness ?? 0, materialId: materialId ?? '' });
  }
  if (MESH_EXTS.has(ext)) {
    const { warnings, ...mesh } = await importMesh(file.bytes, ext as MeshExt, { name, units: opts.meshUnits });
    return { mesh, warnings };
  }
  if (ext === 'step' || ext === 'stp') {
    const { warnings, ...mesh } = await importStep(file.bytes, name);
    return { mesh, warnings };
  }
  throw new ImportError('errors.import.unsupportedExtension', { ext: ext || file.name });
}
