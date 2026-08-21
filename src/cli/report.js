/**
 * `report` answers the only question that changes behaviour: where did the
 * money go, and which habit caused it?
 *
 * Sources, in order of trust:
 *   1. the session transcript, re-read in full (the Stop hook can race the
 *      transcript writer, so live numbers can be a turn short)
 *   2. the `kind:'session'` ledger row written at SessionEnd
 *   3. the last `kind:'turn'` row, for sessions that are still open or crashed
 *
 * No price table is maintained here either: dollars come from Claude Code, or
 * from prices the user supplied. Everything tolerates a corrupt ledger line,
 * because a report that crashes on one bad row is a report nobody trusts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readLedger, ledgerFile, listRecentSessions, effectiveCost } from '../io/state.js';
import { loadConfig, effectiveLimits, homeDir } from '../io/config.js';
import { readSessionTotals, cacheReadRatio, estimateCost } from '../io/transcript.js';
import { money, humanTokens, humanBytes, bold, dim, green, yellow, red } from '../core/format.js';
import { decide } from '../core/policy.js';

/** @param {unknown} x */
const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
/** A ledger row is only as trustworthy as the disk it came from. */
/** @param {unknown} cwd */
const repoName = cwd => (typeof cwd === 'string' && cwd ? path.basename(cwd) : 'unknown');

/**
 * @param {import('../types.js').LedgerRow[]} rows
 * @returns {import('../types.js').LedgerRow[]}
 */
function bySession(rows) {
  /** @type {Map<string, import('../types.js').LedgerRow>} */
  const map = new Map();
  for (const r of rows) {
    if (r.kind === 'session') { map.set(r.sessionId, { ...r }); continue; }
    if (!map.has(r.sessionId)) map.set(r.sessionId, { ...r, partial: true });
    else {
      const prev = map.get(r.sessionId);
      if (prev?.partial) map.set(r.sessionId, { ...prev, ...r, partial: true });
    }
  }
  return [...map.values()];
}

/** Re-read transcripts so the report is right even when the live meter was not. */
/**
 * @param {import('../types.js').LedgerRow[]} sessions
 * @param {Record<string, import('../types.js').PriceEntry>} prices
 * @returns {import('../types.js').LedgerRow[]}
 */
function reconcile(sessions, prices) {
  for (const s of sessions) {
    if (!s.transcriptPath) continue;
    let fresh;
    try { fresh = readSessionTotals(s.transcriptPath); } catch { continue; }
    if (!fresh.tokens.messages) continue;
    s.tokens = fresh.tokens;
    s.byModel = fresh.byModel;
    s.reconciled = true;
    const est = estimateCost(fresh.byModel, prices);
    if (est != null) s.estCostUsd = est;
  }
  return sessions;
}

/** @param {import('../types.js').LedgerRow} s */
const costOf = s => effectiveCost({ costUsd: num(s.costUsd), estCostUsd: s.estCostUsd });
/** @param {import('../types.js').LedgerRow} s */
const tokensOf = s => (s.tokens ? num(s.tokens.input) + num(s.tokens.output) + num(s.tokens.cacheRead) + num(s.tokens.cacheCreate) : 0);

/**
 * @param {import('../types.js').LedgerRow[]} rows
 * @param {(r: import('../types.js').LedgerRow) => string|string[]|null|undefined} keyFn
 * @returns {Array<{key: string, costUsd: number, tokens: number, sessions: number}>}
 */
