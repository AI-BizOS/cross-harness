// Runs inside the page: the web UI as it is drawn right now, as a flat list of shapes
// and text runs with their exact geometry and computed colours. Contents of scrolling
// areas are given in the area's own coordinates, with the area's scroll offset, so a
// scroll moves one group instead of changing every shape inside it.
export function captureScene() {
  const round = (value) => Math.round(value * 2) / 2;
  const view = { x: 0, y: 0, w: innerWidth, h: innerHeight };
  const ctx = document.createElement('canvas').getContext('2d');
  const fontCache = new Map();
  const out = { shapes: [], scrollers: {} };

  function color(value) {
    const match = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const alpha = parts.length > 3 ? parts[3] : 1;
    if (!alpha) return null;
    const hex = `#${parts.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
    return { hex, alpha: Math.round(alpha * 1000) / 1000 };
  }
  function family(value) {
    return /mono/i.test(value) ? 'mono' : 'sans';
  }
  function fontInfo(cs) {
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (!fontCache.has(font)) {
      ctx.font = font;
      const m = ctx.measureText('Hg');
      fontCache.set(font, { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent, ellipsis: ctx.measureText('…').width, font });
    }
    return fontCache.get(font);
  }
  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x;
    const h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }
  function path(el) {
    const parts = [];
    for (let node = el; node && node !== document.body; node = node.parentElement) parts.unshift(node.id ? `#${node.id}` : `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}`);
    return parts.join('>');
  }

  // A shape inside a scrolling area is stored relative to the area's content. `clip`
  // (everything that hides it now) decides whether it is drawn; `inner` (only what
  // clips it inside its scrolling area) is the clip it keeps.
  function push(shape, state) {
    const rect = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    if (!intersect(rect, state.clip)) return;
    const kept = state.inner && intersect(rect, state.inner);
    const offset = state.scroller ? state.scroller.top : 0;
    if (state.inner && !(kept && kept.x <= rect.x && kept.y <= rect.y && kept.x + kept.w >= rect.x + rect.w && kept.y + kept.h >= rect.y + rect.h)) {
      shape.clip = { x: round(state.inner.x), y: round(state.inner.y + offset), w: round(state.inner.w), h: round(state.inner.h) };
    }
    if (state.scroller) {
      shape.y = round(shape.y + offset);
      shape.scroller = state.scroller.id;
    }
    shape.layer = state.layer;
    out.shapes.push(shape);
  }

  function radius(cs, r) {
    const raw = cs.borderTopLeftRadius;
    const value = raw.endsWith('%') ? (parseFloat(raw) / 100) * Math.min(r.width, r.height) : parseFloat(raw) || 0;
    return round(Math.min(value, r.width / 2, r.height / 2));
  }

  function box(el, cs, r, state, opacity) {
    if (r.width < 0.5 || r.height < 0.5) return;
    const fill = color(cs.backgroundColor);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((side) => ({ width: cs[`border${side}Style`] === 'none' ? 0 : parseFloat(cs[`border${side}Width`]) || 0, color: color(cs[`border${side}Color`]) })).map((side) => (side.color && side.width ? side : { width: 0, color: null }));
    const shadow = cs.boxShadow && cs.boxShadow !== 'none';
    if (!fill && !sides.some((side) => side.width) && !shadow) return;
    push(
      {
        type: 'box',
        x: round(r.left),
        y: round(r.top),
        w: round(r.width),
        h: round(r.height),
        rx: radius(cs, r),
        fill: fill && { ...fill, alpha: fill.alpha * opacity },
        sides: sides.map((side) => (side.width ? { width: side.width, hex: side.color.hex, alpha: side.color.alpha * opacity } : null)),
        shadow: Boolean(shadow),
        pulse: el.classList.contains('busy') || undefined,
      },
      state,
    );
  }

  function textRun(text, x, baseline, width, cs, info, state, opacity, extra = {}) {
    const fill = color(cs.color);
    if (!fill || !text.trim()) return;
    const size = parseFloat(cs.fontSize);
    push(
      {
        type: 'text',
        text,
        x: round(x),
        y: round(baseline - info.ascent),
        w: round(width),
        h: round(info.ascent + info.descent),
        base: round(info.ascent),
        font: family(cs.fontFamily),
        size,
        weight: Number(cs.fontWeight) >= 600 ? 700 : Number(cs.fontWeight) >= 500 ? 500 : 400,
        italic: cs.fontStyle === 'italic' || undefined,
        strike: cs.textDecorationLine.includes('line-through') || undefined,
        hex: extra.hex || fill.hex,
        alpha: (extra.alpha ?? fill.alpha) * opacity,
      },
      state,
    );
  }

  function textNode(node, cs, state, opacity) {
    const data = node.data;
    if (!data.trim()) return;
    const info = fontInfo(cs);
    const range = document.createRange();
    const lines = [];
    let line = null;
    for (let i = 0; i < data.length; ) {
      const code = data.codePointAt(i);
      const length = code > 0xffff ? 2 : 1;
      const char = data.slice(i, i + length);
      range.setStart(node, i);
      range.setEnd(node, i + length);
      i += length;
      if (char === '\n') {
        if (line) lines.push(line);
        line = null;
        continue;
      }
      const rects = range.getClientRects();
      if (!rects.length) continue;
      const rect = rects[rects.length - 1];
      if (!rect.width && char !== ' ') continue;
      if (line && Math.abs(rect.top - line.top) < 2 && rect.left >= line.rights.at(-1) - 1.5) {
        line.text += char;
        line.rights.push(rect.right);
      } else {
        if (line) lines.push(line);
        line = { text: char, left: rect.left, top: rect.top, rights: [rect.right] };
      }
    }
    if (line) lines.push(line);
    const parentRect = node.parentElement.getBoundingClientRect();
    const ellipsis = cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible';
    const contentRight = parentRect.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    const upper = cs.textTransform === 'uppercase';
    for (const item of lines) {
      let text = item.text.replace(/\s+$/, '');
      let right = item.rights[text.length - 1] ?? item.rights.at(-1);
      if (ellipsis && right > contentRight + 0.5) {
        let keep = text.length;
        while (keep > 0 && item.rights[keep - 1] > contentRight - info.ellipsis) keep--;
        text = `${text.slice(0, keep).replace(/\s+$/, '')}…`;
        right = (item.rights[keep - 1] ?? item.left) + info.ellipsis;
      }
      const lead = text.length - text.trimStart().length;
      const left = lead ? item.rights[lead - 1] : item.left;
      textRun(upper ? text.trim().toUpperCase() : text.trim(), left, item.top + info.ascent, right - left, cs, info, state, opacity);
    }
  }

  // Form controls draw their value themselves; it is not in the DOM as text.
  function control(el, cs, r, state, opacity) {
    const info = fontInfo(cs);
    const left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const top = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
    const own = { x: r.left, y: r.top, w: r.width, h: r.height };
    const inside = { ...state, clip: intersect(state.clip, own) || state.clip, inner: state.inner ? intersect(state.inner, own) || own : own };
    if (el.tagName === 'SELECT') {
      const label = el.selectedOptions[0]?.textContent || '';
      ctx.font = info.font;
      textRun(label, left, r.top + r.height / 2 + (info.ascent - info.descent) / 2, ctx.measureText(label).width, cs, info, inside, opacity);
      const fill = color(cs.color);
      push({ type: 'chevron', x: round(r.right - 18), y: round(r.top + r.height / 2 - 3), w: 8, h: 5, hex: fill.hex, alpha: fill.alpha * opacity }, state);
      return;
    }
    const value = el.value;
    const placeholder = !value && el.placeholder;
    const text = value || el.placeholder || '';
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    ctx.font = info.font;
    const colorOf = placeholder ? color(getComputedStyle(el, '::placeholder').color) : null;
    text.split('\n').forEach((row, i) => {
      const baseline = top - el.scrollTop + i * lineHeight + (lineHeight - (info.ascent + info.descent)) / 2 + info.ascent;
      textRun(row, left, baseline, ctx.measureText(row).width, cs, info, inside, opacity, colorOf ? { hex: colorOf.hex, alpha: colorOf.alpha } : {});
    });
  }

  function walk(el, state, opacity) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const busy = el.classList.contains('busy');
    const alpha = busy ? opacity : opacity * Number(cs.opacity);
    if (alpha <= 0.01) return;
    const r = el.getBoundingClientRect();
    let current = state;
    if (el.tagName === 'DIALOG' && el.open) {
      const backdrop = color(getComputedStyle(el, '::backdrop').backgroundColor);
      current = { ...state, layer: 2, clip: view, inner: null, scroller: null };
      if (backdrop) push({ type: 'box', x: 0, y: 0, w: view.w, h: view.h, rx: 0, fill: backdrop, sides: [null, null, null, null], shadow: false }, current);
    } else if ((cs.position === 'fixed' || cs.position === 'absolute') && Number(cs.zIndex) > 0) {
      current = { ...state, layer: Math.max(state.layer, 1) };
    }
    box(el, cs, r, current, alpha);
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'text')) return control(el, cs, r, current, alpha);
    if (el.tagName === 'SUMMARY') {
      const info = fontInfo(cs);
      const glyph = el.parentElement.open ? '▾' : '▸';
      textRun(glyph, r.left, r.top + (parseFloat(cs.lineHeight) - (info.ascent + info.descent)) / 2 + info.ascent, info.ascent * 0.8, cs, info, current, alpha);
    }
    let inner = current;
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const padding = {
        x: r.left + parseFloat(cs.borderLeftWidth),
        y: r.top + parseFloat(cs.borderTopWidth),
        w: r.width - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth),
        h: r.height - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth),
      };
      const clip = intersect(current.clip, padding);
      if (!clip) return;
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        // A scrolling area: its contents move as one group, clipped to the area.
        const id = path(el);
        out.scrollers[id] = { top: el.scrollTop, clip: { x: round(clip.x), y: round(clip.y), w: round(clip.w), h: round(clip.h) }, layer: current.layer };
        inner = { ...current, clip, inner: null, scroller: { id, top: el.scrollTop } };
      } else {
        inner = { ...current, clip, inner: current.inner ? intersect(current.inner, padding) || padding : padding };
      }
    }
    // A closed <details> shows only its summary; the rest keeps stale geometry.
    const closed = el.tagName === 'DETAILS' && !el.open;
    for (const node of el.childNodes) {
      if (closed && node.tagName !== 'SUMMARY') continue;
      if (node.nodeType === Node.TEXT_NODE) textNode(node, cs, inner, alpha);
      else if (node.nodeType === Node.ELEMENT_NODE) walk(node, inner, alpha);
    }
  }

  walk(document.documentElement, { layer: 0, clip: view, inner: null, scroller: null }, 1);
  out.background = color(getComputedStyle(document.body).backgroundColor);
  return out;
}
