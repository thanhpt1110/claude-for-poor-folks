import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, newSignals, permissionFor, LEVELS } from '../src/core/policy.js';
import { effectiveLimits, DEFAULTS } from '../src/io/config.js';
import { emptyState } from '../src/io/state.js';
import { present } from './helpers.js';

/** @param {string} profile @param {Partial<import('../src/types.js').Limits>} [over] */
const limitsFor = (profile, over = {}) => ({ ...effectiveLimits({ ...DEFAULTS }, profile), ...over });
/** @param {Partial<import('../src/types.js').Session>} over */
const stateWith = over => ({ ...emptyState('s'), ...over });

test('quiet session produces no signals', () => {
  const d = decide(stateWith({ costUsd: 0.05, promptCount: 2, ctxPct: 10 }), limitsFor('feature'));
  assert.equal(d.signals.length, 0);
  assert.equal(d.levelName, 'ok');
});

test('budget thresholds fire once, highest only', () => {
  const d = decide(stateWith({ costUsd: 1.3 }), limitsFor('feature')); // cap 1.5 -> 86%
  const codes = d.signals.map(s => s.code);
  assert.ok(codes.includes('budget.warn.80'));
  assert.ok(!codes.includes('budget.warn.50'), 'must not stack both thresholds');
});

test('going over the cap is critical, not a warning', () => {
  const d = decide(stateWith({ costUsd: 2.0 }), limitsFor('feature'));
  assert.equal(present(d.signals.find(s => s.code === 'budget.over')).level, 'critical');
});

test('burn rate escalates to critical at 2x and predicts runway', () => {
  const warn = decide(stateWith({ costUsd: 0.2 }), limitsFor('bugfix'), { burnRate: 0.4 });
  assert.equal(present(warn.signals.find(s => s.code === 'burn.high')).level, 'warn');
  const crit = decide(stateWith({ costUsd: 0.2 }), limitsFor('bugfix'), { burnRate: 0.9 });
  const s = present(crit.signals.find(x => x.code === 'burn.high'));
  assert.equal(s.level, 'critical');
  assert.ok(s.data.runwayMin > 0 && s.data.runwayMin < 1);
});

test('quota signals work for people who never see a dollar figure', () => {
  const d = decide(stateWith({ costUsd: 0, fiveHourPct: 96, sevenDayPct: 91 }), limitsFor('feature'));
  assert.equal(present(d.signals.find(s => s.code === 'quota.fivehour')).level, 'critical');
  assert.ok(d.signals.some(s => s.code === 'quota.sevenday'));
});

test('cache ratio is only judged once there is enough evidence', () => {
  const bad = { input: 100000, output: 500, cacheRead: 10000, cacheCreate: 40000 };
  const early = decide(stateWith({ promptCount: 2, lastUsage: bad }), limitsFor('feature'));
  assert.ok(!early.signals.some(s => s.code === 'cache.low'), 'too early to judge');
  const later = decide(stateWith({ promptCount: 5, lastUsage: bad }), limitsFor('feature'));
  assert.ok(later.signals.some(s => s.code === 'cache.low'));
  const healthy = decide(stateWith({ promptCount: 5, lastUsage: { input: 800, output: 500, cacheRead: 148000, cacheCreate: 5000 } }), limitsFor('feature'));
  assert.ok(!healthy.signals.some(s => s.code === 'cache.low'));
});

test('signals are surfaced once, not on every tool call', () => {
  const d = decide(stateWith({ costUsd: 2.0 }), limitsFor('feature'));
  const first = newSignals(d, []);
  assert.ok(first.length > 0);
  assert.equal(newSignals(d, first.map(s => s.code)).length, 0);
});

test('v1 never denies; it asks only when the user opted in and someone is watching', () => {
  const d = decide(stateWith({ costUsd: 2.0 }), limitsFor('feature'));
  assert.equal(d.level, LEVELS.critical);
  assert.equal(permissionFor(d, { onLimit: 'warn' }), null, 'warn mode must not interrupt');
  assert.equal(permissionFor(d, { onLimit: 'ask', unattended: true }), null, 'nobody can answer');
  assert.equal(present(permissionFor(d, { onLimit: 'ask' })).decision, 'ask');
  const calm = decide(stateWith({ costUsd: 0.1 }), limitsFor('feature'));
  assert.equal(permissionFor(calm, { onLimit: 'ask' }), null);
});

test('a daily cap catches what four parallel sessions hide from a per-session cap', () => {
  // Each session stays under its own $1.50 cap; together they spent $4.10 today.
  /** @type {Partial<import('../src/types.js').Limits>} */
  const limits = { ...limitsFor('feature'), dailyUsd: 4.0, dailyScope: 'repo' };
  const quiet = decide(stateWith({ costUsd: 0.4 }), limits, { today: { usd: 3.0, sessions: 3 } });
  assert.ok(!quiet.signals.some(s => s.code.startsWith('daily')));

  const warn = decide(stateWith({ costUsd: 0.4 }), limits, { today: { usd: 3.4, sessions: 4 } });
  assert.equal(present(warn.signals.find(s => s.code === 'daily.warn.80')).level, 'warn');

  const over = decide(stateWith({ costUsd: 0.4 }), limits, { today: { usd: 4.1, sessions: 4 } });
  const s = present(over.signals.find(x => x.code === 'daily.over'));
  assert.equal(s.level, 'critical');
  assert.equal(s.data.sessions, 4);
});

test('no daily cap configured means no daily noise', () => {
  const d = decide(stateWith({ costUsd: 0.4 }), limitsFor('feature'), { today: { usd: 99, sessions: 9 } });
  assert.ok(!d.signals.some(s => s.code.startsWith('daily')));
});
