// Captured web UI frames (web-capture.js) → one animated SVG for a README (<img>): no
// script, no external resources, only inline CSS. Every shape is drawn once and shown
// while the page showed it; a scrolling area's contents move as one group; colours
// follow the viewer's light or dark theme, as the web UI does; a pointer shows where
// the person clicked.

const MARGIN = 18;
const BAR = 38;
const FONTS = {
  sans: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",Helvetica,Arial,sans-serif',
  mono: 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Noto Sans Mono CJK SC",monospace',
};
const CHROME = {
  light: { frame: '#e9e9ed', border: '#d0d0d7', url: '#ffffff', urlText: '#5f5f6b', card: 0.08 },
  dark: { frame: '#26272c', border: '#3a3b42', url: '#1b1c20', urlText: '#a0a0ab', card: 0.35 },
};

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (value) => Number(Number(value).toFixed(2));
const pct = (t, total) => `${Number(((t / total) * 100).toFixed(3))}%`;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Colour pairs (light, dark) become classes, so one drawing serves both themes. */
function palette() {
  const tokens = new Map();
  const rule = (name, property, color) => `.${name}{${property}:${color.hex}${color.alpha < 0.999 ? `;${property}-opacity:${Number(color.alpha.toFixed(3))}` : ''}}`;
  const token = (property, light, dark) => {
    const key = `${property}|${light.hex}/${light.alpha}|${dark.hex}/${dark.alpha}`;
    if (!tokens.has(key)) tokens.set(key, { name: `${property === 'fill' ? 'f' : 'k'}${tokens.size.toString(36)}`, property, light, dark });
    return tokens.get(key).name;
  };
  return {
    fill: (light, dark = light) => token('fill', light, dark),
    stroke: (light, dark = light) => token('stroke', light, dark),
    css() {
      const all = [...tokens.values()];
      const dark = all.filter((t) => t.light.hex !== t.dark.hex || t.light.alpha !== t.dark.alpha).map((t) => rule(t.name, t.property, t.dark));
      return [...all.map((t) => rule(t.name, t.property, t.light)), `@media (prefers-color-scheme:dark){${dark.join('')}}`];
    },
  };
}

// One shape in both themes → a theme-free description with colour classes. The two
// captures walk the same page, so shapes pair up by position in the list.
function describe(light, dark, colors) {
  const twin = dark && dark.type === light.type && dark.x === light.x && dark.y === light.y && dark.w === light.w && dark.h === light.h ? dark : light;
  const { layer, scroller, ...item } = light;
  if (light.type === 'box') {
    item.fill = light.fill ? colors.fill(light.fill, twin.fill || light.fill) : null;
    item.sides = light.sides.map((side, i) => (side ? { width: side.width, k: colors.stroke(side, twin.sides?.[i] || side), f: colors.fill(side, twin.sides?.[i] || side) } : null));
  } else {
    const paint = light.type === 'chevron' ? colors.stroke : colors.fill;
    item.paint = paint({ hex: light.hex, alpha: light.alpha }, { hex: twin.hex, alpha: twin.alpha });
    delete item.hex;
    delete item.alpha;
  }
  return { item, layer, scroller };
}

function boxSvg(shape, clipFor) {
  const { x, y, w, h, rx } = shape;
  const parts = [];
  const r = rx ? ` rx="${rx}"` : '';
  if (shape.shadow) parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}"${r} filter="url(#sh)" class="shadow"/>`);
  if (shape.fill) parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}"${r} class="${shape.fill}${shape.pulse ? ' pulse' : ''}"/>`);
  const drawn = shape.sides.filter(Boolean);
  if (drawn.length === 4 && drawn.every((side) => side.width === drawn[0].width && side.k === drawn[0].k)) {
    const s = drawn[0].width;
    parts.push(`<rect x="${num(x + s / 2)}" y="${num(y + s / 2)}" width="${num(w - s)}" height="${num(h - s)}"${rx ? ` rx="${num(Math.max(0, rx - s / 2))}"` : ''} fill="none" class="${drawn[0].k}" stroke-width="${s}"/>`);
  } else if (drawn.length) {
    // Different sides: strips inside the box, cut to its rounded outline.
    const [top, right, bottom, left] = shape.sides;
    const strips = [
      top && `<rect x="${x}" y="${y}" width="${w}" height="${top.width}" class="${top.f}"/>`,
      right && `<rect x="${num(x + w - right.width)}" y="${y}" width="${right.width}" height="${h}" class="${right.f}"/>`,
      bottom && `<rect x="${x}" y="${num(y + h - bottom.width)}" width="${w}" height="${bottom.width}" class="${bottom.f}"/>`,
      left && `<rect x="${x}" y="${y}" width="${left.width}" height="${h}" class="${left.f}"/>`,
    ].filter(Boolean);
    parts.push(rx ? `<g clip-path="url(#${clipFor({ x, y, w, h, rx })})">${strips.join('')}</g>` : strips.join(''));
  }
  return parts.join('');
}

