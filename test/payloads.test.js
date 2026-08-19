import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome, present } from './helpers.js';
import { handle } from '../src/cli/hook.js';
import { readSessionState } from '../src/io/state.js';

/**
 * These payloads were captured from a live Claude Code session, not written by
 * hand. That distinction matters: the handler used to read `payload.how` on
 * SessionStart and `payload.user_prompt` on UserPromptSubmit, neither of which
 * exists. The hand-written fixtures used the same invented names, so the tests
 * passed while the code did nothing in production. Fixtures now come from
 * reality, so an invented field name fails here first.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'hook-payloads.json'), 'utf8'));

test('the fixtures really are what Claude Code sends', () => {
  assert.equal(REAL.SessionStart.source, 'startup');
  assert.equal(REAL.SessionStart.how, undefined, 'there is no such field');
  assert.ok('prompt' in REAL.UserPromptSubmit);
  assert.equal(REAL.UserPromptSubmit.user_prompt, undefined, 'there is no such field either');
  assert.ok('agent_transcript_path' in REAL.SubagentStop, 'the authoritative subagent transcript path');
  assert.ok('agent_type' in REAL.SubagentStart);
  for (const [event, payload] of Object.entries(REAL)) {
    assert.equal(payload.hook_event_name, event);
    assert.ok(payload.session_id && payload.cwd);
  }
});

test('every real payload is handled without throwing', () => {
  tmpHome();
  for (const [event, payload] of Object.entries(REAL)) {
    assert.doesNotThrow(() => handle(event, payload), `${event} threw on its real payload`);
  }
});

test('SessionStart resets on the real field, so a /clear really starts over', () => {
  tmpHome();
  const start = { ...REAL.SessionStart, session_id: 'real1' };
  handle('SessionStart', start);
  handle('UserPromptSubmit', { ...REAL.UserPromptSubmit, session_id: 'real1', prompt: 'refactor the whole module and migrate it' });
  assert.equal(readSessionState('real1').profile, 'refactor');

  handle('SessionStart', { ...start, source: 'clear' });
  assert.equal(readSessionState('real1').profile, null, 'a /clear must not pin the new task to the old budget');
});

test('a compact recorded through the real field is counted', () => {
  tmpHome();
  handle('SessionStart', { ...REAL.SessionStart, session_id: 'real2', source: 'startup' });
  handle('SessionStart', { ...REAL.SessionStart, session_id: 'real2', source: 'compact' });
  assert.equal(readSessionState('real2').compactCount, 1);
});

test('the prompt is read from the field that exists', () => {
  tmpHome();
  handle('SessionStart', { ...REAL.SessionStart, session_id: 'real3' });
  handle('UserPromptSubmit', { ...REAL.UserPromptSubmit, session_id: 'real3', prompt: 'sửa lỗi crash ở auth.ts' });
  assert.equal(readSessionState('real3').profile, 'bugfix');
});

test('SubagentStop records the transcript path Claude Code hands over', () => {
  tmpHome();
  handle('SessionStart', { ...REAL.SessionStart, session_id: 'real4' });
  handle('SubagentStart', { ...REAL.SubagentStart, session_id: 'real4', agent_type: 'general-purpose' });
  handle('SubagentStop', { ...REAL.SubagentStop, session_id: 'real4', agent_transcript_path: '/tmp/agent-xyz.jsonl' });
  const st = readSessionState('real4');
  assert.deepEqual(st.subagentTranscripts, ['/tmp/agent-xyz.jsonl']);
  assert.equal(st.subagentCount, 1);
  assert.equal(present(st.agentTypes)['general-purpose'], 1);
});

test('an unknown future event is still a no-op', () => {
  tmpHome();
  assert.deepEqual(handle('SomethingAddedNextYear', REAL.Stop), {});
});

test('every field in a captured payload is declared in the types', () => {
  // Without this, "transcribed from reality" is just a comment. `effort` was
  // typed as a string while the real payload carries `{ level: "xhigh" }`, and
  // nothing noticed. If Claude Code adds a field and someone re-captures the
  // fixture, this fails until the type is updated too.
  const types = fs.readFileSync(path.join(HERE, '..', 'src', 'types.js'), 'utf8');
  const missing = new Set();
  for (const payload of Object.values(REAL)) {
    for (const key of Object.keys(payload)) {
      if (!new RegExp(`\\b${key}\\b`).test(types)) missing.add(key);
    }
  }
  assert.deepEqual([...missing], [], `undeclared payload fields: ${[...missing].join(', ')}`);
});

/** Prose about a mistake is not the mistake. Check declarations, not comments. */
/** @param {string} source */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the fields that do NOT exist stay undeclared, so reading one is a type error', () => {
  // `payload.how` and `payload.user_prompt` were read for real, did nothing,
  // and passed every test. Declaring them — even as `undefined` — is what makes
  // reading them legal, so they must be absent from the types entirely.
  const types = fs.readFileSync(path.join(HERE, '..', 'src', 'types.js'), 'utf8');
  const hook = stripComments(fs.readFileSync(path.join(HERE, '..', 'src', 'cli', 'hook.js'), 'utf8'));
  // Quoting a mistake is not making it: prose here always cites fields inside
  // backticks, so strip those spans before looking for a real declaration.
  const declarations = types.replace(/`[^`]*`/g, '');
  for (const ghost of ['how?:', 'user_prompt?:']) {
    assert.ok(!declarations.includes(ghost), `${ghost} must not be declared — declaring it is what permits the read`);
  }
  for (const ghost of ['payload.how', 'payload.user_prompt']) {
    assert.ok(!hook.includes(ghost), `${ghost} must not be read at runtime either`);
  }
});
