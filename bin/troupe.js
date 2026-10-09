#!/usr/bin/env node
import { main } from '../src/cli/main.js';

main(process.argv.slice(2)).then(
  (code) => {
    if (Number.isInteger(code)) process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`troupe: ${error?.message || error}\n`);
    process.exitCode = 1;
  },
);
