import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './browser.js';
import { inspect, hideText, showText, enableHitTesting, sampleBackgrounds, annotate } from './inspect.js';
import { contrast, over, hex, required, suggest, parseHex } from './color.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const RULES = [
  'text-overlap',
  'text-covered',
  'text-clipped',
  'off-canvas',
  'dangling-connector',
  'text-shape-overlap',
  'label-on-line',
  'low-contrast',
];

const DEFAULTS = {
  themes: ['light', 'dark'],
  width: 1280,
  height: 800,
  wait: 250,
  timeout: 15000,
  tolerance: 4,
  scale: 1,
  bgLight: '#ffffff',
  bgDark: '#0d1117',
};

function targetOf(input) {
  if (/^(https?|file):/i.test(input)) return { url: input, path: null };
  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`no such file: ${input}`);
  return { url: pathToFileURL(path).href, path };
}

// Natural size of a standalone SVG: width/height attributes, else the viewBox.
export function svgSize(source) {
  const tag = /<svg\b[^>]*>/i.exec(source);
  if (!tag) return null;
  const attr = (name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag[0]);
    return m ? m[1].trim() : null;
  };
  const num = (v) => (v && /^[\d.]+(px)?$/.test(v) ? parseFloat(v) : null);
  let w = num(attr('width'));
  let h = num(attr('height'));
  const vb = attr('viewBox');
  if (vb) {
    const p = vb.split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) {
      if (!w && !h) {
        w = p[2];
        h = p[3];
      } else if (!w) w = (h * p[2]) / p[3];
      else if (!h) h = (w * p[3]) / p[2];
    }
  }
  if (!w || !h) return null;
  return { width: Math.round(w), height: Math.round(h) };
}

const SEVERITY_ORDER = { error: 0, warning: 1 };