function group(rows, keyFn) {
  /** @type {Map<string, {key: string, costUsd: number, tokens: number, sessions: number}>} */
  const out = new Map();
  for (const r of rows) {
    const raw = keyFn(r) ?? 'unknown';
    for (const key of Array.isArray(raw) ? raw : [raw]) {
      const k = String(key ?? 'unknown');
      const g = out.get(k) ?? { key: k, costUsd: 0, tokens: 0, sessions: 0 };
      g.costUsd += costOf(r);
      g.tokens += tokensOf(r);
      g.sessions += 1;
      out.set(k, g);
    }
  }
  return [...out.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}

/** Per-model, using the real breakdown rather than one representative model. */
/**
 * @param {import('../types.js').LedgerRow[]} sessions
 * @param {Record<string, import('../types.js').PriceEntry>} prices
 * @returns {Array<{key: string, costUsd: number|null, tokens: number, sessions: number}>}
 */
function groupByModel(sessions, prices) {
  /** @type {Map<string, {key: string, costUsd: number|null, tokens: number, sessions: number}>} */
  const out = new Map();
  for (const s of sessions) {
    /** @type {import('../types.js').ByModel} */
    const models = s.byModel && Object.keys(s.byModel).length
      ? s.byModel
      : (s.model && s.tokens ? { [s.model]: s.tokens } : {});
    for (const [model, t] of Object.entries(models)) {
      const g = out.get(model) ?? { key: model, costUsd: /** @type {number|null} */ (null), tokens: 0, sessions: 0 };
      g.tokens += num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheCreate);
      // `?? 0` here used to turn "no prices configured" into "$0.00", so every
      // model showed nothing next to a session total of several dollars.
      // Unknown is reported as unknown.
      const priced = estimateCost(/** @type {import('../types.js').ByModel} */ ({ [model]: t }), prices);
      if (priced != null) g.costUsd = (g.costUsd ?? 0) + priced;
      g.sessions += 1;
      out.set(model, g);
    }
  }
  const rows = [...out.values()];
  const anyCost = rows.some(r => (r.costUsd ?? 0) > 0);
  return rows.sort((a, b) => (anyCost ? (b.costUsd ?? 0) - (a.costUsd ?? 0) : b.tokens - a.tokens));
}

/** @param {number} frac @param {number} [width] */
function bar(frac, width = 18) {
  const n = Math.max(0, Math.min(width, Math.round((Number.isFinite(frac) ? frac : 0) * width)));
  return '█'.repeat(n) + dim('░'.repeat(width - n));
}

/**
 * @param {string} title
 * @param {Array<{key: string, costUsd: number|null, tokens: number, sessions: number}>} groups
 * @param {number} total
 * @param {{ showTokens?: boolean }} [opts]
 */
function table(title, groups, total, { showTokens = false } = {}) {
  if (!groups.length) return '';
  /** @type {string[]} */
  const lines = [bold(title)];
  for (const g of groups.slice(0, 10)) {
    const frac = total > 0 && g.costUsd != null ? g.costUsd / total : 0;
    const amount = g.costUsd == null
      ? `${humanTokens(g.tokens)} tok`
      : (total > 0 || !showTokens) ? money(g.costUsd) : `${humanTokens(g.tokens)} tok`;
    lines.push(`  ${g.key.slice(0, 26).padEnd(26)} ${amount.padStart(9)}  ${bar(frac)} ${dim(`${g.sessions} session${g.sessions === 1 ? '' : 's'}`)}`);
  }
  return lines.join('\n');
}

/**
 * A session's re-sends worked out from its rows, for ledger entries written
 * before `repeatTotals` existed. Capped at the rows the ledger kept, which is the
 * best that can be said about a row that did not record its own total.
 *
 * @param {{tool: string, count: number, bytes: number}[]|undefined} rows
 */
function fromRows(rows) {
  let resent = 0;
  let bytes = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !(r.count > 1)) continue;
    resent += r.count - 1;
    bytes += r.bytes * (r.count - 1) / r.count;
  }
  return { resent, bytes: Math.round(bytes) };
}

