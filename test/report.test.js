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

test('repeated calls are counted as re-sends, not as calls', () => {
  // Three numbers in this one line were wrong in an earlier draft, all in the
  // direction that flatters the feature: it grouped rows by tool, so reading
  // /a.txt 3x and /b.txt 2x came out as "Read, 5 identical calls" — the files are
  // not identical, 5 calls are not 5 re-sends, and the first call of each was
  // work rather than waste. Ground truth here is 3 re-sends.
  tmpHome();
  appendLedger({
    kind: 'session', ts: new Date().toISOString(), sessionId: 'r', cwd: '/tmp',
    costUsd: 1, deltaUsd: 1,
    repeats: [
      { tool: 'Read', count: 3, bytes: 900 },
      { tool: 'Read', count: 2, bytes: 500 }
    ]
  });
  const out = JSON.parse(capture(() => runReport(['--json'])));
  const leak = out.leaks.find((/** @type {any} */ l) => l.code === 'repeat-calls');
  assert.equal(leak.data.resent, 3, '(3-1) + (2-1), not 3 + 2');
  assert.equal(leak.data.bytes, 900 * 2 / 3 + 500 * 1 / 2, 'only the repeats\' share of the bytes');
  assert.equal(leak.data.worst[0].count, 3, 'the worst single input, not a per-tool total');
  assert.match(leak.message, /called 3 times identically/);
  assert.ok(!/5 identical/.test(leak.message), 'counts from different inputs are never merged');
});

test('a session with no repeated call says nothing about repeats', () => {
  tmpHome();
  appendLedger({
    kind: 'session', ts: new Date().toISOString(), sessionId: 'r2', cwd: '/tmp',
    costUsd: 1, deltaUsd: 1,
    repeats: [{ tool: 'Read', count: 1, bytes: 900 }]
  });
  const out = JSON.parse(capture(() => runReport(['--json'])));
  assert.equal(out.leaks.find((/** @type {any} */ l) => l.code === 'repeat-calls'), undefined,
    'one call is work, not waste');
});

test('a ledger row from before this feature does not crash the report', () => {
  // repeats used to be stored as an object, and older rows have no such field at
  // all. Either one reaching a `for...of` would take the whole report down.
  tmpHome();
  appendLedger({
    kind: 'session', ts: new Date().toISOString(), sessionId: 'old', cwd: '/tmp',
    costUsd: 1, deltaUsd: 1,
    repeats: /** @type {any} */ ({ 'Read:abc': { tool: 'Read', count: 4, bytes: 10, sample: 'secret' } })
  });
  const out = JSON.parse(capture(() => runReport(['--json'])));
  assert.ok(out, 'it still produced a report');
  assert.ok(!JSON.stringify(out).includes('secret'), 'and did not resurrect an old sample');
});

test('the headline never says "a second time" about a call made ten times', () => {
  // "900 B moved a second time. Worst single input: Read, called 10 times
  // identically" — one sentence contradicting itself. The bytes are the share of
  // all nine re-sends, so no ordinal belongs in that phrase at all.
  tmpHome();
  appendLedger({
    kind: 'session', ts: new Date().toISOString(), sessionId: 'ten', cwd: '/tmp',
    costUsd: 1, deltaUsd: 1,
    repeats: [{ tool: 'Read', count: 10, bytes: 1000 }],
    repeatTotals: { resent: 9, bytes: 900 }
  });
  const out = JSON.parse(capture(() => runReport(['--json'])));
  const leak = out.leaks.find((/** @type {any} */ l) => l.code === 'repeat-calls');
  assert.equal(leak.data.resent, 9);
  assert.ok(!/second time/.test(leak.message), leak.message);
});

test('the headline says how many sessions it is summing', () => {
  // Every other leak in this file says "N session(s)". This one said "the
  // session" while summing the whole window, so two sessions' re-sends were
  // attributed to one.
  tmpHome();
  for (const [id, count] of [['a', 10], ['b', 2]]) {
    appendLedger({
      kind: 'session', ts: new Date().toISOString(), sessionId: String(id), cwd: `/tmp/${id}`,
      costUsd: 1, deltaUsd: 1,
      repeats: [{ tool: 'Read', count: Number(count), bytes: 100 }],
      repeatTotals: { resent: Number(count) - 1, bytes: 50 }
    });
  }
  const out = JSON.parse(capture(() => runReport(['--json'])));
  const leak = out.leaks.find((/** @type {any} */ l) => l.code === 'repeat-calls');
  assert.equal(leak.data.resent, 10, '9 + 1, across both');
  assert.equal(leak.data.sessions, 2);
  assert.match(leak.message, /across 2 session\(s\)/);
  assert.ok(!/the session had/.test(leak.message));
});

test('the total is not silently capped at the twelve rows the ledger keeps', () => {
  // topRepeats stores the twelve largest groups. Summing those reported twelve
  // re-sends for a session that made fifteen — an undercount, but still a number
  // that was not the truth.
  tmpHome();
  appendLedger({
    kind: 'session', ts: new Date().toISOString(), sessionId: 'capped', cwd: '/tmp',
    costUsd: 1, deltaUsd: 1,
    repeats: Array.from({ length: 12 }, () => ({ tool: 'Read', count: 2, bytes: 100 })),
    repeatTotals: { resent: 15, bytes: 750 }
  });
  const out = JSON.parse(capture(() => runReport(['--json'])));
  const leak = out.leaks.find((/** @type {any} */ l) => l.code === 'repeat-calls');
  assert.equal(leak.data.resent, 15, 'not 12');
  assert.equal(leak.data.bytes, 750);
  assert.equal(leak.data.worst.length, 5, 'while the detail list stays short');
});

test('a session without its own totals is still counted, not silently zeroed', () => {
  // The fallback used to be chosen for the whole window: if ANY session carried
  // repeatTotals, every session without them contributed nothing to the total —
  // while still being counted in "across N session(s)" and still eligible to be
  // named the worst. That produced "1 tool call(s) re-sent ... Worst single
  // input: Read, called 20 times identically" in one sentence.
  tmpHome();
  const ts = new Date().toISOString();
  appendLedger({
    kind: 'session', ts, sessionId: 'modern', cwd: '/tmp/a', costUsd: 1, deltaUsd: 1,
    repeats: [{ tool: 'Read', count: 2, bytes: 100 }], repeatTotals: { resent: 1, bytes: 50 }
  });
  appendLedger({
    kind: 'session', ts, sessionId: 'legacy', cwd: '/tmp/b', costUsd: 1, deltaUsd: 1,
    repeats: [{ tool: 'Read', count: 20, bytes: 2000 }]
  });
  const out = JSON.parse(capture(() => runReport(['--json'])));
  const leak = out.leaks.find((/** @type {any} */ l) => l.code === 'repeat-calls');
  assert.equal(leak.data.resent, 20, '1 from the modern row + 19 from the legacy one');
  assert.equal(leak.data.bytes, 50 + 1900);
  assert.equal(leak.data.sessions, 2);
  // the total can never be smaller than the single group the same sentence names
  assert.ok(leak.data.resent >= leak.data.worst[0].resent,
    'the headline total must cover the worst group it names');
});
