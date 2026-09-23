/** Typed lookups in a ToolLibrary (or a Project.libraryOverlay-shaped object). */
import type { Die, Finger, Machine, Material, Punch, Tool, ToolLibrary } from '../types';

type Tools = Pick<ToolLibrary, 'punches' | 'dies' | 'fingers'>;

export function findPunch(lib: Pick<ToolLibrary, 'punches'>, id: string): Punch | undefined { return lib.punches.find(p => p.id === id); }
export function findDie(lib: Pick<ToolLibrary, 'dies'>, id: string): Die | undefined { return lib.dies.find(d => d.id === id); }
export function findFinger(lib: Pick<ToolLibrary, 'fingers'>, id: string): Finger | undefined { return lib.fingers.find(f => f.id === id); }
export function findMaterial(lib: Pick<ToolLibrary, 'materials'>, id: string): Material | undefined { return lib.materials.find(m => m.id === id); }
export function findMachine(lib: Pick<ToolLibrary, 'machines'>, id: string): Machine | undefined { return lib.machines.find(m => m.id === id); }
export function findTool(lib: Tools, id: string): Tool | undefined { return findPunch(lib, id) ?? findDie(lib, id) ?? findFinger(lib, id); }
