// The terminal: raw input decoded into key events, and the screen modes the UI
// needs (alternate screen, hidden cursor, bracketed paste, no auto-wrap).
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// CSI final byte (with optional "~" number) → key name.
const CSI_KEYS = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'tab', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
const TILDE_KEYS = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12' };

function modifiers(param) {
  // xterm encodes modifiers as 1 + bitmask (shift 1, alt 2, ctrl 4).
  const bits = Math.max(0, (Number(param) || 1) - 1);
  return { shift: Boolean(bits & 1), meta: Boolean(bits & 2), ctrl: Boolean(bits & 4) };
}

/**
 * Turns terminal input into key events:
 *   {name:'text', text}             printable characters (grouped)
 *   {name:'paste', text}            bracketed paste
 *   {name:'enter'|'newline'|'tab'|'backspace'|'delete'|'escape'|'up'|..., ctrl, meta, shift}
 *   {name:'a'..'z', ctrl:true}      control keys; {name:<char>, meta:true} for Alt+char
 * A lone ESC is reported after `escapeTimeoutMs` unless more of a sequence arrives.
 */
export function createDecoder(onKey, { escapeTimeoutMs = 30, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let buffer = '';
  let paste = null;
  let timer = null;

  const key = (name, extra = {}) => onKey({ name, ctrl: false, meta: false, shift: false, ...extra });

  function flushEscape() {
    timer = null;
    if (buffer === ESC) {
      buffer = '';
      key('escape');
    } else if (buffer.startsWith(ESC)) {
      // An incomplete sequence that never finished: drop it.
      buffer = '';
    }
  }

  function parse() {
    let text = '';
    const emitText = () => {
      if (text) {
        key('text', { text });
        text = '';
      }
    };
    while (buffer.length) {
      if (paste !== null) {
        const end = buffer.indexOf(PASTE_END);
        if (end < 0) {
          // Keep only a tail that could be the start of the end marker.
          let keep = 0;
          for (let k = Math.min(buffer.length, PASTE_END.length - 1); k > 0; k--) {
            if (PASTE_END.startsWith(buffer.slice(-k))) {
              keep = k;
              break;
            }
          }
          paste += buffer.slice(0, buffer.length - keep);
          buffer = buffer.slice(buffer.length - keep);
          return emitText();
        }
        paste += buffer.slice(0, end);
        buffer = buffer.slice(end + PASTE_END.length);
        key('paste', { text: paste.replace(/\r\n?/g, '\n') });
        paste = null;
        continue;
      }
      const ch = buffer[0];
      if (ch === ESC) {
        emitText();
        if (buffer.length === 1) {
          // Could be the escape key or the start of a sequence: wait a moment.
          if (!timer) timer = setTimer(flushEscape, escapeTimeoutMs);
          return;
        }
        if (buffer.startsWith(PASTE_START)) {
          buffer = buffer.slice(PASTE_START.length);
          paste = '';
          continue;
        }
        const next = buffer[1];
        if (next === '[') {
          const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(buffer);
          if (!match) {
            if (/^\x1b\[[0-?]*[ -/]*$/.test(buffer)) {
              if (!timer) timer = setTimer(flushEscape, escapeTimeoutMs);
              return;
            }
            buffer = buffer.slice(2);
            continue;
          }
          buffer = buffer.slice(match[0].length);
          const [, params, , final] = match;
          if (params.startsWith('<') || final === 'M' || final === 'm') continue; // mouse reports
          const parts = params.split(';');
          if (final === '~') {
            const name = TILDE_KEYS[parts[0]];
            if (name) key(name, modifiers(parts[1]));
            continue;
          }
          if (final === 'u') {
            // CSI u (kitty/fixterms): code;modifiers
            const code = Number(parts[0]);
            const mods = modifiers(parts[1]);
            if (code === 13) key(mods.shift || mods.meta ? 'newline' : 'enter', mods);
            else if (code === 27) key('escape', mods);
            else if (code === 9) key('tab', mods);
            else if (code === 127) key('backspace', mods);
            else if (code > 31) key(String.fromCodePoint(code), mods);
            continue;
          }
          const name = CSI_KEYS[final];
          if (name) key(name, final === 'Z' ? { shift: true } : modifiers(parts[1]));
          continue;
        }
        if (next === 'O') {
          if (buffer.length < 3) {
            if (!timer) timer = setTimer(flushEscape, escapeTimeoutMs);
            return;
          }
          const name = CSI_KEYS[buffer[2]];
          buffer = buffer.slice(3);
          if (name) key(name);
          continue;
        }
        // ESC + key = Alt+key.
        buffer = buffer.slice(1);
        const alt = buffer[0];
        if (alt === '\r' || alt === '\n') {
          buffer = buffer.slice(1);
          key('newline', { meta: true });
        } else if (alt === '\x7f' || alt === '\b') {
          buffer = buffer.slice(1);
          key('backspace', { meta: true });
        } else if (alt === ESC) {
          key('escape');
        } else {
          const cp = String.fromCodePoint(buffer.codePointAt(0));
          buffer = buffer.slice(cp.length);
          key(cp.length === 1 && cp >= 'A' && cp <= 'Z' ? cp.toLowerCase() : cp, { meta: true, shift: cp >= 'A' && cp <= 'Z' });
        }
        continue;
      }
      const code = ch.charCodeAt(0);
      if (ch === '\r') {
        emitText();
        buffer = buffer.slice(1);
        key('enter');
      } else if (ch === '\n') {
        emitText();
        buffer = buffer.slice(1);
        key('newline');
      } else if (ch === '\t') {
        emitText();
        buffer = buffer.slice(1);
        key('tab');
      } else if (ch === '\x7f' || ch === '\b') {
        emitText();
        buffer = buffer.slice(1);
        key('backspace');
      } else if (code < 32) {
        emitText();
        buffer = buffer.slice(1);
        if (code === 0) key('space', { ctrl: true });
        else if (code <= 26) key(String.fromCharCode(code + 96), { ctrl: true });
        // Other C0 controls (FS, GS, …) are ignored.
      } else {
        const cp = String.fromCodePoint(buffer.codePointAt(0));
        text += cp;
        buffer = buffer.slice(cp.length);
      }
    }
    emitText();
  }

  return {
    feed(chunk) {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      buffer += chunk;
      parse();
    },
    flush: flushEscape,
  };
}

/** The real terminal on process.stdin/stdout. */
export class Terminal extends EventEmitter {
  constructor({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;
    this.env = env;
    this.active = false;
    const decoder = new StringDecoder('utf8');
    const keys = createDecoder((event) => this.emit('key', event));
    this.onData = (chunk) => keys.feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    this.onResize = () => this.emit('resize', this.size());
  }

  size() {
    return { columns: Math.max(20, this.stdout.columns || 80), rows: Math.max(8, this.stdout.rows || 24) };
  }

  write(text) {
    this.stdout.write(text);
  }

  enter() {
    this.stdin.setRawMode?.(true);
    this.stdin.resume();
    this.stdin.on('data', this.onData);
    // Alternate screen, hidden cursor, no auto-wrap, bracketed paste.
    this.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b[2J');
  }

  leave() {
    this.write('\x1b[?2004l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l');
    this.stdin.off('data', this.onData);
    this.stdin.setRawMode?.(false);
    this.stdin.pause();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.enter();
    this.stdout.on('resize', this.onResize);
    this.restore = () => {
      if (this.active) this.leave();
    };
    process.once('exit', this.restore);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.stdout.off('resize', this.onResize);
    process.off('exit', this.restore);
    this.leave();
  }

  /** Hands the terminal to another program (an editor) and takes it back afterwards. */
  suspend() {
    if (this.active) this.leave();
  }

  resume() {
    if (this.active) this.enter();
  }
}