function shapeSvg(shape, clipFor) {
  if (shape.type === 'box') return boxSvg(shape, clipFor);
  if (shape.type === 'text') {
    const fit = [...shape.text].length > 1 ? ` textLength="${shape.w}"` : '';
    const style = `${shape.weight !== 400 ? ` font-weight="${shape.weight}"` : ''}${shape.italic ? ' font-style="italic"' : ''}${shape.strike ? ' text-decoration="line-through"' : ''}`;
    return `<text x="${shape.x}" y="${num(shape.y + shape.base)}" class="${shape.font === 'mono' ? 'm' : 's'} ${shape.paint}" font-size="${shape.size}"${style}${fit}>${esc(shape.text)}</text>`;
  }
  if (shape.type === 'chevron') return `<path d="M${shape.x} ${shape.y}l4 4 4-4" fill="none" class="${shape.paint}" stroke-width="1.5"/>`;
  return '';
}

// Paint order that agrees with every frame: a shape drawn before an overlapping
// shape in any frame stays before it.
function paintOrder(keys, frameLists, boxes) {
  const index = new Map(keys.map((key, i) => [key, i]));
  const after = keys.map(() => new Set());
  const before = keys.map(() => 0);
  for (const list of frameLists) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = index.get(list[i]);
        const b = index.get(list[j]);
        if (a === b || after[a].has(b) || after[b].has(a) || !overlaps(boxes[a], boxes[b])) continue;
        after[a].add(b);
        before[b]++;
      }
    }
  }
  const order = [];
  const done = new Set();
  const ready = keys.map((_, i) => i).filter((i) => before[i] === 0);
  while (order.length < keys.length) {
    // Two shapes swapped between frames: the earliest one goes first.
    if (!ready.length) ready.push(keys.findIndex((_, i) => !done.has(i)));
    ready.sort((a, b) => a - b);
    const i = ready.shift();
    if (done.has(i)) continue;
    done.add(i);
    order.push(i);
    for (const j of after[i]) if (--before[j] <= 0 && !done.has(j)) ready.push(j);
  }
  return order;
}

/**
 * @param {{t:number, light:object, dark:object}[]} frames
 * @param {{end:number, width:number, height:number, pointer:{t,x,y}[], clicks:{t,x,y}[], url:string, label:string}} options
 */
