// Runs inside the page (passed to page.evaluate), so it must not use anything
// from the module scope. Everything it needs is defined inside the function.
//
// It measures the rendered figure and returns geometry findings plus the list of
// text items that the contrast pass needs. Coordinates are CSS pixels relative to
// the top-left of the document (the viewport is sized to the whole document
// before this runs, so client coordinates are document coordinates).

export function inspect(opts) {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const tolerance = opts.tolerance ?? 4;
  const skipRules = new Set(opts.skip || []);
  const onlyRules = opts.only && opts.only.length ? new Set(opts.only) : null;
  const ruleOn = (r) => !skipRules.has(r) && (!onlyRules || onlyRules.has(r));

  const NON_RENDERED = new Set([
    'defs', 'clippath', 'mask', 'marker', 'symbol', 'pattern', 'title', 'desc', 'metadata',
    'lineargradient', 'radialgradient', 'filter', 'style', 'script', 'noscript', 'template', 'head',
  ]);
  const GEOMETRY = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);
  const REPLACED = new Set(['img', 'canvas', 'video', 'iframe', 'object', 'embed']);
  const HINT_RE = /(^|[-_\s])(edge|edges|link|links|arrow|arrows|connector|connectors|conn|wire|wires|flow|flows|leader|leaders)([-_\s]|$)/i;

  const findings = [];
  const R = (n) => Math.round(n * 10) / 10;
  const isSvg = (el) => el.namespaceURI === SVGNS;
  const docIsSvg = document.documentElement.localName === 'svg';

  // ---------- small helpers ----------

  const styleCache = new Map();
  const cs = (el) => {
    let s = styleCache.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styleCache.set(el, s);
    }
    return s;
  };

  const colorCanvas = new OffscreenCanvas(1, 1);
  const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  // Any CSS color string to {r,g,b,a} in sRGB, or null for none/url()/currentColor leftovers.
  const parseColor = (str) => {
    if (!str || str === 'none' || str.startsWith('url(') || str === 'transparent') {
      return str === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 } : null;
    }
    if (colorCache.has(str)) return colorCache.get(str);
    let out = null;
    const m = str.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      out = { r: +m[1], g: +m[2], b: +m[3], a };
    } else {
      // oklch(), color(), lab() and friends: let the canvas convert it.
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    }
    colorCache.set(str, out);
    return out;
  };

  const ignoredFor = (el, rule) => {
    const host = el.closest ? el.closest('[data-figlint-ignore]') : null;
    if (!host) return false;
    const v = (host.getAttribute('data-figlint-ignore') || '').trim();
    if (!v || v === 'all' || v === 'true') return true;
    return v.split(/[\s,]+/).includes(rule);
  };

  // Hidden, inside defs/markers/etc, or display:none somewhere up the tree.
  const notRendered = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (NON_RENDERED.has(n.localName.toLowerCase())) return true;
      if (cs(n).display === 'none') return true;
    }
    const s = cs(el);
    return s.visibility === 'hidden' || s.visibility === 'collapse';
  };

  const opacityChain = (el) => {
    let a = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) a *= parseFloat(cs(n).opacity);
    return a;
  };

  const rectOf = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const boxOut = (b) => ({ x: R(b.x), y: R(b.y), width: R(b.w), height: R(b.h) });
  const area = (b) => Math.max(0, b.w) * Math.max(0, b.h);
  const inter = (a, b) => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x;
    const h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  };
  const grow = (b, d) => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
  const contains = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  const distToBox = (b, p) => {
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
    return Math.hypot(dx, dy);
  };
  const clampToBox = (b, p) => ({
    x: Math.min(Math.max(p.x, b.x), b.x + b.w),
    y: Math.min(Math.max(p.y, b.y), b.y + b.h),
  });
  const grid = (b, nx, ny) => {
    const pts = [];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        pts.push({ x: b.x + ((i + 0.5) * b.w) / nx, y: b.y + ((j + 0.5) * b.h) / ny });
      }
    }
    return pts;
  };

  const selectorOf = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.id) {
        const idSel = '#' + CSS.escape(n.id);
        let unique = false;
        try {
          unique = document.querySelectorAll(idSel).length === 1;
        } catch {}
        if (unique) {
          parts.unshift(idSel);
          break;
        }
      }
      const tag = n.localName;
      const p = n.parentElement;
      if (!p || tag === 'body') {
        parts.unshift(tag);
        break;
      }
      const cls = typeof n.className === 'string' ? n.className : n.getAttribute('class') || '';
      const first = cls.trim().split(/\s+/)[0];
      const same = [...p.children].filter((c) => c.localName === tag);
      let part = tag + (first ? '.' + CSS.escape(first) : '');
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(part);
      n = p;
    }
    return parts.join(' > ');
  };

  const snippet = (s) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > 40 ? t.slice(0, 39) + '…' : t;
  };

  // Screen transform for an SVG element.
  const ctmOf = (el) => {
    try {
      return el.getScreenCTM();
    } catch {
      return null;
    }
  };
  const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const scaleOf = (m) => (m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1 : 1);
  const toLocal = (el, p) => {
    const m = ctmOf(el);
    if (!m) return null;
    const inv = m.inverse();
    return new DOMPoint(p.x, p.y).matrixTransform(inv);
  };

  const outermostSvg = (el) => {
    let s = el.ownerSVGElement || (el.localName === 'svg' ? el : null);
    while (s && s.ownerSVGElement) s = s.ownerSVGElement;
    return s;
  };

  const page = {
    x: 0,
    y: 0,
    w: window.innerWidth,
    h: docIsSvg ? window.innerHeight : Math.max(window.innerHeight, document.documentElement.scrollHeight),
  };

  // The area an SVG element can paint into: its outermost <svg> box, unless that
  // svg lets content overflow, and never more than the page.
  const canvasCache = new Map();
  const canvasOf = (el) => {
    const root = outermostSvg(el);
    if (!root) return page;
    if (canvasCache.has(root)) return canvasCache.get(root);
    let c = page;
    const ov = cs(root).overflow;
    if (root === document.documentElement) {
      c = inter(rectOf(root.getBoundingClientRect()), page) || page;
    } else if (!(ov === 'visible' || ov === 'auto') || root.parentElement?.localName === 'foreignobject') {
      c = rectOf(root.getBoundingClientRect());
    } else if (ov === 'visible' || ov === 'auto') {
      c = page;
    }
    canvasCache.set(root, c);
    return c;
  };

  const all = [...document.querySelectorAll('*')];

  // ---------- text items ----------

  const texts = [];
  const pushText = (el, rects, str, fsPx, extra) => {
    rects = rects.filter((r) => r.w > 0.5 && r.h > 0.5);
    if (!rects.length) return;
    const cores = rects.map((r) => {
      const top = Math.min(0.2 * fsPx, r.h * 0.22);
      const bot = Math.min(0.14 * fsPx, r.h * 0.16);
      const side = Math.min(0.05 * fsPx, r.w * 0.1);
      return { x: r.x + side, y: r.y + top, w: r.w - 2 * side, h: r.h - top - bot };
    });
    const box = rects.reduce((u, r) => {
      const x = Math.min(u.x, r.x);
      const y = Math.min(u.y, r.y);
      return { x, y, w: Math.max(u.x + u.w, r.x + r.w) - x, h: Math.max(u.y + u.h, r.y + r.h) - y };
    });
    texts.push({ el, rects, cores, box, text: snippet(str), fs: fsPx, ...extra });
  };

  for (const el of all) {
    if (!isSvg(el) || el.localName !== 'text') continue;
    if (notRendered(el)) continue;
    const str = el.textContent || '';
    if (!str.trim()) continue;
    const s = cs(el);
    const m = ctmOf(el);
    const fs = parseFloat(s.fontSize) * scaleOf(m);
    const lines = [...el.querySelectorAll('tspan')].filter(
      (t) => t.hasAttribute('y') || t.hasAttribute('dy'),
    );
    let rects;
    if (lines.length > 1) rects = lines.map((t) => rectOf(t.getBoundingClientRect()));
    else rects = [rectOf(el.getBoundingClientRect())];
    const strokeC = parseColor(s.stroke);
    const sw = parseFloat(s.strokeWidth) * scaleOf(m);
    const halo =
      strokeC && strokeC.a > 0 && sw >= 1.5 && /^stroke/.test(s.paintOrder.trim())
        ? { ...strokeC, a: strokeC.a * parseFloat(s.strokeOpacity) }
        : null;
    pushText(el, rects, str, fs, {
      svg: true,
      fill: s.fill,
      fillOpacity: parseFloat(s.fillOpacity),
      halo,
      weight: parseInt(s.fontWeight, 10) || 400,
    });
  }

  if (!docIsSvg && document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const byParent = new Map();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || isSvg(p)) continue;
      if (!n.data.trim()) continue;
      const tag = p.localName;
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'textarea' || tag === 'title') continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(n);
    }
    for (const [p, nodes] of byParent) {
      if (notRendered(p)) continue;
      const rects = [];
      let str = '';
      for (const n of nodes) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) rects.push(rectOf(r));
        str += n.data + ' ';
      }
      const s = cs(p);
      pushText(p, rects, str, parseFloat(s.fontSize), {
        svg: false,
        color: s.webkitTextFillColor && s.webkitTextFillColor !== s.color ? s.webkitTextFillColor : s.color,
        weight: parseInt(s.fontWeight, 10) || 400,
        halo: null,
      });
    }
  }

  // ---------- shapes ----------

  const shapes = [];
  for (const el of all) {
    if (!isSvg(el)) continue;
    const tag = el.localName;
    if (!GEOMETRY.has(tag) && tag !== 'image' && tag !== 'use') continue;
    if (notRendered(el)) continue;
    const s = cs(el);
    const box = rectOf(el.getBoundingClientRect());
    const m = ctmOf(el);
    const op = opacityChain(el);
    const fill = tag === 'image' || tag === 'use' ? { r: 0, g: 0, b: 0, a: 1 } : parseColor(s.fill);
    const stroke = parseColor(s.stroke);
    const fillA = fill ? fill.a * parseFloat(s.fillOpacity) * op : 0;
    const strokeA = stroke ? stroke.a * parseFloat(s.strokeOpacity) * op : 0;
    const sw = parseFloat(s.strokeWidth) * scaleOf(m);
    const d = tag === 'path' ? el.getAttribute('d') || '' : '';
    const commands = tag === 'path' ? (d.match(/[MLHVCSQTAZ]/gi) || []).length : 0;
    const closed =
      tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon' ||
      (tag === 'path' && /z\s*$/i.test(d.trim()));
    const open = tag === 'line' || tag === 'polyline' || (tag === 'path' && !closed);
    const hint =
      el.hasAttribute('data-figlint-connector') ||
      HINT_RE.test(el.getAttribute('class') || '') ||
      HINT_RE.test(el.id || '') ||
      HINT_RE.test(el.parentElement?.getAttribute('class') || '') ||
      HINT_RE.test(el.parentElement?.id || '');
    const markerStart = s.markerStart && s.markerStart !== 'none' ? s.markerStart : null;
    const markerEnd = s.markerEnd && s.markerEnd !== 'none' ? s.markerEnd : null;
    shapes.push({
      el, tag, box, m, op, fill, stroke, fillA, strokeA, sw, commands, closed, open,
      complex: commands > 60,
      hint, markerStart, markerEnd,
      canvas: canvasOf(el),
      geometry: GEOMETRY.has(tag),
    });
  }

  // HTML boxes that paint something: backgrounds, borders, images.
  const boxes = [];
  if (!docIsSvg && document.body) {
    for (const el of document.body.querySelectorAll('*')) {
      if (isSvg(el) && el.localName !== 'svg') continue;
      if (notRendered(el)) continue;
      const s = cs(el);
      const bg = parseColor(s.backgroundColor);
      const op = opacityChain(el);
      const bgA = bg ? bg.a * op : 0;
      const bw = ['Top', 'Right', 'Bottom', 'Left'].map((k) => parseFloat(s['border' + k + 'Width']) || 0);
      const bc = parseColor(s.borderTopColor);
      const border = Math.max(...bw) >= 1 && bc && bc.a * op > 0.2 && s.borderTopStyle !== 'none';
      const replaced = REPLACED.has(el.localName) || el.localName === 'svg';
      const image = s.backgroundImage && s.backgroundImage !== 'none';
      if (!(bgA > 0.15 || border || replaced || image)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      boxes.push({ el, box: rectOf(r), bgA: image || el.localName === 'img' ? 1 : bgA, border, replaced, op });
    }
  }

  const pageArea = area(page);
  const nodeShapes = shapes.filter(
    (s) =>
      (s.closed || s.tag === 'image' || s.tag === 'use') &&
      (s.fillA > 0.05 || s.strokeA > 0.05) &&
      area(s.box) < 0.4 * area(s.canvas) &&
      area(s.box) >= 4,
  );
  const nodeBoxes = boxes.filter((b) => b.el.localName !== 'svg' && area(b.box) < 0.4 * pageArea);
  const lineShapes = shapes.filter(
    (s) => s.geometry && (s.open || (s.closed && s.fillA < 0.05)) && s.strokeA >= 0.3 && s.sw >= 0.5,
  );

  // Shapes that sit among many siblings of the same kind are a data layer
  // (map countries, scatter dots), not hand-placed diagram parts.
  const crowd = new Map();
  const inCrowd = (el) => {
    const p = el.parentElement;
    if (!p) return false;
    if (!crowd.has(p)) {
      const counts = {};
      for (const c of p.children) counts[c.localName] = (counts[c.localName] || 0) + 1;
      crowd.set(p, counts);
    }
    return crowd.get(p)[el.localName] >= 25;
  };

  const related = (a, b) => a === b || a.contains(b) || b.contains(a);
  const describe = (el, box, text) => {
    const o = { selector: selectorOf(el), box: boxOut(box) };
    if (text) o.text = text;
    return o;
  };

  // Hit-test helper: which element is painted on top at a point.
  const stack = (p) => {
    if (p.x < 0 || p.y < 0 || p.x >= window.innerWidth || p.y >= window.innerHeight) return [];
    return document.elementsFromPoint(p.x, p.y);
  };
  const textOwns = (t, el) => el === t.el || t.el.contains(el);
  // Does `el` (hit at a point) paint an opaque-enough surface there?
  const opaqueAt = (el) => {
    if (isSvg(el)) {
      const sh = shapes.find((s) => s.el === el);
      if (sh) return sh.fillA >= 0.6 || sh.tag === 'image';
      return false;
    }
    if (REPLACED.has(el.localName)) return true;
    const b = boxes.find((x) => x.el === el);
    return !!b && b.bgA >= 0.6;
  };

  // ---------- rule: text-overlap ----------

  if (ruleOn('text-overlap')) {
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i];
        const b = texts[j];
        if (related(a.el, b.el)) continue;
        if (ignoredFor(a.el, 'text-overlap') || ignoredFor(b.el, 'text-overlap')) continue;
        if (!inter(a.box, b.box)) continue;
        let best = null;
        for (const ca of a.cores) {
          for (const cb of b.cores) {
            const x = inter(ca, cb);
            if (x && x.w > 1 && x.h > 1 && (!best || area(x) > area(best.x))) best = { x, ca, cb };
          }
        }
        if (!best) continue;
        const { x, ca, cb } = best;
        // Smallest move that separates the two core boxes, plus 2px air.
        const moveX = x.w + 2;
        const moveY = x.h + 2;
        const bCenter = { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 };
        const aCenter = { x: ca.x + ca.w / 2, y: ca.y + ca.h / 2 };
        let hint;
        if (moveY <= moveX) {
          const down = bCenter.y >= aCenter.y;
          hint = `move "${b.text}" ${Math.ceil(moveY)}px ${down ? 'down' : 'up'} (or "${a.text}" ${Math.ceil(moveY)}px ${down ? 'up' : 'down'})`;
        } else {
          const right = bCenter.x >= aCenter.x;
          hint = `move "${b.text}" ${Math.ceil(moveX)}px ${right ? 'right' : 'left'} (or "${a.text}" ${Math.ceil(moveX)}px ${right ? 'left' : 'right'})`;
        }
        findings.push({
          rule: 'text-overlap',
          severity: 'error',
          message: `"${a.text}" overlaps "${b.text}"`,
          ...describe(a.el, a.box, a.text),
          related: [describe(b.el, b.box, b.text)],
          hint,
          data: { overlap: boxOut(x) },
        });
      }
    }
  }

  // ---------- rules: text-covered, text-shape-overlap ----------

  const coveredPairs = new Set();
  if (ruleOn('text-covered')) {
    for (const t of texts) {
      if (ignoredFor(t.el, 'text-covered')) continue;
      const pts = t.cores.flatMap((c) => grid(c, 6, 3));
      const hits = new Map();
      let tested = 0;
      for (const p of pts) {
        const st = stack(p);
        const ti = st.findIndex((e) => textOwns(t, e));
        if (ti < 0) continue;
        tested++;
        for (let k = 0; k < ti; k++) {
          const e = st[k];
          if (related(e, t.el)) continue;
          if (texts.some((o) => o.el === e)) continue;
          if (!opaqueAt(e)) continue;
          hits.set(e, (hits.get(e) || 0) + 1);
          break;
        }
      }
      for (const [e, n] of hits) {
        if (!tested || n / tested < 0.25) continue;
        coveredPairs.add(t.el);
        const eb = rectOf(e.getBoundingClientRect());
        findings.push({
          rule: 'text-covered',
          severity: 'error',
          message: `"${t.text}" is painted under ${e.localName}; ${Math.round((100 * n) / tested)}% of it is hidden`,
          ...describe(t.el, t.box, t.text),
          related: [describe(e, eb)],
          hint: isSvg(e)
            ? `move the text after the ${e.localName} in the SVG source (later elements paint on top), or move it off the shape`
            : `raise the text above the box (z-index or source order), or move it off the box`,
          data: { hiddenFraction: R(n / tested) },
        });
      }
    }
  }

  if (ruleOn('text-shape-overlap')) {
    const filled = [
      // Paths are left out: on maps and charts, labels cross region edges all the time.
      ...nodeShapes
        .filter((s) => s.fillA >= 0.15 && s.tag !== 'path' && !inCrowd(s.el))
        .map((s) => ({ el: s.el, box: s.box, svg: s.geometry })),
      ...nodeBoxes.filter((b) => b.bgA >= 0.15 || b.replaced).map((b) => ({ el: b.el, box: b.box, svg: false })),
    ];
    for (const t of texts) {
      if (ignoredFor(t.el, 'text-shape-overlap') || coveredPairs.has(t.el)) continue;
      // A haloed label is drawn to sit on top of things.
      if (t.halo && t.halo.a >= 0.6) continue;
      const tArea = t.cores.reduce((s, c) => s + area(c), 0);
      for (const f of filled) {
        if (related(f.el, t.el)) continue;
        if (!t.cores.some((c) => inter(c, f.box))) continue;
        if (area(f.box) < 9) continue;
        const pts = t.cores.flatMap((c) => grid(c, 8, 3));
        let inside = 0;
        for (const p of pts) {
          let hit;
          if (f.svg) {
            const lp = toLocal(f.el, p);
            hit = lp ? f.el.isPointInFill(lp) : contains(f.box, p);
          } else hit = contains(f.box, p);
          if (hit) inside++;
        }
        const frac = inside / pts.length;
        if (frac <= 0.1 || frac >= 0.9) continue;
        // A shape much smaller than the label poking into it is usually a marker
        // dot next to its own label; report it, but say which way to move.
        const fc = { x: f.box.x + f.box.w / 2, y: f.box.y + f.box.h / 2 };
        const tc = { x: t.box.x + t.box.w / 2, y: t.box.y + t.box.h / 2 };
        const dir =
          Math.abs(tc.x - fc.x) / (f.box.w + t.box.w) > Math.abs(tc.y - fc.y) / (f.box.h + t.box.h)
            ? tc.x > fc.x ? 'right' : 'left'
            : tc.y > fc.y ? 'down' : 'up';
        findings.push({
          rule: 'text-shape-overlap',
          severity: 'warning',
          message: `"${t.text}" sits across the edge of ${f.el.localName} (${Math.round(frac * 100)}% inside)`,
          ...describe(t.el, t.box, t.text),
          related: [describe(f.el, f.box)],
          hint: `move the label fully inside the shape or fully outside it (try ${dir}), or enlarge the shape to fit the text`,
          data: { insideFraction: R(frac), textArea: R(tArea) },
        });
      }
    }
  }

  // ---------- rule: text-clipped ----------

  if (ruleOn('text-clipped')) {
    for (const t of texts) {
      if (ignoredFor(t.el, 'text-clipped')) continue;
      let clipper = null;
      let clip = null;
      // An HTML element clips its own text, so start the walk at the element itself.
      for (let n = t.svg ? t.el.parentElement : t.el; n && n.nodeType === 1; n = n.parentElement) {
        if (n === document.documentElement || n === document.body) break;
        if (isSvg(n)) {
          if (n.localName !== 'svg' && n.localName !== 'foreignObject') continue;
          const ov = cs(n).overflow;
          if (ov === 'visible' || ov === 'auto') continue;
          clipper = n;
          clip = rectOf(n.getBoundingClientRect());
          break;
        }
        const s = cs(n);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.overflow === 'clip') {
          const r = n.getBoundingClientRect();
          clipper = n;
          clip = {
            x: r.left + n.clientLeft,
            y: r.top + n.clientTop,
            w: n.clientWidth || r.width,
            h: n.clientHeight || r.height,
          };
          break;
        }
      }
      const checks = [];
      if (clip) checks.push({ el: clipper, box: clip, what: clipper.localName === 'svg' ? 'the SVG viewBox' : clipper.localName });
      if (docIsSvg) checks.push({ el: document.documentElement, box: canvasOf(t.el), what: 'the SVG viewBox' });
      checks.push({ el: null, box: page, what: 'the page' });
      for (const c of checks) {
        const out = { left: 0, right: 0, top: 0, bottom: 0 };
        for (const r of t.rects) {
          out.left = Math.max(out.left, c.box.x - r.x);
          out.top = Math.max(out.top, c.box.y - r.y);
          out.right = Math.max(out.right, r.x + r.w - (c.box.x + c.box.w));
          out.bottom = Math.max(out.bottom, r.y + r.h - (c.box.y + c.box.h));
        }
        // Allow the font's internal leading to poke out a little vertically.
        const vSlack = 0.2 * t.fs + 1;
        const sides = [];
        if (out.left > 1.5) sides.push(['left', out.left]);
        if (out.right > 1.5) sides.push(['right', out.right]);
        if (out.top > vSlack) sides.push(['top', out.top]);
        if (out.bottom > vSlack) sides.push(['bottom', out.bottom]);
        if (!sides.length) continue;
        const desc = sides.map(([s, v]) => `${Math.ceil(v)}px past the ${s}`).join(', ');
        const [side, amount] = sides.sort((a, b) => b[1] - a[1])[0];
        const away = { left: 'right', right: 'left', top: 'down', bottom: 'up' }[side];
        const hint =
          c.what === 'the SVG viewBox'
            ? `move it ${Math.ceil(amount) + 2}px ${away}, or grow the viewBox on the ${side}`
            : c.what === 'the page'
              ? `move it ${Math.ceil(amount) + 2}px ${away}`
              : `shorten the text, let it wrap, or make the ${c.what} ${Math.ceil(amount) + 2}px ${side === 'left' || side === 'right' ? 'wider' : 'taller'}`;
        findings.push({
          rule: 'text-clipped',
          severity: 'error',
          message: `"${t.text}" is cut off by ${c.what} (${desc})`,
          ...describe(t.el, t.box, t.text),
          related: c.el && c.el !== t.el ? [describe(c.el, c.box)] : [],
          hint,
          data: { outside: { left: R(out.left), right: R(out.right), top: R(out.top), bottom: R(out.bottom) } },
        });
        break;
      }
    }
  }

  // ---------- rule: off-canvas ----------

  if (ruleOn('off-canvas')) {
    const clippedByAncestor = (el) => {
      for (let n = el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
        if (n.hasAttribute('clip-path') || n.hasAttribute('mask')) return true;
        const s = cs(n);
        if (s.clipPath && s.clipPath !== 'none') return true;
        if (s.maskImage && s.maskImage !== 'none') return true;
      }
      return false;
    };
    const report = (el, box, canvas, what) => {
      if (ignoredFor(el, 'off-canvas')) return;
      if (box.w <= 0 && box.h <= 0) return;
      const vis = inter(box, grow(canvas, 0.5));
      const visible = vis ? area(vis) : 0;
      const total = Math.max(area(box), 1);
      // Lines have no area; measure them by length instead.
      const thin = box.w < 1 || box.h < 1;
      let outside;
      if (thin) {
        const len = Math.max(box.w, box.h);
        const inside =
          box.w < 1
            ? Math.max(0, Math.min(box.y + box.h, canvas.y + canvas.h) - Math.max(box.y, canvas.y)) *
              (box.x >= canvas.x - 0.5 && box.x <= canvas.x + canvas.w + 0.5 ? 1 : 0)
            : Math.max(0, Math.min(box.x + box.w, canvas.x + canvas.w) - Math.max(box.x, canvas.x)) *
              (box.y >= canvas.y - 0.5 && box.y <= canvas.y + canvas.h + 0.5 ? 1 : 0);
        outside = len > 0 ? 1 - inside / len : 0;
      } else outside = 1 - visible / total;
      if (outside <= 0.02) return;
      const over = {
        left: Math.max(0, canvas.x - box.x),
        right: Math.max(0, box.x + box.w - (canvas.x + canvas.w)),
        top: Math.max(0, canvas.y - box.y),
        bottom: Math.max(0, box.y + box.h - (canvas.y + canvas.h)),
      };
      const worst = Object.entries(over).sort((a, b) => b[1] - a[1])[0];
      if (worst[1] < 2) return;
      const full = outside >= 0.98;
      const away = { left: 'right', right: 'left', top: 'down', bottom: 'up' }[worst[0]];
      findings.push({
        rule: 'off-canvas',
        severity: full ? 'error' : 'warning',
        message: full
          ? `${el.localName} is entirely outside ${what}`
          : `${el.localName} sticks ${Math.ceil(worst[1])}px out of ${what} on the ${worst[0]}`,
        ...describe(el, box),
        related: [],
        hint: `move it ${Math.ceil(worst[1]) + 2}px ${away}, or enlarge ${what === 'the page' ? 'the page' : 'the viewBox'} on the ${worst[0]}`,
        data: { outsideFraction: R(outside), overflow: Object.fromEntries(Object.entries(over).map(([k, v]) => [k, R(v)])) },
      });
    };
    // Data layers (map countries, scatter dots) are cropped by the frame on purpose.
    for (const s of shapes) {
      if (s.complex) continue;
      if (inCrowd(s.el)) continue;
      if (s.fillA < 0.05 && s.strokeA < 0.05) continue;
      // Backgrounds that bleed past every edge are deliberate.
      if (area(s.box) > 1.5 * area(s.canvas)) continue;
      if (s.box.x <= s.canvas.x && s.box.y <= s.canvas.y && s.box.x + s.box.w >= s.canvas.x + s.canvas.w && s.box.y + s.box.h >= s.canvas.y + s.canvas.h) continue;
      if (clippedByAncestor(s.el)) continue;
      report(s.el, s.box, s.canvas, s.canvas === page ? 'the page' : 'the SVG viewBox');
    }
    for (const b of boxes) {
      let clipped = false;
      for (let n = b.el.parentElement; n && n !== document.body; n = n.parentElement) {
        const st = cs(n);
        if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      report(b.el, b.box, page, 'the page');
    }
  }

  // ---------- rule: dangling-connector ----------

  const markerSize = (s, ref) => {
    if (!ref) return 0;
    const id = (ref.match(/#([^"')]+)/) || [])[1];
    const mk = id ? document.getElementById(id) : null;
    const userSw = s.sw / scaleOf(s.m);
    if (!mk) return 3 * s.sw;
    const mw = parseFloat(mk.getAttribute('markerWidth') || '3');
    const mh = parseFloat(mk.getAttribute('markerHeight') || '3');
    const units = mk.getAttribute('markerUnits') === 'userSpaceOnUse' ? 1 : userSw;
    return Math.min(40, Math.max(mw, mh) * units * scaleOf(s.m));
  };

  const endsOf = (s) => {
    try {
      const len = s.el.getTotalLength();
      if (!(len > 0)) return null;
      const a = s.el.getPointAtLength(0);
      const b = s.el.getPointAtLength(len);
      if (!s.m) return null;
      return { len: len * scaleOf(s.m), start: apply(s.m, a.x, a.y), end: apply(s.m, b.x, b.y) };
    } catch {
      return null;
    }
  };

  // Does point p touch target t within tol px?
  const touches = (t, p, tol) => {
    if (distToBox(t.box, p) > tol) return false;
    if (!t.geometry) return true;
    const ring = [p];
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      ring.push({ x: p.x + tol * Math.cos(a), y: p.y + tol * Math.sin(a) });
      ring.push({ x: p.x + (tol / 2) * Math.cos(a), y: p.y + (tol / 2) * Math.sin(a) });
    }
    const st = t.el;
    const m = ctmOf(st);
    if (!m) return true;
    const inv = m.inverse();
    for (const q of ring) {
      const lp = new DOMPoint(q.x, q.y).matrixTransform(inv);
      try {
        if (st.isPointInFill(lp) || st.isPointInStroke(lp)) return true;
      } catch {
        return true;
      }
    }
    return false;
  };

  if (ruleOn('dangling-connector') && shapes.length) {
    const textTargets = texts.map((t) => ({ el: t.el, box: grow(t.box, 1), geometry: false, kind: 'text' }));
    const shapeTargets = shapes
      .filter((s) => area(s.box) < 0.4 * area(s.canvas) || s.open)
      .map((s) => ({ el: s.el, box: s.box, geometry: s.geometry, kind: s.open ? 'line' : 'node', complex: s.complex }));
    const boxTargets = nodeBoxes.map((b) => ({ el: b.el, box: b.box, geometry: false, kind: 'node' }));
    const targets = [...shapeTargets, ...boxTargets, ...textTargets];

    for (const s of shapes) {
      if (!s.geometry || !s.open || s.strokeA < 0.05 || s.sw <= 0) continue;
      if (ignoredFor(s.el, 'dangling-connector')) continue;
      const explicit = s.hint || s.markerStart || s.markerEnd;
      if (!explicit && s.complex) continue;
      const ends = endsOf(s);
      if (!ends || ends.len < 2) continue;
      if (!explicit && ends.len < 8) continue;
      const tolStart = tolerance + s.sw / 2 + markerSize(s, s.markerStart);
      const tolEnd = tolerance + s.sw / 2 + markerSize(s, s.markerEnd);
      const own = (t) => related(t.el, s.el);
      const hitAt = (p, tol, kinds) =>
        targets.find((t) => !own(t) && (!kinds || kinds.includes(t.kind)) && !(t.kind === 'node' && t.complex && !explicit) && touches(t, p, tol));
      const startHit = hitAt(ends.start, tolStart);
      const endHit = hitAt(ends.end, tolEnd);
      let floating = [];
      if (explicit) {
        if (!startHit) floating.push(['start', ends.start]);
        if (!endHit) floating.push(['end', ends.end]);
      } else {
        // Plain lines count as connectors only if one end sits on a node shape.
        const startNode = hitAt(ends.start, tolStart, ['node']);
        const endNode = hitAt(ends.end, tolEnd, ['node']);
        if (startNode && !endHit) floating.push(['end', ends.end]);
        if (endNode && !startHit) floating.push(['start', ends.start]);
      }
      if (!floating.length) continue;
      const nodeLike = targets.filter((t) => t.kind !== 'line' && !own(t));
      const near = (p) => {
        let best = null;
        for (const t of nodeLike) {
          const d = distToBox(t.box, p);
          if (!best || d < best.d) best = { t, d };
        }
        return best;
      };
      const ends2 = floating.map(([which, p]) => {
        const n = near(p);
        return {
          which,
          at: { x: R(p.x), y: R(p.y) },
          nearest: n ? { selector: selectorOf(n.t.el), distance: R(n.d), point: (({ x, y }) => ({ x: R(x), y: R(y) }))(clampToBox(n.t.box, p)) } : null,
        };
      });
      const parts = ends2.map((e) =>
        e.nearest && e.nearest.distance < 200
          ? `${e.which} at (${Math.round(e.at.x)}, ${Math.round(e.at.y)}) is ${Math.round(e.nearest.distance)}px from ${e.nearest.selector}`
          : `${e.which} at (${Math.round(e.at.x)}, ${Math.round(e.at.y)}) touches nothing`,
      );
      const hintParts = ends2.map((e) =>
        e.nearest && e.nearest.distance < 200
          ? `extend the ${e.which} to (${Math.round(e.nearest.point.x)}, ${Math.round(e.nearest.point.y)}) on ${e.nearest.selector}`
          : `point the ${e.which} at the node it belongs to, or remove the line`,
      );
      findings.push({
        rule: 'dangling-connector',
        severity: 'error',
        message: `${s.tag} ends in mid-air: ${parts.join('; ')}`,
        ...describe(s.el, s.box),
        related: ends2.filter((e) => e.nearest && e.nearest.distance < 200).map((e) => {
          const t = nodeLike.find((x) => selectorOf(x.el) === e.nearest.selector);
          return describe(t.el, t.box);
        }),
        hint: hintParts.join('; ') + ' (coordinates are page pixels; convert to SVG units if the figure is scaled)',
        data: { ends: ends2, explicit: !!explicit },
      });
    }
  }

  // ---------- rule: label-on-line ----------

  if (ruleOn('label-on-line') && lineShapes.length) {
    const sampleCache = new Map();
    const samples = (s) => {
      if (sampleCache.has(s.el)) return sampleCache.get(s.el);
      const pts = [];
      try {
        const len = s.el.getTotalLength();
        const step = Math.max(1.5 / scaleOf(s.m), len / 1500);
        for (let at = 0; at <= len; at += step) {
          const q = s.el.getPointAtLength(at);
          pts.push(apply(s.m, q.x, q.y));
        }
      } catch {}
      sampleCache.set(s.el, pts);
      return pts;
    };
    for (const t of texts) {
      if (ignoredFor(t.el, 'label-on-line')) continue;
      if (t.halo && t.halo.a >= 0.6) continue;
      for (const s of lineShapes) {
        if (ignoredFor(s.el, 'label-on-line')) continue;
        if (related(s.el, t.el)) continue;
        const cores = t.cores.map((c) => grow(c, -1)).filter((c) => c.w > 0 && c.h > 0);
        if (!cores.some((c) => inter(grow(s.box, s.sw / 2 + 0.5), c))) continue;
        const ends = s.open ? endsOf(s) : null;
        if (ends && [ends.start, ends.end].some((p) => contains(grow(t.box, tolerance + 2), p))) continue;
        const inside = samples(s).filter((p) => contains(s.canvas, p) && cores.some((c) => contains(c, p)));
        if (!inside.length) continue;
        // Visible through the label? Look at what is painted at a few of the points.
        let visible = 0;
        let checked = 0;
        for (const p of inside.filter((_, k) => k % Math.max(1, Math.floor(inside.length / 6)) === 0).slice(0, 6)) {
          const st = stack(p);
          const li = st.indexOf(s.el);
          if (li < 0) continue;
          checked++;
          const ti = st.findIndex((e) => textOwns(t, e) || e.contains(t.el));
          if (ti < 0 || li < ti) {
            visible++;
            continue;
          }
          let hidden = false;
          for (let k = ti; k < li; k++) {
            if (opaqueAt(st[k])) {
              hidden = true;
              break;
            }
          }
          if (!hidden) visible++;
        }
        // Never hit: the line is clipped away or buried under something at the label.
        if (!visible) continue;
        const crossing = inside.length * 1.5;
        findings.push({
          rule: 'label-on-line',
          severity: 'warning',
          message: `${s.tag} runs through "${t.text}"`,
          ...describe(t.el, t.box, t.text),
          related: [describe(s.el, s.box)],
          hint: t.svg
            ? `move the label off the line, or give it a halo: stroke="<background color>" stroke-width="3" paint-order="stroke"`
            : `move the label off the line, or give the label an opaque background`,
          data: { approxCrossingPx: R(crossing) },
        });
      }
    }
  }

  // ---------- data for the contrast pass ----------

  const contrastItems = [];
  const coreOf = (r, fs) => {
    const top = Math.min(0.2 * fs, r.h * 0.22);
    const bot = Math.min(0.14 * fs, r.h * 0.16);
    const side = Math.min(0.05 * fs, r.w * 0.1);
    return { x: r.x + side, y: r.y + top, w: r.w - 2 * side, h: r.h - top - bot };
  };
  const haloOf = (st, m) => {
    const c = parseColor(st.stroke);
    const sw = parseFloat(st.strokeWidth) * scaleOf(m);
    return c && c.a > 0 && sw >= 1.5 && /^stroke/.test(st.paintOrder.trim())
      ? { ...c, a: c.a * parseFloat(st.strokeOpacity) }
      : null;
  };
  if (ruleOn('low-contrast')) {
    for (const t of texts) {
      if (ignoredFor(t.el, 'low-contrast')) continue;
      // SVG text can mix fills across tspans; measure each run with its own fill.
      let runs;
      if (t.svg) {
        const leaves = [...t.el.querySelectorAll('tspan')].filter(
          (x) => !x.querySelector('tspan') && x.textContent.trim(),
        );
        const loose = [...t.el.childNodes].some((n) => n.nodeType === 3 && n.data.trim());
        const m = ctmOf(t.el);
        runs = (leaves.length ? leaves : [t.el]).map((el) => ({ el, rect: rectOf(el.getBoundingClientRect()) }));
        if (leaves.length && loose) runs.push({ el: t.el, rect: t.box });
        runs = runs.map((r) => {
          const st = cs(r.el);
          const fs = parseFloat(st.fontSize) * scaleOf(m);
          const c = parseColor(st.fill);
          return {
            ...r,
            text: r.el === t.el ? t.text : snippet(r.el.textContent),
            fs,
            weight: parseInt(st.fontWeight, 10) || 400,
            fg: c ? { ...c, a: c.a * parseFloat(st.fillOpacity) * opacityChain(r.el) } : null,
            halo: haloOf(st, m),
            cores: r.el === t.el ? t.cores : [coreOf(r.rect, fs)],
          };
        });
      } else {
        const c = parseColor(t.color);
        const op = opacityChain(t.el);
        runs = [{ el: t.el, rect: t.box, text: t.text, fs: t.fs, weight: t.weight, fg: c ? { ...c, a: c.a * op } : null, halo: null, cores: t.cores }];
      }
      for (const r of runs) {
        if (!r.fg || r.fg.a < 0.1) continue;
        if (r.rect.w < 0.5 || r.rect.h < 0.5) continue;
        const op = opacityChain(r.el);
        contrastItems.push({
          selector: selectorOf(r.el),
          text: r.text,
          box: boxOut(r.rect),
          cores: r.cores.map(boxOut),
          fg: r.fg,
          halo: r.halo ? { ...r.halo, a: r.halo.a * op } : null,
          fontSize: R(r.fs),
          weight: r.weight,
        });
      }
    }
  }

  return {
    findings,
    contrastItems,
    stats: { texts: texts.length, shapes: shapes.length, boxes: boxes.length },
    isSvgDocument: docIsSvg,
  };
}

// Injected before the screenshot used for contrast: hides glyphs but keeps
// everything else (including the boxes and shapes behind the text).
export function hideText() {
  const css =
    'svg text, svg tspan, svg textPath { fill: transparent !important; stroke: transparent !important; }' +
    ' :not(svg *) { -webkit-text-fill-color: transparent !important; text-shadow: none !important;' +
    ' -webkit-text-stroke: 0 !important; caret-color: transparent !important; text-decoration-color: transparent !important; }';
  const ns = document.documentElement.namespaceURI;
  const st = document.createElementNS(ns || 'http://www.w3.org/1999/xhtml', 'style');
  st.setAttribute('data-figlint', '');
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);
}

