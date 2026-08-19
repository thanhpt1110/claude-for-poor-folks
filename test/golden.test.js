import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionTotals, estimateCost, cacheReadRatio } from '../src/io/transcript.js';

/**
 * The numbers the README sells this tool on, locked down.
 *
 * These usage rows reproduce a real measured session: a main agent on
 * claude-opus-5 that delegated to one subagent on claude-opus-4-8. Claude Code
 * reported input 8 / output 2,716 / cache-read 47,807 / cache-write 66,715 and
 * $0.508812 for it. Only the usage figures are reproduced here — no prompt or
 * response text — so the fixture proves the arithmetic without carrying anyone's
 * private conversation into a public repository.
 *
 * Note the subagent rows: the same message id repeated with output_tokens
 * growing (2 -> 579). Summing them gives the wrong answer, and so does taking
 * the first. That is exactly the regression this test exists to catch.
 */
/** @type {Array<[string, number, number, number, number, string]>} */
const MAIN = [
  ['m-main-1', 2, 353, 0, 28373, 'claude-opus-5'],
  ['m-main-1', 2, 353, 0, 28373, 'claude-opus-5'],
  ['m-main-2', 2, 1128, 28374, 11606, 'claude-opus-5']
];
/** @type {Array<[string, number, number, number, number, string]>} */
const SUB = [
  ['m-sub-1', 2, 2, 0, 19433, 'claude-opus-4-8'],
  ['m-sub-1', 2, 2, 0, 19433, 'claude-opus-4-8'],
  ['m-sub-1', 2, 579, 0, 19433, 'claude-opus-4-8'],
  ['m-sub-2', 2, 2, 19433, 7303, 'claude-opus-4-8'],
  ['m-sub-2', 2, 656, 19433, 7303, 'claude-opus-4-8']
];

const CLAUDE_REPORTED = { input: 8, output: 2716, cacheRead: 47807, cacheCreate: 66715 };
const CLAUDE_COST_USD = 0.508812;
const PRICES = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
};

/** @param {[string, number, number, number, number, string]} r */
const row = ([id, i, o, cr, cc, model]) => JSON.stringify({
  type: 'assistant', requestId: `req-${id}`,
  message: { id, model, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc } }
});

function buildSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-golden-'));
  const id = 'golden-session';
  const main = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(main, MAIN.map(row).join('\n') + '\n');
  const sub = path.join(dir, id, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-golden.jsonl'), SUB.map(row).join('\n') + '\n');
  return main;
}

test('token totals match what Claude Code reported for the same session', () => {
  const totals = readSessionTotals(buildSession()).tokens;
  for (const k of /** @type {const} */ (['input', 'output', 'cacheRead', 'cacheCreate'])) {
    assert.equal(totals[k], CLAUDE_REPORTED[k], `${k} drifted`);
  }
});

test('the subagent is counted — without it this session under-reports by 41%', () => {
  const r = readSessionTotals(buildSession());
  const sub = r.byModel['claude-opus-4-8'];
  assert.ok(sub, 'the subagent model must appear at all');
  assert.equal(sub.output, 1235);
  assert.equal(sub.cacheCreate, 26736);

  const subCost = estimateCost({ 'claude-opus-4-8': sub }, PRICES);
  const allCost = estimateCost(r.byModel, PRICES);
  assert.ok(subCost != null && allCost, 'prices are supplied, so both must price');
  const share = subCost / allCost;
  assert.ok(share > 0.35 && share < 0.45, `subagent share was ${(share * 100).toFixed(0)}%, expected ~41%`);
});

test('the priced estimate lands within 0.1% of the figure Claude Code reported', () => {
  const est = estimateCost(readSessionTotals(buildSession()).byModel, PRICES);
  assert.ok(est != null, 'prices are supplied, so a figure must come out');
  const errPct = Math.abs(est - CLAUDE_COST_USD) / CLAUDE_COST_USD * 100;
  assert.ok(errPct < 0.1, `cost estimate was ${est} vs ${CLAUDE_COST_USD} (${errPct.toFixed(3)}% off)`);
});

test('cache read ratio is computed over the whole session, subagent included', () => {
  const ratio = cacheReadRatio(readSessionTotals(buildSession()).tokens);
  assert.ok(ratio != null);
  assert.ok(Math.abs(ratio - 47807 / (47807 + 66715 + 8)) < 1e-9);
});
