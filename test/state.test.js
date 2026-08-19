import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpHome, present } from './helpers.js';
import {
  emptyState, emptySnapshot, writeSessionState, writeSnapshot, readSessionState,
  readSnapshot, readSession, effectiveCost, pushSample, burnRate, safeId,
  appendLedger, readLedger, todaySpend, pruneOldSessions, sessionsDir, stateFile, snapshotFile
} from '../src/io/state.js';

test('the status line cannot erase what a hook counted', () => {
  // The old design had one shared file: the status line would read a snapshot
  // taken before a hook's increment, write the whole object back, and the
  // increment was gone for good. Separate files make that impossible.
  tmpHome();
  const st = { ...emptyState('s1'), subagentCount: 3, toolCount: 7 };
  writeSessionState(st);

  writeSnapshot({ ...emptySnapshot('s1'), costUsd: 5.2 });      // status line, concurrently
  st.subagentCount = 4;
  writeSessionState(st);                                        // hook, afterwards
  writeSnapshot({ ...emptySnapshot('s1'), costUsd: 5.4 });      // status line again

  const merged = readSession('s1');
  assert.equal(merged.subagentCount, 4, 'the hook increment survived');
  assert.equal(merged.toolCount, 7);
  assert.equal(merged.costUsd, 5.4, 'and the latest cost is still there');
});

test('each writer owns exactly one file', () => {
  const home = tmpHome();
  writeSessionState({ ...emptyState('s2'), toolCount: 1 });
  assert.ok(fs.existsSync(stateFile('s2')));
  assert.ok(!fs.existsSync(snapshotFile('s2')));
  writeSnapshot({ ...emptySnapshot('s2'), costUsd: 1 });
  assert.ok(fs.existsSync(snapshotFile('s2')));
  assert.ok(home);
});

test('two different session ids can never collide onto one file', () => {
  // A plain character substitution mapped every unusual id onto the same name.
  assert.notEqual(safeId('sess/../ün™'), safeId('sess/../ün!'));
  assert.equal(safeId('9f3c-4a1b'), '9f3c-4a1b', 'ordinary ids stay readable');
  assert.ok(!/[^A-Za-z0-9._-]/.test(safeId('a b/c\\d:e*f')));
});

test('effectiveCost prefers the real number over the estimate, in one place', () => {
  assert.equal(effectiveCost({ costUsd: 2, estCostUsd: 9 }), 2);
  assert.equal(effectiveCost({ costUsd: 0, estCostUsd: 9 }), 9);
  assert.equal(effectiveCost({}), 0);
  assert.equal(effectiveCost(null), 0);
});

test('burn rate measures dollars per minute, and refuses to guess', () => {
  const t0 = 1_700_000_000_000;
  const c = { samples: [] };
  for (let i = 0; i <= 6; i++) pushSample(c, i * 0.05, t0 + i * 10_000);
  assert.ok(Math.abs(present(burnRate(c, t0 + 60_000)) - 0.3) < 1e-9);

  assert.equal(burnRate({ samples: [] }), null, 'no data');
  assert.equal(burnRate({ samples: [[t0, 1]] }, t0), null, 'a single point is not a rate');
  assert.equal(burnRate({ samples: [[t0, 1], [t0 + 2000, 1.5]] }, t0 + 2000), null, 'window too short to trust');
  assert.equal(burnRate({ samples: [[t0, 5], [t0 + 30_000, 1]] }, t0 + 30_000), null, 'cost went backwards: a reset, not a refund');
  assert.equal(burnRate({ samples: 'nonsense' }), null);
});

test('the sample window stays bounded however long the session runs', () => {
  const t0 = 1_700_000_000_000;
  const c = { samples: [] };
  for (let i = 0; i < 5000; i++) pushSample(c, i * 0.001, t0 + i * 1000);
  assert.ok(c.samples.length <= 60, `kept ${c.samples.length} samples`);
});

test("today's spend comes from per-turn deltas, not lifetime session totals", () => {
  // A session opened yesterday and touched today must not drag yesterday's
  // spend into today's budget. That false alarm costs trust like a false block.
  tmpHome();
  const today = new Date(); today.setHours(9, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 86_400_000);
  appendLedger({ kind: 'turn', ts: yesterday.toISOString(), sessionId: 'long', cwd: '/repo1', deltaUsd: 4.0, costUsd: 4.0 });
  appendLedger({ kind: 'turn', ts: today.toISOString(), sessionId: 'long', cwd: '/repo1', deltaUsd: 0.5, costUsd: 4.5 });
  appendLedger({ kind: 'turn', ts: today.toISOString(), sessionId: 'other', cwd: '/repo1', deltaUsd: 0.25, costUsd: 0.25 });
  appendLedger({ kind: 'turn', ts: today.toISOString(), sessionId: 'elsewhere', cwd: '/repo2', deltaUsd: 9.0, costUsd: 9.0 });

  assert.equal(todaySpend('/repo1').usd, 0.75, 'yesterday must not count');
  assert.equal(todaySpend('/repo1').sessions, 2);
  assert.equal(todaySpend(null).usd, 9.75, 'machine scope');
});

