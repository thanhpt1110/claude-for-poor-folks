import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
