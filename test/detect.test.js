import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProfile, detectBudget, shouldAsk } from '../src/core/detect.js';

test('infers the profile when the user already said what they are doing', () => {
  const cases = [
    ['sửa lỗi crash ở auth.ts khi login', 'bugfix'],
    ['fix the null pointer bug in parser.js', 'bugfix'],
    ['refactor toàn bộ src và migrate sang ESM', 'refactor'],
    ['chạy test rồi cho pass hết đi', 'test'],
    ['brainstorm với tôi vài ý tưởng kiến trúc', 'discuss'],
    ['where is the retry logic, walk me through it', 'research'],
    ['viết readme cho repo này', 'docs'],
    ['deploy cái này lên kubernetes', 'ops']
  ];
  for (const [prompt, expected] of cases) {
    const d = detectProfile(prompt);
    assert.equal(d.profileId, expected, `"${prompt}" -> ${d.profileId}, expected ${expected}`);
    assert.notEqual(d.confidence, 'low', `"${prompt}" should be confident enough not to ask`);
  }
});

test('admits when it does not know, instead of guessing', () => {
  for (const prompt of ['làm cái này đi', 'ok', 'tiếp tục', 'hmm']) {
    assert.equal(detectProfile(prompt).confidence, 'low', prompt);
  }
});

test('an explicit #profile tag always wins', () => {
  const d = detectProfile('#docs refactor migrate rewrite everything');
  assert.equal(d.profileId, 'docs');
  assert.equal(d.confidence, 'certain');
});

test('user-defined profiles participate in detection', () => {
  const custom = { pentest: { id: 'pentest', label: 'Pentest', budgetUsd: 3, burnUsdPerMin: 1, ctxWarnPct: 80, keywords: { en: ['pentest', 'exploit'], vi: ['thâm nhập'] } } };
  assert.equal(detectProfile('run a pentest against the exploit path', custom).profileId, 'pentest');
});

test('reads a budget stated in the prompt, in either language', () => {
  assert.equal(detectBudget('add a login endpoint, budget $2.50'), 2.5);
  assert.equal(detectBudget('ngân sách 1.5 đô cho việc này'), 1.5);
  assert.equal(detectBudget('giới hạn $0.75 thôi nhé'), 0.75);
  assert.equal(detectBudget('no money mentioned here'), null);
});

test('never asks when nobody is there to answer', () => {
  const low = detectProfile('làm cái này đi');
  assert.equal(shouldAsk(low, { unattended: true }), false);
  assert.equal(shouldAsk(low, { askProfile: false }), false);
  assert.equal(shouldAsk(low, {}), true);
});

test('budget phrases are data, so a new language needs no code change', () => {
  // This was a hardcoded English-and-Vietnamese regex while profile detection
  // had already become language-agnostic: a German profile was recognised, but
  // "höchstens 4" was not.
  assert.equal(detectBudget('höchstens 4 euro bitte'), null, 'not known out of the box');
  assert.equal(detectBudget('höchstens 4 euro bitte', { de: ['höchstens'] }), 4);
  assert.equal(detectBudget('presupuesto 2.5', { es: ['presupuesto'] }), 2.5);
});

test('the longest phrase wins, so "at most" is not read as "max"', () => {
  assert.equal(detectBudget('at most $0.75 please'), 0.75);
  assert.equal(detectBudget('no more than 12'), 12);
});

test('a phrase containing regex characters cannot break the matcher', () => {
  assert.doesNotThrow(() => detectBudget('spend 5', { weird: ['(a|b)[', '*+?'] }));
  assert.equal(detectBudget('c++ budget 7', { cpp: ['c++'] }), 7);
});
