#!/usr/bin/env node
/**
 * `claude-for-poor-folks statusline` — wired to settings.json "statusLine".
 *
 * Claude Code already computes cost, context usage and rate-limit percentages
 * and hands them to the status line on stdin. So this process is both the
 * display AND the meter: metering costs nothing extra, because the status line
 * was going to run anyway.
 *
 * It writes ONLY the snapshot file. The hooks own the other file. See io/state.js
 * for why sharing one file was wrong.
 *
 * Hard rules: never throw, never block, never touch the network, and never write
 * anything the model can read.
 */

import { loadConfig, effectiveLimits } from '../io/config.js';
import { readSnapshot, readSessionState, writeSnapshot, emptySnapshot, pushSample, burnRate } from '../io/state.js';
import { decide } from '../core/policy.js';
import { statusLine } from '../core/format.js';

/**
 * Pull the fields we understand out of the payload, and report whether we
 * understood ANY of them.
 *
 * This flag matters more than it looks. If Claude Code renames a field, every
 * read becomes undefined, every number becomes 0, and a budget meter that reads
 * $0.00 looks exactly like a session that has spent nothing. Failing silently
 * towards zero is the one failure direction this tool must never take, so a
 * payload that arrives non-empty but yields nothing recognisable is recorded as
 * unrecognised and surfaced instead of being averaged into a comfortable green.
 */
/**
 * @param {import('../types.js').StatusLinePayload} payload
 * @param {import('../types.js').Snapshot} snap
 * @returns {import('../types.js').Snapshot}
 */
export function readPayload(payload, snap) {
  let recognized = false;

  if (payload.cost && typeof payload.cost.total_cost_usd === 'number') {
    snap.costUsd = payload.cost.total_cost_usd;
    snap.durationMs = payload.cost.total_duration_ms ?? snap.durationMs;
    recognized = true;
  }
  if (payload.model?.id) {
    snap.model = payload.model.id;              // last writer wins, deliberately
    snap.modelName = payload.model.display_name || snap.modelName;
    recognized = true;
  }
  const cw = payload.context_window;
  if (cw && typeof cw.used_percentage === 'number') {
    snap.ctxPct = cw.used_percentage;
    snap.ctxSize = cw.context_window_size ?? snap.ctxSize;
    const cu = cw.current_usage || {};
    snap.lastUsage = {
      input: Number(cu.input_tokens || 0),
      output: Number(cu.output_tokens || 0),
      cacheRead: Number(cu.cache_read_input_tokens || 0),
      cacheCreate: Number(cu.cache_creation_input_tokens || 0)
    };
    recognized = true;
  }
  const rl = payload.rate_limits;
  if (rl && (rl.five_hour || rl.seven_day)) {
    snap.fiveHourPct = rl.five_hour?.used_percentage ?? snap.fiveHourPct;
    snap.fiveHourResetsAt = rl.five_hour?.resets_at ?? snap.fiveHourResetsAt;
    snap.sevenDayPct = rl.seven_day?.used_percentage ?? snap.sevenDayPct;
    snap.sevenDayResetsAt = rl.seven_day?.resets_at ?? snap.sevenDayResetsAt;
    recognized = true;
  }

  // One sparse frame proves nothing — an early render can legitimately carry
  // only a session id. Only a run of them means the shape really moved.
  const looksEmpty = !payload || Object.keys(payload).length === 0;
  if (!looksEmpty) {
    snap.unrecognizedRuns = recognized ? 0 : (snap.unrecognizedRuns || 0) + 1;
    if (recognized) snap.recognized = true;
    else if (snap.unrecognizedRuns >= 3) snap.recognized = false;
  }
  return snap;
}

/**
 * @param {string} stdinText
 * @returns {Promise<string>}
 */
export async function runStatusline(stdinText) {
  /** @type {import('../types.js').StatusLinePayload} */
  let payload = {};
  try { payload = JSON.parse(stdinText || '{}'); } catch { payload = {}; }

  const sessionId = payload.session_id || 'unknown';
  const cwd = payload.workspace?.current_dir || payload.cwd || process.cwd();
  const now = Date.now();

  const snap = { ...emptySnapshot(sessionId), ...readSnapshot(sessionId), sessionId };
  readPayload(payload, snap);
  pushSample(snap, snap.costUsd, now);
  writeSnapshot(snap);

  const state = readSessionState(sessionId);
  const config = loadConfig(cwd);
  const limits = effectiveLimits(config, state.profile);
  const session = {
    ...state, ...snap,
    budgetUsd: state.budgetUsd ?? limits.sessionUsd,
    tokens: state.tokens,
    estCostUsd: state.estCostUsd
  };

  const decision = decide(session, { ...limits, sessionUsd: session.budgetUsd }, { now, burnRate: burnRate(snap, now) });
  return config.quiet ? '' : statusLine(session, decision, limits);
}

export async function main() {
  let input = '';
  try {
    for await (const chunk of process.stdin) input += chunk;
  } catch { /* no stdin: fall through with an empty payload */ }
  try {
    const line = await runStatusline(input);
    if (line) process.stdout.write(line);
  } catch {
    /* a broken meter must never break the editor */
  }
  process.exit(0);
}
