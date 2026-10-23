// Plain-text report for people and for agents reading terminal output.

const ANSI = { red: 31, yellow: 33, dim: 2, bold: 1, green: 32, cyan: 36 };

export function format(result, { color = false } = {}) {
  const c = (name, s) => (color ? `\x1b[${ANSI[name]}m${s}\x1b[0m` : s);
  const lines = [];
  const themes = result.themes.join(' + ');
  lines.push(`${c('bold', 'figlint')} ${result.file}  ${c('dim', `(${result.document}, ${themes}, ${result.viewport.width}x${result.viewport.height})`)}`);
  lines.push('');
  const b = (box) => `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`;
  result.findings.forEach((f, i) => {
    const sev = f.severity === 'error' ? c('red', 'error') : c('yellow', 'warn ');
    const themeNote = f.themes.length < result.themes.length ? c('dim', ` [${f.themes.join(', ')} only]`) : '';
    lines.push(`${String(i + 1).padStart(3)}. ${sev}  ${c('bold', f.rule)}  ${f.message}${themeNote}`);
    lines.push(`       at   ${f.selector}  ${c('dim', `(${b(f.box)})`)}`);
    for (const r of f.related || []) lines.push(`       with ${r.selector}  ${c('dim', `(${b(r.box)})`)}`);
    lines.push(`       ${c('cyan', 'fix')}  ${f.hint}`);
    lines.push('');
  });
  for (const n of result.notes || []) lines.push(c('dim', `note: ${n}`));
  for (const s of result.shots || []) lines.push(c('dim', `wrote ${s}`));
  const summary = result.findings.length
    ? `${result.errors} error${result.errors === 1 ? '' : 's'}, ${result.warnings} warning${result.warnings === 1 ? '' : 's'}`
    : 'no problems found';
  lines.push(result.errors ? c('red', summary) : result.warnings ? c('yellow', summary) : c('green', summary));
  return lines.join('\n');
}
