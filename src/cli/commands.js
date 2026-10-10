// troupe subcommands. Everything that needs a project goes through an engine client,
// local or remote, so the same command works on this machine and over SSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Engine, VERSION } from '../engine/engine.js';
import { connectRemote, localClient, serveEngine, sshCommand } from '../engine/rpc.js';
import { PERMISSION_MODES, PROTOCOL_VERSION } from '../protocol/index.js';
import { loadConfig, troupeHome } from '../config.js';
import { starPromptFor } from '../star.js';
import { compareVersions, installKind, latestRelease, PACKAGE_ROOT, releaseUrl, updateCheckFor } from '../update.js';
import { openUrl } from '../util/open.js';
import { pickLang, setLang, t } from '../i18n/index.js';
import { engineText } from '../i18n/strings.js';
import { formatCount, oneLine, sanitize } from '../util/text.js';
import { parseArgs } from './args.js';

const COMMON = { boolean: ['help', 'version', 'shared', 'json', 'refresh', 'no-open', 'stdio', 'yes', 'force', 'check'], string: ['cwd', 'ssh', 'mode', 'lang', 'port', 'timeout', 'remote-command', 'host'], alias: { h: 'help', v: 'version', C: 'cwd' } };

export const HELP = `Troupe ${VERSION} — run coding agents side by side (${PROTOCOL_VERSION})

Usage
  troupe [dir]                    open the terminal UI for a project (default: here)
  troupe gui [dir]                open the web UI in your browser
  troupe run "<message>" [dir]    send a message, wait for the answers, print them
  troupe agents [dir]             list the agents on a project
  troupe detect                   list the coding agents installed on this machine
  troupe update [--check]         install the newest Troupe release (--check: only report it)
  troupe serve --stdio [dir]      serve a project over stdio (used for --ssh)
  troupe mcp                      collaboration tools (started by agents, not by you)

Messages
  @codex @claude review src/      several agents, one task, started together
  @codex fix the test             one line per agent: each does its own line
  @codex+ ...                     a fresh session instead of resuming
  @all / @auto / @compare:claude  every agent / let Troupe pick / compare the answers

Options
  --cwd <dir>        project directory
  --ssh <host>       run the agents on another machine (needs troupe installed there;
                     a relative --cwd starts from your home directory on that host)
  --remote-command <cmd>
                     with --ssh: how to start troupe there (default: troupe)
  --mode <mode>      permission mode for new agents: plan, ask, workspace (default), full
  --shared           new agents work in the project directory instead of worktrees
  --lang <en|zh>     interface language
  --port <n>         gui: port to listen on (default: any free port)
  --host <addr>      gui: 127.0.0.1 (default), ::1 or localhost
  --no-open          gui: print the address instead of opening a browser
  --json             run/agents/detect: print JSON
  --yes              run: allow everything agents ask for (same as --mode full)
  --timeout <sec>    run: give up after this many seconds (default 3600)
  --force            open a project whose lock names a live process (only if that
                     process is not a troupe using this project)
`;

function projectDir(flags, positionals) {
  const given = flags.cwd || positionals[0] || process.cwd();
  // A quoted '~/src/app' reaches `troupe serve` on an SSH host unexpanded.
  const dir = path.resolve(given === '~' || given.startsWith('~/') ? path.join(os.homedir(), given.slice(1)) : given);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return dir;
}

function configWithFlags(flags) {
  const config = loadConfig();
  if (flags.mode) {
    if (!PERMISSION_MODES.includes(flags.mode)) throw new Error(`--mode must be one of ${PERMISSION_MODES.join(', ')}`);
    config.defaults.mode = flags.mode;
  }
  if (flags.yes) config.defaults.mode = 'full';
  if (flags.shared) config.defaults.isolation = 'shared';
  return config;
}

/** A client for the project: an engine in this process, or one on another host over SSH. */
export async function openClient(flags, positionals) {
  if (flags.ssh) {
    const remoteCwd = flags.cwd || positionals[0] || null;
    const { command, args } = sshCommand(flags.ssh, { cwd: remoteCwd, remoteCommand: flags['remote-command'] || 'troupe' });
    return connectRemote({ command, args, label: `troupe on ${flags.ssh}` });
  }
  const engine = new Engine({ root: projectDir(flags, positionals), config: configWithFlags(flags) });
  await engine.open({ force: Boolean(flags.force) });
  return localClient(engine);
}

