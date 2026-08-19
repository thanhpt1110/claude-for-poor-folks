import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readFileDelta, readSessionDelta, readSessionTotals, sessionTranscripts,
  cacheReadRatio, estimateCost, addTokens, emptyTokens
} from '../src/io/transcript.js';

/** @param {any[]} rows @param {any[]|null} [subagentRows] */
function session(rows, subagentRows = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorclaude-tr-'));
  const id = 'sess-1';
  const main = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(main, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  if (subagentRows) {
    const sub = path.join(dir, id, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-abc.jsonl'), subagentRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  return main;
}
/** @param {string} id @param {[number, number, number, number]} u @param {string} [model] */
const asst = (id, u, model = 'claude-opus-5') => ({
  type: 'assistant', requestId: `req-${id}`,
  message: { id, model, usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] } }
});

test('a streaming message counted from its growing copies, not summed and not first-wins', () => {
  // Real shape: one id written three times, output_tokens 2 -> 2 -> 579.
  // Summing gives 583. Taking the first gives 2. The truth is 579.
  const f = session([asst('m1', [2, 2, 0, 19433]), asst('m1', [2, 2, 0, 19433]), asst('m1', [2, 579, 0, 19433])]);
  const r = readSessionTotals(f);
  assert.equal(r.tokens.output, 579);
  assert.equal(r.tokens.cacheCreate, 19433, 'cache write must not be multiplied either');
  assert.equal(r.tokens.messages, 1);
});

test('subagent transcripts are found and included', () => {
  const f = session(
    [asst('m1', [2, 100, 0, 500], 'claude-opus-5')],
    [asst('s1', [2, 900, 100, 700], 'claude-opus-4-8')]
  );
  assert.equal(sessionTranscripts(f).length, 2);
  const r = readSessionTotals(f);
  assert.equal(r.tokens.output, 1000, 'a fan-out session under-reports badly without this');
  assert.equal(r.byModel['claude-opus-4-8'].output, 900);
  assert.equal(r.byModel['claude-opus-5'].output, 100);
});

test('a session with no subagents still works', () => {
  const f = session([asst('m1', [1, 10, 0, 100])]);
  assert.equal(sessionTranscripts(f).length, 1);
  assert.equal(readSessionTotals(f).tokens.output, 10);
});

test('incremental reads add each increase exactly once', () => {
  const f = session([asst('m1', [1, 10, 0, 100])]);
  const a = readSessionDelta(f);
  assert.equal(a.tokens.output, 10);

  fs.appendFileSync(f, JSON.stringify(asst('m1', [1, 300, 0, 100])) + '\n');
  const b = readSessionDelta(f, a.offsets, a.counted);
  assert.equal(b.tokens.output, 290, 'only the increase');
  assert.equal(b.tokens.messages, 0, 'not a new message');

  fs.appendFileSync(f, JSON.stringify(asst('m2', [1, 20, 300, 5])) + '\n');
  const c = readSessionDelta(f, b.offsets, b.counted);
  assert.equal(c.tokens.output, 20);
  assert.equal(c.tokens.messages, 1);

  const d = readSessionDelta(f, c.offsets, c.counted);
  assert.equal(d.tokens.output, 0, 'nothing new is nothing counted');

  const total = [a, b, c, d].reduce((acc, x) => addTokens(acc, x.tokens), emptyTokens());
  assert.equal(total.output, 320);
  assert.equal(total.output, readSessionTotals(f).tokens.output, 'incremental must equal a full recount');
});

test('a half-written last line is not consumed', () => {
  const f = session([asst('m1', [1, 10, 0, 100])]);
  fs.appendFileSync(f, '{"type":"assistant","message":{"id":"m2","usa');
  const r = readSessionDelta(f);
  assert.equal(r.tokens.messages, 1);
  fs.appendFileSync(f, 'ge":{"output_tokens":7,"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n');
  const r2 = readSessionDelta(f, r.offsets, r.counted);
  assert.equal(r2.tokens.output, 7, 'picked up once complete');
});

test('a truncated or rotated file does not wedge the reader', () => {
  const f = session([asst('m1', [1, 10, 0, 100]), asst('m2', [1, 10, 0, 100])]);
  const r = readSessionDelta(f);
  fs.writeFileSync(f, JSON.stringify(asst('m3', [1, 5, 0, 0])) + '\n');
  const r2 = readSessionDelta(f, r.offsets, r.counted);
  assert.equal(r2.tokens.output, 5, 'restarts from the top of the new file');
});

test('garbage lines and missing files are survivable', () => {
  const f = session([asst('m1', [1, 10, 0, 100])]);
  fs.appendFileSync(f, 'not json at all\n{"type":"user"}\n{"type":"assistant","message":{}}\n');
  assert.equal(readSessionTotals(f).tokens.messages, 1);
  assert.equal(readSessionTotals('/nope/nothing.jsonl').tokens.messages, 0);
  assert.deepEqual(sessionTranscripts(null), []);
});

test('the tracked-message map stays bounded', () => {
  const rows = Array.from({ length: 400 }, (_, i) => asst(`m${i}`, [1, 1, 0, 0]));
  const f = session(rows);
  const r = readSessionTotals(f);
  assert.equal(r.tokens.messages, 400);
  assert.ok(Object.keys(r.counted).length <= 128, 'must not grow without bound');
});

test('cache ratio reflects how much input was served from cache', () => {
  assert.equal(cacheReadRatio({ input: 0, output: 0, cacheRead: 90, cacheCreate: 10 }), 0.9);
  assert.equal(cacheReadRatio({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }), null);
  assert.equal(cacheReadRatio(null), null);
});

test('cost stays null until the user supplies prices — no stale table shipped', () => {
  const byModel = { 'claude-opus-5': { input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreate: 1e6, messages: 1 } };
  assert.equal(estimateCost(byModel, {}), null);
  assert.equal(estimateCost(byModel, { 'other-model': { input: 1 } }), null);
  assert.equal(estimateCost(byModel, { 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }), 36.75);
});

test('a model id with a suffix still matches its price entry', () => {
  const byModel = { 'claude-opus-5[1m]': { input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0, messages: 1 } };
  assert.equal(estimateCost(byModel, { 'claude-opus-5': { input: 5 } }), 5);
});

test('readFileDelta is usable on its own', () => {
  const f = session([asst('m1', [1, 10, 0, 100])]);
  const r = readFileDelta(f, 0, {});
  assert.equal(r.tokens.output, 10);
  assert.ok(r.offset > 0);
});

test('a transcript larger than one readable chunk is counted, not silently zeroed', () => {
  // Buffer.toString('utf8') throws above Node's ~512 MB string cap, and the
  // throw used to be swallowed: one huge transcript counted as zero tokens with
  // no error. Reading is chunked now, so this exercises the multi-pass path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-big-'));
  const f = path.join(dir, 'big.jsonl');
  const filler = 'x'.repeat(4000);
  const lines = [];
  for (let i = 0; i < 3000; i++) {
    lines.push(JSON.stringify({ type: 'user', note: filler }));            // bulk, no usage
    if (i % 500 === 0) lines.push(JSON.stringify(asst(`m${i}`, [1, 10, 0, 0])));
  }
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.ok(fs.statSync(f).size > 12_000_000, 'fixture must be big enough to matter');

  const r = readSessionTotals(f);
  assert.equal(r.tokens.messages, 6, 'every usage row across every chunk');
  assert.equal(r.tokens.output, 60);
  assert.equal(r.offsets[f], fs.statSync(f).size, 'and the whole file was consumed');
});