export function webSvg(frames, { end, width, height, pointer, clicks, url, label }) {
  const total = end;
  const css = [];
  const defs = [];
  const colors = palette();
  let serial = 0;
  const name = (prefix) => `${prefix}${(serial++).toString(36)}`;
  const clips = new Map();
  const clipFor = (rect) => {
    const key = JSON.stringify(rect);
    if (!clips.has(key)) {
      const id = name('c');
      clips.set(key, id);
      defs.push(`<clipPath id="${id}"><rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}"${rect.rx ? ` rx="${rect.rx}"` : ''}/></clipPath>`);
    }
    return clips.get(key);
  };
  const visibility = (intervals) => {
    const id = name('v');
    const stops = [];
    let first = false;
    for (const [from, to] of intervals) {
      if (from <= 0) first = true;
      else stops.push(`${pct(from, total)}{opacity:1}`);
      if (to < total) stops.push(`${pct(to, total)}{opacity:0}`);
    }
    css.push(`@keyframes ${id}{0%{opacity:${first ? 1 : 0}}${stops.join('')}}`);
    return id;
  };
  // The stretches of time covered by a set of frames (by index).
  const spans = (indices) => {
    const list = [];
    for (const f of indices) {
      const from = frames[f].t;
      const to = f + 1 < frames.length ? frames[f + 1].t : total;
      const last = list.at(-1);
      if (last && last[1] === from) last[1] = to;
      else list.push([from, to]);
    }
    return list;
  };
  const always = (intervals) => intervals.length === 1 && intervals[0][0] <= 0 && intervals[0][1] >= total;
  // With reduced motion the last frame stands still: what it shows is marked as the poster.
  const poster = total - 1;
  const onPoster = (intervals) => intervals.some(([from, to]) => from <= poster && poster < to);
  const still = [];

  // Groups: the page itself, and one per scrolling area and size, per layer.
  const groups = new Map();
  frames.forEach((frame, f) => {
    const { light, dark } = frame;
    const paired = dark.shapes.length === light.shapes.length;
    light.shapes.forEach((shape, i) => {
      const described = describe(shape, paired ? dark.shapes[i] : null, colors);
      let { item } = described;
      const { layer, scroller } = described;
      let groupKey = `L${layer}`;
      if (scroller) {
        const area = light.scrollers[scroller];
        groupKey = `L${layer}|${scroller}|${JSON.stringify(area.clip)}`;
        item = { ...item, y: num(item.y - area.clip.y), clip: item.clip && { ...item.clip, y: num(item.clip.y - area.clip.y) } };
        if (!groups.has(groupKey)) groups.set(groupKey, { layer, area: area.clip, shapes: new Map(), lists: [], tops: new Map() });
        groups.get(groupKey).tops.set(f, area.top);
      } else if (!groups.has(groupKey)) groups.set(groupKey, { layer, shapes: new Map(), lists: [] });
      const group = groups.get(groupKey);
      const key = JSON.stringify(item);
      if (!group.shapes.has(key)) group.shapes.set(key, { item, frames: [] });
      const entry = group.shapes.get(key);
      if (entry.frames.at(-1) !== f) entry.frames.push(f);
      (group.lists[f] ||= []).push(key);
    });
  });

  const body = [];
  const ordered = [...groups.entries()].sort(([a, ga], [b, gb]) => ga.layer - gb.layer || Number(Boolean(ga.area)) - Number(Boolean(gb.area)) || a.localeCompare(b));
  for (const [, group] of ordered) {
    const keys = [...group.shapes.keys()];
    const boxes = keys.map((key) => {
      const { item } = group.shapes.get(key);
      return { x: item.x, y: item.y, w: item.w, h: item.h };
    });
    const inner = [];
    for (const i of paintOrder(keys, group.lists.filter(Boolean), boxes)) {
      const { item, frames: present } = group.shapes.get(keys[i]);
      let svg = shapeSvg(item, clipFor);
      if (!svg) continue;
      if (item.clip) svg = `<g clip-path="url(#${clipFor(item.clip)})">${svg}</g>`;
      const intervals = spans(present);
      inner.push(always(intervals) ? svg : `<g class="v${onPoster(intervals) ? ' p' : ''}" style="animation-name:${visibility(intervals)}">${svg}</g>`);
    }
    if (!group.area) {
      body.push(...inner);
      continue;
    }
    // A scrolling area: shown while it had this size, its contents moved by the scroll.
    const shown = [...group.tops.keys()].sort((a, b) => a - b);
    const moves = [];
    for (const f of shown) {
      const value = `transform:translateY(${num(group.area.y - group.tops.get(f))}px)`;
      if (moves.at(-1)?.value !== value) moves.push({ t: frames[f].t, value });
    }
    const scroll = name('s');
    css.push(`@keyframes ${scroll}{${moves.map((m, i) => `${i ? pct(m.t, total) : '0%'}{${m.value}}`).join('')}}`);
    still.push(`.${scroll}{${moves.filter((m) => m.t <= poster).at(-1).value}!important}`);
    const clipped = `<g clip-path="url(#${clipFor(group.area)})"><g class="scroll ${scroll}" style="animation-name:${scroll};${moves[0].value}">${inner.join('')}</g></g>`;
    const intervals = spans(shown);
    body.push(always(intervals) ? clipped : `<g class="v${onPoster(intervals) ? ' p' : ''}" style="animation-name:${visibility(intervals)}">${clipped}</g>`);
  }

  // The pointer glides between the places it was moved to; a ring shows each click.
  const place = (p) => `transform:translate(${num(p.x)}px,${num(p.y)}px)`;
  css.push(`@keyframes ptr{0%{${place(pointer[0])}}${pointer.map((p) => `${pct(Math.min(p.t, total), total)}{${place(p)}}`).join('')}100%{${place(pointer.at(-1))}}}`);
  const rings = clicks.map((c) => {
    const id = name('r');
    css.push(`@keyframes ${id}{0%,${pct(c.t, total)}{opacity:0;transform:scale(.2)}${pct(c.t + 1, total)}{opacity:.55;transform:scale(.2)}${pct(Math.min(total, c.t + 450), total)}{opacity:0;transform:scale(1)}100%{opacity:0}}`);
    return `<circle cx="${num(c.x)}" cy="${num(c.y)}" r="16" class="ring" style="animation-name:${id};transform-origin:${num(c.x)}px ${num(c.y)}px"/>`;
  });

  const W = width + MARGIN * 2;
  const H = height + BAR + MARGIN * 2;
  const seconds = `${(total / 1000).toFixed(2)}s`;
  const { light: L, dark: D } = CHROME;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">`,
    `<title>${esc(label)}</title>`,
    '<style>',
    `.s{font-family:${FONTS.sans}}.m{font-family:${FONTS.mono}}text{white-space:pre}`,
    `.v{opacity:0;animation-duration:${seconds};animation-iteration-count:infinite;animation-timing-function:step-end}`,
    `.scroll{animation-duration:${seconds};animation-iteration-count:infinite;animation-timing-function:step-end}`,
    `.pulse{animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}`,
    `.ptr{animation:ptr ${seconds} linear infinite}`,
    `.ring{fill:none;stroke:#2f6fed;stroke-width:2.5;opacity:0;animation-duration:${seconds};animation-iteration-count:infinite;animation-timing-function:ease-out}`,
    `.frame{fill:${L.frame};stroke:${L.border}}.edge{stroke:${L.border}}.urlbox{fill:${L.url}}.url{font-family:${FONTS.sans};font-size:12.5px;fill:${L.urlText}}.shadow{fill:#000;opacity:${L.card}}`,
    `@media (prefers-color-scheme:dark){.frame{fill:${D.frame};stroke:${D.border}}.edge{stroke:${D.border}}.urlbox{fill:${D.url}}.url{fill:${D.urlText}}.shadow{opacity:${D.card}}}`,
    ...colors.css(),
    ...css,
    `@media (prefers-reduced-motion:reduce){.v,.scroll,.ptr,.ring,.pulse{animation:none!important}.v{opacity:0}.v.p{opacity:1}.ptr,.ring{display:none}${still.join('')}}`,
    '</style>',
    `<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="140%"><feGaussianBlur stdDeviation="6"/><feOffset dy="3"/></filter><filter id="wsh" x="-5%" y="-5%" width="110%" height="115%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000" flood-opacity=".22"/></filter>`,
    `<clipPath id="page"><path d="M0 0h${width}v${height - 10}a10 10 0 0 1-10 10h-${width - 20}a10 10 0 0 1-10-10z"/></clipPath>${defs.join('')}</defs>`,
    `<g transform="translate(${MARGIN} ${MARGIN})">`,
    `<rect width="${width}" height="${height + BAR}" rx="10" class="frame" filter="url(#wsh)"/>`,
    `<circle cx="20" cy="19" r="6" fill="#ff5f57"/><circle cx="40" cy="19" r="6" fill="#febc2e"/><circle cx="60" cy="19" r="6" fill="#28c840"/>`,
    `<rect x="${num(width / 2 - 170)}" y="8" width="340" height="22" rx="6" class="urlbox"/>`,
    `<text x="${num(width / 2)}" y="23.5" text-anchor="middle" class="url">${esc(url)}</text>`,
    `<g transform="translate(0 ${BAR})" clip-path="url(#page)">`,
    ...body,
    ...rings,
    `<g class="ptr"><path d="M0 0v17l4.4-4.2 2.9 6.6 2.9-1.3-2.9-6.4h6z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></g>`,
    '</g>',
    `<path d="M0 ${BAR}h${width}" class="edge"/>`,
    '</g>',
    '</svg>',
  ].join('\n');
}
