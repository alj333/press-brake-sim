import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dictionaries, hasKey, interpolate, setGlobalLanguage, t, tm, translate, translateMessage } from './index';
import { simLabelsEn } from '../sim/labels';

const en = dictionaries.en;
const th = dictionaries.th;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const SRC = join(process.cwd(), 'src');

describe('i18n interpolation', () => {
  it('replaces {{param}} and {param}', () => {
    expect(interpolate('Bend {{bendId}} at {x}', { bendId: 'B1', x: 3 })).toBe('Bend B1 at 3');
    expect(interpolate('{{ a }} {b} {{c}}', { a: 1, b: 'two', c: 'three' })).toBe('1 two three');
  });
  it('keeps unknown params as written', () => {
    expect(interpolate('Hello {{name}} {x}', { other: 1 })).toBe('Hello {{name}} {x}');
    expect(interpolate('plain', undefined)).toBe('plain');
  });
  it('translate falls back to English, then to the key', () => {
    expect(translate('en', 'app.name')).toBe(en['app.name']);
    expect(translate('th', 'app.name')).toBe(th['app.name']);
    expect(translate('th', 'app.name')).not.toBe(en['app.name']);
    // a key present only in English (synthetic): fallback path
    (th as Record<string, string>)['__test.only.en'] = undefined as unknown as string;
    (en as Record<string, string>)['__test.only.en'] = 'only english';
    expect(translate('th', '__test.only.en')).toBe('only english');
    delete (en as Record<string, string>)['__test.only.en'];
    delete (th as Record<string, string>)['__test.only.en'];
    expect(translate('en', 'no.such.key', { a: 1 })).toBe('no.such.key');
    expect(hasKey('app.name')).toBe(true);
    expect(hasKey('no.such.key')).toBe(false);
  });
  it('tm / translateMessage interpolate a Message', () => {
    const message = { key: 'warnings.gauge.outOfRange', params: { x: 800, xMin: 10, xMax: 750 }, severity: 'error' as const };
    expect(translateMessage('en', message)).toBe('Backgauge X 800 mm is outside the range 10–750 mm');
    setGlobalLanguage('th');
    expect(tm(message)).toBe(translate('th', message.key, message.params));
    expect(t('common.ok')).toBe(th['common.ok']);
    setGlobalLanguage('en');
    expect(tm(message)).toBe(translateMessage('en', message));
    expect(t('sim.step', { index: 2, bendId: 'B3' })).toBe('Step 2 · B3');
  });
});

