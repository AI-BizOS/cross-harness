// Terminal display width of text. CJK ideographs, kana, hangul, fullwidth forms
// and most emoji take two columns; combining marks and format characters take none.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Ranges of East Asian Wide (W) and Fullwidth (F) code points, plus emoji that
// default to emoji presentation. Sorted, inclusive.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18aff], [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inWide(code) {
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = WIDE[mid];
    if (code < start) hi = mid - 1;
    else if (code > end) lo = mid + 1;
    else return true;
  }
  return false;
}

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u;
const PICTO = /\p{Extended_Pictographic}/u;

/** Width of one grapheme cluster: 0, 1 or 2 columns. */
export function clusterWidth(cluster) {
  let first = null;
  for (const char of cluster) {
    if (ZERO.test(char)) continue;
    first = char;
    break;
  }
  if (first === null) return 0;
  const code = first.codePointAt(0);
  if (inWide(code)) return 2;
  // A text-default pictograph shown as emoji (U+FE0F) or joined into a sequence.
  if (PICTO.test(first) && (cluster.includes('️') || cluster.includes('‍'))) return 2;
  // Regional indicator pairs (flags).
  if (code >= 0x1f1e6 && code <= 0x1f1ff) return cluster.length > 2 ? 2 : 1;
  return 1;
}

export function graphemes(text) {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** Columns `text` occupies; ANSI escape sequences must be removed first. */
export function displayWidth(text) {
  if (ASCII_PRINTABLE.test(text)) return text.length;
  let width = 0;
  for (const cluster of graphemes(text)) width += clusterWidth(cluster);
  return width;
}
