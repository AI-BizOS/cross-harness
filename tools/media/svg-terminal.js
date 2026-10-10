// Recorded terminal frames → one animated SVG that plays in a README (<img>): no
// script, no external resources, only inline CSS animations. Each screen row is
// drawn once per distinct content and shown while the recording showed it; braille
// spinners turn by themselves; box-drawing characters become lines so borders join.
import { SPINNER } from '../../src/tui/views.js';
import { clusterWidth, graphemes } from '../../src/util/width.js';

const FONT = 14;
const CELL = 8.4;
const LINE = 18;
const PAD = 14;
const BAR = 34;
const MARGIN = 18;
const CHAPTERS = 46;
const SPIN = '\u{F8FF}';
const SPIN_CLASS = new RegExp(`[${SPINNER.join('')}]`, 'g');

const THEME = {
  background: '#0d1117',
  bar: '#161b22',
  border: '#30363d',
  text: '#c9d1d9',
  cursor: '#c9d1d9',
  colors: {
    30: '#6e7681', 31: '#ff7b72', 32: '#3fb950', 33: '#d29922', 34: '#58a6ff', 35: '#bc8cff', 36: '#39c5cf', 37: '#b1bac4',
    90: '#6e7681', 91: '#ffa198', 92: '#56d364', 93: '#e3b341', 94: '#79c0ff', 95: '#d2a8ff', 96: '#56d4dd',
  },
};

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (value) => Number(value.toFixed(2));

/** One rendered row → runs of {text, col, width, style}. */
export function parseRow(row) {
  const runs = [];
  let style = {};
  let col = 0;
  const pattern = /\x1b\[([0-9;]*)m|([^\x1b]+)/g;
  for (const [, codes, text] of row.matchAll(pattern)) {
    if (codes !== undefined) {
      if (codes === '' || codes === '0') style = {};
      else {
        style = { ...style };
        for (const code of codes.split(';').map(Number)) {
          if (code === 1) style.bold = true;
          else if (code === 2) style.dim = true;
          else if (code === 3) style.italic = true;
          else if (code === 4) style.underline = true;
          else if (code === 7) style.inverse = true;
          else if (THEME.colors[code]) style.fg = code;
        }
      }
      continue;
    }
    let width = 0;
    for (const cluster of graphemes(text)) width += clusterWidth(cluster);
    runs.push({ text, col, width, style });
    col += width;
  }
  return runs;
}

const BOX = { '─': 'h', '│': 'v', '┌': 'rd', '┐': 'ld', '└': 'ru', '┘': 'lu', '├': 'vr', '┤': 'vl' };

function color(style) {
  return style.fg ? THEME.colors[style.fg] : THEME.text;
}

function textAttrs(style) {
  const attrs = [`fill="${style.inverse ? THEME.background : color(style)}"`];
  if (style.bold) attrs.push('font-weight="700"');
  if (style.dim && !style.inverse) attrs.push('fill-opacity="0.58"');
  if (style.italic) attrs.push('font-style="italic"');
  if (style.underline) attrs.push('text-decoration="underline"');
  return attrs.join(' ');
}

/** SVG for one row's content at row index `r`. */
function rowSvg(row, r) {
  const y = r * LINE;
  const baseline = num(y + LINE * 0.72);
  const parts = [];
  for (const run of parseRow(row)) {
    const { style } = run;
    if (style.inverse) parts.push(`<rect x="${num(run.col * CELL)}" y="${y}" width="${num(run.width * CELL)}" height="${LINE}" fill="${color(style)}"${style.dim ? ' fill-opacity="0.58"' : ''}/>`);
    // Split the run into box-drawing lines, spinners and text pieces at their columns.
    let col = run.col;
    let piece = '';
    let pieceCol = col;
    const flush = () => {
      const trimmed = piece.replace(/\s+$/, '');
      const lead = trimmed.length - trimmed.replace(/^\s+/, '').length;
      const body = trimmed.slice(lead);
      if (body) {
        let width = 0;
        for (const cluster of graphemes(body)) width += clusterWidth(cluster);
        const x = num((pieceCol + lead) * CELL);
        const fit = width > 1 ? ` textLength="${num(width * CELL)}"` : '';
        parts.push(`<text x="${x}" y="${baseline}"${fit} ${textAttrs(style)}>${esc(body)}</text>`);
      }
      piece = '';
    };
    for (const cluster of graphemes(run.text)) {
      const width = clusterWidth(cluster);
      const box = BOX[cluster];
      if (box || cluster === SPIN) {
        flush();
        const x = col * CELL;
        const stroke = `stroke="${color(style)}"${style.dim ? ' stroke-opacity="0.45"' : ''}`;
        if (cluster === SPIN) parts.push(`<use href="#spin" x="${num(x)}" y="${baseline}" fill="${color(style)}"${style.dim ? ' fill-opacity="0.58"' : ''}/>`);
        else {
          const cx = num(x + CELL / 2);
          const cy = num(y + LINE / 2);
          const left = `M${num(x)} ${cy}H${cx}`;
          const right = `M${cx} ${cy}H${num(x + CELL)}`;
          const up = `M${cx} ${y}V${cy}`;
          const down = `M${cx} ${cy}V${y + LINE}`;
          const d = { h: `M${num(x)} ${cy}H${num(x + CELL)}`, v: `M${cx} ${y}V${y + LINE}`, rd: right + down, ld: left + down, ru: right + up, lu: left + up, vr: `M${cx} ${y}V${y + LINE}` + right, vl: `M${cx} ${y}V${y + LINE}` + left }[box];
          parts.push(`<path d="${d}" ${stroke}/>`);
        }
        col += width;
        pieceCol = col;
        continue;
      }
      if (!piece) pieceCol = col;
      piece += cluster;
      col += width;
    }
    flush();
  }
  return mergePaths(parts).join('');
}

// Neighbouring box-drawing pieces of the same colour become one path.
function mergePaths(parts) {
  const out = [];
  for (const part of parts) {
    const previous = out.at(-1);
    const a = /^<path d="([^"]+)" (stroke[^/]*)\/>$/.exec(part);
    const b = previous && /^<path d="([^"]+)" (stroke[^/]*)\/>$/.exec(previous);
    if (a && b && a[2] === b[2]) out[out.length - 1] = `<path d="${b[1]}${a[1]}" ${a[2]}/>`;
    else out.push(part);
  }
  return out;
}

