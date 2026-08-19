#!/usr/bin/env node
/**
 * Run the test suite on every supported platform and Node version.
 *
 * `node --test "test/*.test.js"` only works from Node 22 — Node 20 does not
 * expand the glob and reports "Could not find". Leaving the glob unquoted hands
 * the job to the shell, which works in bash but not in cmd.exe or PowerShell.
 * And pointing `--test` at the directory sweeps in every file under `test/`,
 * including the benchmark and the shared helpers, because Node treats anything
 * inside a directory named `test` as a test file.
 *
 * So the file list is built here, where the rules are the same everywhere.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test');
const files = readdirSync(testDir)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join(testDir, name));

if (files.length === 0) {
  process.stderr.write('no test files found\n');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
