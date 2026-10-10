import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDetector, deepseekDesktop, installDirs, resolveExecutable } from '../src/providers/detect.js';
import { launchCommand, nodeFor } from '../src/providers/launch.js';
import { buildRegistry } from '../src/providers/registry.js';
import { tempDir } from './helpers.js';

const tool = (file, text = '#!/bin/sh\necho "1.2.3"\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
};

test('Kimi Code is found where its installer puts it, even off PATH', (t) => {
  const home = tempDir(t);
  const kimi = tool(path.join(home, '.kimi-code', 'bin', 'kimi'));
  assert.equal(resolveExecutable('kimi', { PATH: '', HOME: home }), kimi);
  const custom = tool(path.join(home, 'kimi-home', 'bin', 'kimi'));
  assert.equal(resolveExecutable('kimi', { PATH: '', HOME: home, KIMI_CODE_HOME: path.join(home, 'kimi-home') }), custom);
  // PATH still comes first.
  const onPath = tool(path.join(home, 'bin', 'kimi'));
  assert.equal(resolveExecutable('kimi', { PATH: path.join(home, 'bin'), HOME: home }), onPath);
});

test('commands from version and package managers are found without their PATH setup', (t) => {
  const home = tempDir(t);
  tool(path.join(home, '.nvm', 'versions', 'node', 'v18.20.0', 'bin', 'codex'));
  const newest = tool(path.join(home, '.nvm', 'versions', 'node', 'v22.3.0', 'bin', 'codex'));
  assert.equal(resolveExecutable('codex', { PATH: '', HOME: home }), newest);
  const pnpm = tool(path.join(home, 'Library', 'pnpm', 'gemini'));
  assert.equal(resolveExecutable('gemini', { PATH: '', HOME: home }), pnpm);
  const prefix = tool(path.join(home, 'npm-prefix', 'bin', 'qwen'));
  assert.equal(resolveExecutable('qwen', { PATH: '', HOME: home, npm_config_prefix: path.join(home, 'npm-prefix') }), prefix);
  assert.ok(installDirs({ HOME: home, APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32').includes('C:\\Users\\me\\AppData\\Roaming\\npm'));
});

test('DeepSeek Harness desktop without a dsh command runs its own CLI', { skip: process.platform !== 'darwin' && 'the bundle layout is macOS' }, (t) => {
  // /Applications is searched before ~/Applications; a real install there would win.
  const realApp = deepseekDesktop({ HOME: tempDir(t) }, 'darwin');
  const bundle = (home, name) => {
    const runtime = path.join(home, 'Applications', name, 'Contents', 'Resources', 'runtime');
    return { entry: tool(path.join(runtime, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'console.log("0.1.7")\n'), node: tool(path.join(runtime, 'node')) };
  };
  const home = tempDir(t);
  const { entry, node } = bundle(home, 'DeepSeek Harness.app');
  if (!realApp) assert.equal(resolveExecutable('dsh', { PATH: '', HOME: home }), entry);
  // The app's CLI starts with the app's own Node; other scripts with cross-harness's.
  assert.deepEqual(launchCommand(entry, ['--profile', 'acp'], {}), { binary: node, args: [entry, '--profile', 'acp'], env: {} });
  assert.equal(nodeFor(path.join(home, 'elsewhere', 'cli.js')), process.execPath);
  // A renamed backup is not an installed app.
  const backup = tempDir(t);
  bundle(backup, 'DeepSeek Harness.bak.app');
  if (!realApp) assert.equal(resolveExecutable('dsh', { PATH: '', HOME: backup }), null);
});

test('Windows wrappers are started without cmd.exe', (t) => {
  const dir = tempDir(t);
  // npm's wrapper names a Node script.
  const script = tool(path.join(dir, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js'), '');
  const npm = path.join(dir, 'gemini.cmd');
  fs.writeFileSync(npm, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*\r\n');
  const launch = launchCommand(npm, ['--experimental-acp'], { PATH: '' });
  assert.deepEqual(launch.args, [script, '--experimental-acp']);
  assert.equal(launch.binary, process.execPath);
  // DeepSeek Harness desktop's wrapper runs its Electron executable as Node.
  const exe = tool(path.join(dir, 'app', 'DeepSeek Harness.exe'), '');
  const cli = tool(path.join(dir, 'app', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'), '');
  const desktop = path.join(dir, 'app', 'dsh.cmd');
  fs.writeFileSync(desktop, '@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0DeepSeek Harness.exe" --expose-internals "%~dp0resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\n');
  assert.deepEqual(launchCommand(desktop, ['--profile', 'acp'], { A: '1' }), { binary: exe, args: ['--expose-internals', cli, '--profile', 'acp'], env: { A: '1', ELECTRON_RUN_AS_NODE: '1' } });
  // Anything else is refused with a message the adapters show.
  const odd = path.join(dir, 'odd.cmd');
  fs.writeFileSync(odd, '@echo off\r\nstart something\r\n');
  assert.throws(() => launchCommand(odd, [], {}), /cannot read the Windows wrapper .*odd\.cmd; reinstall the harness/);
});

test('a harness that is slow to answer --version is still available', async (t) => {
  const dir = tempDir(t);
  tool(path.join(dir, 'slow-agent'));
  const registry = buildRegistry({ slow: { name: 'Slow', command: 'slow-agent', protocol: 'acp' } });
  const detector = createDetector({ registry: { slow: registry.slow }, env: { PATH: dir, HOME: dir }, probe: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }) });
  const slow = await detector.detect('slow');
  assert.equal(slow.available, true);
  assert.equal(slow.version, null);
  assert.match(slow.note, /did not answer within 10 seconds/);
});