/**
 * The frames between `from` and `to` (ms of the recording), starting at 0. Spinners
 * become one placeholder that the SVG animates, so frames that only moved a spinner
 * are dropped.
 */
export function clip(frames, from, to) {
  const out = [];
  const before = frames.filter((frame) => frame.t <= from).at(-1);
  for (const frame of [...(before ? [{ ...before, t: from }] : []), ...frames.filter((f) => f.t > from && f.t < to)]) {
    const rows = frame.rows.map((row) => row.replace(SPIN_CLASS, SPIN));
    const previous = out.at(-1);
    if (previous && previous.rows.every((row, i) => row === rows[i]) && JSON.stringify(previous.cursor) === JSON.stringify(frame.cursor)) continue;
    out.push({ t: frame.t - from, rows, cursor: frame.cursor });
  }
  return out;
}

const pct = (t, total) => `${Number(((t / total) * 100).toFixed(3))}%`;

/**
 * @param {{t:number, rows:string[], cursor:{row:number,col:number}|null}[]} frames
 * @param {{columns:number, rows:number, title:string, end:number, chapters?:{label:string,start:number,end:number}[], label?:string}} options
 */
export function terminalSvg(frames, { columns, rows, title, end, chapters = [], label = 'cross-harness terminal UI' }) {
  const total = end;
  const width = num(MARGIN * 2 + PAD * 2 + columns * CELL);
  const screenHeight = rows * LINE;
  const windowHeight = BAR + PAD + screenHeight + PAD;
  const height = num(MARGIN + windowHeight + (chapters.length ? CHAPTERS : MARGIN));
  const css = [];
  const body = [];
  let serial = 0;
  const keyframes = (intervals) => {
    const name = `k${(serial++).toString(36)}`;
    const stops = [];
    let visibleAtStart = false;
    for (const [from, to] of intervals) {
      if (from <= 0) visibleAtStart = true;
      else stops.push(`${pct(from, total)}{opacity:1}`);
      if (to < total) stops.push(`${pct(to, total)}{opacity:0}`);
    }
    css.push(`@keyframes ${name}{0%{opacity:${visibleAtStart ? 1 : 0}}${stops.join('')}}`);
    return name;
  };

  // With reduced motion the last frame stands still: its rows are marked as the poster.
  const poster = total - 1;
  const onPoster = (intervals) => intervals.some(([from, to]) => from <= poster && poster < to);

  // Rows: each distinct content of each row, with the stretches it is on screen.
  for (let r = 0; r < rows; r++) {
    const variants = new Map();
    frames.forEach((frame, i) => {
      const row = frame.rows[r] ?? '';
      const from = frame.t;
      const to = i + 1 < frames.length ? frames[i + 1].t : total;
      if (to <= from) return;
      const list = variants.get(row) || [];
      const last = list.at(-1);
      if (last && last[1] === from) last[1] = to;
      else list.push([from, to]);
      variants.set(row, list);
    });
    for (const [row, intervals] of variants) {
      const svg = rowSvg(row, r);
      if (!svg) continue;
      if (intervals.length === 1 && intervals[0][0] <= 0 && intervals[0][1] >= total) body.push(svg);
      else body.push(`<g${onPoster(intervals) ? ' class="p"' : ''} style="animation-name:${keyframes(intervals)}">${svg}</g>`);
    }
  }

  // The cursor: a block that moves between the places the UI put it.
  const cursorStops = [];
  frames.forEach((frame) => {
    const c = frame.cursor;
    const value = c ? `transform:translate(${num(c.col * CELL)}px,${c.row * LINE}px);opacity:1` : 'opacity:0';
    if (cursorStops.at(-1)?.value !== value) cursorStops.push({ t: frame.t, value });
  });
  css.push(`@keyframes cur{${cursorStops.map((s) => `${pct(s.t, total)}{${s.value}}`).join('')}}`);

  // Chapters under the window: the current one is lit and its bar fills while it plays.
  const chapterSvg = [];
  if (chapters.length) {
    const top = MARGIN + windowHeight + 18;
    const slot = (width - MARGIN * 2) / chapters.length;
    chapters.forEach((chapter, i) => {
      const x = num(MARGIN + i * slot);
      const lit = `c${i}`;
      const fill = `f${i}`;
      css.push(`@keyframes ${lit}{0%{fill:#8b949e}${pct(chapter.start, total)}{fill:#2f81f7}${chapter.end < total ? `${pct(chapter.end, total)}{fill:#8b949e}` : ''}}`);
      css.push(`@keyframes ${fill}{0%{transform:scaleX(0)}${pct(chapter.start, total)}{transform:scaleX(0)}${pct(chapter.end, total)}{transform:scaleX(1)}${chapter.end < total ? `${pct(Math.min(total, chapter.end + 1), total)}{transform:scaleX(0)}` : ''}}`);
      chapterSvg.push(
        `<g transform="translate(${x} ${top})">`,
        `<rect width="${num(slot - 14)}" height="3" rx="1.5" class="track"/>`,
        `<rect width="${num(slot - 14)}" height="3" rx="1.5" class="fill" style="animation-name:${fill}"/>`,
        `<text y="21" class="chapter" style="animation-name:${lit}">${esc(chapter.label)}</text>`,
        `</g>`,
      );
    });
  }

  const seconds = `${(total / 1000).toFixed(2)}s`;
  const spinner = SPINNER.map((glyph, i) => `<text class="s" style="animation-delay:${num(i * 0.1 - 1)}s">${glyph}</text>`).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}">`,
    `<title>${esc(label)}</title>`,
    '<style>',
    `text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Monaco,Consolas,"Liberation Mono","DejaVu Sans Mono",monospace;font-size:${FONT}px;white-space:pre}`,
    `.screen g{opacity:0;animation-duration:${seconds};animation-iteration-count:infinite;animation-timing-function:step-end}`,
    `.screen path{fill:none;stroke-width:1}`,
    `.s{opacity:0;animation:sp 1s step-end infinite}@keyframes sp{0%{opacity:1}10%{opacity:0}}`,
    `.cursor{opacity:0;animation:cur ${seconds} step-end infinite}`,
    `.bar-title{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:12.5px;fill:#8b949e}`,
    `.chapter{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;fill:#8b949e;animation-duration:${seconds};animation-iteration-count:infinite;animation-timing-function:step-end}`,
    `.track{fill:#8b949e;opacity:.25}.fill{fill:#2f81f7;transform:scaleX(0);animation-duration:${seconds};animation-iteration-count:infinite;animation-timing-function:linear}`,
    `@media (prefers-reduced-motion:reduce){.screen g,.cursor,.s,.chapter,.fill{animation:none!important}.screen g{opacity:0}.screen g.p{opacity:1}.cursor,.s{opacity:0}.s:first-child{opacity:1}}`,
    ...css,
    '</style>',
    `<defs><g id="spin">${spinner}</g><filter id="shadow" x="-5%" y="-5%" width="110%" height="115%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000" flood-opacity=".28"/></filter></defs>`,
    `<g transform="translate(${MARGIN} ${MARGIN})">`,
    `<rect width="${num(width - MARGIN * 2)}" height="${num(windowHeight)}" rx="10" fill="${THEME.background}" stroke="${THEME.border}" filter="url(#shadow)"/>`,
    `<path d="M0 10a10 10 0 0 1 10-10h${num(width - MARGIN * 2 - 20)}a10 10 0 0 1 10 10v${BAR - 10}h-${num(width - MARGIN * 2)}z" fill="${THEME.bar}"/>`,
    `<path d="M0 ${BAR}h${num(width - MARGIN * 2)}" stroke="${THEME.border}"/>`,
    `<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>`,
    `<text x="${num((width - MARGIN * 2) / 2)}" y="21.5" text-anchor="middle" class="bar-title">${esc(title)}</text>`,
    `<g class="screen" transform="translate(${PAD} ${BAR + PAD})">`,
    ...body,
    `<rect class="cursor" width="${CELL}" height="${LINE}" fill="${THEME.cursor}" fill-opacity=".75"/>`,
    '</g>',
    '</g>',
    ...chapterSvg,
    '</svg>',
  ].join('\n');
}