/**
 * The part people act on. Thresholds come from config, so the retrospective view
 * and the live warnings can never drift apart.
 *
 * Findings are structured and carry no colour. `report --json` used to put ANSI
 * escapes inside JSON strings, which is meaningless to whatever asked for JSON —
 * and JSON is exactly what a script or a model consumes. Colour is applied by
 * the text renderer, at the edge.
 *
 * @param {import('../types.js').LedgerRow[]} sessions
 * @param {import('../types.js').Limits} limits
 * @returns {import('../types.js').Leak[]}
 */
function leaks(sessions, limits) {
  /** @type {import('../types.js').Leak[]} */
  const out = [];
  const compacted = sessions.filter(s => num(s.compactCount) >= 1);
  if (compacted.length) {
    const cost = compacted.reduce((a, s) => a + costOf(s), 0);
    out.push({
      code: 'compaction', severity: 'warn',
      message: `${compacted.length} session(s) hit compaction, ${money(cost)} total. Compaction re-reads everything; splitting the work into fresh sessions is usually cheaper and sharper.`,
      data: { sessions: compacted.length, costUsd: Number(cost.toFixed(6)) }
    });
  }
  const fanout = sessions.filter(s => num(s.subagentCount) >= limits.warnSubagents);
  if (fanout.length) {
    const cost = fanout.reduce((a, s) => a + costOf(s), 0);
    out.push({
      code: 'fanout', severity: 'notice',
      message: `${fanout.length} session(s) spawned ${limits.warnSubagents}+ subagents, ${money(cost)} total. Fan-out multiplies spend faster than anything else.`,
      data: { sessions: fanout.length, costUsd: Number(cost.toFixed(6)), threshold: limits.warnSubagents }
    });
  }
  const minInput = Number(limits.cacheMinInputTokens ?? 50_000);
  const cacheRows = sessions.filter(s => s.tokens && tokensOf(s) > minInput);
  if (cacheRows.length) {
    const ratios = cacheRows.map(s => cacheReadRatio(s.tokens)).filter(r => r != null);
    if (ratios.length) {
      const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const label = avg >= 0.7 ? 'healthy' : avg >= limits.minCacheReadRatio ? 'mediocre' : 'poor';
      out.push({
        code: 'cache', severity: label === 'healthy' ? 'notice' : 'warn',
        message: `Average prompt-cache read ratio: ${(avg * 100).toFixed(0)}% (${label}). Cache reads cost ~1/10 of fresh input, so this ratio is the single biggest lever on the bill.`,
        data: { ratio: Number(avg.toFixed(4)), label, sessions: cacheRows.length }
      });
    }
  }
  // The one form of waste nothing else can see. The transcript records that a
  // file was read; it never records that the same file was read forty times.
  // Each row is one input to one tool, so `count` is a true identical-call count.
  // Grouping them by tool first — an earlier draft did — turns "Read /a.txt 3x and
  // /b.txt 2x" into "Read, 5 identical calls", which is three separate untruths:
  // the two files are not identical, five calls are not five re-sends, and the
  // first call of each was work rather than waste.
  const rows = sessions.flatMap(s2 => Array.isArray(s2.repeats) ? s2.repeats : []);
  const wasted = rows.filter(r => r && r.count > 1).map(r => ({
    tool: r.tool,
    count: r.count,
    // The first call had to happen. Only the ones after it were re-sent, and the
    // byte total covers every call, so charge the repeats their share of it.
    resent: r.count - 1,
    bytes: Math.round(r.bytes * (r.count - 1) / r.count)
  }));
  if (wasted.length) {
    const ranked = [...wasted].sort((a, b) => b.bytes - a.bytes);
    // Prefer the session's own uncapped totals. The rows are the largest twelve
    // groups, so summing them reports twelve re-sends for a session that made
    // fifteen. Older rows have no totals; fall back to the rows for those.
    // Per session, not per window. Choosing one branch for the whole window meant
    // that a single session carrying totals silenced every other session's
    // re-sends — while they were still counted in the span and still named as the
    // worst, so the sentence contradicted itself: a total of 1 beside "called 20
    // times identically".
    const counted = sessions.reduce((a, s2) => {
      const own = s2.repeatTotals || fromRows(s2.repeats);
      return { resent: a.resent + own.resent, bytes: a.bytes + own.bytes };
    }, { resent: 0, bytes: 0 });
    const span = new Set(sessions.filter(s2 => (s2.repeatTotals?.resent ?? 0) > 0
      || (Array.isArray(s2.repeats) && s2.repeats.some(r => r && r.count > 1))).map(s2 => s2.sessionId)).size;
    const top = ranked[0];
    out.push({
      code: 'repeat-calls', severity: 'warn',
      // "a second time" was wrong for any group called more than twice, and sat
      // in the same sentence as "called 10 times identically". And the figure
      // spans the whole window, so it cannot be attributed to "the session" —
      // every other leak here says "N session(s)".
      message: `${counted.resent} tool call(s) re-sent input that had already been sent, ${humanBytes(counted.bytes)} moved again, across ${span} session(s). Worst single input: ${top.tool}, called ${top.count} times identically. What was in it is deliberately not recorded.`,
      data: { resent: counted.resent, bytes: counted.bytes, sessions: span, worst: ranked.slice(0, 5) }
    });
  }

  const over = sessions.filter(s => num(s.budgetUsd) > 0 && costOf(s) > num(s.budgetUsd));
  if (over.length) out.push({
    code: 'over-budget', severity: 'warn',
    message: `${over.length} session(s) finished over their cap.`,
    data: { sessions: over.length }
  });
  const blind = sessions.filter(s => s.recognized === false);
  if (blind.length) out.push({
    code: 'blind-meter', severity: 'warn',
    message: `${blind.length} session(s) produced a status-line payload this version did not understand — their dollar figures are not trustworthy. Update the tool.`,
    data: { sessions: blind.length }
  });
  return out;
}

