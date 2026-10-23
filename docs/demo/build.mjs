// Rebuilds the demo images in this folder:
//   node docs/demo/build.mjs
// before.png / after.png      the broken and fixed figure, light theme, 2x
// before-marked.png           the broken figure with figlint's findings boxed
// report.txt / report.png     the terminal report for broken.svg
// vertical.png                1080x1920, before (marked) over after, for phone screens
import { writeFileSync, readFileSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { lint, launch } from '../../src/lint.js';
import { format } from '../../src/report.js';

const here = dirname(fileURLToPath(import.meta.url));
const at = (f) => join(here, f);
const b64 = (f) => readFileSync(at(f)).toString('base64');

const browser = await launch();

async function render(svg, png, theme = 'light') {
  const page = await browser.newPage({ viewport: { width: 720, height: 440 }, deviceScaleFactor: 2, colorScheme: theme });
  await page.goto(pathToFileURL(at(svg)).href);
  await page.screenshot({ path: at(png) });
  await page.close();
}

await render('broken.svg', 'before.png');
await render('fixed.svg', 'after.png');
await render('broken.svg', 'before-dark.png', 'dark');
await render('fixed.svg', 'after-dark.png', 'dark');

const result = await lint(at('broken.svg'), { browser, scale: 2, shot: at('before-marked.png'), themes: ['light', 'dark'] });
renameSync(at('before-marked.light.png'), at('before-marked.png'));
renameSync(at('before-marked.dark.png'), at('before-marked-dark.png'));
const fixed = await lint(at('fixed.svg'), { browser });
const shown = { ...result, file: 'broken.svg', shots: [] };
writeFileSync(at('report.txt'), format(shown) + '\n');
writeFileSync(at('report.json'), JSON.stringify({ ...result, file: 'broken.svg', shots: [] }, null, 2) + '\n');

// Terminal-style picture of the report, sized for a phone (1080 px wide).
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ansi = (s) =>
  esc(s)
    .replace(/\x1b\[(\d+)m/g, (_, n) => `<span class="c${n}">`)
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/<span class="c0">/g, '</span>');
const coloured = format(shown, { color: true });
const lines = coloured
  .split('\n')
  .map((l) => `<div class="l">${ansi(l) || '&nbsp;'}</div>`)
  .join('');
const terminal = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #0d1117; }
  .win { width: 1080px; box-sizing: border-box; padding: 34px 34px 40px; font: 25px/1.38 'DejaVu Sans Mono', Menlo, Consolas, monospace; color: #e6edf3; }
  .bar { display: flex; gap: 12px; margin-bottom: 26px; }
  .bar i { width: 18px; height: 18px; border-radius: 50%; display: block; }
  .prompt { color: #7ee787; margin-bottom: 18px; }
  .l { white-space: pre-wrap; word-break: break-word; padding-left: 7ch; text-indent: -7ch; }
  .c1 { font-weight: bold; } .c2 { color: #8d96a0; } .c31 { color: #ff7b72; } .c33 { color: #e3b341; }
  .c32 { color: #7ee787; } .c36 { color: #79c0ff; }
</style></head><body><div class="win">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
  <div class="prompt">$ npx figlint broken.svg</div>${lines}
  <div class="l">&nbsp;</div><div class="prompt">$ echo $?</div><div class="l">1</div>
</div></body></html>`;
{
  const page = await browser.newPage({ viewport: { width: 1080, height: 400 }, deviceScaleFactor: 1 });
  await page.setContent(terminal);
  await page.screenshot({ path: at('report.png'), fullPage: true });
  await page.close();
}

// 1080x1920: before (marked) on top, the verdict in the middle, after below.
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);
const short = (f) =>
  ({
    'text-overlap': () => `${cut(f.text, 14)} on ${cut(f.related[0].text, 14)}`,
    'text-clipped': () => `title cut off by the frame`,
    'dangling-connector': () => `arrow stops ${Math.round(f.data.ends[0].nearest.distance)}px short`,
    'low-contrast': () => `${f.data.ratio}:1 in ${f.themes.join(' + ')} mode`,
  })[f.rule]?.() ?? '';
const errs = result.findings.filter((f) => f.severity === 'error');
const vertical = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; }
  body { width: 1080px; height: 1920px; background: #0d1117; color: #e6edf3; font-family: Inter, sans-serif;
         display: flex; flex-direction: column; align-items: center; box-sizing: border-box; padding: 70px 40px 0; }
  .tag { font: 700 44px Inter, sans-serif; letter-spacing: 0.02em; align-self: flex-start; margin: 0 0 18px 0; }
  .bad { color: #ff7b72; } .good { color: #7ee787; }
  img { width: 1000px; border-radius: 18px; display: block; }
  .mid { width: 1000px; box-sizing: border-box; margin: 34px 0 40px; padding: 26px 30px; background: #161b22; border-radius: 18px;
         font: 26px/1.45 'DejaVu Sans Mono', monospace; }
  .mid .cmd { color: #7ee787; margin-bottom: 8px; }
  .mid .e { color: #ff7b72; white-space: pre; }
  .mid .d { color: #c9d1d9; }
  .mid .sum { color: #ff7b72; margin-top: 8px; font-weight: bold; }
</style></head><body>
  <div class="tag bad">Before: what the agent drew</div>
  <img src="data:image/png;base64,${b64('before-marked.png')}">
  <div class="mid">
    <div class="cmd">$ npx figlint broken.svg</div>
    ${errs.map((f) => `<div class="e">${esc(f.rule.padEnd(19))}<span class="d">${esc(short(f))}</span></div>`).join('')}
    <div class="sum">${result.errors} errors, ${result.warnings} warnings, exit 1</div>
  </div>
  <div class="tag good">After: ${fixed.findings.length ? `${fixed.findings.length} left` : 'no problems found'}</div>
  <img src="data:image/png;base64,${b64('after.png')}">
</body></html>`;
{
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.setContent(vertical);
  await page.screenshot({ path: at('vertical.png') });
  await page.close();
}

await browser.close();
console.log(`broken.svg: ${result.errors} errors, ${result.warnings} warnings; fixed.svg: ${fixed.findings.length} findings`);
