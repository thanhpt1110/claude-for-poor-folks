#!/usr/bin/env node
/**
 * `claude-for-poor-folks hook` — one entry point for every Claude Code hook event.
 *
 * Two constraints shape everything here.
 *
 * 1. Hooks are NOT interactive. They run without a controlling terminal and
 *    cannot open /dev/tty, so the gate can never be a question asked from here.
 *    It is inferred, or raised as a permission "ask", or simply reported.
 *
 * 2. EVERY TOKEN THIS TOOL ADDS TO THE CONVERSATION IS BILLED TO THE USER.
 *    A tool that exists to reduce spend must not quietly increase it. Measured
 *    on a real session: text returned as `systemMessage` is shown to the human
 *    and is NOT visible to the model (asked directly, the model could not read
 *    it back), while `additionalContext` IS visible and therefore costs money.
 *    So warnings go out as `systemMessage` only, and the single place that uses
 *    `additionalContext` is opt-in and off by default.
 *
 * And always exit 0. A budget tool that breaks someone's session is worse than
 * no budget tool.
 */

import { loadConfig, effectiveLimits } from '../io/config.js';
import {
  readSessionState, writeSessionState, readSnapshot, readSession, effectiveCost,
  emptyState, burnRate, pushSample, appendLedger, pruneOldSessions, todaySpend
} from '../io/state.js';
import { readSessionDelta, addTokens, emptyTokens, estimateCost } from '../io/transcript.js';
import { decide, newSignals, permissionFor } from '../core/policy.js';
import { signalBlock, money } from '../core/format.js';
import { detectProfile, shouldAsk } from '../core/detect.js';
import { resolveProfiles } from '../core/profiles.js';

/** Sync sleep. Hooks are synchronous by nature and this is bounded and short. */
/** @param {number} ms */
function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ }
}

/**
 * Headless runs (`claude -p`, CI) have no status line, so nothing feeds the
 * meter. The transcript does: read only the bytes appended since last time,
 * across the main transcript and every subagent transcript, and fold them in.
 */
/**
 * @param {import('../types.js').SessionState} state
 * @param {Partial<import('../types.js').HookPayload>} payload
 * @param {import('../types.js').Config} config
 */
function meterFromTranscript(state, payload, config) {
  const file = payload.transcript_path || state.transcriptPath;
  if (!file) return;
  state.transcriptPath = file;
  const delta = readSessionDelta(file, state.transcriptOffsets || {}, state.counted || {}, state.subagentTranscripts || []);
  state.transcriptOffsets = delta.offsets;
  state.counted = delta.counted;

  const t = delta.tokens;
  if (!t.messages && !t.input && !t.output && !t.cacheRead && !t.cacheCreate) return;

  state.tokens = addTokens(state.tokens || emptyTokens(), t);
  state.byModel = state.byModel || {};
  for (const [model, mt] of Object.entries(delta.byModel)) {
    state.byModel[model] = addTokens(state.byModel[model] || emptyTokens(), mt);
  }
  const est = estimateCost(state.byModel, config.prices);
  if (est != null) {
    state.estCostUsd = est;
    pushSample(state, est);            // only used when no status line is sampling
  }
}

/**
 * Read the transcript until it stops growing, or the budget runs out.
 *
 * The Stop hook races the process writing the transcript: the final assistant
 * message is usually not on disk yet. Measured on a real session, without this
 * wait every session silently under-reports by its last turn.
 */
/**
 * @param {import('../types.js').SessionState} state
 * @param {Partial<import('../types.js').HookPayload>} payload
 * @param {import('../types.js').Config} config
 * @param {number} [budgetMs]
 */
function meterSettled(state, payload, config, budgetMs = 900) {
  const POLL_MS = 120;
  // An earlier version skipped this wait when the main transcript looked "cold"
  // (mtime older than 1.5s), to save ~240ms per turn. Measured against a real
  // session, that lost 226 output tokens: while a subagent runs it writes to its
  // OWN file, so the main transcript goes quiet even though the turn is not
  // finished. The wait stays. Correct numbers are the entire product; 240ms once
  // per turn is not worth trading them for.

  const QUIET_POLLS = 2;          // one quiet poll is not enough: the writer may
                                  // simply not have started yet when Stop fires
  const deadline = Date.now() + budgetMs;
  const total = () => {
    const t = state.tokens || {};
    return (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreate || 0);
  };

  meterFromTranscript(state, payload, config);
  let previous = total();
  let quiet = 0;
  while (Date.now() < deadline && quiet < QUIET_POLLS) {
    sleep(POLL_MS);
    meterFromTranscript(state, payload, config);
    const now = total();
    quiet = now === previous ? quiet + 1 : 0;
    previous = now;
  }
}

/** @param {import('../types.js').Config} config */
function profileMenu(config) {
  return Object.values(resolveProfiles(config.customProfiles))
    .map(p => `${p.id} (${money(p.budgetUsd)})`)
    .join(', ');
}

