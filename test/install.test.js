import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInstall, runUninstall, runDoctor } from '../src/cli/install.js';

const HERE_INSTALL = path.dirname(fileURLToPath(import.meta.url));

/** @param {string|undefined} prev */
const restoreHome = prev => {
  if (prev === undefined) delete process.env.POOR_FOLKS_HOME;
  else process.env.POOR_FOLKS_HOME = prev;
};

/** @param {() => any} fn @returns {Promise<string>} */
const capture = async fn => {
  /** @type {string[]} */
  const chunks = [];
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = (/** @type {any} */ s) => { chunks.push(String(s)); return true; };
  try { await fn(); } finally { process.stdout.write = w; }
  return chunks.join('');
};

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


test('installing from npm also brings the skill the plugin channel ships', () => {
  // Neither channel is complete alone: a plugin manifest cannot declare a status
  // line, and an npm install carries no skill. This closes the npm half.
  const cwd = process.cwd();
  try {
    const { dir } = sandbox();
    quiet(() => runInstall([]));
    const skill = path.join(dir, '.claude', 'skills', 'poor-folks-review', 'SKILL.md');
    assert.ok(fs.existsSync(skill), 'the skill must be installed alongside the hooks');
    const body = fs.readFileSync(skill, 'utf8');
    assert.match(body, /disable-model-invocation:\s*true/, 'and it must stay explicit-invocation only');
  } finally { process.chdir(cwd); }
});

test('a skill already sitting at that path is never overwritten or deleted', () => {
  // The path belongs to the user, not to this tool.
  const cwd = process.cwd();
  try {
    const { dir } = sandbox();
    const target = path.join(dir, '.claude', 'skills', 'poor-folks-review', 'SKILL.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'someone else wrote this');

    quiet(() => runInstall([]));
    assert.equal(fs.readFileSync(target, 'utf8'), 'someone else wrote this', 'install must not overwrite it');

    quiet(() => runUninstall([]));
    assert.ok(fs.existsSync(target), 'uninstall must not delete it either');
  } finally { process.chdir(cwd); }
});

test('uninstall takes back the skill it installed', () => {
  const cwd = process.cwd();
  try {
    const { dir } = sandbox();
    quiet(() => runInstall([]));
    quiet(() => runUninstall([]));
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills', 'poor-folks-review')),
      'our own skill should be gone');
  } finally { process.chdir(cwd); }
});

test('the plugin ships an executable that works without npm',
  { skip: process.platform === 'win32' && 'POSIX shim; Windows parity is not claimed' }, () => {
  // `bin/` lands on the Bash tool's PATH while a plugin is enabled, so someone
  // who never ran npm can still use the CLI. Verified on Linux and macOS; the
  // wrapper is `#!/bin/sh`, and no Windows machine was available to test it, so
  // the README does not claim it works there.
  const bin = path.join(HERE_INSTALL, '..', 'bin', 'claude-for-poor-folks');
  assert.ok(fs.existsSync(bin), 'bin/claude-for-poor-folks must exist');
  assert.ok((fs.statSync(bin).mode & 0o111) !== 0, 'and it must be executable');
  const out = execFileSync(bin, ['--version']).toString().trim();
  assert.match(out, /^\d+\.\d+\.\d+$/, `expected a version, got ${out}`);
});


test('--status-line-only adds the one thing a plugin cannot, and nothing else', () => {
  // A plugin already supplies the eight hooks, and its copies are not in
  // settings.json, so a full install cannot see them to dedupe and would wire
  // every hook a second time: doubled banners, doubled latency, and a daily
  // total inflated by two Stop hooks appending the same delta.
  const cwd = process.cwd();
  try {
    const { dir, settings } = sandbox();
    fs.writeFileSync(settings, '{}');
    quiet(() => runInstall(['--status-line-only']));

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.ok(after.statusLine, 'the status line is the point');
    assert.equal(Object.keys(after.hooks || {}).length, 0, 'no hooks may be added');
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills', 'poor-folks-review')),
      'and no skill either — the plugin already has one');
  } finally { process.chdir(cwd); }
});

