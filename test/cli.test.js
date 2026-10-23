import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = fileURLToPath(new URL('../bin/figlint.js', import.meta.url));
const fx = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('exit 1 and a readable report when there are errors', () => {
  const r = run(fx('overlap.svg'), '--theme', 'light', '--wait', '0');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /error {2}text-overlap {2}"Payment service" overlaps "Queue worker"/);
  assert.match(r.stdout, /fix {2}move/);
  assert.match(r.stdout, /1 error, 0 warnings/);
});

test('exit 0 on a clean figure, --json output parses', () => {
  const r = run(fx('themed.svg'), '--json', '--wait', '0');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.errors, 0);
  assert.deepEqual(j.findings, []);
  assert.deepEqual(j.themes, ['light', 'dark']);
});

test('warnings pass unless --strict', () => {
  assert.equal(run(fx('label-on-line.svg'), '--theme', 'light', '--wait', '0').status, 0);
  assert.equal(run(fx('label-on-line.svg'), '--theme', 'light', '--wait', '0', '--strict').status, 1);
});

test('--shot writes one png per theme', () => {
  const dir = mkdtempSync(join(tmpdir(), 'figlint-'));
  try {
    const r = run(fx('dangling.svg'), '--shot', join(dir, 'out.png'), '--wait', '0');
    assert.equal(r.status, 1, r.stderr);
    assert.ok(existsSync(join(dir, 'out.light.png')));
    assert.ok(existsSync(join(dir, 'out.dark.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit 2 on a missing file or bad option', () => {
  assert.equal(run('nope.svg').status, 2);
  assert.equal(run('--theme', 'sepia', 'x.svg').status, 2);
});
