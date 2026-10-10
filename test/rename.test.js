import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {crossHarnessHome, loadConfig} from '../src/config.js';
import {tempDir} from './helpers.js';

test('renamed installations keep existing worktree paths and custom configuration', (t) => {
 const home=tempDir(t);
 const legacy=path.join(home,'.troupe');
 assert.equal(crossHarnessHome({HOME:home}),path.join(home,'.cross-harness'));
 fs.mkdirSync(legacy);
 fs.writeFileSync(path.join(legacy,'config.json'),JSON.stringify({lang:'zh',defaults:{mode:'ask'}}));
 assert.equal(crossHarnessHome({HOME:home}),legacy);
 assert.equal(loadConfig({HOME:home}).defaults.mode,'ask');
 assert.equal(crossHarnessHome({HOME:home,TROUPE_HOME:legacy}),legacy);
 const current=path.join(home,'.cross-harness');fs.mkdirSync(current);
 assert.equal(crossHarnessHome({HOME:home}),current);
 assert.equal(crossHarnessHome({HOME:home,TROUPE_HOME:legacy,CROSS_HARNESS_HOME:current}),current);
});
