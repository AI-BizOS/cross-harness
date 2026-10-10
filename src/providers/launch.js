// How a harness found on disk is started. Most are executables, but some are not:
// - npm installs a Windows command as a .cmd wrapper, which Node cannot spawn without a
//   shell. cross-harness reads the wrapper and starts what it names (a Node script or an .exe)
//   directly, so arguments never pass through cmd.exe.
// - DeepSeek Harness desktop can ship its CLI as a Node script next to its own Node
//   runtime instead of registering a `dsh` command.
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = /\.[cm]?js$/i;
const WRAPPER = /\.(?:cmd|bat)$/i;

/** The Node that runs a script: the runtime bundled next to it, else cross-harness's own. */
export function nodeFor(entry) {
  const marker = `${path.sep}runtime${path.sep}`;
  const at = entry.lastIndexOf(marker);
  if (at >= 0) {
    const bundled = path.join(entry.slice(0, at + marker.length), process.platform === 'win32' ? 'node.exe' : 'node');
    if (isFile(bundled)) return bundled;
  }
  return process.execPath;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} binary the harness as found on disk
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{binary:string, args:string[], env:NodeJS.ProcessEnv}}
 */
export function launchCommand(binary, args, env) {
  if (SCRIPT.test(binary)) return { binary: nodeFor(binary), args: [binary, ...args], env };
  if (!WRAPPER.test(binary)) return { binary, args, env };
  // The adapters report this message as the reason the harness failed to start.
  const unreadable = () => Object.assign(new Error(`cross-harness cannot read the Windows wrapper ${binary}; reinstall the harness`), { unreadable: true });
  let source;
  try {
    if (fs.statSync(binary).size > 65536) throw unreadable();
    source = fs.readFileSync(binary, 'utf8');
  } catch (error) {
    throw error.unreadable ? error : unreadable();
  }
  const base = path.dirname(binary);
  const local = (relative) => path.resolve(base, ...relative.split(/[\\/]/));
  // DeepSeek Harness desktop: its Electron executable runs the CLI as Node.
  const desktop = /"%~dp0([^"\r\n]+\.exe)" --expose-internals "%~dp0([^"\r\n]+\.js)" %\*/i.exec(source);
  if (desktop && /^set "ELECTRON_RUN_AS_NODE=1"$/im.test(source) && isFile(local(desktop[1])) && isFile(local(desktop[2]))) {
    return { binary: local(desktop[1]), args: ['--expose-internals', local(desktop[2]), ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  }
  // npm's wrapper: `"%~dp0\node.exe" "%~dp0\node_modules\pkg\bin\cli.js" %*` (or `%dp0%`).
  const target = /"%(?:dp0%|~dp0)[\\/]?([^"\r\n]+)"\s+%\*/i.exec(source);
  if (!target || !isFile(local(target[1]))) throw unreadable();
  const entry = local(target[1]);
  if (/\.exe$/i.test(entry)) return { binary: entry, args, env };
  const node = [path.join(base, 'node.exe'), ...String(env?.PATH || env?.Path || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'node.exe'))].find(isFile);
  return { binary: node || process.execPath, args: [entry, ...args], env };
}
