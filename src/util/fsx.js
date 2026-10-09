// Small file helpers. State files are written atomically (temp file + rename) and
// are private to the user (0600 files, 0700 directories).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value, { pretty = false } = {}) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, pretty ? 2 : 0) + (pretty ? '\n' : ''), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
}

/**
 * Reads up to `limit` of the last JSON lines of a file without loading all of it.
 * A torn last line (a crash mid-write) is skipped.
 */
export function readJsonlTail(file, limit = 500, maxBytes = 8 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* Torn or foreign line. */
      }
    }
    return rows.slice(-limit);
  } finally {
    fs.closeSync(fd);
  }
}

export function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* Best effort. */
  }
}