export function showText() {
  for (const el of document.querySelectorAll('style[data-figlint]')) el.remove();
}

// Makes everything hit-testable so elementsFromPoint reports what is painted.
export function enableHitTesting() {
  const css =
    'svg, svg * { pointer-events: visiblePainted !important; } :not(svg *) { pointer-events: auto !important; }';
  const ns = document.documentElement.namespaceURI;
  const st = document.createElementNS(ns || 'http://www.w3.org/1999/xhtml', 'style');
  st.setAttribute('data-figlint-hit', '');
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);
}

// Reads a PNG (base64) and returns the dominant background color under each item.
export async function sampleBackgrounds({ png, items, dpr, base }) {
  const blob = await (await fetch('data:image/png;base64,' + png)).blob();
  const bmp = await createImageBitmap(blob);
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const out = [];
  for (const it of items) {
    const bins = new Map();
    let n = 0;
    for (const c of it.cores) {
      const x0 = Math.max(0, Math.floor(c.x * dpr));
      const y0 = Math.max(0, Math.floor(c.y * dpr));
      const x1 = Math.min(bmp.width, Math.ceil((c.x + c.width) * dpr));
      const y1 = Math.min(bmp.height, Math.ceil((c.y + c.height) * dpr));
      if (x1 <= x0 || y1 <= y0) continue;
      const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      const stride = Math.max(1, Math.floor(data.length / 4 / 4000));
      for (let i = 0; i < data.length; i += 4 * stride) {
        const a = data[i + 3] / 255;
        const r = data[i] * a + base.r * (1 - a);
        const g = data[i + 1] * a + base.g * (1 - a);
        const b = data[i + 2] * a + base.b * (1 - a);
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const bin = bins.get(key) || { r: 0, g: 0, b: 0, n: 0 };
        bin.r += r;
        bin.g += g;
        bin.b += b;
        bin.n++;
        bins.set(key, bin);
        n++;
      }
    }
    if (!n) {
      out.push(null);
      continue;
    }
    const top = [...bins.values()].sort((a, b) => b.n - a.n)[0];
    out.push({ r: top.r / top.n, g: top.g / top.n, b: top.b / top.n, a: 1, share: top.n / n });
  }
  return out;
}

// Draws numbered boxes over a screenshot for --shot.
export async function annotate({ png, marks, dpr, base }) {
  const blob = await (await fetch('data:image/png;base64,' + png)).blob();
  const bmp = await createImageBitmap(blob);
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d');
  if (base) {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, cv.width, cv.height);
  }
  ctx.drawImage(bmp, 0, 0);
  ctx.scale(dpr, dpr);
  marks.forEach((m) => {
    const color = m.severity === 'error' ? '#e5243b' : '#f08c00';
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.setLineDash(m.severity === 'error' ? [] : [5, 3]);
    for (const b of m.boxes) ctx.strokeRect(b.x - 2, b.y - 2, b.width + 4, b.height + 4);
    for (const p of m.points || []) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const b = m.boxes[0];
    const label = String(m.index);
    ctx.font = 'bold 12px sans-serif';
    const w = ctx.measureText(label).width + 8;
    const lx = Math.max(0, b.x - 2);
    const ly = Math.max(0, b.y - 18);
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly, w, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 4, ly + 12);
  });
  const out = await cv.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await out.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