function mergeThemes(perTheme) {
  const merged = new Map();
  for (const [theme, list] of perTheme) {
    for (const f of list) {
      const key = [f.rule, f.selector, (f.related || []).map((r) => r.selector).join('|'), f.message].join('\u0000');
      if (merged.has(key)) merged.get(key).themes.push(theme);
      else merged.set(key, { ...f, themes: [theme] });
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      RULES.indexOf(a.rule) - RULES.indexOf(b.rule) ||
      a.box.y - b.box.y ||
      a.box.x - b.box.x,
  );
}

function contrastFindings(items, backgrounds, theme) {
  const out = [];
  items.forEach((it, i) => {
    const sampled = backgrounds[i];
    if (!sampled) return;
    const bg = it.halo && it.halo.a >= 0.6 ? over(it.halo, sampled) : sampled;
    const fg = over(it.fg, bg);
    const ratio = contrast(fg, bg);
    const need = required(it.fontSize, it.weight);
    if (ratio >= need) return;
    const better = suggest(fg, bg, need);
    out.push({
      rule: 'low-contrast',
      severity: ratio < 3 ? 'error' : 'warning',
      message: `"${it.text}" has contrast ${ratio.toFixed(2)}:1 on ${hex(bg)} (needs ${need}:1)`,
      selector: it.selector,
      text: it.text,
      box: it.box,
      related: [],
      hint: better
        ? `use ${better} for the text (now ${hex(fg)}), or change the background`
        : `change the background behind the text`,
      data: {
        ratio: Math.round(ratio * 100) / 100,
        required: need,
        foreground: hex(fg),
        background: hex(bg),
        fontSize: it.fontSize,
        suggestion: better,
      },
    });
  });
  return out;
}

async function settle(page, { wait, timeout }) {
  await page.waitForLoadState('networkidle', { timeout: Math.min(3000, timeout) }).catch(() => {});
  await page
    .evaluate(() => Promise.race([document.fonts ? document.fonts.ready.then(() => 1) : 1, new Promise((r) => setTimeout(r, 3000))]))
    .catch(() => {});
  if (wait > 0) await page.waitForTimeout(wait);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
}

/**
 * Lint one figure. Returns the report object described in the README.
 *
 * options: themes, width, height, wait, timeout, tolerance, only, skip, scale,
 * shot (path for an annotated PNG), chrome, browser (reuse a launched one),
 * beforeLoad(page) hook, bgLight, bgDark.
 */
export async function lint(input, options = {}) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
  const { url, path } = targetOf(input);
  let size = { width: o.width, height: o.height };
  let svgFile = /\.svg(?:[?#]|$)/i.test(path || url);
  if (svgFile && path && !options.width) {
    const s = svgSize(readFileSync(path, 'utf8'));
    if (s) size = { width: Math.min(s.width, 4000), height: Math.min(s.height, 8000) };
  }

  const ownBrowser = !o.browser;
  const browser = o.browser || (await launch({ chrome: o.chrome }));
  const perTheme = [];
  const shots = [];
  const notes = [];
  let stats = null;
  let viewport = size;
  try {
    for (const theme of o.themes) {
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: o.scale,
        colorScheme: theme,
      });
      try {
        const page = await context.newPage();
        if (o.beforeLoad) await o.beforeLoad(page, theme);
        try {
          await page.goto(url, { waitUntil: 'load', timeout: o.timeout });
        } catch (e) {
          if (!/timeout/i.test(e.message)) throw e;
          notes.push(`${theme}: the page did not finish loading in ${o.timeout}ms; checked what had rendered`);
        }
        await settle(page, o);

        const info = await page.evaluate(() => ({
          svg: document.documentElement.localName === 'svg',
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight,
        }));
        svgFile = info.svg;
        if (!info.svg && info.scrollHeight > info.innerHeight + 1) {
          viewport = { width: size.width, height: Math.min(info.scrollHeight, 16000) };
          await page.setViewportSize(viewport);
          await settle(page, { ...o, wait: 50 });
        } else viewport = size;

        await page.evaluate(enableHitTesting);
        const res = await page.evaluate(inspect, {
          tolerance: o.tolerance,
          only: o.only,
          skip: o.skip,
        });
        stats = res.stats;
        const base = parseHex(theme === 'dark' ? o.bgDark : o.bgLight) || { r: 255, g: 255, b: 255, a: 1 };
        let found = res.findings;
        if (res.contrastItems.length) {
          await page.evaluate(hideText);
          const png = (await page.screenshot({ omitBackground: info.svg, animations: 'disabled' })).toString('base64');
          await page.evaluate(showText);
          const bgs = await page.evaluate(sampleBackgrounds, {
            png,
            items: res.contrastItems,
            dpr: o.scale,
            base: info.svg ? base : { r: 255, g: 255, b: 255 },
          });
          found = found.concat(contrastFindings(res.contrastItems, bgs, theme));
        }
        perTheme.push([theme, found]);
        if (o.shot) {
          const png = (await page.screenshot({ omitBackground: info.svg, animations: 'disabled' })).toString('base64');
          shots.push({ theme, png, base: info.svg ? hex(base) : null });
        }
      } finally {
        await context.close();
      }
    }

    const findings = mergeThemes(perTheme);
    const written = [];
    if (o.shot && shots.length) {
      const page = await browser.newPage();
      try {
        for (const s of shots) {
          const marks = findings
            .filter((f) => f.themes.includes(s.theme))
            .map((f) => ({
              severity: f.severity,
              index: findings.indexOf(f) + 1,
              // Related boxes help for overlaps and dangling ends; for big shapes they are clutter.
              boxes: [f.box, ...(f.related || []).map((r) => r.box)]
                .slice(0, 2)
                .filter((b, k) => k === 0 || ['text-overlap', 'text-covered', 'dangling-connector'].includes(f.rule)),
              points: f.rule === 'dangling-connector' ? f.data.ends.map((e) => e.at) : [],
            }));
          const out = await page.evaluate(annotate, { png: s.png, marks, dpr: o.scale, base: s.base });
          const file =
            shots.length > 1 ? o.shot.replace(/(\.png)?$/i, `.${s.theme}.png`) : o.shot.endsWith('.png') ? o.shot : o.shot + '.png';
          writeFileSync(file, Buffer.from(out, 'base64'));
          written.push(file);
        }
      } finally {
        await page.close();
      }
    }

    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.length - errors;
    return {
      figlint: VERSION,
      file: input,
      themes: o.themes,
      viewport,
      document: svgFile ? 'svg' : 'html',
      ok: errors === 0,
      errors,
      warnings,
      findings,
      notes,
      shots: written,
      stats,
    };
  } finally {
    if (ownBrowser) await browser.close();
  }
}

export { launch };
