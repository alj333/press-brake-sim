/** Minimal typings for occt-import-js (emscripten module). */
declare module 'occt-import-js' {
  export interface OcctReadParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
    linearDeflection?: number;
    angularDeflection?: number;
  }
  export interface OcctBrepFace { first: number; last: number; color: number[] | null }
  export interface OcctMesh {
    name: string;
    color?: number[];
    brep_faces: OcctBrepFace[];
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }
  export interface OcctNode { name: string; meshes: number[]; children: OcctNode[] }
  export interface OcctResult { success: boolean; root: OcctNode; meshes: OcctMesh[] }
  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: OcctReadParams | null): OcctResult;
    ReadIgesFile(content: Uint8Array, params: OcctReadParams | null): OcctResult;
    ReadBrepFile(content: Uint8Array, params: OcctReadParams | null): OcctResult;
    ReadFile(format: string, content: Uint8Array, params: OcctReadParams | null): OcctResult;
  }
  export interface OcctModuleOverrides { locateFile?: (path: string) => string }
  const occtimportjs: (overrides?: OcctModuleOverrides) => Promise<OcctModule>;
  export default occtimportjs;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}