/** Fold the current decision into a user-facing message, marking codes as seen. */
/**
 * @param {import('../types.js').SessionState} state
 * @param {import('../types.js').Decision} decision
 * @returns {string|null}
 */
function surface(state, decision) {
  const fresh = newSignals(decision, state.firedWarnings);
  if (!fresh.length) return null;
  state.firedWarnings = [...new Set([...(state.firedWarnings || []), ...fresh.map(s => s.code)])];
  return signalBlock(fresh);
}

/**
 * @param {string} event
 * @param {Partial<import('../types.js').HookPayload>} payload  parsed from stdin,
 *   so every field is treated as possibly absent — this handler reads defensively
 * @returns {import('../types.js').HookResult}
 */
export function handle(event, payload) {
  const sessionId = payload.session_id || 'unknown';
  const cwd = payload.cwd || process.cwd();
  const config = loadConfig(cwd);
  const state = readSessionState(sessionId);
  state.sessionId = sessionId;
  state.cwd = cwd;

  const withLimits = () => effectiveLimits(config, state.profile);

  // Scanning the ledger on every tool call would be wasteful; a 10s cache is far
  // finer-grained than the thing it watches.
  /** @type {{ usd: number, sessions: number }|null} */
  let todayCache = null;
  let todayCacheAt = 0;
  const todayTotals = () => {
    const limits = withLimits();
    if (!(Number(limits.dailyUsd ?? 0) > 0)) return null;
    if (todayCacheAt && Date.now() - todayCacheAt < 10_000) return todayCache;
    todayCache = todaySpend(limits.dailyScope === 'machine' ? null : cwd);
    todayCacheAt = Date.now();
    return todayCache;
  };

  const judge = () => {
    const limits = withLimits();
    const session = readSession(sessionId);
    const merged = { ...session, ...state, costUsd: session.costUsd, samples: session.samples };
    const cap = state.budgetUsd ?? limits.sessionUsd;
    return {
      limits,
      decision: decide(merged, { ...limits, sessionUsd: cap },
        { burnRate: burnRate(merged), today: todayTotals() })
    };
  };

  switch (event) {
    case 'SessionStart': {
      pruneOldSessions();
      // The field is `source`, not `how`. Captured from a live session, because
      // guessing it meant this whole block was dead code while the tests, which
      // used the invented name, stayed green.
      const how = payload.source;
      const reset = how === 'startup' || how === 'clear';
      if (reset) {
        // A /clear starts a new task. Leaving the previous task's profile in
        // place pins the new work to the old budget and never re-detects.
        // Everything task-scoped has to go, not just the counters. Leaving
        // `tokens` behind would add the previous task's usage to the new one's
        // token budget, and leaving `firedWarnings` cleared while `tokens` stays
        // would immediately re-fire a warning about spend that already happened.
        Object.assign(state, {
          ...emptyState(sessionId),
          cwd,
          profile: config.profile || null,
          profileLabel: config.profileLabel || null,
          profileSource: config.profile ? 'config' : null
        });
      }
      if (how === 'compact') state.compactCount = (state.compactCount || 0) + 1;
      const limits = withLimits();
      state.budgetUsd = state.budgetUsd ?? limits.sessionUsd;
      writeSessionState(state, { merge: !reset });
      if (config.quiet) return {};
      // systemMessage is shown to the human and is NOT visible to the model
      // (measured), so it is free. Clarity costs nothing here.
      return {
        systemMessage:
          `[poor-folks] budget ${money(limits.sessionUsd)} · profile ${state.profile || 'auto'} · on-limit ${config.onLimit}` +
          `${config.unattended ? ' · unattended' : ''}${config.askProfile ? '' : ' · adds 0 tokens'}`
      };
    }

    case 'UserPromptSubmit': {
      meterFromTranscript(state, payload, config);
      state.promptCount = (state.promptCount || 0) + 1;
      const prompt = payload.prompt ?? '';
      /** @type {string|null} */
      let note = null;
      /** @type {string|null} */
      let ask = null;

      if (!state.profile) {
        const det = detectProfile(prompt, config.customProfiles, config.budgetPhrases);
        if (det.budgetUsd) { state.budgetUsd = det.budgetUsd; state.budgetSource = 'prompt'; }
        if (det.confidence !== 'low') {
          state.profile = det.profileId;
          state.profileSource = det.confidence === 'certain' ? 'explicit' : 'detected';
          const limits = effectiveLimits(config, state.profile);
          const cap = state.budgetSource === 'prompt' ? state.budgetUsd : limits.sessionUsd;
          note = `[poor-folks] ${limits.profile.label} · cap ${money(cap)} · #<profile> to override`;
        } else if (shouldAsk(det, config)) {
          // The only text this tool ever puts in front of the model, and it is
          // off by default precisely because it is the only part that costs.
          ask = `Ask the user once, with AskUserQuestion, which kind of task this is: ${profileMenu(config)}. Then continue. Do not ask again.`;
        } else {
          state.profile = det.profileId;
          state.profileSource = 'fallback';
          const limits = effectiveLimits(config, state.profile);
          note = `[poor-folks] unclear task — assuming ${limits.profile.label} · cap ${money(state.budgetUsd ?? limits.sessionUsd)} · say #<profile> to change`;
        }
      }

      const { limits, decision } = judge();
      if (state.budgetSource !== 'prompt') state.budgetUsd = limits.sessionUsd;
      const warn = surface(state, decision);
      writeSessionState(state);

      /** @type {import('../types.js').HookResult} */
      const res = {};
      if (ask) res.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: ask };
      const lines = [note, warn].filter(Boolean);
      if (lines.length && !config.quiet) res.systemMessage = lines.join('\n');
      return res;
    }

    case 'PreToolUse': {
      meterFromTranscript(state, payload, config);
      state.toolCount = (state.toolCount || 0) + 1;
      const { decision } = judge();
      const perm = permissionFor(decision, config);
      const warn = surface(state, decision);
      writeSessionState(state);

      /** @type {import('../types.js').HookResult} */
      const res = {};
      if (perm) {
        res.hookSpecificOutput = {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `[poor-folks] ${perm.reason}`
        };
      }
      if (warn && !config.quiet) res.systemMessage = warn;
      return res;
    }

    case 'SubagentStart': {
      state.subagentCount = (state.subagentCount || 0) + 1;
      if (payload.agent_type) {
        state.agentTypes = state.agentTypes || {};
        state.agentTypes[payload.agent_type] = (state.agentTypes[payload.agent_type] || 0) + 1;
      }
      writeSessionState(state);
      return {};
    }

    case 'SubagentStop': {
      // Claude Code hands us the subagent's transcript path outright. That beats
      // inferring it from the directory layout, which is an undocumented detail
      // that can move; the inferred path stays as a fallback for older versions.
      if (payload.agent_transcript_path) {
        state.subagentTranscripts = [...new Set([...(state.subagentTranscripts || []), payload.agent_transcript_path])];
      }
      meterFromTranscript(state, payload, config);
      writeSessionState(state);
      return {};
    }

    case 'PreCompact': {
      state.compactCount = (state.compactCount || 0) + 1;
      writeSessionState(state);
      if (config.quiet) return {};
      return { systemMessage: `[poor-folks] compaction #${state.compactCount} — the whole conversation gets re-read. A fresh session is usually cheaper.` };
    }

    case 'Stop': {
      meterSettled(state, payload, config);
      const snap = readSnapshot(sessionId);
      const cost = effectiveCost({ costUsd: snap.costUsd, estCostUsd: state.estCostUsd });
      const delta = Math.max(0, cost - (state.lastLedgerCostUsd || 0));
      // A thin per-turn row: this is what "spent today" is summed from, and it
      // must stay small because it is appended on every single turn.
      appendLedger({
        kind: 'turn', ts: new Date().toISOString(), sessionId, cwd,
        deltaUsd: Number(delta.toFixed(6)), costUsd: Number(cost.toFixed(6))
      });
      state.lastLedgerCostUsd = cost;
      writeSessionState(state);
      return {};
    }

    case 'SessionEnd': {
      meterSettled(state, payload, config, 1200);
      const limits = withLimits();
      const snap = readSnapshot(sessionId);
      const cost = effectiveCost({ costUsd: snap.costUsd, estCostUsd: state.estCostUsd });
      // One fat row per session: this is what `report` reads.
      appendLedger({
        kind: 'session', ts: new Date().toISOString(), sessionId, cwd,
        model: snap.model || Object.keys(state.byModel || {})[0] || null,
        profile: state.profile || null,
        profileLabel: state.profileLabel || null,
        profileSource: state.profileSource || null,
        costUsd: Number(cost.toFixed(6)),
        estCostUsd: state.estCostUsd == null ? null : Number(state.estCostUsd.toFixed(6)),
        budgetUsd: state.budgetUsd ?? limits.sessionUsd,
        promptCount: state.promptCount || 0,
        toolCount: state.toolCount || 0,
        subagentCount: state.subagentCount || 0,
        compactCount: state.compactCount || 0,
        ctxPct: snap.ctxPct ?? null,
        fiveHourPct: snap.fiveHourPct ?? null,
        sevenDayPct: snap.sevenDayPct ?? null,
        recognized: snap.recognized,
        transcriptPath: state.transcriptPath || null,
        tokens: state.tokens || null,
        byModel: state.byModel || null
      });
      writeSessionState(state);
      return {};
    }

    default:
      return {};
  }
}

/** @param {string[]} argv */
export async function main(argv) {
  let input = '';
  try { for await (const chunk of process.stdin) input += chunk; } catch { /* empty */ }
  try {
    const payload = JSON.parse(input || '{}');
    const event = argv[0] || payload.hook_event_name || 'unknown';
    const out = handle(event, payload);
    if (out && Object.keys(out).length) process.stdout.write(JSON.stringify(out));
  } catch {
    /* silence is the correct failure mode for a hook */
  }
  process.exit(0);
}
