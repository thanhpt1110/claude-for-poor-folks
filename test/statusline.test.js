import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpHome, STATUSLINE_PAYLOAD, present } from './helpers.js';
import { runStatusline } from '../src/cli/statusline.js';
import { readSession, readSnapshot, snapshotFile, stateFile } from '../src/io/state.js';

test('renders a line and records the session from one real payload', async () => {
  tmpHome();
  const line = await runStatusline(JSON.stringify(STATUSLINE_PAYLOAD));
  assert.match(line, /\$0\.12/);
  assert.match(line, /ctx 33%/);
  assert.match(line, /5h 24%|5h 23%/);

  const st = readSnapshot('test-session-1');
  assert.equal(st.costUsd, 0.1234);
  assert.equal(st.model, 'claude-opus-5');
  assert.equal(present(st.lastUsage).cacheRead, 148000);
  assert.equal(st.fiveHourPct, 23.5);
  assert.equal(st.recognized, true);
  assert.ok(fs.existsSync(snapshotFile('test-session-1')));
  assert.ok(!fs.existsSync(stateFile('test-session-1')), 'the status line must not write the hooks\' file');
});

test('survives every shape of broken input', async () => {
  tmpHome();
  for (const bad of ['', 'not json', '{}', '{"session_id":null}', JSON.stringify({ session_id: 'x', cost: null, context_window: null })]) {
    const line = await runStatusline(bad);
    assert.equal(typeof line, 'string');
  }
});

test('the light turns red once the cap is passed, and says by how much', async () => {
  tmpHome();
  const payload = { ...STATUSLINE_PAYLOAD, session_id: 'red', cost: { total_cost_usd: 9.0 } };
  const line = await runStatusline(JSON.stringify(payload));
  assert.match(line, /🔴/);
  assert.match(line, /\$9\.0/, 'the number matters more than the colour');
});

test('one sparse frame is not treated as a schema change', () => {
  // An early render can legitimately carry almost nothing. Crying "the shape
  // moved" on the first sparse frame would train people to ignore the warning.
  tmpHome();
  return runStatusline(JSON.stringify({ session_id: 'sparse', workspace: { current_dir: '/tmp' } }))
    .then(() => assert.notEqual(readSnapshot('sparse').recognized, false));
});

test('a run of unrecognisable payloads is recorded as blind, not as $0', async () => {
  // The one failure direction a money meter must never take is silently to zero.
  tmpHome();
  const drift = JSON.stringify({ session_id: 'drift', some_future_shape: { total: 1 } });
  for (let i = 0; i < 3; i++) await runStatusline(drift);
  assert.equal(readSnapshot('drift').recognized, false);
  const { decide } = await import('../src/core/policy.js');
  const d = decide(readSession('drift'), { sessionUsd: 1, warnAtPct: [50, 80] });
  assert.ok(d.signals.some(s => s.code === 'meter.blind'), 'it must say so out loud');
});

test('an unwritable state dir degrades to display-only instead of crashing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorclaude-ro-'));
  fs.chmodSync(dir, 0o500);
  process.env.POOR_FOLKS_HOME = path.join(dir, 'nested');
  const line = await runStatusline(JSON.stringify(STATUSLINE_PAYLOAD));
  assert.match(line, /\$0\.12/);
  fs.chmodSync(dir, 0o700);
});

test('a POOR_FOLKS_HOME pointing at a pseudo-filesystem is refused, not trusted', async () => {
  // fs.mkdirSync recursive HANGS under /proc on Linux; homeDir() must reject it.
  process.env.POOR_FOLKS_HOME = '/proc/definitely-not-writable/cfp';
  const t0 = Date.now();
  const line = await runStatusline(JSON.stringify(STATUSLINE_PAYLOAD));
  assert.ok(Date.now() - t0 < 2000, 'must not hang');
  assert.match(line, /\$0\.12/);
});
