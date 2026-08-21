import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome, present } from './helpers.js';
import { handle } from '../src/cli/hook.js';
import { readSessionState, writeSessionState, emptyState, writeSnapshot, emptySnapshot, stateFile } from '../src/io/state.js';


const base = { session_id: 'h1', cwd: '/tmp' };

test('SessionStart announces the budget without blocking anything', () => {
  tmpHome();
  const res = handle('SessionStart', { ...base, source: 'startup' });
  assert.match(present(res.systemMessage), /poor-folks/);
  assert.match(present(res.systemMessage), /budget/);
  assert.ok(!('continue' in res), 'must never block a session start');
});

test('a /clear starts a new task, so the previous profile must not stick', () => {
  tmpHome();
  handle('SessionStart', { ...base, source: 'startup' });
  handle('UserPromptSubmit', { ...base, prompt: 'brainstorm some architecture ideas with me' });
  assert.equal(readSessionState('h1').profile, 'discuss');

  handle('SessionStart', { ...base, source: 'clear' });
  assert.equal(readSessionState('h1').profile, null, 'cleared');
  handle('UserPromptSubmit', { ...base, prompt: 'refactor the whole auth module and migrate it' });
  assert.equal(readSessionState('h1').profile, 'refactor', 're-detected for the new task');
});

test('a clear first prompt sets the profile silently, without asking', () => {
  tmpHome();
  handle('SessionStart', { ...base, source: 'startup' });
  const res = handle('UserPromptSubmit', { ...base, prompt: 'sửa lỗi crash ở auth.ts' });
  assert.equal(readSessionState('h1').profile, 'bugfix');
  assert.equal(readSessionState('h1').profileSource, 'detected');
  assert.ok(!res.hookSpecificOutput?.additionalContext?.includes('AskUserQuestion'));
});

test('by default an unclear prompt costs the user NOTHING — no text reaches the model', () => {
  // The whole point: a tool that spends tokens to save tokens is a fraud.
  const home = tmpHome();
  handle('SessionStart', { ...base, source: 'startup' });
  const res = handle('UserPromptSubmit', { ...base, prompt: 'làm cái này đi' });
  assert.equal(res.hookSpecificOutput, undefined, 'nothing may be injected into the context');
  assert.match(present(res.systemMessage), /unclear task/, 'the human is told, for free');
  assert.equal(readSessionState('h1').profileSource, 'fallback');
  assert.ok(home);
});

test('asking the model is opt-in, and then it is the only thing that costs', () => {
  const home = tmpHome();
  fs.writeFileSync(`${home}/config.json`, JSON.stringify({ askProfile: true }));
  handle('SessionStart', { ...base, source: 'startup' });
  const res = handle('UserPromptSubmit', { ...base, prompt: 'làm cái này đi' });
  assert.match(present(present(res.hookSpecificOutput).additionalContext), /AskUserQuestion/);
  assert.ok(present(present(res.hookSpecificOutput).additionalContext).length < 400, 'must stay small: the user pays per character');
  assert.equal(readSessionState('h1').profile, null, 'profile stays open until answered');
});

test('a budget stated in the prompt is honoured over the profile default', () => {
  tmpHome();
  handle('SessionStart', { ...base, source: 'startup' });
  handle('UserPromptSubmit', { ...base, prompt: 'add a JWT login endpoint, budget $3' });
  assert.equal(readSessionState('h1').budgetUsd, 3);
});

test('PreToolUse warns once, and only asks when configured to', () => {
  const home = tmpHome();
  handle('SessionStart', { ...base, source: 'startup' });
  handle('UserPromptSubmit', { ...base, prompt: 'fix the bug in parser.js' });
  writeSnapshot({ ...emptySnapshot('h1'), costUsd: 5.0 });   // way past the bugfix cap of $0.50

  const first = handle('PreToolUse', { ...base, tool_name: 'Bash' });
  assert.match(present(first.systemMessage), /Over budget/);
  assert.equal(first.hookSpecificOutput, undefined, 'default mode must not interrupt');

  const second = handle('PreToolUse', { ...base, tool_name: 'Bash' });
  assert.equal(second.systemMessage, undefined, 'must not nag on every tool call');
  assert.ok(home);
});

test('counters and the ledger survive a full session', () => {
  tmpHome();
  handle('SessionStart', { ...base, source: 'startup' });
  handle('UserPromptSubmit', { ...base, prompt: 'refactor the auth module' });
  handle('SubagentStart', base);
  handle('SubagentStart', base);
  handle('PreCompact', base);
  writeSnapshot({ ...emptySnapshot('h1'), costUsd: 1.25 });
  handle('Stop', base);

  const after = readSessionState('h1');
  assert.equal(after.subagentCount, 2);
  assert.equal(after.compactCount, 1);
  assert.equal(after.lastLedgerCostUsd, 1.25);
});

test('an unknown event is a no-op, not an error', () => {
  tmpHome();
  assert.deepEqual(handle('SomeFutureEvent', base), {});
});

