// Text shaping for terminal output. Everything an agent or a remote peer sends is
// treated as untrusted: escape sequences and control characters are removed before
// it reaches the screen, so agent output cannot move the cursor or retitle windows.
import { displayWidth, graphemes, clusterWidth } from './width.js';

// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings and lone ESC pairs.
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ESCAPES, '');
}

/** Untrusted text made safe to print: no escapes, no controls, tabs expanded, CRLF folded. */
export function sanitize(text) {
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(CONTROLS, '');
}

export function clip(text, max, note = '…') {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, Math.max(0, max - note.length)) + note : value;
}

export function oneLine(text, max = 200) {
  return clip(sanitize(text).replace(/\s+/g, ' ').trim(), max);
}

/** Cuts plain text to at most `width` columns, ending with an ellipsis when cut. */
export function truncate(text, width, ellipsis = '…') {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ellipsis);
  let out = '';
  let used = 0;
  for (const cluster of graphemes(text)) {
    const w = clusterWidth(cluster);
    if (used + w > room) break;
    out += cluster;
    used += w;
  }
  return out + ellipsis;
}

export function padEnd(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

/**
 * Wraps plain text to `width` columns. Explicit newlines are kept; words are kept
 * whole where possible, CJK text and over-long words break anywhere.
 * @returns {string[]}
 */
export function wrap(text, width) {
  const lines = [];
  const limit = Math.max(1, width);
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let line = '';
    let lineWidth = 0;
    // Tokens: runs of spaces, runs of non-space ASCII-ish word chars, single wide clusters.
    for (const token of tokenize(paragraph)) {
      const w = displayWidth(token);
      if (lineWidth + w <= limit) {
        line += token;
        lineWidth += w;
        continue;
      }
      if (/^\s+$/.test(token)) {
        // Break at the space; it is not carried to the next line.
        lines.push(line.trimEnd());
        line = '';
        lineWidth = 0;
        continue;
      }
      if (w <= limit && lineWidth > 0) {
        lines.push(line.trimEnd());
        line = token;
        lineWidth = w;
        continue;
      }
      // Hard-break a token that is wider than the remaining room.
      for (const cluster of graphemes(token)) {
        const cw = clusterWidth(cluster);
        if (lineWidth + cw > limit && lineWidth > 0) {
          lines.push(line);
          line = '';
          lineWidth = 0;
        }
        line += cluster;
        lineWidth += cw;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function* tokenize(text) {
  const parts = text.match(/\s+|[\x21-\x7e -˿]+|[^\s\x21-\x7e -˿]/gu) || [];
  yield* parts;
}

/** "3m 05s", "42s", "1h 02m" */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** "12.3k" style token counts. */
export function formatCount(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
