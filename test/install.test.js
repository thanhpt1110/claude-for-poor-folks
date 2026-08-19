import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInstall, runUninstall } from '../src/cli/install.js';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorclaude-install-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  process.chdir(dir);
  return { dir, settings: path.join(dir, '.claude', 'settings.json') };
}

/** @template T @param {() => T} fn @returns {T} */
const quiet = fn => {
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = w; }
};

test('install then uninstall leaves the user settings exactly as found', () => {
  const cwd = process.cwd();
  const { settings } = sandbox();
  const original = {
    env: { FOO: 'bar' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }]
    }
  };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2) + '\n');

  quiet(() => runInstall([]));
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(after.statusLine.command.includes('statusline'));
  assert.equal(after.hooks.PreToolUse.length, 2, 'ours is added next to theirs');
  assert.ok(after.hooks.SessionStart && after.hooks.Stop);

  quiet(() => runUninstall([]));
  const restored = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(restored, original, 'uninstall must be exact');
  process.chdir(cwd);
});

test('an existing status line is never clobbered without --force', () => {
  const cwd = process.cwd();
  const { settings } = sandbox();
  const mine = { type: 'command', command: 'my-fancy-statusline.sh' };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: mine }, null, 2));

  quiet(() => runInstall([]));
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine, mine);

  quiet(() => runInstall(['--force']));
  assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command.includes('statusline'));
  process.chdir(cwd);
});

test('installing twice does not duplicate hooks', () => {
  const cwd = process.cwd();
  const { settings } = sandbox();
  quiet(() => runInstall([]));
  quiet(() => runInstall([]));
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  for (const [event, list] of Object.entries(after.hooks)) {
    assert.equal(list.length, 1, `${event} duplicated`);
  }
  process.chdir(cwd);
});

test('the backup written before any change is byte-identical to the original', () => {
  // This used to assert only that a file existed, so a backup() writing the
  // wrong bytes — or nothing — would have passed.
  const cwd = process.cwd();
  try {
    const { dir, settings } = sandbox();
    const original = JSON.stringify({ env: { A: '1' }, statusLine: { type: 'command', command: 'mine.sh' } }, null, 2);
    fs.writeFileSync(settings, original);

    quiet(() => runInstall([]));
    const backups = fs.readdirSync(path.join(dir, '.claude')).filter(f => f.includes('.bak-poor-folks-'));
    assert.equal(backups.length, 1, 'exactly one backup');
    assert.ok(!backups[0].endsWith('.'), 'no trailing dot in the timestamp');
    assert.equal(fs.readFileSync(path.join(dir, '.claude', backups[0]), 'utf8'), original,
      'the backup must be what was there before, byte for byte');
  } finally {
    process.chdir(cwd);
  }
});

test('init with piped stdin writes a config instead of silently doing nothing', async () => {
  // Found by a first-time user, not by a code review: piped stdin fell into the
  // interactive branch, answered nothing, wrote nothing and exited 0. A tool
  // whose whole purpose is to stop silent failures must not fail silently.
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-init-'));
  try {
    process.chdir(dir);
    process.env.POOR_FOLKS_HOME = dir;
    const { runInit } = await import('../src/cli/init.js');
    await quiet(() => runInit([]));            // no --yes, and stdin is not a TTY here
    const written = path.join(dir, '.poor-folks.json');
    assert.ok(fs.existsSync(written), 'a config must exist afterwards');
    const cfg = JSON.parse(fs.readFileSync(written, 'utf8'));
    assert.equal(cfg.version, 1);
    assert.equal(cfg.askProfile, false, 'and it must keep the zero-token default');
  } finally {
    process.chdir(cwd);
  }
});
