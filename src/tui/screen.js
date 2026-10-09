// Drawing: a line is a list of styled spans; a frame is one rendered string per row.
// Only rows that changed since the last frame are written, inside a synchronized
// update, so the screen does not flicker while agents stream text.
import { clusterWidth, displayWidth, graphemes } from '../util/width.js';

/** SGR codes by name. Colours are dropped under NO_COLOR; emphasis is kept. */
export const STYLE = {
  bold: '1',
  dim: '2',
  italic: '3',
  underline: '4',
  inverse: '7',
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
  brightRed: '91',
  brightGreen: '92',
  brightYellow: '93',
  brightBlue: '94',
  brightMagenta: '95',
  brightCyan: '96',
};
const EMPHASIS = new Set(['1', '2', '3', '4', '7']);
const UNSAFE = /[\x00-\x1f\x7f-\x9f]/g;

/** A styled span: span('text', 'bold', 'cyan'). */
export function span(text, ...styles) {
  return { text: String(text ?? '').replace(UNSAFE, ''), styles: styles.filter(Boolean) };
}

export function spansWidth(spans) {
  let width = 0;
  for (const s of spans) width += displayWidth(s.text);
  return width;
}

export function plain(spans) {
  return spans.map((s) => s.text).join('');
}

/**
 * Fits spans to exactly `width` columns: cut (optionally with an ellipsis) or padded.
 * A wide character that would straddle the edge becomes a space.
 */
export function fitSpans(spans, width, { ellipsis = true } = {}) {
  if (width <= 0) return [];
  const total = spansWidth(spans);
  if (total <= width) return total === width ? spans : [...spans, span(' '.repeat(width - total))];
  const room = ellipsis ? width - 1 : width;
  const out = [];
  let used = 0;
  for (const s of spans) {
    if (used >= room) break;
    let text = '';
    for (const cluster of graphemes(s.text)) {
      const w = clusterWidth(cluster);
      if (used + w > room) break;
      text += cluster;
      used += w;
    }
    if (text) out.push({ text, styles: s.styles });
    if (used >= room || text.length < s.text.length) break;
  }
  if (ellipsis) {
    out.push(span('…', 'dim'));
    used += 1;
  }
  if (used < width) out.push(span(' '.repeat(width - used)));
  return out;
}

function sgr(styles, color) {
  const codes = color ? styles.map((s) => STYLE[s] || s) : styles.map((s) => STYLE[s] || s).filter((c) => EMPHASIS.has(c));
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

/** One row of output: the spans fitted to `width`, with styles reset at the end. */
export function renderLine(spans, width, { color = true, ellipsis = true, background = null } = {}) {
  const fitted = fitSpans(spans, width, { ellipsis });
  let out = '';
  for (const s of fitted) {
    const styles = background ? [...background, ...s.styles] : s.styles;
    const open = sgr(styles, color);
    out += open ? `${open}${s.text}\x1b[0m` : s.text;
  }
  return out;
}

export function colorEnabled(env = process.env) {
  return !(env.NO_COLOR && env.NO_COLOR !== '') && env.TERM !== 'dumb';
}

/** Keeps the last frame and writes only what changed. */
export class Screen {
  constructor(terminal) {
    this.terminal = terminal;
    this.previous = [];
    this.cursor = null;
    this.size = null;
  }

  invalidate() {
    this.previous = [];
    this.cursor = null;
  }

  /**
   * @param {string[]} rows rendered rows, each exactly the terminal width
   * @param {{row:number,col:number}|null} cursor zero-based position to show the cursor at
   */
  draw(rows, cursor = null) {
    const size = this.terminal.size();
    if (!this.size || this.size.columns !== size.columns || this.size.rows !== size.rows) {
      this.previous = [];
      this.size = size;
    }
    let out = '';
    if (!this.previous.length) out += '\x1b[0m\x1b[2J';
    for (let i = 0; i < size.rows; i++) {
      const row = rows[i] ?? ' '.repeat(size.columns);
      if (this.previous[i] === row) continue;
      out += `\x1b[${i + 1};1H${row}\x1b[0m`;
    }
    this.previous = rows.slice(0, size.rows);
    const place = cursor ? `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h` : '\x1b[?25l';
    // An unchanged frame writes nothing, so idle animation ticks cost no output.
    if (!out && place === this.cursor) return;
    this.cursor = place;
    this.terminal.write(`\x1b[?2026h${out}${place}\x1b[?2026l`);
  }
}
