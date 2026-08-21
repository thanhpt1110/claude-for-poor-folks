import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './helpers.js';
import { handle } from '../src/cli/hook.js';
import { writeSnapshot, emptySnapshot } from '../src/io/state.js';

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
    ['PostToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok' }],
    ['SubagentStart', base],
    ['SubagentStop', base],
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

test('every message the tool prints carries the same prefix', () => {
  // A package-wide rename left `signalBlock` defaulting to one prefix while the
  // hook's own notes used another, so a single session printed both
  // "[poor-folks]" and "[claude-for-poor-folks]". Nobody reads their own output
  // closely enough to catch that; a test does.
  tmpHome();
  /** @type {Partial<import('../src/types.js').HookPayload>} */
  const base = { session_id: 'prefix', cwd: os.tmpdir(), source: 'startup' };
  handle('SessionStart', base);
  handle('UserPromptSubmit', { ...base, prompt: 'fix the bug in auth.ts' });

  writeSnapshot({ ...emptySnapshot('prefix'), costUsd: 5 });

  const messages = [
    handle('SessionStart', base).systemMessage,
    handle('PreToolUse', { ...base, tool_name: 'Bash' }).systemMessage,
    handle('PreCompact', base).systemMessage
  ].filter(Boolean);

  assert.ok(messages.length >= 2, 'expected the tool to say something');
  for (const m of messages) {
    const prefixes = [...String(m).matchAll(/\[([a-z-]+)\]/g)].map(x => x[1]);
    for (const p of prefixes) {
      assert.equal(p, 'poor-folks', `printed "[${p}]" — the tool must speak with one name`);
    }
  }
});

test('the bundled skill can only be invoked by hand, never by the model', () => {
  // This is the one part of the package that puts text in front of a model, so
  // it costs the user tokens. A skill without `disable-model-invocation` can be
  // pulled in automatically whenever Claude decides it is relevant — which is
  // exactly the silent, unannounced spending this tool exists to prevent.
  const skill = fs.readFileSync(path.join(HERE, '..', 'skills', 'review', 'SKILL.md'), 'utf8');
  const frontmatter = skill.split('---')[1] || '';

  assert.match(frontmatter, /disable-model-invocation:\s*true/,
    'the skill must be explicit-invocation only');
  assert.match(frontmatter, /description:/);
  assert.match(frontmatter, /token/i,
    'the description must tell the user it costs tokens before they run it');
});

test('the skill is the only thing in the package that addresses a model', () => {
  // Everything else stays on the free channel. If a second skill or an always-on
  // prompt appears, this fails and someone has to justify it.
  const root = path.join(HERE, '..');
  const skillsDir = path.join(root, 'skills');
  const skills = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : [];
  assert.deepEqual(skills, ['review'], `unexpected skills: ${skills.join(', ')}`);
  assert.ok(!fs.existsSync(path.join(root, 'agents')), 'no bundled agents');
  assert.ok(!fs.existsSync(path.join(root, 'commands')), 'no bundled commands');
});

test('nothing a tool was called with is ever written to disk', () => {
  // SECURITY.md promises that prompts and code are never stored and that no API
  // key is ever touched. A Bash tool_input IS a command line and an Edit
  // tool_input IS the user's source, so recording even a truncated sample of one
  // makes both sentences false — on disk, and again in `report --json`.
  // The fixtures below are deliberately NOT shaped like real credentials. An
  // earlier version used a payment provider's live-key prefix and a key-looking
  // assignment; secret scanners match on shape rather than intent, so this
  // repository — whose pitch is that it never touches a key — was reported as
  // leaking one. The assertion only needs a string unique enough to grep for.
  // Realism bought nothing and cost a permanent false positive.
  const home = tmpHome();
  const secret = 'fixture-not-a-credential-9f8e7d6c5b4a';
  const code = "greeting = 'fixture-not-a-credential-in-source'";
  for (let i = 0; i < 2; i++) {
    handle('PostToolUse', {
      hook_event_name: 'PostToolUse', session_id: 'sec', cwd: home,
      tool_name: 'Bash', tool_input: { command: `curl -H 'Authorization: Bearer ${secret}' https://x` }
    }, 500);
    handle('PostToolUse', {
      hook_event_name: 'PostToolUse', session_id: 'sec', cwd: home,
      tool_name: 'Edit', tool_input: { file_path: '/a.js', new_string: code }
    }, 500);
  }
  const written = fs.readdirSync(path.join(home, 'sessions'))
    .map(f => fs.readFileSync(path.join(home, 'sessions', f), 'utf8')).join('\n');
  for (const leak of [secret, code, 'curl', 'Authorization', 'fixture-not-a-credential']) {
    assert.ok(!written.includes(leak), `"${leak}" reached the state file`);
  }
  // and the count still works, which is the whole point of keeping the fingerprint
  const state = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'sec.state.json'), 'utf8'));
  const counts = Object.values(state.repeats).map((/** @type {any} */ r) => r.count);
  assert.deepEqual(counts.sort(), [2, 2], 'both repeats are still detected');
});

test('nothing in this repository looks like a credential', () => {
  // A tool that promises it never touches an API key must not be the reason a
  // secret scanner fires. Test fixtures shaped like real keys are still flagged —
  // scanners match on shape, not on intent — so the shapes are kept out entirely.
  // The prefixes are assembled at runtime so that this file does not itself
  // contain the literals it is looking for.
  const shapes = [
    ['sk', '_live_'], ['sk', '-live-'], ['sk', '-ant-api'], ['gh', 'p_'],
    ['xo', 'xb-'], ['AKI', 'A'], ['ASI', 'A'], ['-----BEGIN ', 'PRIVATE KEY-----']
  ].map(parts => parts.join(''));

  const roots = ['src', 'test', 'skills', 'scripts', 'bin', '.claude-plugin', '.github'];
  /**
   * @param {string} target
   * @returns {string[]}
   */
  const walk = target => {
    if (!fs.existsSync(target)) return [];
    if (!fs.statSync(target).isDirectory()) return [target];
    return fs.readdirSync(target, { withFileTypes: true })
      .flatMap(e => walk(path.join(target, e.name)));
  };

  const root = path.join(HERE, '..');
  /** @type {string[]} */
  const hits = [];
  for (const rel of [...roots.map(r => path.join(root, r)), path.join(root, 'README.md')]) {
    for (const file of walk(rel)) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const shape of shapes) {
        if (text.includes(shape)) hits.push(`${path.relative(root, file)} contains ${shape}`);
      }
    }
  }
  assert.deepEqual(hits, [], 'use a fixture that is not shaped like a key');
});
