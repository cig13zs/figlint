import { lint, launch, RULES, VERSION } from './lint.js';
import { format } from './report.js';

const HELP = `figlint ${VERSION}: layout lint for HTML and SVG figures

usage: figlint <file.html|file.svg|url>... [options]

  --json               print the report as JSON
  --theme <t>          light, dark or both (default both)
  --shot <file.png>    save the render with each finding boxed and numbered
  --width <px>         viewport width for HTML (default 1280; SVG uses its own size)
  --height <px>        viewport height for HTML (default 800; grows to fit the page)
  --wait <ms>          extra time after load before measuring (default 250)
  --timeout <ms>       page load timeout (default 15000)
  --tolerance <px>     how close a line end must be to a shape to count as attached (default 4)
  --only <rules>       comma-separated rules to run
  --skip <rules>       comma-separated rules to skip
  --strict             exit 1 on warnings too
  --scale <n>          device pixel ratio for screenshots (default 1)
  --chrome <path>      browser executable (or set FIGLINT_CHROME)
  -h, --help           show this help
  -v, --version        print the version

rules: ${RULES.join(', ')}

exit codes: 0 no errors, 1 errors found (or warnings with --strict), 2 figlint itself failed
`;

export function parseArgs(argv) {
  const opts = { files: [], json: false, strict: false };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  const num = (v, flag) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a number, got "${v}"`);
    return n;
  };
  const rules = (v, flag) => {
    const list = v.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((r) => !RULES.includes(r));
    if (bad.length) throw new Error(`${flag}: unknown rule ${bad.join(', ')} (rules: ${RULES.join(', ')})`);
    return list;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--strict':
        opts.strict = true;
        break;
      case '--theme': {
        const t = need(i++, a);
        if (!['light', 'dark', 'both'].includes(t)) throw new Error('--theme must be light, dark or both');
        opts.themes = t === 'both' ? ['light', 'dark'] : [t];
        break;
      }
      case '--shot':
        opts.shot = need(i++, a);
        break;
      case '--width':
      case '--height':
      case '--wait':
      case '--timeout':
      case '--tolerance':
      case '--scale':
        opts[a.slice(2)] = num(need(i++, a), a);
        break;
      case '--only':
      case '--skip':
        opts[a.slice(2)] = rules(need(i++, a), a);
        break;
      case '--chrome':
        opts.chrome = need(i++, a);
        break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        opts.files.push(a);
    }
  }
  return opts;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    stderr.write(`figlint: ${e.message}\n`);
    return 2;
  }
  if (opts.help) {
    stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    stdout.write(VERSION + '\n');
    return 0;
  }
  if (!opts.files.length) {
    stderr.write(HELP);
    return 2;
  }
  if (opts.shot && opts.files.length > 1) {
    stderr.write('figlint: --shot works with one file at a time\n');
    return 2;
  }
  const color = !opts.json && stdout.isTTY && !process.env.NO_COLOR;
  let browser;
  const results = [];
  try {
    browser = await launch({ chrome: opts.chrome });
    for (const file of opts.files) {
      results.push(
        await lint(file, {
          browser,
          themes: opts.themes,
          width: opts.width,
          height: opts.height,
          wait: opts.wait,
          timeout: opts.timeout,
          tolerance: opts.tolerance,
          only: opts.only,
          skip: opts.skip,
          scale: opts.scale,
          shot: opts.shot,
        }),
      );
    }
  } catch (e) {
    stderr.write(`figlint: ${e.message}\n`);
    return 2;
  } finally {
    if (browser) await browser.close();
  }
  if (opts.json) stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n');
  else stdout.write(results.map((r) => format(r, { color })).join('\n\n') + '\n');
  const failed = results.some((r) => r.errors > 0 || (opts.strict && r.warnings > 0));
  return failed ? 1 : 0;
}
