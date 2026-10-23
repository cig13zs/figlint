import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// Finding a Chromium to drive, in this order:
//   1. --chrome / FIGLINT_CHROME
//   2. the Chromium that matches the installed playwright-core
//   3. any other Chromium in the Playwright cache (a neighbouring version works fine over CDP)
//   4. an installed Chrome or Edge
async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    throw new Error('figlint needs playwright-core. Run: npm install playwright-core');
  }
}

function cachedChromiums() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ].filter((p) => p && p !== '0' && existsSync(p));
  const found = [];
  for (const root of roots) {
    for (const dir of readdirSync(root)) {
      const m = /^chromium(_headless_shell)?-(\d+)$/.exec(dir);
      if (!m) continue;
      const candidates = [
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
        'chrome-headless-shell-linux64/chrome-headless-shell',
        'chrome-linux/headless_shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-win/chrome.exe',
        'chrome-win64/chrome.exe',
        'chrome-headless-shell-win64/chrome-headless-shell.exe',
      ].map((p) => join(root, dir, p));
      for (const c of candidates) if (existsSync(c)) found.push({ path: c, rev: Number(m[2]), shell: !!m[1] });
    }
  }
  // Newest first; prefer the headless shell at equal revisions (it starts faster).
  return found.sort((a, b) => b.rev - a.rev || Number(b.shell) - Number(a.shell)).map((f) => f.path);
}

function systemChromes() {
  const p = platform();
  const list =
    p === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : p === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/microsoft-edge',
          ];
  return list.filter((f) => existsSync(f));
}

export async function launch({ chrome } = {}) {
  const { chromium } = await loadPlaywright();
  const explicit = chrome || process.env.FIGLINT_CHROME;
  const base = { headless: true, args: ['--font-render-hinting=none'] };
  if (explicit) return chromium.launch({ ...base, executablePath: explicit });
  const errors = [];
  try {
    return await chromium.launch(base);
  } catch (e) {
    errors.push(e.message.split('\n')[0]);
  }
  for (const path of [...cachedChromiums(), ...systemChromes()]) {
    try {
      return await chromium.launch({ ...base, executablePath: path });
    } catch (e) {
      errors.push(`${path}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error(
    'could not start a browser. Install one with `npx playwright-core install chromium`, ' +
      'or point FIGLINT_CHROME at Chrome, Edge or Chromium.\n  ' +
      errors.join('\n  '),
  );
}
