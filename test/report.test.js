import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpHome, quiet } from './helpers.js';
import { runReport, runStatus } from '../src/cli/report.js';
import { appendLedger } from '../src/io/state.js';

/** @param {() => void} fn */
const capture = fn => {
  /** @type {string[]} */
  const chunks = [];
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = (/** @type {any} */ s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { process.stdout.write = w; }
  return chunks.join('');
};

function seed() {
  const home = tmpHome();
  appendLedger({ kind: 'session', ts: new Date().toISOString(), sessionId: 'a', cwd: '/work/api', profile: 'refactor', costUsd: 2.4, budgetUsd: 4, promptCount: 9, toolCount: 40, subagentCount: 6, compactCount: 1, tokens: { input: 10, output: 2000, cacheRead: 400000, cacheCreate: 600000, messages: 9 }, byModel: { 'claude-opus-5': { input: 10, output: 2000, cacheRead: 400000, cacheCreate: 600000, messages: 9 } } });
  appendLedger({ kind: 'session', ts: new Date().toISOString(), sessionId: 'b', cwd: '/work/api', profile: 'bugfix', costUsd: 0.3, budgetUsd: 0.5, promptCount: 2, toolCount: 5, tokens: { input: 4, output: 300, cacheRead: 90000, cacheCreate: 5000, messages: 3 } });
  return home;
}

test('report survives a ledger with wrong types instead of printing NaN', () => {
  const home = seed();
  fs.appendFileSync(`${home}/ledger.jsonl`,
    '{"kind":"session","ts":"2026-08-19T10:00:00Z","sessionId":"bad","costUsd":"lots","promptCount":"many"}\n' +
    'not json at all\n[]\n{"kind":"session","sessionId":"no-ts"}\n');
  const out = capture(() => runReport(['--days', '30']));
  assert.ok(!out.includes('NaN'), 'no NaN anywhere');
  assert.ok(!out.includes('undefined'), 'no undefined anywhere');
  assert.match(out, /\$2\.70|\$2\.7/);
});

test('report --json stays valid JSON with a corrupt ledger', () => {
  const home = seed();
  fs.appendFileSync(`${home}/ledger.jsonl`, '{"kind":"session","ts":"2026-08-19T10:00:00Z","sessionId":"bad","costUsd":"lots"}\n');
  const out = capture(() => runReport(['--json']));
  const parsed = JSON.parse(out);
  assert.equal(typeof parsed.totalUsd, 'number');
  assert.ok(Number.isFinite(parsed.totalUsd));
  assert.ok(Array.isArray(parsed.byProfile));
});

test('a nonsense --days falls back instead of showing everything', () => {
  seed();
  const out = capture(() => runReport(['--days', 'abc']));
  assert.match(out, /last 30 days/);
  assert.ok(!out.includes('NaN'));
});

test('the leaks section names the habit, using the configured thresholds', () => {
  seed();
  const out = capture(() => runReport([]));
  assert.match(out, /where it leaks/);
  assert.match(out, /compaction/);
  assert.match(out, /cache read ratio/);
});

test('no data produces guidance, not an empty screen or a crash', () => {
  tmpHome();
  const out = capture(() => runReport([]));
  assert.match(out, /no data yet/);
  assert.match(out, /doctor/);
});

test('status prints config warnings so a broken config cannot hide', () => {
  const home = tmpHome();
  fs.writeFileSync(`${home}/config.json`, JSON.stringify({ budget: { sessionUsd: -1 } }));
  const out = capture(() => runStatus());
  assert.match(out, /config/);
  assert.match(out, /sessionUsd/);
});

test('status runs with no sessions at all', () => {
  tmpHome();
  const out = capture(() => runStatus());
  assert.match(out, /none in the last 6 hours/);
  assert.ok(quiet(() => true));
});

test('a cost that is not known is reported as unknown, never as zero', () => {
  // With no prices configured, every model used to show $0.00 next to a session
  // total of several dollars. Turning "not known" into "nothing" is the one
  // direction this tool must never fail in.
  seed();
  const out = capture(() => runReport(['--json']));
  const byModel = JSON.parse(out).byModel;
  assert.ok(byModel.length > 0);
  for (const m of byModel) {
    assert.equal(m.costUsd, null, 'unknown cost must be null, not 0');
    assert.ok(m.tokens > 0, 'and the tokens must still be reported');
  }
});

test('report --json contains no terminal colour codes', () => {
  // JSON is what a script or a model consumes; ANSI escapes inside it are noise
  // at best and a parse hazard at worst.
  seed();
  const out = capture(() => runReport(['--json']));
  const ansi = /\u001b/;
  assert.ok(!ansi.test(out), 'found an ANSI escape in JSON output');
  const parsed = JSON.parse(out);
  for (const leak of parsed.leaks) {
    assert.ok(!ansi.test(leak.message));
    assert.equal(typeof leak.code, 'string');
    assert.equal(typeof leak.severity, 'string');
  }
});
