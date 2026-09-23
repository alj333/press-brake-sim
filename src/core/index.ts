/**
 * core barrel — re-exports every pure module of `src/core` (no DOM, no three.js):
 * types (the contract), geom, bend, part, import (+ recognize), tools, machine, library, planner.
 * The app imports the module barrels directly to keep chunks small; this barrel exists for
 * scripts, tests and embedding (`import { buildPartModel, planProgram } from './core'`).
 */
export * from './types';
export * from './geom';
export * from './bend';
export * from './part';
export * from './import';
export * from './import/recognize';
export * from './tools';
export * from './machine';
export * from './library';
export * from './planner';
