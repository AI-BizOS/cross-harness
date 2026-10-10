// Shared by the stand-in agents: the scene a prompt starts, real commands and edits in
// the agent's working directory, and calls to Troupe's collaboration tools over MCP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { scenes } from '../story.js';

// DEMO_PACE slows every pause down (2 = twice as long) so a recording can be read.
const PACE = Number(process.env.DEMO_PACE) || 1;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms * PACE));
export const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

/** `--version` prints no version number, so the interface shows none for a stand-in. */
export function answerVersion() {
  if (!process.argv.includes('--version')) return false;
  process.stdout.write('troupe demo stand-in\n');
  return true;
}

export function lines(onMessage) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    onMessage(message);
  });
  rl.on('close', () => process.exit(0));
}

/** The actions for a prompt; a prompt no scene matches gets a short answer. */
export function sceneFor(role, prompt) {
  const list = scenes(process.env.DEMO_LANG || 'en')[role] || [];
  const scene = list.find((item) => item.match.test(prompt));
  return scene ? scene.actions : [['say', 'Done.']];
}

/** Answer text in chunks of a few words, the way models stream it. */
export async function stream(text, emit, { words = 4, ms = 70 } = {}) {
  const parts = text.match(/\S+\s*|\s+/g) || [];
  for (let i = 0; i < parts.length; i += words) {
    emit(parts.slice(i, i + words).join(''));
    await sleep(ms);
  }
}

export function applyEdit(cwd, file, change) {
  const target = path.resolve(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  let after = before;
  if (change.write !== undefined) after = change.write;
  else if (change.append !== undefined) after = before + change.append;
  else if (change.replace) {
    const [from, to] = change.replace;
    if (!before.includes(from)) throw new Error(`${file}: text to replace not found`);
    after = before.replace(from, to);
  }
  fs.writeFileSync(target, after);
  return { target, before, after };
}

/** Runs a shell command for real; `onOutput` gets each chunk of stdout and stderr. */
export function runCommand(command, cwd, onOutput = () => {}) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    let output = '';
    const take = (chunk) => {
      const text = chunk.toString();
      output += text;
      onOutput(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Calls one tool on an MCP stdio server (Troupe's `troupe mcp`) and returns its text. */
export async function callTool(server, tool, args) {
  const env = { ...process.env, ...(server.env || {}) };
  const child = spawn(server.command, server.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'troupe-demo', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const reply = await request('tools/call', { name: tool, arguments: args });
  child.stdin.end();
  child.kill();
  return reply.result?.content?.map((part) => part.text).join('') ?? JSON.stringify(reply.error);
}
