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
import { statusLineState, noticeAlreadyShown } from '../io/wiring.js';

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
 * FNV-1a over the tool input. Only ever compared with itself, so it needs to be
 * fast and stable, not cryptographic — and it avoids pulling in node:crypto on
 * a path that runs after every single tool call.
 * @param {string} str
 * @returns {string}
 */
function fingerprint(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Bounds on what a single session may accumulate, so state cannot grow without limit. */
const MAX_TOOL_NAMES = 40;
const MAX_REPEAT_KEYS = 400;

/**
 * @param {string} event
 * @param {Partial<import('../types.js').HookPayload>} payload  parsed from stdin,
 *   so every field is treated as possibly absent — this handler reads defensively
 * @param {number} [rawBytes]  size of the payload as it arrived. Used instead of
 *   re-serialising `tool_response`, which can be megabytes and would put that cost
 *   on every tool call purely to measure it.
 * @returns {import('../types.js').HookResult}
 */
export function handle(event, payload, rawBytes = 0) {
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
      const banner = [
        `[poor-folks] budget ${money(limits.sessionUsd)} · profile ${state.profile || 'auto'} · on-limit ${config.onLimit}` +
        `${config.unattended ? ' · unattended' : ''}${config.askProfile ? '' : ' · adds 0 tokens'}`
      ];
      // A setting that does not exist is dropped in silence, so someone who
      // wrote `budgetUsd` instead of `budget.sessionUsd` sees a budget in their
      // file, a different one in the banner, and no reason for the gap. Say it
      // where they are already looking. This is systemMessage, so it is free.
      const ignored = config._warnings || [];
      if (ignored.length) {
        banner.push(`[poor-folks] ${ignored.length} setting${ignored.length > 1 ? 's' : ''} in your config ${ignored.length > 1 ? 'are' : 'is'} being ignored — run \`claude-for-poor-folks doctor\` for the list.`);
      }
      // These hooks are clearly running or this code would not be executing, so
      // a missing status line means this is a plugin install: a plugin manifest
      // cannot declare one. Say it once, hand over the command, then never
      // mention it again. Writing it into their settings unasked is not this
      // tool's decision to make.
      // Only when the slot is empty. Someone running their own status line made a
      // choice, and `install` will not overwrite it, so nudging them would be
      // advice that cannot work.
      // Order matters: the flag is one stat, the state check reads two JSON
      // files. Once this project has been told, the cheap check short-circuits
      // and the session never touches settings.json again.
      if (!noticeAlreadyShown('statusline', cwd, { peek: true }) && statusLineState(cwd) === 'none'
          && !noticeAlreadyShown('statusline', cwd)) {
        banner.push('[poor-folks] the live meter needs one more step: run `claude-for-poor-folks install --status-line-only`. A plugin cannot declare a status line, and that flag adds only the missing piece — a full install would wire the hooks a second time. Said once per project; `doctor` will tell you any time.');
      }
      return { systemMessage: banner.join('\n') };
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

    case 'PostToolUse': {
      if (!config.measureTools) return {};
      // Deliberately does NOT read the transcript. This fires after every tool
      // call, so anything expensive here is paid hundreds of times a session by
      // a tool whose whole purpose is to not waste the user's resources.
      const name = String(payload.tool_name || 'unknown');
      const stats = state.toolStats || (state.toolStats = {});
      const seen = stats[name];
      if (seen || Object.keys(stats).length < MAX_TOOL_NAMES) {
        const entry = seen || (stats[name] = { calls: 0, bytes: 0, ms: 0 });
        entry.calls++;
        entry.bytes += rawBytes;
        entry.ms += Number(payload.duration_ms) || 0;
      }

      // Identical input to the same tool is the cheapest waste to find and the
      // one nothing else reports: the transcript shows the bytes, never that the
      // same bytes were fetched before.
      // Only the fingerprint is kept, never the input it came from. A Bash
      // tool_input is a command line, which carries credentials; an Edit
      // tool_input is the user's source. SECURITY.md promises that prompts and
      // code are never stored and that no API key is ever touched, and a
      // truncated "sample" of the input would have made both sentences false —
      // in a file on disk and in `report --json`. The actionable signal is that
      // the SAME call happened N times, which the fingerprint carries on its own.
      const repeats = state.repeats || (state.repeats = {});
      let input = '';
      try { input = JSON.stringify(payload.tool_input ?? null); } catch { input = ''; }
      if (input) {
        const key = `${name}:${fingerprint(input)}`;
        const hit = repeats[key];
        if (hit) { hit.count++; hit.bytes += rawBytes; }
        else if (Object.keys(repeats).length < MAX_REPEAT_KEYS) {
          repeats[key] = { tool: name, count: 1, bytes: rawBytes };
        }
      }
      writeSessionState(state);
      return {};
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
        // Trimmed on the way in, not on the way out: the ledger rotates at 4 MB
        // and one session with 400 distinct calls would otherwise dominate it.
        toolStats: state.toolStats && Object.keys(state.toolStats).length ? state.toolStats : undefined,
        repeats: topRepeats(state.repeats, 12),
        // Separate from the capped list above: the headline has to be able to
        // say how much was re-sent in total, and summing the top 12 would quietly
        // report 12 when the truth was 15.
        repeatTotals: repeatTotals(state.repeats),
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


/**
 * Every repeated group, not just the ones that fit in the ledger. The first call
 * of a group was work; only the ones after it were re-sent, so they are what is
 * counted and what the byte total is apportioned to.
 *
 * @param {Record<string, {tool: string, count: number, bytes: number}>|undefined} repeats
 */
function repeatTotals(repeats) {
  let resent = 0;
  let bytes = 0;
  for (const r of Object.values(repeats || {})) {
    if (!(r.count > 1)) continue;
    resent += r.count - 1;
    bytes += r.bytes * (r.count - 1) / r.count;
  }
  return resent ? { resent, bytes: Math.round(bytes) } : undefined;
}

/**
 * The worst repeated calls, largest first. Calls that happened once are dropped —
 * they are just work, not waste — and the rest is capped so a single session
 * cannot crowd the ledger.
 *
 * @param {Record<string, {tool: string, count: number, bytes: number}>|undefined} repeats
 * @param {number} limit
 */
function topRepeats(repeats, limit) {
  const rows = Object.values(repeats || {}).filter(r => r.count > 1);
  if (!rows.length) return undefined;
  return rows.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

/** @param {string[]} argv */
export async function main(argv) {
  let input = '';
  try { for await (const chunk of process.stdin) input += chunk; } catch { /* empty */ }
  try {
    const payload = JSON.parse(input || '{}');
    const event = argv[0] || payload.hook_event_name || 'unknown';
    // `input` is the decoded string; .length counts UTF-16 code units, which
    // undercounts real bytes by up to 3x on CJK or emoji. It is labelled bytes
    // everywhere it surfaces, so it has to actually be bytes.
    const out = handle(event, payload, Buffer.byteLength(input));
    if (out && Object.keys(out).length) process.stdout.write(JSON.stringify(out));
  } catch {
    /* silence is the correct failure mode for a hook */
  }
  process.exit(0);
}