test('a corrupt ledger line is skipped, not fatal', () => {
  const home = tmpHome();
  appendLedger({ kind: 'turn', ts: new Date().toISOString(), sessionId: 'ok', deltaUsd: 1 });
  fs.appendFileSync(`${home}/ledger.jsonl`, 'not json\n{"no_ts":true}\n[]\n');
  const rows = readLedger(0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, 'ok');
});

test('pruning removes stale sessions and abandoned tmp files, keeps live ones', () => {
  const home = tmpHome();
  writeSessionState(emptyState('fresh'));
  const dir = sessionsDir();
  fs.writeFileSync(`${dir}/old.state.json`, '{}');
  fs.utimesSync(`${dir}/old.state.json`, new Date(Date.now() - 30 * 86_400_000), new Date(Date.now() - 30 * 86_400_000));
  fs.writeFileSync(`${dir}/dead.state.json.999.tmp`, 'partial');
  fs.utimesSync(`${dir}/dead.state.json.999.tmp`, new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));

  pruneOldSessions();
  const left = fs.readdirSync(dir);
  assert.ok(left.includes('fresh.state.json'));
  assert.ok(!left.includes('old.state.json'));
  assert.ok(!left.some(f => f.endsWith('.tmp')));
  assert.ok(home);
});

test('unreadable or absent state degrades to empty, never throws', () => {
  const home = tmpHome();
  writeSessionState(emptyState('seed'));            // ensures the directory exists
  fs.writeFileSync(stateFile('broken'), '{ this is not json');
  assert.equal(readSessionState('broken').toolCount, 0);
  assert.equal(readSnapshot('missing').costUsd, 0);
  assert.equal(readSession('missing').promptCount, 0);
  assert.ok(home);
});

test('two overlapping hook processes cannot lose a counter', () => {
  // A Stop can sit in its settle wait while the next event fires. Both read the
  // same base state; without a merge on write, the later writer erases the
  // other's increments.
  tmpHome();
  writeSessionState({ ...emptyState('race'), toolCount: 5, subagentCount: 1, firedWarnings: ['a'] });

  const a = readSessionState('race');   // process A reads
  const b = readSessionState('race');   // process B reads the same base
  a.toolCount += 1;
  a.firedWarnings.push('b');
  b.subagentCount += 1;
  writeSessionState(a);
  writeSessionState(b);                 // B writes last, and used to win outright

  const after = readSessionState('race');
  assert.equal(after.toolCount, 6, "A's increment survived B writing later");
  assert.equal(after.subagentCount, 2, "B's increment is there too");
  assert.deepEqual(after.firedWarnings.sort(), ['a', 'b']);
});

test('a stale write cannot erase metering, and cannot make the loss permanent', () => {
  // Reproduced from a real mismatch. Merging `transcriptOffsets` on its own was
  // worse than not merging: an advanced offset next to stale tokens means the
  // difference is never read again. The five metering fields move as a group.
  tmpHome();
  const fresh = {
    ...emptyState('m'), toolCount: 2,
    tokens: { input: 1, output: 400, cacheRead: 0, cacheCreate: 0, messages: 2 },
    transcriptOffsets: { '/t.jsonl': 900 },
    counted: { a: { input: 1, output: 400, cacheRead: 0, cacheCreate: 0 } }, estCostUsd: 0.4
  };
  writeSessionState(fresh);

  const stale = {
    ...emptyState('m'), toolCount: 3,
    tokens: { input: 1, output: 100, cacheRead: 0, cacheCreate: 0, messages: 1 },
    transcriptOffsets: { '/t.jsonl': 300 },
    counted: { a: { input: 1, output: 100, cacheRead: 0, cacheCreate: 0 } }, estCostUsd: 0.1
  };
  writeSessionState(stale);

  const after = readSessionState('m');
  assert.equal(after.tokens.output, 400, 'the fuller picture survives');
  assert.equal(after.transcriptOffsets['/t.jsonl'], 900, 'and its offset came with it');
  assert.equal(after.estCostUsd, 0.4);
  assert.equal(after.toolCount, 3, 'while the counter still moves forward');
});

test('a deliberate reset is still allowed to reset', () => {
  tmpHome();
  writeSessionState({ ...emptyState('r'), toolCount: 9, promptCount: 4, firedWarnings: ['x'] });
  writeSessionState(emptyState('r'), { merge: false });
  const after = readSessionState('r');
  assert.equal(after.toolCount, 0);
  assert.equal(after.promptCount, 0);
  assert.deepEqual(after.firedWarnings, []);
});

test('process-local scratch never reaches the disk', () => {
  const home = tmpHome();
  // Underscore keys are process-local scratch: deliberately not part of the
  // persisted shape, which is why the type does not know about them.
  const st = /** @type {any} */ (emptyState('scratch'));
  st._today = { usd: 1 };
  st._todayAt = Date.now();
  writeSessionState(st);
  const raw = fs.readFileSync(stateFile('scratch'), 'utf8');
  assert.ok(!raw.includes('_today'), 'underscore-prefixed keys are not persisted');
  assert.ok(home);
});