test('a full install still wires everything', () => {
  const cwd = process.cwd();
  try {
    const { dir, settings } = sandbox();
    fs.writeFileSync(settings, '{}');
    quiet(() => runInstall([]));
    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    // A count told you a number changed; it never told you WHICH event went
    // missing. The list does, and it is the thing that has to stay in step with
    // the plugin manifest.
    assert.deepEqual(Object.keys(after.hooks).sort(), [
      'PostToolUse', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart',
      'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'
    ]);
    assert.ok(after.statusLine);
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'poor-folks-review', 'SKILL.md')));
  } finally { process.chdir(cwd); }
});

test('uninstall removes only the file it wrote, not the directory around it', () => {
  const cwd = process.cwd();
  try {
    const { dir } = sandbox();
    quiet(() => runInstall([]));
    const skillDir = path.join(dir, '.claude', 'skills', 'poor-folks-review');
    fs.writeFileSync(path.join(skillDir, 'notes-of-my-own.md'), 'mine');

    quiet(() => runUninstall([]));
    assert.ok(!fs.existsSync(path.join(skillDir, 'SKILL.md')), 'ours goes');
    assert.ok(fs.existsSync(path.join(skillDir, 'notes-of-my-own.md')), 'theirs stays');
  } finally { process.chdir(cwd); }
});

test('both shipped executables work directly and through a symlink',
  { skip: process.platform === 'win32' && 'POSIX exec bits and symlinks' }, () => {
  // `npm pack` drops symlinks and a Windows checkout cannot make them, so both
  // are real files; and an alias placed elsewhere on PATH must still resolve
  // back to the package rather than look beside itself.
  const binDir = path.join(HERE_INSTALL, '..', 'bin');
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-bin-'));
  for (const name of ['claude-for-poor-folks', 'pclaude']) {
    const real = path.join(binDir, name);
    assert.ok(fs.existsSync(real) && !fs.lstatSync(real).isSymbolicLink(), `${name} must be a real file`);
    assert.ok((fs.statSync(real).mode & 0o111) !== 0, `${name} must be executable`);
    assert.match(execFileSync(real, ['--version']).toString().trim(), /^\d+\.\d+\.\d+$/);

    const alias = path.join(link, `alias-${name}`);
    fs.symlinkSync(real, alias);
    assert.match(execFileSync(alias, ['--version']).toString().trim(), /^\d+\.\d+\.\d+$/,
      `${name} must survive being reached through a symlink`);
  }
});


test('doctor never sends a plugin user into a second set of hooks', async () => {
  // The notice fires once per project and names doctor as the lasting fallback,
  // so doctor had to stop saying "run install" — a plugin's hooks come from its
  // manifest, are invisible here, and a full install would wire all eight again.
  const cwd = process.cwd();
  try {
    const { settings } = sandbox();
    fs.writeFileSync(settings, '{}');
    const out = await capture(() => runDoctor([]));
    assert.match(out, /--status-line-only/, 'the plugin case must be offered');
    assert.match(out, /Otherwise you need everything/, 'and the fresh-machine case too');
    assert.ok(!/^\s*note\s+nothing is wired yet — run: claude-for-poor-folks install$/m.test(out),
      'it must not give the bare full-install instruction');
  } finally { process.chdir(cwd); }
});

test('doctor calls an empty status-line slot empty, not somebody else\'s', async () => {
  const cwd = process.cwd();
  try {
    const { settings } = sandbox();
    fs.writeFileSync(settings, '{}');
    const out = await capture(() => runDoctor([]));
    assert.match(out, /statusLine: empty/);
    assert.ok(!/someone else's/.test(out), 'nobody else is there');
  } finally { process.chdir(cwd); }
});

test('doctor tells someone with hooks but no status line exactly which flag to use', async () => {
  const cwd = process.cwd();
  try {
    const { settings } = sandbox();
    fs.writeFileSync(settings, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x #poor-folks' }] }] }
    }));
    const out = await capture(() => runDoctor([]));
    assert.match(out, /hooks are wired but the status line is not/);
    assert.match(out, /--status-line-only/);
  } finally { process.chdir(cwd); }
});