test('quiet mode says nothing at all', () => {
  const home = tmpHome();
  fs.writeFileSync(`${home}/config.json`, JSON.stringify({ quiet: true }));
  const res = handle('SessionStart', { ...base, source: 'startup' });
  assert.deepEqual(res, {});
});



test('Stop waits for the transcript to settle, so the final turn is not lost', () => {
  // The Stop hook fires before Claude Code has finished writing the last
  // assistant message. Without the wait, every session silently under-reports
  // by its last turn. A second process appends mid-wait, exactly like the race.
  //
  // The writer signals that it is alive before the clock starts: spawning a node
  // process costs a few hundred milliseconds on Windows, and that startup cost
  // is not part of the race being tested — in production the writer is Claude
  // Code itself, already running.
  const home = tmpHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-settle-'));
  const transcript = path.join(dir, 'sess.jsonl');
  const ready = path.join(dir, 'writer-ready');
  /** @param {string} id @param {number} out */
  const row = (id, out) => JSON.stringify({
    type: 'assistant', requestId: id,
    message: { id, model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  }) + '\n';
  fs.writeFileSync(transcript, row('m1', 100));

  const writer = spawn(process.execPath, ['-e',
    `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'1');` +
    `setTimeout(()=>fs.appendFileSync(${JSON.stringify(transcript)}, ${JSON.stringify(row('m2', 250))}), 150)`
  ], { detached: true, stdio: 'ignore' });
  writer.unref();

  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.ok(fs.existsSync(ready), 'the writer process never started');

  handle('Stop', { session_id: 'settle', cwd: '/tmp', transcript_path: transcript });
  assert.equal(readSessionState('settle').tokens.output, 350, 'the late-arriving turn must be included');
  assert.ok(home);
});


test('a plugin install is told once how to get the status line, and then left alone', () => {
  // A plugin manifest cannot declare a status line. Rather than write one into
  // someone's settings behind their back, say it once and hand over the command.
  const home = tmpHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-nudge-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');
  /** @type {Partial<import('../src/types.js').HookPayload>} */
  const base = { session_id: 'n1', cwd: dir, source: 'startup' };

  const first = handle('SessionStart', base).systemMessage || '';
  assert.match(first, /claude-for-poor-folks install/, 'the first session should say how');

  const second = handle('SessionStart', { ...base, session_id: 'n2' }).systemMessage || '';
  assert.ok(!/claude-for-poor-folks install/.test(second), 'the second must not repeat it');
  assert.match(second, /budget/, 'but the normal banner stays');
  assert.ok(home);
});

test('nothing is said when the status line is already wired', () => {
  const home = tmpHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-wired-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'node x statusline #poor-folks' } }));

  const msg = handle('SessionStart', /** @type {Partial<import('../src/types.js').HookPayload>} */ ({ session_id: 'w1', cwd: dir, source: 'startup' })).systemMessage || '';
  assert.ok(!/one more step/.test(msg));
  assert.ok(home);
});


test('the status line slot is read as ours, someone else\'s, or empty', async () => {
  const { statusLineState } = await import('../src/io/wiring.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-slot-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const settings = path.join(dir, '.claude', 'settings.json');

  fs.writeFileSync(settings, '{}');
  assert.equal(statusLineState(dir), 'none');

  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'their-own.sh' } }));
  assert.equal(statusLineState(dir), 'foreign', 'a status line we did not write is theirs');

  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'node x statusline #poor-folks' } }));
  assert.equal(statusLineState(dir), 'ours');
});

test('someone running their own status line is never nudged', () => {
  // `install` refuses to replace it, so the advice could not work anyway.
  const home = tmpHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-foreign-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'their-own.sh' } }));

  const msg = handle('SessionStart', /** @type {Partial<import('../src/types.js').HookPayload>} */ (
    { session_id: 'f1', cwd: dir, source: 'startup' })).systemMessage || '';
  assert.ok(!/one more step/.test(msg));
  assert.ok(home);
});

test('the notice is once per project, so a second repository still hears it', () => {
  // Per-machine was wrong: the usual fix is a project-scoped install, which
  // leaves every other repository without a meter and never mentions it again.
  const home = tmpHome();
  const mk = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-proj-'));
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude', 'settings.json'), '{}');
    return d;
  };
  const a = mk(), b = mk();
  const say = (/** @type {string} */ dir, /** @type {string} */ id) =>
    handle('SessionStart', /** @type {Partial<import('../src/types.js').HookPayload>} */ (
      { session_id: id, cwd: dir, source: 'startup' })).systemMessage || '';

  assert.match(say(a, '1'), /one more step/, 'first project, first time');
  assert.ok(!/one more step/.test(say(a, '2')), 'same project again: silent');
  assert.match(say(b, '3'), /one more step/, 'a different project still gets told');
  assert.ok(home);
});

