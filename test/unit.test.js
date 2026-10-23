import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, over, required, suggest, parseHex, hex } from '../src/color.js';
import { svgSize } from '../src/lint.js';
import { parseArgs } from '../src/cli.js';

test('contrast matches the WCAG reference values', () => {
  const black = parseHex('#000');
  const white = parseHex('#fff');
  assert.equal(Math.round(contrast(black, white) * 100) / 100, 21);
  assert.equal(Math.round(contrast(parseHex('#777777'), white) * 100) / 100, 4.48);
  assert.equal(contrast(white, white), 1);
});

test('translucent text is blended before measuring', () => {
  const c = over({ r: 0, g: 0, b: 0, a: 0.5 }, parseHex('#ffffff'));
  assert.equal(hex(c), '#808080');
});

test('large text threshold', () => {
  assert.equal(required(16, 400), 4.5);
  assert.equal(required(24, 400), 3);
  assert.equal(required(19, 700), 3);
  assert.equal(required(19, 600), 4.5);
});

test('suggested color passes and stays close', () => {
  const bg = parseHex('#ffffff');
  const s = suggest(parseHex('#bbbbbb'), bg, 4.5);
  assert.ok(contrast(parseHex(s), bg) >= 4.5);
  const dark = parseHex('#0d1117');
  const s2 = suggest(parseHex('#57606a'), dark, 4.5);
  assert.ok(contrast(parseHex(s2), dark) >= 4.5);
});

test('svgSize reads width/height and falls back to the viewBox', () => {
  assert.deepEqual(svgSize('<svg width="400" height="200">'), { width: 400, height: 200 });
  assert.deepEqual(svgSize('<svg viewBox="0 0 800 450">'), { width: 800, height: 450 });
  assert.deepEqual(svgSize('<svg width="100%" viewBox="0 0 800 450">'), { width: 800, height: 450 });
  assert.deepEqual(svgSize('<svg width="300" viewBox="0 0 600 300">'), { width: 300, height: 150 });
  assert.equal(svgSize('<html>'), null);
});

test('cli arguments', () => {
  const o = parseArgs(['a.svg', '--json', '--theme', 'dark', '--only', 'text-overlap,low-contrast', '--wait', '0']);
  assert.deepEqual(o.files, ['a.svg']);
  assert.equal(o.json, true);
  assert.deepEqual(o.themes, ['dark']);
  assert.deepEqual(o.only, ['text-overlap', 'low-contrast']);
  assert.equal(o.wait, 0);
  assert.throws(() => parseArgs(['--only', 'nope']), /unknown rule/);
  assert.throws(() => parseArgs(['--theme', 'sepia']), /light, dark or both/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
});
