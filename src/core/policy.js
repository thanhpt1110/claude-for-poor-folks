/**
 * The decision engine. Pure: (state, limits) -> signals. No I/O, no clock of
 * its own (pass `now`), so every rule is testable from a fixture.
 *
 * v1 never denies a tool call. It reports, and at most asks. A budget tool that
 * blocks wrongly once gets uninstalled the same evening.
 */

/** @type {Record<import('../types.js').SignalLevel, number>} */
export const LEVELS = { ok: 0, notice: 1, warn: 2, critical: 3 };

/**
 * @param {string} code
 * @param {import('../types.js').SignalLevel} level
 * @param {string} title    what happened
 * @param {string} detail   why it matters
 * @param {string} action   what to do about it
 * @param {Record<string, any>} [data]
 * @returns {import('../types.js').Signal}
 */
function sig(code, level, title, detail, action, data = {}) {
  return { code, level, title, detail, action, data };
}

/**
 * @param {Partial<import('../types.js').Session>} state
 * @param {Partial<import('../types.js').Limits>} limits  from config.effectiveLimits()
 * @param {{ now?: number, burnRate?: number|null, today?: {usd: number, sessions: number}|null }} [opts]
 * @returns {import('../types.js').Decision}
 */
export function decide(state, limits, opts = {}) {
  const now = opts.now ?? Date.now();
  /** @type {import('../types.js').Signal[]} */
  const signals = [];

  const cap = Number(limits.sessionUsd ?? 0);
  // The status line is the primary meter. With no status line (headless, CI) it
  // reports nothing, so fall back to the price-estimated transcript figure.
  const cost = Number(state.costUsd || 0) || Number(state.estCostUsd || 0);
  const pct = cap > 0 ? (cost / cap) * 100 : 0;

  // --- 1. budget ---------------------------------------------------------
  if (cap > 0) {
    if (pct >= 100) {
      signals.push(sig(
        'budget.over', 'critical',
        `Over budget: $${cost.toFixed(2)} of $${cap.toFixed(2)}`,
        `This session has spent ${pct.toFixed(0)}% of the cap set for a "${limits.profile?.label ?? 'unknown'}" task.`,
        'Decide explicitly: raise the cap, narrow the task, or stop here.',
        { cost, cap, pct }
      ));
    } else {
      const thresholds = [...(limits.warnAtPct || [])].sort((a, b) => b - a);
      for (const t of thresholds) {
        if (pct >= t) {
          signals.push(sig(
            `budget.warn.${t}`, t >= 80 ? 'warn' : 'notice',
            `${t}% of budget used — $${cost.toFixed(2)} of $${cap.toFixed(2)}`,
            `Remaining: $${(cap - cost).toFixed(2)}.`,
            t >= 80 ? 'Wrap up, or raise the cap on purpose rather than by accident.' : 'Still fine. Just so you know where you are.',
            { cost, cap, pct, threshold: t }
          ));
          break;   // only the highest threshold crossed
        }
      }
    }
  }

  // --- 1b. token budget: the only unit that needs no price list ---------
  const tok = state.tokens || null;
  const tokenCap = Number(limits.sessionTokens ?? 0);
  if (tokenCap > 0 && tok) {
    const used = tok.input + tok.output + tok.cacheRead + tok.cacheCreate;
    const tpct = (used / tokenCap) * 100;
    if (tpct >= 100) {
      signals.push(sig(
        'tokens.over', 'critical',
        `Over token budget: ${Math.round(used / 1000)}k of ${Math.round(tokenCap / 1000)}k`,
        'Counted from the session transcript, so this works with no status line and no price list.',
        'Raise the token budget on purpose, or stop here.',
        { used, tokenCap, pct: tpct }
      ));
    } else {
      const threshold = [...(limits.warnAtPct || [])].sort((a, b) => b - a).find(t => tpct >= t);
      if (threshold) signals.push(sig(
        `tokens.warn.${threshold}`, threshold >= 80 ? 'warn' : 'notice',
        `${threshold}% of token budget used — ${Math.round(used / 1000)}k of ${Math.round(tokenCap / 1000)}k`,
        `Remaining: ${Math.round((tokenCap - used) / 1000)}k tokens.`,
        'Wrap up, or raise the budget deliberately.',
        { used, tokenCap, pct: tpct }
      ));
    }
  }

  // --- 1c. today's total across every session ---------------------------
  // Four sessions in four tmux panes each stay under a $1 cap and still spend $4.
  const dailyCap = Number(limits.dailyUsd ?? 0);
  if (dailyCap > 0 && opts.today) {
    const { usd, sessions } = opts.today;
    const dpct = (usd / dailyCap) * 100;
    const where = limits.dailyScope === 'machine' ? 'on this machine' : 'in this repo';
    if (dpct >= 100) {
      signals.push(sig(
        'daily.over', 'critical',
        `Day's budget gone: $${usd.toFixed(2)} of $${dailyCap.toFixed(2)} ${where}`,
        `Across ${sessions} session(s) today. A per-session cap does not see this.`,
        'Stop, or raise the daily cap deliberately.',
        { usd, cap: dailyCap, sessions, pct: dpct }
      ));
    } else if (dpct >= 80) {
      signals.push(sig(
        'daily.warn.80', 'warn',
        `80% of today's budget — $${usd.toFixed(2)} of $${dailyCap.toFixed(2)} ${where}`,
        `Across ${sessions} session(s) today.`,
        'Whatever is left has to cover the rest of the day.',
        { usd, cap: dailyCap, sessions, pct: dpct }
      ));
    }
  }

  // --- 2. burn rate (the runaway-loop signal) ---------------------------
  const burn = opts.burnRate ?? null;
  const burnLimit = Number(limits.burnUsdPerMin ?? 0);
  if (burn != null && burnLimit > 0 && burn > burnLimit) {
    const runwayMin = cap > 0 && burn > 0 ? Math.max(0, (cap - cost) / burn) : null;
    signals.push(sig(
      'burn.high', burn > burnLimit * 2 ? 'critical' : 'warn',
      `Burning $${burn.toFixed(2)}/min (limit $${burnLimit.toFixed(2)}/min)`,
      runwayMin != null
        ? `At this rate the budget is gone in ~${runwayMin.toFixed(1)} min.`
        : 'Spend per minute is above what this kind of task should need.',
      'Usually means a retry loop or a very large read. Check what the agent has been doing for the last minute.',
      { burn, limit: burnLimit, runwayMin }
    ));
  }

  // --- 3. subscription quota (for people who do not pay per token) -------
  if (state.fiveHourPct != null && state.fiveHourPct >= Number(limits.fiveHourPct ?? 100)) {
    signals.push(sig(
      'quota.fivehour', state.fiveHourPct >= 95 ? 'critical' : 'warn',
      `5-hour quota at ${Number(state.fiveHourPct).toFixed(0)}%`,
      'This limit is per rolling window, not per session.',
      'Park long-running work until the window resets, or move it to a cheaper model.',
      { pct: state.fiveHourPct, resetsAt: state.fiveHourResetsAt ?? null }
    ));
  }
  if (state.sevenDayPct != null && state.sevenDayPct >= Number(limits.sevenDayPct ?? 100)) {
    signals.push(sig(
      'quota.sevenday', state.sevenDayPct >= 95 ? 'critical' : 'warn',
      `Weekly quota at ${Number(state.sevenDayPct).toFixed(0)}%`,
      'Weekly limits reset slowly — running out here costs you days, not minutes.',
      'Save the remaining budget for work that actually needs this model.',
      { pct: state.sevenDayPct, resetsAt: state.sevenDayResetsAt ?? null }
    ));
  }

  // --- 4. context pressure (compaction is an expensive event) -----------
  const ctxPct = Number(state.ctxPct ?? 0);
  if (ctxPct >= Number(limits.ctxWarnPct ?? 100)) {
    signals.push(sig(
      'ctx.high', ctxPct >= 95 ? 'warn' : 'notice',
      `Context ${ctxPct.toFixed(0)}% full`,
      'Compaction is near. Compaction re-reads the whole conversation, so it costs real money and loses detail.',
      'Finish the current thread and start a fresh session for the next one — cheaper and sharper than compacting.',
      { ctxPct }
    ));
  }

  // --- 5. cache health (the biggest silent leak there is) ---------------
  // Cumulative transcript numbers when we have them; the status-line snapshot
  // otherwise. Cumulative is the more honest of the two.
  /** @type {Partial<import('../types.js').Tokens>} */
  const u = (state.tokens && state.tokens.messages > 0) ? state.tokens : (state.lastUsage ?? {});
  const cacheRead = Number(u.cacheRead || 0);
  const cacheCreate = Number(u.cacheCreate || 0);
  const fresh = Number(u.input || 0);
  const totalIn = cacheRead + cacheCreate + fresh;
  // Was hardcoded to 50_000 while `cache.minInputTokens` sat in the config doing
  // nothing. A knob that is read nowhere is worse than no knob.
  if (Number(state.promptCount ?? 0) >= 3 && totalIn >= Number(limits.cacheMinInputTokens ?? 50_000)) {
    const ratio = cacheRead / totalIn;
    if (ratio < Number(limits.minCacheReadRatio ?? 0.5)) {
      signals.push(sig(
        'cache.low', 'warn',
        `Prompt cache read ratio ${(ratio * 100).toFixed(0)}%`,
        'Cache reads cost about a tenth of fresh input. A low ratio this deep into a session means the prefix keeps changing.',
        'Common causes: editing files that are already in context, a tool that injects a timestamp, or switching model/effort mid-session.',
        { ratio, cacheRead, cacheCreate, fresh }
      ));
    }
  }

  // --- 6. fan-out and repeated compaction -------------------------------
  if (Number(state.subagentCount ?? 0) >= Number(limits.warnSubagents ?? Infinity)) {
    signals.push(sig(
      'fanout.high', 'notice',
      `${state.subagentCount} subagents spawned`,
      'Each subagent carries its own context and bills separately.',
      'Fan-out is the fastest way to multiply spend. Make sure every one of them is doing necessary work.',
      { count: state.subagentCount }
    ));
  }
  if (Number(state.compactCount ?? 0) >= Number(limits.warnCompacts ?? Infinity)) {
    signals.push(sig(
      'compact.repeat', 'warn',
      `Context compacted ${state.compactCount}x in one session`,
      'Repeated compaction means the session is carrying more than it needs.',
      'Split the work into separate sessions; each compaction pays to re-read everything.',
      { count: state.compactCount }
    ));
  }

  // A meter that reads zero because it stopped understanding the payload looks
  // exactly like a session that has spent nothing. Say so out loud.
  if (state.recognized === false) {
    signals.push(sig(
      'meter.blind', 'warn',
      'Cost data not recognised',
      'Claude Code sent a status-line payload with no field this version understands — most likely it was updated and the shape changed.',
      'Update this tool (npm i -g claude-for-poor-folks). Until then the dollar figure is not trustworthy; token counts from the transcript still are.',
      {}
    ));
  }

  const level = signals.reduce((max, s) => Math.max(max, LEVELS[s.level] ?? 0), 0);
  const levelName = /** @type {import('../types.js').SignalLevel} */ (
    Object.keys(LEVELS).find(k => LEVELS[/** @type {import('../types.js').SignalLevel} */ (k)] === level) ?? 'ok'
  );
  return {
    signals,
    level,
    levelName,
    pct,
    cost,
    cap,
    burn,
    now
  };
}

/**
 * Signals not yet surfaced this session. Keeps the tool from nagging.
 * @param {import('../types.js').Decision} decision
 * @param {string[]} [firedWarnings]
 */
export function newSignals(decision, firedWarnings = []) {
  const fired = new Set(firedWarnings);
  return decision.signals.filter(s => !fired.has(s.code));
}

/**
 * v1 policy: warn, or ask at critical when the user opted in. Never deny.
 * @param {import('../types.js').Decision} decision
 * @param {Partial<import('../types.js').Config>|null|undefined} config
 * @returns {{ decision: 'ask', reason: string }|null}
 */
export function permissionFor(decision, config) {
  if (config?.unattended) return null;                 // nobody can answer a prompt
  if (config?.onLimit !== 'ask') return null;
  if (decision.level < LEVELS.critical) return null;
  return {
    decision: 'ask',
    reason: decision.signals
      .filter(s => s.level === 'critical')
      .map(s => `${s.title}. ${s.action}`)
      .join(' ')
  };
}