/** @param {string[]} [argv] */
export function runReport(argv = []) {
  const i = argv.indexOf('--days');
  const parsed = i >= 0 ? Number(argv[i + 1]) : 30;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  const asJson = argv.includes('--json');

  const config = loadConfig(process.cwd());
  const limits = effectiveLimits(config, config.profile);
  const since = Date.now() - days * 86_400_000;
  const sessions = argv.includes('--no-reconcile')
    ? bySession(readLedger(since))
    : reconcile(bySession(readLedger(since)), config.prices);

  const total = sessions.reduce((a, s) => a + costOf(s), 0);
  const tokenTotal = sessions.reduce((a, s) => a + tokensOf(s), 0);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      days,
      totalUsd: Number(total.toFixed(6)),
      totalTokens: tokenTotal,
      sessions: sessions.length,
      byProfile: group(sessions, r => r.profileLabel || r.profile),
      byRepo: group(sessions, r => repoName(r.cwd)),
      byModel: groupByModel(sessions, config.prices),
      leaks: leaks(sessions, limits)
    }, null, 2) + '\n');
    return;
  }

  if (!sessions.length) {
    process.stdout.write(
      `no data yet (${ledgerFile()})\n` +
      dim('The ledger fills up as sessions end. Check the wiring with: claude-for-poor-folks doctor\n')
    );
    return;
  }

  /** @type {string[]} */
  const out = [`\n${bold(`claude-for-poor-folks · last ${days} days`)}`];
  const head = total > 0 ? bold(money(total)) : bold(`${humanTokens(tokenTotal)} tokens`);
  out.push(`  ${head} across ${sessions.length} session(s)` +
    (total > 0 ? dim(` · ${humanTokens(tokenTotal)} tokens · avg ${money(total / sessions.length)}/session`) : ''));
  if (total === 0 && tokenTotal > 0) {
    out.push(dim('  (no cost data — add "prices" to your config to see dollars for headless sessions)'));
  }
  out.push('');
  out.push(table('by task profile', group(sessions, r => r.profileLabel || r.profile), total, { showTokens: true }));
  out.push('');
  out.push(table('by repo', group(sessions, r => repoName(r.cwd)), total, { showTokens: true }));
  out.push('');
  out.push(table('by model', groupByModel(sessions, config.prices), total, { showTokens: true }));

  const top = [...sessions].sort((a, b) => costOf(b) - costOf(a)).slice(0, 5);
  out.push('\n' + bold('most expensive sessions'));
  for (const s of top) {
    const amount = total > 0 ? money(costOf(s)) : `${humanTokens(tokensOf(s))} tok`;
    out.push(`  ${amount.padStart(9)}  ${dim(String(s.ts || '').slice(0, 16))}  ${String(s.profile || '?').padEnd(9)} ` +
      dim(`${num(s.promptCount)} prompts · ${num(s.toolCount)} tools · ${num(s.subagentCount)} subagents${s.partial ? ' · still open' : ''}`));
  }

  /** @type {Record<string, {calls: number, bytes: number, ms: number}>} */
  const tools = {};
  for (const s2 of sessions) {
    for (const [name, t] of Object.entries(s2.toolStats || {})) {
      const e = tools[name] || (tools[name] = { calls: 0, bytes: 0, ms: 0 });
      e.calls += t.calls; e.bytes += t.bytes; e.ms += t.ms;
    }
  }
  const byBytes = Object.entries(tools).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8);
  if (byBytes.length) {
    out.push('\n' + bold('which tools moved the bytes'));
    out.push(dim('  measured at the hook, not inferred from the transcript'));
    for (const [name, t] of byBytes) {
      out.push(`  ${humanBytes(t.bytes).padStart(9)}  ${String(t.calls).padStart(5)} calls  ${dim((t.ms / 1000).toFixed(1) + 's')}  ${name}`);
    }
  }

  const l = leaks(sessions, limits);
  if (l.length) {
    out.push('\n' + bold('where it leaks'));
    for (const x of l) out.push(`  ${x.severity === 'warn' ? yellow('•') : dim('•')} ${x.message}`);
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

/** @param {string[]} [_argv] */
export function runStatus(_argv = []) {
  const config = loadConfig(process.cwd());
  const limits = effectiveLimits(config, config.profile);
  /** @type {string[]} */
  const out = [`\n${bold('config')}`];
  const sources = config._sources ?? { global: '', repo: null };
  out.push(`  repo   ${sources.repo || dim('(none — using defaults)')}`);
  out.push(`  global ${sources.global && fs.existsSync(sources.global) ? sources.global : dim('(none)')}`);
  out.push(`  profile ${config.profile || 'auto'} · cap ${money(limits.sessionUsd)} · burn ${money(limits.burnUsdPerMin)}/min · on-limit ${config.onLimit}` +
    `${config.unattended ? ' · unattended' : ''}${config.askProfile ? ' · may ask (costs ~60 tokens/session)' : ' · never adds tokens'}`);
  for (const w of config._warnings || []) out.push(`  ${yellow('config')} ${w}`);

  out.push(`\n${bold('live sessions')}`);
  const live = listRecentSessions();
  if (!live.length) out.push(dim('  none in the last 6 hours'));
  for (const s of live) {
    const lim = effectiveLimits(config, s.profile);
    const d = decide(s, { ...lim, sessionUsd: s.budgetUsd ?? lim.sessionUsd });
    out.push(`  ${money(effectiveCost(s)).padStart(8)}/${money(s.budgetUsd ?? lim.sessionUsd)} ${String(s.profile || '?').padEnd(9)} ` +
      dim(`${s.promptCount}p ${s.toolCount}t · ctx ${Number(s.ctxPct || 0).toFixed(0)}% · ${d.levelName} `) + dim(s.cwd || ''));
  }
  out.push(dim(`\nstate: ${homeDir()}\n`));
  process.stdout.write(out.join('\n'));
}
