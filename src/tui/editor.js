// The composer: multi-line text with a cursor that moves by grapheme cluster (so
// emoji and CJK never split), readline-style keys, history and @ completion.
import { clusterWidth, graphemes } from '../util/width.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WORD = /[\p{L}\p{N}_]/u;
// The leading run of mentions on a line, ending in the one being typed.
const MENTION_RUN = /^\s*(?:@[A-Za-z0-9][A-Za-z0-9_.-]*\+?(?::[A-Za-z0-9_.-]+)?\s+)*@([A-Za-z0-9_.-]*)$/;

export class Editor {
  constructor({ history = [], maxHistory = 200 } = {}) {
    this.text = '';
    this.cursor = 0;
    this.history = [...history];
    this.maxHistory = maxHistory;
    this.historyIndex = null;
    this.draft = '';
  }

  setText(text, cursor = text.length) {
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
  }

  clear() {
    this.setText('');
    this.historyIndex = null;
  }

  lineStart(at = this.cursor) {
    return this.text.lastIndexOf('\n', at - 1) + 1;
  }

  lineEnd(at = this.cursor) {
    const end = this.text.indexOf('\n', at);
    return end < 0 ? this.text.length : end;
  }

  /** Grapheme boundaries of the line holding `at`, as absolute offsets. */
  boundaries(at = this.cursor) {
    const start = this.lineStart(at);
    const end = this.lineEnd(at);
    const out = [start];
    for (const part of segmenter.segment(this.text.slice(start, end))) out.push(start + part.index + part.segment.length);
    return out;
  }

  insert(value) {
    const clean = String(value)
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '  ')
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
    if (!clean) return;
    this.text = this.text.slice(0, this.cursor) + clean + this.text.slice(this.cursor);
    this.cursor += clean.length;
    this.historyIndex = null;
  }

  left() {
    if (this.cursor === 0) return;
    if (this.text[this.cursor - 1] === '\n') {
      this.cursor--;
      return;
    }
    const marks = this.boundaries();
    this.cursor = [...marks].reverse().find((mark) => mark < this.cursor) ?? this.lineStart();
  }

  right() {
    if (this.cursor >= this.text.length) return;
    if (this.text[this.cursor] === '\n') {
      this.cursor++;
      return;
    }
    const marks = this.boundaries();
    this.cursor = marks.find((mark) => mark > this.cursor) ?? this.lineEnd();
  }

  home() {
    this.cursor = this.lineStart();
  }

  end() {
    this.cursor = this.lineEnd();
  }

  wordLeft() {
    let i = this.cursor;
    while (i > 0 && !WORD.test(this.text[i - 1])) i--;
    while (i > 0 && WORD.test(this.text[i - 1])) i--;
    this.cursor = i;
  }

  wordRight() {
    let i = this.cursor;
    const n = this.text.length;
    while (i < n && !WORD.test(this.text[i])) i++;
    while (i < n && WORD.test(this.text[i])) i++;
    this.cursor = i;
  }

  backspace() {
    if (this.cursor === 0) return;
    const before = this.cursor;
    this.left();
    this.text = this.text.slice(0, this.cursor) + this.text.slice(before);
  }

  delete() {
    if (this.cursor >= this.text.length) return;
    const at = this.cursor;
    this.right();
    this.text = this.text.slice(0, at) + this.text.slice(this.cursor);
    this.cursor = at;
  }

  deleteWordBack() {
    const end = this.cursor;
    this.wordLeft();
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }

  killToEnd() {
    const end = this.lineEnd();
    // At the end of a line, join it with the next one.
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end === this.cursor && end < this.text.length ? end + 1 : end);
  }

  killToStart() {
    const start = this.lineStart();
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  /** Moves between lines; at the first/last line it walks the history instead. */
  up() {
    const start = this.lineStart();
    if (start === 0) return this.historyPrev();
    const column = this.cursor - start;
    const prevStart = this.lineStart(start - 1);
    this.cursor = Math.min(prevStart + column, start - 1);
    return true;
  }

  down() {
    const end = this.lineEnd();
    if (end >= this.text.length) return this.historyNext();
    const column = this.cursor - this.lineStart();
    const nextStart = end + 1;
    this.cursor = Math.min(nextStart + column, this.lineEnd(nextStart));
    return true;
  }

  historyPrev() {
    if (!this.history.length) return false;
    if (this.historyIndex === null) {
      this.draft = this.text;
      this.historyIndex = this.history.length;
    }
    if (this.historyIndex === 0) return false;
    this.historyIndex--;
    this.setText(this.history[this.historyIndex]);
    return true;
  }

  historyNext() {
    if (this.historyIndex === null) return false;
    this.historyIndex++;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = null;
      this.setText(this.draft);
    } else {
      this.setText(this.history[this.historyIndex]);
    }
    return true;
  }

  /** Returns the text and clears the composer; non-empty text goes to history. */
  submit() {
    const text = this.text;
    if (text.trim() && this.history.at(-1) !== text) {
      this.history.push(text);
      if (this.history.length > this.maxHistory) this.history.shift();
    }
    this.clear();
    return text;
  }

  /** The @name being typed in the line's leading mentions, if any. */
  mentionToken() {
    const start = this.lineStart();
    const match = MENTION_RUN.exec(this.text.slice(start, this.cursor));
    if (!match) return null;
    return { prefix: `@${match[1]}`, start: this.cursor - match[1].length - 1, end: this.cursor };
  }

  complete(name) {
    const token = this.mentionToken();
    if (!token) return false;
    const after = this.text.slice(token.end).replace(/^[A-Za-z0-9_.-]*/, '');
    const insert = `@${name}${after.startsWith(' ') ? '' : ' '}`;
    this.text = this.text.slice(0, token.start) + insert + after;
    this.cursor = token.start + insert.length + (after.startsWith(' ') ? 1 : 0);
    return true;
  }

  /**
   * Wraps the text to `width` columns (every row is indented by `indent` columns
   * for the prompt) and finds the cursor.
   * @returns {{rows:string[], cursorRow:number, cursorCol:number}}
   */
  layout(width, indent = 2) {
    const avail = Math.max(4, width - indent);
    const rows = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let offset = 0;
    const lines = this.text.split('\n');
    lines.forEach((line, lineIndex) => {
      let row = '';
      let used = 0;
      let index = offset;
      if (this.cursor === index) {
        cursorRow = rows.length;
        cursorCol = 0;
      }
      for (const cluster of graphemes(line)) {
        const w = clusterWidth(cluster);
        if (used + w > avail) {
          rows.push(row);
          row = '';
          used = 0;
        }
        row += cluster;
        used += w;
        index += cluster.length;
        if (this.cursor === index) {
          cursorRow = rows.length;
          cursorCol = used;
        }
      }
      rows.push(row);
      offset += line.length + (lineIndex < lines.length - 1 ? 1 : 0);
    });
    if (cursorCol >= avail) {
      cursorRow++;
      cursorCol = 0;
      if (cursorRow >= rows.length) rows.push('');
    }
    return { rows, cursorRow, cursorCol: cursorCol + indent };
  }
}