test('PostToolUse attributes bytes to the tool that moved them', () => {
  const home = tmpHome();
  /**
   * @param {string} tool
   * @param {any} input
   * @param {number} respBytes
   */
  const post = (tool, input, respBytes) => handle('PostToolUse', {
    hook_event_name: 'PostToolUse', session_id: 'attr', cwd: home,
    tool_name: tool, tool_input: input, duration_ms: 10
  }, respBytes);
  post('Read', { file_path: '/a.txt' }, 1000);
  post('Read', { file_path: '/a.txt' }, 1000);
  post('Bash', { command: 'ls' }, 50);
  const s = readSessionState('attr');
  assert.equal(s.toolStats?.Read.calls, 2);
  assert.equal(s.toolStats?.Read.bytes, 2000);
  assert.equal(s.toolStats?.Bash.calls, 1);
  const repeat = Object.values(s.repeats || {}).find(r => r.tool === 'Read');
  assert.equal(repeat?.count, 2, 'the same file read twice is counted as a repeat');
  const once = Object.values(s.repeats || {}).find(r => r.tool === 'Bash');
  assert.equal(once?.count, 1, 'and a single call is recorded but is not waste');
});

test('different inputs to the same tool are not called repeats', () => {
  const home = tmpHome();
  for (const f of ['/a.txt', '/b.txt', '/c.txt']) {
    handle('PostToolUse', {
      hook_event_name: 'PostToolUse', session_id: 'distinct', cwd: home,
      tool_name: 'Read', tool_input: { file_path: f }
    }, 100);
  }
  const s = readSessionState('distinct');
  assert.equal(s.toolStats?.Read.calls, 3);
  const counts = Object.values(s.repeats || {}).map(r => r.count);
  assert.deepEqual(counts, [1, 1, 1], 'three different files are three different calls');
});

test('PostToolUse never reads the transcript', () => {
  // It fires after every tool call. Metering there would make the meter itself
  // the most expensive thing in the session.
  const home = tmpHome();
  const transcript = path.join(home, 'fake.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage: { output_tokens: 9999 } }
  }) + '\n');
  handle('PostToolUse', {
    hook_event_name: 'PostToolUse', session_id: 'notranscript', cwd: home,
    transcript_path: transcript, tool_name: 'Read', tool_input: { file_path: '/x' }
  }, 10);
  const s = readSessionState('notranscript');
  assert.deepEqual(s.transcriptOffsets, {}, 'it must not have opened the transcript');
  assert.equal(s.tokens.output, 0);
});

test('measureTools: false turns the whole thing off', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ measureTools: false }));
  const res = handle('PostToolUse', {
    hook_event_name: 'PostToolUse', session_id: 'off', cwd: home,
    tool_name: 'Read', tool_input: { file_path: '/x' }
  }, 5000);
  assert.deepEqual(res, {});
  // readSessionState hands back a fresh emptyState when no file was written, so
  // the field exists and is empty — which is the point: nothing was recorded.
  const s = readSessionState('off');
  assert.deepEqual(Object.keys(s.toolStats || {}), [], 'nothing recorded');
  assert.deepEqual(Object.keys(s.repeats || {}), []);
});

test('PostToolUse adds nothing to the conversation', () => {
  const home = tmpHome();
  const res = handle('PostToolUse', {
    hook_event_name: 'PostToolUse', session_id: 'quiet', cwd: home,
    tool_name: 'Read', tool_input: { file_path: '/x' }
  }, 100);
  assert.equal(res.hookSpecificOutput?.additionalContext, undefined);
  assert.equal(/** @type {any} */ (res).additionalContext, undefined);
  assert.equal(res.systemMessage, undefined, 'and it does not even talk to the human');
});

test('the byte count is bytes, on the real stdin path', async () => {
  // Every other test here calls handle() with an explicit byte count, which is
  // exactly why this bug survived: the conversion happens in main(), between
  // stdin and handle(). `input.length` counts UTF-16 code units, so 100 '✓'
  // (3 bytes each) plus 50 '😀' (4 bytes each) were reported as 355 instead of
  // 655 — a figure printed under the word "bytes" everywhere it surfaces.
  const home = tmpHome();
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'utf8', cwd: home,
    tool_name: 'Read', tool_input: { file_path: '/unicode.txt' },
    tool_response: '✓'.repeat(100) + '😀'.repeat(50)
  });
  assert.ok(Buffer.byteLength(payload) > payload.length, 'the fixture must actually be multibyte');

  // `new URL(import.meta.url).pathname` yields "/C:/Users/..." on Windows — a
  // leading slash that is not a valid path there, so the child never started and
  // the failure surfaced as a missing state file rather than as itself.
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');
  const code = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, 'hook'], {
      env: { ...process.env, POOR_FOLKS_HOME: home }, stdio: ['pipe', 'ignore', 'ignore']
    });
    p.on('error', reject);
    p.on('close', c => resolve(c));
    p.stdin.end(payload);
  });
  assert.equal(code, 0, 'the hook must have run at all before its output is judged');

  const state = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'utf8.state.json'), 'utf8'));
  assert.equal(state.toolStats.Read.bytes, Buffer.byteLength(payload));
  assert.notEqual(state.toolStats.Read.bytes, payload.length, 'and not the UTF-16 length');
});
