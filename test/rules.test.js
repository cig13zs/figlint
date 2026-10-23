import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { lint, launch } from '../src/lint.js';

const fx = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

const run = (name, opts = {}) => lint(fx(name), { browser, wait: 0, ...opts });
const rules = (r) => r.findings.map((f) => f.rule);
const only = (r, rule) => r.findings.filter((f) => f.rule === rule);
const clean = (r) => assert.deepEqual(r.findings.map((f) => `${f.rule}: ${f.message}`), []);

describe('text-overlap', () => {
  test('svg labels on top of each other', async () => {
    const r = await run('overlap.svg');
    const f = only(r, 'text-overlap');
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'error');
    assert.equal(f[0].selector, '#a');
    assert.equal(f[0].related[0].selector, '#b');
    assert.match(f[0].hint, /move "Queue worker" \d+px down/);
    assert.deepEqual(f[0].themes, ['light', 'dark']);
    assert.equal(r.ok, false);
  });

  test('html absolutely positioned labels', async () => {
    const r = await run('overlap.html');
    const f = only(r, 'text-overlap');
    assert.equal(f.length, 1);
    assert.equal(f[0].selector, '#api');
    assert.equal(f[0].related[0].selector, '#db');
  });

  test('tight leading, tspans, badges and inline markup are not overlaps', async () => {
    clean(await run('overlap-clean.svg'));
    clean(await run('overlap-clean.html'));
  });
});

describe('text-clipped', () => {
  test('svg text past the viewBox', async () => {
    const r = await run('clipped.svg', { themes: ['light'] });
    const f = only(r, 'text-clipped');
    assert.deepEqual(f.map((x) => x.selector).sort(), ['#long', '#low']);
    const long = f.find((x) => x.selector === '#long');
    assert.ok(long.data.outside.right > 40, `right overflow ${long.data.outside.right}`);
    assert.match(long.hint, /left/);
  });

  test('html text cut by overflow:hidden', async () => {
    const r = await run('clipped.html', { themes: ['light'] });
    const f = only(r, 'text-clipped');
    assert.equal(f.length, 1);
    assert.equal(f[0].selector, '#tight');
    assert.match(f[0].hint, /wider/);
  });

  test('text that fits or wraps is fine', async () => {
    clean(await run('clipped-clean.svg'));
    clean(await run('clipped-clean.html'));
  });
});

describe('off-canvas', () => {
  test('shape fully outside is an error, partly outside a warning', async () => {
    const r = await run('offcanvas.svg', { themes: ['light'] });
    const f = only(r, 'off-canvas');
    const gone = f.find((x) => x.selector === '#gone');
    const half = f.find((x) => x.selector === '#half');
    assert.equal(gone.severity, 'error');
    assert.equal(half.severity, 'warning');
    assert.equal(f.length, 2);
  });

  test('bleeding backgrounds and clip-path crops are fine', async () => {
    clean(await run('offcanvas-clean.svg'));
  });
});

describe('dangling-connector', () => {
  test('arrow stopping short and a line going nowhere', async () => {
    const r = await run('dangling.svg', { themes: ['light'] });
    const f = only(r, 'dangling-connector');
    assert.deepEqual(f.map((x) => x.selector).sort(), ['#req', '#stray']);
    const req = f.find((x) => x.selector === '#req');
    assert.equal(req.data.ends.length, 1);
    assert.equal(req.data.ends[0].which, 'end');
    assert.equal(req.data.ends[0].nearest.selector, '#server');
    assert.ok(Math.abs(req.data.ends[0].nearest.distance - 40) < 2);
    assert.match(req.hint, /\(360, 115\) on #server/);
  });

  test('svg arrows over an html diagram', async () => {
    const r = await run('dangling.html', { themes: ['light'] });
    const f = only(r, 'dangling-connector');
    assert.equal(f.length, 1);
    assert.equal(f[0].selector, '#short');
  });

  test('attached arrows, legend swatches, axes and ticks are fine', async () => {
    clean(await run('dangling-clean.svg'));
  });
});

describe('label-on-line', () => {
  test('label drawn straight on a line', async () => {
    const r = await run('label-on-line.svg', { themes: ['light'] });
    const f = only(r, 'label-on-line');
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'warning');
    assert.equal(f[0].selector, '#onit');
    assert.equal(r.ok, true, 'warnings alone do not fail');
  });

  test('halo, opaque chip and clear space are fine', async () => {
    clean(await run('label-on-line-clean.svg'));
  });
});

describe('text-covered and text-shape-overlap', () => {
  test('shape painted over a label', async () => {
    const r = await run('covered.svg', { themes: ['light'] });
    assert.deepEqual(rules(r), ['text-covered']);
    assert.equal(r.findings[0].related[0].selector, '#lid');
  });

  test('label spilling over the edge of its box', async () => {
    const r = await run('straddle.svg', { themes: ['light'] });
    const f = only(r, 'text-shape-overlap');
    assert.equal(f.length, 1);
    assert.equal(f[0].selector, '#spill');
    assert.equal(f[0].related[0].selector, '#box');
  });
});

describe('low-contrast', () => {
  test('light grey text; large text gets the 3:1 threshold', async () => {
    const r = await run('contrast.svg');
    const f = only(r, 'low-contrast');
    const faint = f.find((x) => x.selector === '#faint');
    const meh = f.find((x) => x.selector === '#meh');
    assert.equal(faint.severity, 'error');
    assert.equal(meh.severity, 'warning');
    assert.deepEqual(faint.themes, ['light', 'dark']);
    assert.ok(!f.some((x) => x.selector === '#big'));
    assert.ok(faint.data.ratio < 2 && faint.data.ratio > 1.8, `ratio ${faint.data.ratio}`);
    assert.match(faint.data.suggestion, /^#[0-9a-f]{6}$/);
  });

  test('transparent svg with dark text fails only on a dark page', async () => {
    const r = await run('transparent.svg');
    const f = only(r, 'low-contrast');
    assert.equal(f.length, 1);
    assert.deepEqual(f[0].themes, ['dark']);
    assert.equal(f[0].data.background, '#0d1117');
  });

  test('a dark theme that forgets one color', async () => {
    const r = await run('contrast-dark.html');
    const f = only(r, 'low-contrast');
    assert.equal(f.length, 1);
    assert.equal(f[0].selector, '#cap');
    assert.deepEqual(f[0].themes, ['dark']);
  });

  test('themes that respect prefers-color-scheme are fine', async () => {
    clean(await run('themed.svg'));
    clean(await run('contrast-clean.html'));
  });

  test('--theme light skips the dark pass', async () => {
    clean(await run('transparent.svg', { themes: ['light'] }));
  });
});

describe('escape hatches', () => {
  test('data-figlint-ignore with and without a rule list', async () => {
    const r = await run('ignore.svg', { themes: ['light'] });
    assert.deepEqual(r.findings.map((f) => [f.rule, f.text]), [['low-contrast', 'still checked']]);
  });

  test('--only and --skip', async () => {
    const a = await run('dangling.svg', { themes: ['light'], only: ['text-overlap'] });
    clean(a);
    const b = await run('contrast.svg', { themes: ['light'], skip: ['low-contrast'] });
    clean(b);
  });
});
