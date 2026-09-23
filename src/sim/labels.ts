/**
 * sim-3d — label keys and English defaults. The module does not depend on src/i18n: the ui
 * passes its `t(key, params)`; `defaultT` interpolates the English strings below.
 */
export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

export const simLabelsEn: Record<string, string> = {
  'sim.play': 'Play',
  'sim.pause': 'Pause',
  'sim.stepBack': 'Previous phase',
  'sim.stepForward': 'Next phase',
  'sim.speed': 'Speed',
  'sim.continueOnCollision': 'Continue on collision',
  'sim.section': 'Section',
  'sim.camera': 'Camera',
  'sim.camera.iso': 'Iso',
  'sim.camera.front': 'Front',
  'sim.camera.side': 'Side',
  'sim.camera.top': 'Top',
  'sim.phase.position': 'Position part',
  'sim.phase.gauge': 'Gauge',
  'sim.phase.approach': 'Approach',
  'sim.phase.bend': 'Bend',
  'sim.phase.release': 'Release',
  'sim.phase.retract': 'Retract',
  'sim.phase.reposition': 'Turn part',
  'sim.steps': 'Steps',
  'sim.step': 'Step {index} · {bendId}',
  'sim.stepKind.bend': 'Bend',
  'sim.stepKind.hem-flatten': 'Hem flatten',
  'sim.turn.none': 'no turn',
  'sim.turn.rotate180': 'rotate 180°',
  'sim.turn.flip-front-back': 'flip front/back',
  'sim.turn.flip-end-for-end': 'flip end for end',
  'sim.noProgram': 'No bend program — plan the sequence to simulate it.',
  'sim.pausedOnCollision': 'Paused on collision',
  'sim.collisions': 'Collisions',
  'sim.time': 'Time',
  'sim.operator': 'Operator (−X)',
  'sim.backgauge': 'Backgauge (+X)',
  'sim.ramY': 'Ram Y {y}',
  'sim.finger': 'Finger {index}: X {x} R {r} Z {z}',
  'sim.legend.sheet': 'Sheet',
  'sim.legend.gauged': 'Gauged flange',
  'sim.legend.collision': 'Collision',
  'sim.idle': 'Preview — finished part on the die',
  'sim.warnings': 'warnings',
};

/** English fallback translator: interpolates `{param}` in simLabelsEn, returns the key when unknown. */
export const defaultT: TranslateFn = (key, params) => {
  const s = simLabelsEn[key];
  if (s === undefined) return key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
};

/** Wraps the ui's translator: falls back to the English default when it returns the key itself. */
export function withFallback(t: TranslateFn | undefined): TranslateFn {
  if (!t) return defaultT;
  return (key, params) => {
    const s = t(key, params);
    return s === key || s === '' ? defaultT(key, params) : s;
  };
}