export async function run(argv) {
  let parsed;
  const [command, ...rest] = argv;
  const known = ['gui', 'run', 'agents', 'detect', 'serve', 'update', 'help', 'version'];
  const sub = known.includes(command) ? command : null;
  try {
    parsed = parseArgs(sub ? rest : argv, COMMON);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    return 2;
  }
  const { flags, positionals } = parsed;
  setLang(pickLang(flags.lang || loadConfig().lang));
  if (flags.version || sub === 'version') {
    process.stdout.write(`troupe ${VERSION} (${PROTOCOL_VERSION})\n`);
    return 0;
  }
  if (flags.help || sub === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  switch (sub) {
    case 'serve':
      return serve(flags, positionals);
    case 'detect':
      return detect(flags);
    case 'update':
      return update(flags);
    case 'agents':
      return agents(flags, positionals);
    case 'run':
      return runOnce(flags, positionals);
    case 'gui':
      return gui(flags, positionals);
    default:
      return tui(flags, positionals);
  }
}

async function serve(flags, positionals) {
  if (!flags.stdio) {
    process.stderr.write('troupe serve needs --stdio (the protocol runs over standard input and output)\n');
    return 2;
  }
  const engine = new Engine({ root: projectDir(flags, positionals), config: configWithFlags(flags) });
  await engine.open({ force: Boolean(flags.force) });
  await serveEngine(engine, { input: process.stdin, output: process.stdout });
  await engine.close();
  return 0;
}

async function detect(flags) {
  const engine = new Engine({ root: process.cwd(), config: configWithFlags(flags), collab: false });
  const list = await engine.detector.detectAll({ refresh: Boolean(flags.refresh) });
  if (flags.json) {
    process.stdout.write(JSON.stringify(list, null, 2) + '\n');
    return 0;
  }
  for (const p of list) {
    const mark = p.available ? '✓' : '·';
    const detail = p.available ? `${p.version || p.note || ''}${p.verified ? '' : `  (${t('provider.untested')})`}` : p.fix || p.reason;
    process.stdout.write(`${mark} ${p.id.padEnd(10)} ${p.name.padEnd(18)} ${p.protocol.padEnd(14)} ${detail}\n`);
  }
  return 0;
}

/** Installs the newest release the way the README does, or says how to update a checkout. */
async function update(flags) {
  let latest;
  try {
    latest = await latestRelease();
  } catch (error) {
    process.stderr.write(`${t('update.failed', { error: error.message })}\n`);
    return 1;
  }
  if (!latest || compareVersions(latest, VERSION) <= 0) {
    const ahead = latest && compareVersions(latest, VERSION) < 0;
    process.stdout.write(`${t(ahead ? 'update.ahead' : 'update.current', { version: VERSION, latest })}\n`);
    return 0;
  }
  process.stdout.write(`${t('update.available', { latest, current: VERSION })}\n`);
  if (flags.check) return 0;
  if (installKind() === 'source') {
    process.stdout.write(`${t('update.source', { dir: PACKAGE_ROOT })}\n`);
    return 0;
  }
  const command = `npm install -g ${releaseUrl(latest)}`;
  process.stdout.write(`${t('update.installing', { command })}\n`);
  // npm is a .cmd on Windows; the command line holds only a release URL Troupe built.
  const result = spawnSync('npm', ['install', '-g', releaseUrl(latest)], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.stderr.write(`${t('update.installFailed', { command })}\n`);
    return result.status || 1;
  }
  process.stdout.write(`${t('update.done', { version: latest })}\n`);
  return 0;
}

async function agents(flags, positionals) {
  const client = await openClient(flags, positionals);
  try {
    const snapshot = await client.call('snapshot');
    if (flags.json) {
      process.stdout.write(JSON.stringify(snapshot.agents, null, 2) + '\n');
      return 0;
    }
    if (!snapshot.agents.length) process.stdout.write(`${t('empty.noAgents')}\n`);
    for (const a of snapshot.agents) {
      const usage = a.usage?.output_tokens ? `  ${formatCount((a.usage.input_tokens || 0) + (a.usage.output_tokens || 0))} tok` : '';
      process.stdout.write(`@${a.name.padEnd(14)} ${a.providerName.padEnd(16)} ${a.state.padEnd(9)} ${a.mode.padEnd(9)} ${a.branch || '-'}${usage}\n`);
    }
    return 0;
  } finally {
    await client.close();
  }
}

/** Sends one message, follows it until every agent it reached is idle, prints the answers. */
async function runOnce(flags, positionals) {
  const [message, ...dirs] = positionals;
  if (!message) {
    process.stderr.write('troupe run needs a message, for example: troupe run "@codex fix the failing test"\n');
    return 2;
  }
  const client = await openClient(flags, dirs);
  const timeoutMs = (Number(flags.timeout) || 3600) * 1000;
  const touched = new Set();
  const answers = [];
  let lastWrite = '';
  const say = (line) => {
    if (flags.json) return;
    if (line !== lastWrite) process.stderr.write(`${line}\n`);
    lastWrite = line;
  };
  const unsubscribe = client.subscribe((event) => {
    if (event.type === 'agent.message' && touched.has(event.agentId)) {
      const entry = event.entry;
      if (entry.role === 'assistant' || entry.role === 'error' || entry.role === 'gate') answers.push({ agentId: event.agentId, ...entry });
    }
    if (event.type === 'agent.activity' && touched.has(event.agentId) && event.activity.status === 'running') say(`  … ${oneLine(event.activity.title, 100)}`);
    if (event.type === 'approval.requested') {
      const a = event.approval;
      // Unattended runs never block on a person: --yes allows, otherwise the request is denied.
      const choice = flags.yes ? 'allow_once' : 'deny';
      say(`  ! @${a.agentName} asked: ${oneLine(a.title, 100)} — ${flags.yes ? 'allowed (--yes)' : 'denied (use --yes to allow)'}`);
      client.call('approve', { id: a.id, choice }).catch(() => {});
    }
    if (event.type === 'decision.requested') say(`  ? @${event.decision.agentName} asks you: ${oneLine(event.decision.question, 160)} (answer it in troupe or troupe gui)`);
    if (event.type === 'notice') say(`  ${event.level === 'error' ? '✖' : '·'} ${oneLine(engineText(event, t), 160)}`);
  });
  try {
    const result = await client.call('send', { text: message });
    for (const d of result.dispatched) {
      touched.add(d.agentId);
      say(`→ @${d.agent}${d.created ? ` (${d.provider}${d.branch ? `, ${d.branch}` : ''})` : ''}`);
    }
    for (const s of result.skipped) say(`  skipped ${s.target}: ${s.reason}`);
    const started = Date.now();
    // Idle means: not running, nothing queued, not being checked, for two polls in a row.
    let quiet = 0;
    while (quiet < 2) {
      if (Date.now() - started > timeoutMs) throw new Error(`gave up after ${Math.round(timeoutMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const snapshot = await client.call('snapshot');
      const busy = snapshot.agents.filter((a) => touched.has(a.id) && (a.state === 'running' || a.state === 'starting' || a.queue > 0 || a.checking));
      quiet = busy.length ? 0 : quiet + 1;
    }
    const snapshot = await client.call('snapshot');
    const names = new Map(snapshot.agents.map((a) => [a.id, a.name]));
    if (flags.json) {
      process.stdout.write(JSON.stringify({ dispatched: result.dispatched, skipped: result.skipped, answers: answers.map((a) => ({ agent: names.get(a.agentId), role: a.role, text: a.text, code: a.code || null })) }, null, 2) + '\n');
    } else {
      for (const a of answers) {
        process.stdout.write(`\n── @${names.get(a.agentId)}${a.role === 'error' ? ' (error)' : a.role === 'gate' ? ' (goal check)' : ''} ──\n${sanitize(a.text)}\n`);
      }
    }
    return answers.some((a) => a.role === 'error') ? 1 : 0;
  } finally {
    unsubscribe();
    await client.close();
  }
}

async function gui(flags, positionals) {
  const { startGui } = await import('../gui/server.js');
  const client = await openClient(flags, positionals);
  const config = loadConfig();
  const star = starPromptFor({ home: troupeHome(), config });
  const updates = updateCheckFor({ home: troupeHome(), config, current: VERSION });
  const server = await startGui({ client, port: flags.port ? Number(flags.port) : 0, host: flags.host || '127.0.0.1', lang: pickLang(flags.lang || config.lang), star, update: updates });
  process.stdout.write(`${t('gui.listening', { url: server.url })}\n`);
  if (!flags['no-open']) server.openBrowser();
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.close();
  await client.close();
  return 0;
}

async function tui(flags, positionals) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('The terminal UI needs an interactive terminal. Use `troupe run "<message>"` or `troupe gui` instead.\n');
    return 2;
  }
  const { runTui } = await import('../tui/app.js');
  const client = await openClient(flags, positionals);
  try {
    const config = loadConfig();
    await runTui({ client, lang: pickLang(flags.lang || config.lang), star: starPromptFor({ home: troupeHome(), config }), update: updateCheckFor({ home: troupeHome(), config, current: VERSION }), openUrl });
  } finally {
    await client.close();
  }
  return 0;
}
