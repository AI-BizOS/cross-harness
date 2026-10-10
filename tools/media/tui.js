// Records Troupe's real terminal UI: runTui draws into a terminal of a fixed size, a
// person's keystrokes are fed through the real key decoder, and every frame the UI
// draws is kept with its time.
import { EventEmitter } from 'node:events';
import { runTui } from '../../src/tui/app.js';
import { Screen } from '../../src/tui/screen.js';
import { createDecoder } from '../../src/tui/terminal.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RecordingTerminal extends EventEmitter {
  constructor(columns, rows) {
    super();
    this.dimensions = { columns, rows };
    this.decoder = createDecoder((key) => this.emit('key', key));
  }

  size() {
    return { ...this.dimensions };
  }

  write() {}
  start() {}
  stop() {}
  suspend() {}
  resume() {}

  /** Bytes as a terminal would send them: "\r" Enter, "\x1b\r" Alt+Enter, "\x1b" Esc. */
  press(bytes) {
    this.decoder.feed(bytes);
  }
}

/**
 * Starts the terminal UI on `client` and records it.
 * @returns {{press:Function, type:Function, mark:Function, stop:Function, frames:object[], marks:object[]}}
 */
export function recordTui({ client, lang = 'en', columns = 112, rows = 30 }) {
  const terminal = new RecordingTerminal(columns, rows);
  const frames = [];
  const marks = [];
  const started = Date.now();
  const original = Screen.prototype.draw;
  Screen.prototype.draw = function draw(lines, cursor) {
    frames.push({ t: Date.now() - started, rows: [...lines], cursor: cursor ? { ...cursor } : null });
    return original.call(this, lines, cursor);
  };
  const done = runTui({ client, lang, terminal, env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '' } });

  // A person types unevenly: a little faster inside words, slower after spaces.
  let seed = 7;
  const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  async function type(text, { cps = 34 } = {}) {
    for (const char of text) {
      terminal.press(char);
      const base = 1000 / cps;
      await sleep(base * (char === ' ' ? 1.6 : 1) + jitter() * base * 0.35);
    }
  }

  return {
    frames,
    marks,
    press: (bytes) => terminal.press(bytes),
    type,
    mark: (name, extra = {}) => marks.push({ t: Date.now() - started, name, ...extra }),
    async stop() {
      terminal.press('\x03');
      await sleep(50);
      terminal.press('\x03');
      await done;
      Screen.prototype.draw = original;
    },
  };
}
