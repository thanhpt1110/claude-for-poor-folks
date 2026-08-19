import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.js';
import { handle } from '../src/cli/hook.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const CLI = path.join(SRC, 'cli', 'index.js');

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : (e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

test('nothing in src/ can reach the network', () => {
  // The README promises this in so many words. Promises belong in tests.
  const forbidden = /\b(fetch|XMLHttpRequest)\s*\(|require\(['"](node:)?(http|https|net|dgram|tls)['"]|from\s+['"](node:)?(http|https|net|dgram|tls)['"]/;
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!forbidden.test(text), `${path.relative(SRC, file)} looks like it can talk to the network`);
    assert.ok(!/https?:\/\/(?!\S*claude\.com|\S*npmjs\.com|\S*github\.com)/.test(text.replace(/^\s*\/\/.*$/gm, '')),
      `${path.relative(SRC, file)} contains a non-documentation URL`);
  }
});

test('the package has no dependencies at all', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
});

test('by default NOT ONE TOKEN is added to the conversation', () => {
  // Measured on a real session: `additionalContext` is visible to the model and
  // is therefore billed; `systemMessage` is shown only to the human and is not.
  // A tool that spends tokens to save tokens is a fraud, so the default config
  // must never emit the former, on any event.
  tmpHome();
  const base = { session_id: 'z', cwd: os.tmpdir(), transcript_path: '' };
  /** @type {Array<[string, Partial<import('../src/types.js').HookPayload>]>} */
  const events = [
    ['SessionStart', { ...base, source: 'startup' }],
    ['UserPromptSubmit', { ...base, prompt: 'làm cái này đi' }],
    ['UserPromptSubmit', { ...base, prompt: 'refactor everything and migrate it' }],
    ['PreToolUse', { ...base, tool_name: 'Bash' }],
    ['SubagentStart', base],
    ['PreCompact', base],
    ['Stop', base],
    ['SessionEnd', base]
  ];
  for (const [event, payload] of events) {
    const res = handle(event, payload) || {};
    const injected = res.hookSpecificOutput?.additionalContext
      ?? /** @type {any} */ (res).additionalContext;
    assert.equal(injected, undefined, `${event} tried to put text in front of the model`);
  }
});

test('the one opt-in message that does cost is capped in size', () => {
  const home = tmpHome();
  fs.writeFileSync(`${home}/config.json`, JSON.stringify({ askProfile: true }));
  const res = handle('UserPromptSubmit', { session_id: 'q', cwd: os.tmpdir(), prompt: 'ok' });
  const text = res.hookSpecificOutput?.additionalContext || '';
  assert.ok(text.length > 0, 'opt-in should actually opt in');
  assert.ok(text.length < 400, `injected ${text.length} chars; the user pays for every one`);
});

/** @param {string[]} args @param {string} input */
const run = (args, input) => {
  const env = { ...process.env, POOR_FOLKS_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-cli-')) };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { input, env, stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, stdout: stdout.toString() };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.status, stdout: (err.stdout || '').toString(), stderr: (err.stderr || '').toString() };
  }
};

test('hooks exit 0 on every kind of rubbish input', () => {
  for (const input of ['', 'garbage', '{', 'null', '[]', '{"session_id":null}', '{"transcript_path":"/nope/none.jsonl"}']) {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd', 'MadeUpFutureEvent']) {
      const r = run(['hook', event], input);
      assert.equal(r.code, 0, `hook ${event} with input ${JSON.stringify(input)} exited ${r.code}`);
    }
  }
});

test('the status line exits 0 and prints at most one line, whatever it is fed', () => {
  for (const input of ['', 'garbage', '{}', '{"cost":{"total_cost_usd":"free"}}', '{"session_id":"x","context_window":[]}']) {
    const r = run(['statusline'], input);
    assert.equal(r.code, 0, `statusline exited ${r.code} on ${JSON.stringify(input)}`);
    assert.ok(!r.stdout.includes('\n'), 'a status line must stay one line');
  }
});

test('an unknown command prints help and does not pretend to have worked', () => {
  const r = run(['nonsense-command'], '');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage/);
});