describe('dictionary completeness', () => {
  it('en and th have the same keys and no empty strings', () => {
    const enKeys = Object.keys(en).sort();
    const thKeys = Object.keys(th).sort();
    const missingInTh = enKeys.filter(k => !(k in th));
    const missingInEn = thKeys.filter(k => !(k in en));
    expect(missingInTh).toEqual([]);
    expect(missingInEn).toEqual([]);
    for (const k of enKeys) {
      expect(typeof en[k], k).toBe('string');
      expect(en[k]!.length, k).toBeGreaterThan(0);
      expect(th[k]!.length, k).toBeGreaterThan(0);
    }
  });

  it('Thai strings carry the same parameters as the English ones', () => {
    const params = (s: string): string[] => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g)].map(m => m[1] ?? m[2] ?? '').sort();
    for (const k of Object.keys(en)) {
      expect(params(th[k]!), k).toEqual(params(en[k]!));
    }
  });

  it('every sim label key exists in en.json', () => {
    for (const k of Object.keys(simLabelsEn)) expect(k in en, k).toBe(true);
  });

  it('every t("…") literal in src/app and src/sim exists in en.json', () => {
    const files = [...walk(join(SRC, 'app')), ...walk(join(SRC, 'sim'))];
    const missing: string[] = [];
    const prefixes: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\b(?:t|tt|tr)\(\s*'([^']+)'/g)) {
        const key = m[1]!;
        if (!(key in en)) missing.push(`${file}: ${key}`);
      }
      for (const m of text.matchAll(/\b(?:t|tt|tr)\(\s*"([^"]+)"/g)) {
        const key = m[1]!;
        if (!(key in en)) missing.push(`${file}: ${key}`);
      }
      for (const m of text.matchAll(/\b(?:t|tt|tr)\(\s*`([^`$]+)\$\{/g)) prefixes.push(m[1]!);
    }
    expect(missing).toEqual([]);
    for (const p of prefixes) {
      expect(Object.keys(en).some(k => k.startsWith(p)), `prefix ${p}`).toBe(true);
    }
  });

  it('every Message literal ({ key: "…" }) built in src/app exists in en.json', () => {
    const missing: string[] = [];
    for (const file of walk(join(SRC, 'app'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bkey:\s*'([a-z]+\.[A-Za-z0-9_.-]+)'/g)) {
        const key = m[1]!;
        if (!(key in en)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the dynamic key families used by the panels are complete', () => {
    const need: string[] = [];
    for (const u of ['auto', 'mm', 'in', 'cm', 'm']) need.push(`part.units.${u}`);
    for (const p of ['evaluate', 'search', 'assemble']) need.push(`sequence.phase.${p}`);
    for (const f of ['straight', 'gooseneck', 'acute', 'radius', 'hemming', 'custom', 'v', 'multi-v', 'u']) need.push(`family.${f}`);
    for (const k of ['punch', 'die', 'finger']) need.push(`tools.kind.${k}`, `tools.dialog.hint.${k}`);
    for (const d of ['y+', 'y-', 'x+', 'x-']) need.push(`tools.dialog.upDir.${d}`);
    for (const t of ['none', 'rotate180', 'flip-front-back', 'flip-end-for-end']) need.push(`turn.${t}`);
    for (const c of ['cut-edge', 'flange-face', 'radius', 'none']) need.push(`contact.${c}`);
    for (const r of ['virtual-sharp', 'tangent']) need.push(`ref.${r}`);
    for (const f of ['top', 'bottom']) need.push(`faceUp.${f}`);
    for (const s of ['dxf', 'step', 'mesh', 'user', 'default']) need.push(`source.${s}`);
    for (const s of ['info', 'warning', 'error']) need.push(`severity.${s}`);
    for (const h of ['closed', 'open', 'teardrop']) need.push(`part.bend.hem.${h}`);
    for (const k of ['bend', 'hem-flatten']) need.push(`sequence.kind.${k}`);
    for (const n of ['L-bracket', 'U-channel', 'Z-bracket', 'hat-channel', 'acute-bracket', 'box-4-flange', 'tabbed-plate']) need.push(`part.sample.${n}`);
    for (const r of ['saved', 'conflict-resolved', 'conflict', 'unavailable', 'disabled', 'error']) need.push(`tools.remote.${r}`);
    for (const w of ['flip', 'rotate', 'stationChange', 'shortFlange', 'collisionWarning']) need.push(`sequence.weight.${w}`);
    for (const k of ['bedLength', 'capacity', 'stroke', 'daylight', 'throatDepth', 'distanceBetweenFrames', 'yCorrection']) need.push(`machine.${k}`);
    for (const k of ['thickness', 'height', 'clampThickness', 'clampHeight', 'clampFrontOffset']) need.push(`machine.ram.${k}`);
    for (const k of ['approach', 'bend', 'retract']) need.push(`machine.speed.${k}`);
    for (const k of ['width', 'holderWidth', 'holderHeight', 'height']) need.push(`machine.table.${k}`);
    for (const k of ['xMin', 'xMax', 'rMin', 'rMax', 'zMin', 'zMax', 'beamDepth', 'beamHeight', 'retractAtPinch', 'speed', 'fingerCount', 'fingerId', 'independentX', 'independentR']) need.push(`machine.backgauge.${k}`);
    expect(need.filter(k => !(k in en))).toEqual([]);
  });

  it('every warnings.* / collisions.* / errors.* literal in src/core and src/app exists in en.json', () => {
    const files = [...walk(join(SRC, 'core')), ...walk(join(SRC, 'app'))];
    const missing = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/['"`]((?:warnings|collisions|errors)\.[A-Za-z0-9_.-]+)['"`]/g)) {
        const key = m[1]!;
        if (!(key in en)) missing.add(key);
      }
    }
    // keys built from prefixes in core: collisions.<ObstacleKind>, warnings.recognize.<issue>
    for (const kind of ['punch', 'ram', 'clamp', 'die', 'holder', 'table', 'finger', 'backgauge-beam', 'frame', 'self']) {
      expect(`collisions.${kind}` in en, kind).toBe(true);
    }
    for (const file of walk(join(SRC, 'core/import/recognize'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bissue\(\s*'([A-Za-z0-9_]+)'/g)) {
        const key = `warnings.recognize.${m[1]!}`;
        if (!(key in en)) missing.add(key);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
