import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { validateConfig, loadConfig, effectiveLimits, homeDir, DEFAULTS, CLOSED_SECTIONS, OPEN_MAPS } from '../src/io/config.js';
import { decide } from '../src/core/policy.js';

test('a scalar where an array belongs is repaired instead of killing the tool', () => {
  // Writing "warnAtPct": 80 instead of [80] used to make decide() throw on a
  // spread of a number. Every caller swallows exceptions, so the status line
  // went blank and no signal ever fired again — while doctor still said "ok".
  const { config } = validateConfig({ budget: { warnAtPct: 80, sessionUsd: 1 } });
  assert.deepEqual(config.budget.warnAtPct, [80]);
  const d = decide({ costUsd: 0.9, promptCount: 1 }, effectiveLimits(config, 'feature'));
  assert.ok(d.signals.some(s => s.code === 'budget.warn.80'), 'and it still works afterwards');
});

test('nonsense budgets are rejected loudly, not silently obeyed', () => {
  for (const bad of [-5, 0, 'lots', null, NaN]) {
    const { config, warnings } = validateConfig({ budget: { sessionUsd: bad } });
    assert.equal(config.budget.sessionUsd, null, `${bad} must not become the cap`);
    if (bad !== null) assert.ok(warnings.length > 0, `${bad} should be reported`);
  }
  // and with the cap falling back to the profile, the gate still fires
  const { config } = validateConfig({ budget: { sessionUsd: -5 } });
  const d = decide({ costUsd: 50, promptCount: 1 }, effectiveLimits(config, 'bugfix'));
  assert.ok(d.signals.some(s => s.code === 'budget.over'));
});

test('every other bad type is coerced to something usable', () => {
  const { config } = validateConfig({
    onLimit: 'explode', unattended: 'yes', quiet: 1, profile: 42,
    prices: [1, 2], customProfiles: 'nope', quota: { warnFiveHourPct: 'x', warnSevenDayPct: 500 },
    budget: { dailyScope: 'galaxy', warnAtPct: ['a', -1, 150, 60] }
  });
  assert.equal(config.onLimit, 'warn');
  assert.equal(config.unattended, true);
  assert.equal(config.quiet, true);
  assert.equal(config.profile, null);
  assert.deepEqual(config.prices, {});
  assert.deepEqual(config.customProfiles, {});
  assert.equal(config.quota.warnFiveHourPct, DEFAULTS.quota.warnFiveHourPct);
  assert.equal(config.quota.warnSevenDayPct, DEFAULTS.quota.warnSevenDayPct);
  assert.equal(config.budget.dailyScope, 'repo');
  assert.deepEqual(config.budget.warnAtPct, [60], 'only the sane percentage survives');
});

test('asking the model is off by default, because it is the only thing that costs', () => {
  assert.equal(DEFAULTS.askProfile, false);
  assert.equal(validateConfig({}).config.askProfile, false);
});

test('a missing config still produces a working tool', () => {
  tmpHome();
  const config = loadConfig(os.tmpdir());
  const limits = effectiveLimits(config, 'bugfix');
  assert.equal(limits.sessionUsd, 0.5);
  assert.ok(limits.burnUsdPerMin > 0);
  assert.deepEqual(config._warnings, []);
});

test('a repo config overrides the global one, field by field', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ onLimit: 'ask', budget: { sessionUsd: 9 } }));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-repo-'));
  fs.writeFileSync(path.join(repo, '.poor-folks.json'), JSON.stringify({ budget: { sessionUsd: 2 } }));
  const config = loadConfig(repo);
  assert.equal(config.budget.sessionUsd, 2, 'repo wins');
  assert.equal(config.onLimit, 'ask', 'global still applies where the repo is silent');
});

// The hazard is Linux-specific: fs.mkdirSync recursive HANGS under /proc there.
// On Windows these are ordinary relative paths that resolve onto the current
// drive, so the guard has nothing to guard and the assertion is meaningless.
test('a home directory on a virtual filesystem is refused, a real tmpfs is not', { skip: process.platform !== 'linux' && 'linux-only hazard' }, () => {
  process.env.POOR_FOLKS_HOME = '/proc/nope/x';
  assert.ok(!homeDir().startsWith('/proc'));
  process.env.POOR_FOLKS_HOME = '/sys/nope/x';
  assert.ok(!homeDir().startsWith('/sys'));
  process.env.POOR_FOLKS_HOME = '/dev/shm/poor-folks';
  assert.equal(homeDir(), '/dev/shm/poor-folks', '/dev/shm is an ordinary writable tmpfs');
  delete process.env.POOR_FOLKS_HOME;
});

