import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_PROVIDERS, buildRegistry, providerList, validateProvider } from '../src/providers/registry.js';
import { createDetector, parseVersion, resolveExecutable } from '../src/providers/detect.js';
import { loadConfig, projectId } from '../src/config.js';
import { CODES } from '../src/protocol/errors.js';
import { NODE, tempDir } from './helpers.js';

test('built-in providers are valid and ranked', () => {
  for (const provider of Object.values(BUILTIN_PROVIDERS)) validateProvider({ ...provider });
  const list = providerList(buildRegistry());
  assert.equal(list[0].id, 'bizos');
  assert.equal(list[1].id, 'claude');
  assert.ok(list.find((p) => p.id === 'codex').verified);
  assert.equal(list.find((p) => p.id === 'gemini').verified, false);
});

test('BizOS Code is built in and started as an ACP agent', () => {
  const bizos = buildRegistry().bizos;
  assert.equal(bizos.name, 'BizOS Code');
  assert.equal(bizos.command, 'bizos');
  assert.equal(bizos.protocol, 'acp');
  assert.deepEqual(bizos.args, ['acp']);
  assert.equal(bizos.verified, true);
  assert.match(bizos.install, /code\.bizos-ai\.com/);
  assert.match(bizos.signIn, /bizos login/);
});

test('user config can add a closed runner and override built-in fields', () => {
  const registry = buildRegistry({
    acme: { name: 'Acme Agent', command: 'acme-agent', protocol: 'acp', args: ['--acp'] },
    codex: { args: ['-c', 'model_reasoning_effort=high'] },
  });
  assert.equal(registry.acme.custom, true);
  assert.equal(registry.acme.protocol, 'acp');
  assert.deepEqual(registry.codex.args, ['-c', 'model_reasoning_effort=high']);
  assert.equal(registry.codex.protocol, 'codex-app');
  assert.throws(() => buildRegistry({ broken: { name: 'x', command: 'x', protocol: 'telepathy' } }), (error) => error.code === CODES.ARGUMENT_INVALID);
  assert.throws(() => buildRegistry({ e: { name: 'E', command: 'e', protocol: 'exec', exec: { args: ['no prompt'] } } }), /exec.args/);
});

test('custom one-shot harnesses default to the modes they map to flags', () => {
  const registry = buildRegistry({
    once: { name: 'Once', command: 'once', protocol: 'exec', exec: { args: ['{prompt}'] } },
    careful: { name: 'Careful', command: 'careful', protocol: 'exec', exec: { args: ['{prompt}'], modeArgs: { plan: ['--dry-run'] } } },
  });
  assert.deepEqual(registry.once.modes, ['full']);
  assert.deepEqual(registry.careful.modes, ['plan', 'full']);
});

test('executables resolve from PATH and absolute paths', (t) => {
  const dir = tempDir(t);
  const tool = path.join(dir, 'fake-agent');
  fs.writeFileSync(tool, '#!/bin/sh\necho "fake-agent 1.2.3"\n', { mode: 0o755 });
  const env = { PATH: dir, HOME: dir };
  assert.equal(resolveExecutable('fake-agent', env), tool);
  assert.equal(resolveExecutable(tool, env), tool);
  assert.equal(resolveExecutable('missing-agent', env), null);
  assert.equal(resolveExecutable('../escape', env), null);
});

test('detection reports versions, missing tools and caches results', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'fake-agent'), '#!/bin/sh\necho "fake-agent version 1.2.3"\n', { mode: 0o755 });
  const registry = buildRegistry({
    fake: { name: 'Fake', command: 'fake-agent', protocol: 'acp' },
    gone: { name: 'Gone', command: 'not-installed-anywhere', protocol: 'acp', install: 'npm i -g gone' },
  });
  let probes = 0;
  const detector = createDetector({
    registry: { fake: registry.fake, gone: registry.gone },
    env: { PATH: dir, HOME: dir },
    probe: async (...args) => {
      probes++;
      const { runCommand } = await import('../src/util/process.js');
      return runCommand(...args);
    },
  });
  const [fake, gone] = await Promise.all([detector.detect('fake'), detector.detect('gone')]);
  assert.equal(fake.available, true);
  assert.equal(fake.version, '1.2.3');
  assert.equal(gone.available, false);
  assert.equal(gone.reason, 'not-installed');
  assert.equal(gone.fix, 'npm i -g gone');
  await detector.detect('fake');
  assert.equal(probes, 1, 'cached');
  await detector.detect('fake', { refresh: true });
  assert.equal(probes, 2);
  const all = await detector.detectAll();
  assert.equal(all[0].id, 'fake');
});

test('versions are parsed from typical --version output', () => {
  assert.equal(parseVersion('codex-cli 0.159.1'), '0.159.1');
  assert.equal(parseVersion('2.1.4 (Claude Code)'), '2.1.4');
  assert.equal(parseVersion('dsh v0.1.7-rc.2'), '0.1.7-rc.2');
  assert.equal(parseVersion('no digits'), null);
  assert.ok(parseVersion(NODE ? 'v24.3.0' : ''));
});

test('config loads defaults and ignores invalid values', (t) => {
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'full', maxPerProvider: 2, isolation: 'nowhere' }, providers: { x: {} }, lang: 'zh' }));
  const config = loadConfig({ TROUPE_HOME: home });
  assert.equal(config.defaults.mode, 'full');
  assert.equal(config.defaults.maxPerProvider, 2);
  assert.equal(config.defaults.isolation, 'worktree');
  assert.equal(config.lang, 'zh');
  assert.match(projectId(home), /^troupe-test-.+-[0-9a-f]{12}$/);
});
