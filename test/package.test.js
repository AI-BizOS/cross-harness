// What `npm install` ships: the entry points resolve, the bin runs, and the public API
// is what the documentation says it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NODE, ROOT } from './helpers.js';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('package entry points exist and load', async () => {
  for (const target of Object.values(pkg.exports)) assert.ok(fs.existsSync(path.join(ROOT, target)), target);
  const api = await import(pkg.name);
  for (const name of ['Engine', 'METHODS', 'VERSION', 'PROTOCOL_VERSION', 'CODES', 'localClient', 'serveEngine', 'connectRemote', 'sshCommand', 'createSession', 'buildRegistry', 'createDetector', 'loadConfig', 'startGui', 'runTui']) {
    assert.ok(api[name] !== undefined, `${name} is exported`);
  }
  assert.equal(api.VERSION, pkg.version);
  assert.equal(api.PROTOCOL_VERSION, 'cross-harness/1');
  const protocol = await import(`${pkg.name}/protocol`);
  assert.deepEqual(protocol.PERMISSION_MODES, ['plan', 'ask', 'workspace', 'full']);
});

test('the cross-harness command prints its version without opening anything', () => {
  const result = spawnSync(NODE, [path.join(ROOT, pkg.bin['cross-harness']), '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), `cross-harness ${pkg.version} (cross-harness/1)`);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(pkg.dependencies, undefined, 'no runtime dependencies');
});