test('doctor says --force when the slot is taken by someone else', async () => {
  const cwd = process.cwd();
  try {
    const { settings } = sandbox();
    fs.writeFileSync(settings, JSON.stringify({
      statusLine: { type: 'command', command: 'their-own.sh' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x #poor-folks' }] }] }
    }));
    const out = await capture(() => runDoctor([]));
    assert.match(out, /--force/, 'because install refuses to replace it otherwise');
  } finally { process.chdir(cwd); }
});

test('a fully wired install gives doctor nothing to complain about', async () => {
  const cwd = process.cwd();
  try {
    sandbox();
    quiet(() => runInstall([]));
    const out = await capture(() => runDoctor([]));
    assert.ok(!/note /.test(out), `doctor should be quiet, got: ${out}`);
  } finally { process.chdir(cwd); }
});

test('--status-line-only warns when nothing supplies the hooks', async () => {
  // Without hooks from somewhere the meter renders defaults forever.
  const cwd = process.cwd();
  try {
    const { settings } = sandbox();
    fs.writeFileSync(settings, '{}');
    const out = await capture(() => runInstall(['--status-line-only']));
    assert.match(out, /no hooks found in settings.json/);
    assert.ok(!('hooks' in JSON.parse(fs.readFileSync(settings, 'utf8'))),
      'and it must not leave an empty hooks key behind');
  } finally { process.chdir(cwd); }
});

test('doctor reports settings that are being ignored', async () => {
  // doctor now reads the GLOBAL config too, so without this the suite fails on
  // any machine whose own config has a typo — i.e. exactly the contributor this
  // feature was written for.
  const prevHome = process.env.POOR_FOLKS_HOME;
  process.env.POOR_FOLKS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'poorclaude-home-'));
  // These warnings were generated and then thrown away: `_warnings` had no
  // reader anywhere in the codebase, so a config half-ignored looked identical
  // to a config fully honoured — including to doctor, which said "ok".
  const cwd = process.cwd();
  try {
    const { dir, settings } = sandbox();
    fs.writeFileSync(settings, '{}');
    fs.writeFileSync(path.join(dir, '.poor-folks.json'), JSON.stringify({ budgetUsd: 0.5 }));
    const out = await capture(() => runDoctor([]));
    assert.match(out, /budgetUsd: not a setting/, 'the dead key is named');
    assert.match(out, /budget\.sessionUsd/, 'and the live one is offered');
    assert.match(out, /\.poor-folks\.json/, 'and the file to fix is pointed at');
  } finally { process.chdir(cwd); restoreHome(prevHome); }
});

test('doctor stays quiet when the config is correct', async () => {
  // doctor now reads the GLOBAL config too, so without this the suite fails on
  // any machine whose own config has a typo — i.e. exactly the contributor this
  // feature was written for.
  const prevHome = process.env.POOR_FOLKS_HOME;
  process.env.POOR_FOLKS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'poorclaude-home-'));
  const cwd = process.cwd();
  try {
    const { dir, settings } = sandbox();
    fs.writeFileSync(settings, '{}');
    fs.writeFileSync(path.join(dir, '.poor-folks.json'), JSON.stringify({ budget: { sessionUsd: 5 } }));
    const out = await capture(() => runDoctor([]));
    assert.ok(!/not a setting/.test(out), 'nothing is wrong, so nothing is said');
  } finally { process.chdir(cwd); restoreHome(prevHome); }
});

test('both install routes declare the same hooks', () => {
  // The npm route reads HOOK_EVENTS in install.js; the plugin route reads
  // .claude-plugin/plugin.json. They are edited by hand, in different files, and
  // nothing connected them — so adding an event to one and forgetting the other
  // gave plugin users a quietly different tool. Whichever way you installed it,
  // the same things must run.
  const cwd = process.cwd();
  try {
    const { settings } = sandbox();
    fs.writeFileSync(settings, '{}');
    quiet(() => runInstall([]));
    const viaNpm = Object.keys(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks).sort();
    const manifest = JSON.parse(fs.readFileSync(path.join(HERE_INSTALL, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    const viaPlugin = Object.keys(manifest.hooks).sort();
    assert.deepEqual(viaPlugin, viaNpm, 'plugin.json and HOOK_EVENTS have drifted apart');
  } finally { process.chdir(cwd); }
});