test('a setting that does not exist is reported, not dropped in silence', () => {
  // The failure this catches: `{"budgetUsd": 0.5}` looks exactly like a budget.
  // It is not one, so the profile default runs instead — and nothing anywhere
  // said so. The user believes they are capped at $0.50 and they are not.
  const { config, warnings } = validateConfig({ budgetUsd: 0.5 });
  assert.equal(config.budget.sessionUsd, null, 'the bogus key sets nothing');
  const hit = warnings.find(w => w.startsWith('budgetUsd:'));
  assert.ok(hit, 'and the user is told');
  assert.match(hit, /budget\.sessionUsd/, 'with the setting they actually meant');
});

test('a misspelling inside a section is caught too', () => {
  const { warnings } = validateConfig({ budget: { sessionUSD: 2 } });
  const hit = warnings.find(w => w.startsWith('budget.sessionUSD:'));
  assert.ok(hit);
  assert.match(hit, /"budget\.sessionUsd"/);
});

test('maps that are meant to hold arbitrary keys are never flagged', () => {
  // prices is keyed by model id, budgetPhrases by language tag, customProfiles
  // by profile id. Flagging their contents would make the check unusable for
  // exactly the people who configure the tool most.
  const { warnings } = validateConfig({
    prices: { 'claude-opus-5': { input: 5, output: 25 }, 'some-future-model': { input: 1 } },
    budgetPhrases: { de: ['budget'], 'pt-BR': ['orçamento'] },
    customProfiles: { 'my-own-thing': { sessionUsd: 3 } }
  });
  assert.deepEqual(warnings, []);
});

test('a correct config produces no noise at all', () => {
  const { warnings } = validateConfig({
    budget: { sessionUsd: 5, dailyUsd: 20, warnAtPct: [50, 90] },
    quota: { warnFiveHourPct: 70 },
    onLimit: 'ask',
    quiet: false
  });
  assert.deepEqual(warnings, [], 'silence is the whole point when nothing is wrong');
});

test('internal fields round-trip without being called typos', () => {
  // loadConfig writes _sources and _warnings onto the object it returns; feeding
  // that back in must not accuse the tool of misconfiguring itself.
  const { warnings } = validateConfig({ _sources: { global: '/x', repo: null }, _warnings: [] });
  assert.deepEqual(warnings, []);
});

test('every section in DEFAULTS is classified, so none loses its typo check silently', () => {
  // reportUnknownKeys only looks inside a section listed in CLOSED_SECTIONS.
  // Adding a fixed-shape section to DEFAULTS and forgetting to list it would
  // drop every typo inside it on the floor — the silent drift this tool is
  // supposed to be the opposite of. Fail here instead of in someone's config.
  const objectSettings = Object.entries(DEFAULTS)
    .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
    .map(([k]) => k);
  const classified = new Set([...CLOSED_SECTIONS, ...OPEN_MAPS]);
  const orphans = objectSettings.filter(k => !classified.has(k));
  assert.deepEqual(orphans, [],
    `add these to CLOSED_SECTIONS (fixed keys) or OPEN_MAPS (user-supplied keys): ${orphans.join(', ')}`);
});

test('a mistyped section name is not answered with "quiet"', () => {
  // "quiet" is the setting that silences these warnings. Suggesting it to
  // someone who mistyped a section name is the worst advice available.
  for (const typed of ['Budget', 'Quota', 'Cache']) {
    const [w] = validateConfig({ [typed]: 1 }).warnings;
    assert.ok(w, `${typed} must still be flagged`);
    assert.ok(!/"quiet"/.test(w), `${typed} must not be answered with quiet: ${w}`);
    assert.match(w, new RegExp(`"${typed.toLowerCase()}\\.`), 'it points into the right section');
  }
});
