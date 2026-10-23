// WCAG 2.x contrast math. Colors are {r, g, b, a} with channels 0-255 and a 0-1.

const channel = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function luminance({ r, g, b }) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Paint `top` (possibly translucent) over an opaque `bottom`.
export function over(top, bottom) {
  const a = top.a ?? 1;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

export function hex({ r, g, b }) {
  const h = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function parseHex(str) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.replace(/./g, (c) => c + c);
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16), a: 1 };
}

// WCAG "large text": at least 24px, or at least 18.66px (14pt) and bold.
export function isLarge(fontSizePx, weight) {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && weight >= 700);
}

export function required(fontSizePx, weight) {
  return isLarge(fontSizePx, weight) ? 3 : 4.5;
}

// Nearest color to `fg` (mixing toward black or white) that reaches `target`
// against `bg`. Returns null if neither direction gets there.
export function suggest(fg, bg, target) {
  const tries = [];
  for (const end of [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }]) {
    for (let t = 0.02; t <= 1.0001; t += 0.02) {
      const c = {
        r: fg.r + (end.r - fg.r) * t,
        g: fg.g + (end.g - fg.g) * t,
        b: fg.b + (end.b - fg.b) * t,
        a: 1,
      };
      if (contrast(c, bg) >= target + 0.05) {
        tries.push({ c, t });
        break;
      }
    }
  }
  if (!tries.length) return null;
  tries.sort((a, b) => a.t - b.t);
  return hex(tries[0].c);
}
