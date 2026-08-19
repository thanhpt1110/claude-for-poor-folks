/**
 * On-disk session state.
 *
 * The important design decision here is that TWO different processes observe a
 * session and they are given SEPARATE files:
 *
 *   <id>.snapshot.json  written only by the status line (cost, context, quota)
 *   <id>.state.json     written only by the hooks (counters, offsets, profile)
 *
 * They used to share one file, and that was wrong. Atomic tmp+rename prevents a
 * torn read; it does nothing about a lost update. The status line re-renders
 * several times a second, so it would routinely read a snapshot taken before a
 * hook incremented `subagentCount`, then write the whole object back and erase
 * the increment. Token totals survived that (they are re-derivable from the
 * transcript) but the counters did not — and those counters feed the fan-out
 * and compaction signals this tool exists to raise.
 *
 * Splitting by writer removes the shared mutable object entirely, so no lock is
 * needed. `readSession()` merges the two for the decision engine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './config.js';

export const STATE_VERSION = 1;

const MAX_SAMPLES = 60;
const SAMPLE_WINDOW_MS = 60_000;
const LEDGER_MAX_BYTES = 4 * 1024 * 1024;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export function sessionsDir() { return path.join(homeDir(), 'sessions'); }
export function ledgerFile() { return path.join(homeDir(), 'ledger.jsonl'); }
export function ledgerArchive() { return path.join(homeDir(), 'ledger.1.jsonl'); }

/**
 * Session ids come from Claude Code and are normally uuids, but the file name
 * must stay safe on every platform. A plain character substitution would map two
 * different ids onto the same file, so anything unusual keeps a short digest of
 * the original to preserve uniqueness.
 */
/**
 * @param {unknown} sessionId
 * @returns {string}
 */
export function safeId(sessionId) {
  const raw = String(sessionId ?? 'unknown');
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (cleaned === raw && cleaned.length <= 96) return cleaned;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return `${cleaned.slice(0, 60)}-${h.toString(36)}`;
}

/** @param {unknown} sessionId */
export function snapshotFile(sessionId) { return path.join(sessionsDir(), `${safeId(sessionId)}.snapshot.json`); }
/** @param {unknown} sessionId */
export function stateFile(sessionId) { return path.join(sessionsDir(), `${safeId(sessionId)}.state.json`); }

/**
 * @param {string} [sessionId]
 * @returns {import('../types.js').Snapshot}
 */
export function emptySnapshot(sessionId) {
  return {
    v: STATE_VERSION,
    sessionId: sessionId || 'unknown',
    updatedAt: 0,
    recognized: null,      // did the status-line payload contain fields we know?
    costUsd: 0,
    ctxPct: 0,
    ctxSize: null,
    model: null,
    modelName: null,
    durationMs: null,
    lastUsage: null,
    fiveHourPct: null,
    fiveHourResetsAt: null,
    sevenDayPct: null,
    sevenDayResetsAt: null,
    samples: []            // [[epochMs, costUsd], ...]
  };
}

/**
 * @param {string} [sessionId]
 * @returns {import('../types.js').SessionState}
 */
export function emptyState(sessionId) {
  return {
    v: STATE_VERSION,
    sessionId: sessionId || 'unknown',
    startedAt: Date.now(),
    updatedAt: 0,
    cwd: null,
    profile: null,
    profileLabel: null,
    profileSource: null,        // 'config' | 'explicit' | 'detected' | 'asked' | 'fallback'
    budgetUsd: null,
    budgetSource: null,
    promptCount: 0,
    toolCount: 0,
    subagentCount: 0,
    compactCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 },
    byModel: {},
    estCostUsd: null,
    transcriptPath: null,
    transcriptOffsets: {},
    counted: {},
    firedWarnings: [],
    lastLedgerCostUsd: 0,
    samples: []                 // used only when there is no status line to sample cost
  };
}

/**
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

const ensured = new Set();
/** @param {string} dir */
function ensureDir(dir) {
  if (ensured.has(dir)) return true;
  try { fs.mkdirSync(dir, { recursive: true }); ensured.add(dir); return true; } catch { return false; }
}

/** @param {string} target @param {string} data */
function writeAtomic(target, data) {
  try {
    if (!ensureDir(path.dirname(target))) return false;
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;   // bookkeeping must never break the user's session
  }
}

/** @param {string} sessionId @returns {import('../types.js').Snapshot} */
export function readSnapshot(sessionId) { return readJson(snapshotFile(sessionId), emptySnapshot(sessionId)); }
/** @param {string} sessionId @returns {import('../types.js').SessionState} */
export function readSessionState(sessionId) { return readJson(stateFile(sessionId), emptyState(sessionId)); }

/** @param {import('../types.js').Snapshot} snap */
export function writeSnapshot(snap) {
  snap.v = STATE_VERSION;
  snap.updatedAt = Date.now();
  return writeAtomic(snapshotFile(snap.sessionId), JSON.stringify(snap));
}

/** @type {Array<'promptCount'|'toolCount'|'subagentCount'|'compactCount'>} */
const MONOTONIC = ['promptCount', 'toolCount', 'subagentCount', 'compactCount'];

/**
 * These five fields are ONE value in five parts. `transcriptOffsets` says how
 * much of the transcript has been read, `counted` says what was taken from it,
 * and `tokens`/`byModel`/`estCostUsd` are the result. Merging them field by
 * field is worse than not merging at all: an advanced offset paired with stale
 * tokens means the difference is never read again, so a lost update becomes
 * permanent instead of self-healing. Reproduced, then fixed by moving them as
 * a group — tokens only grow within a session, so the larger total is the
 * newer, complete picture.
 */
/** @type {Array<keyof import('../types.js').SessionState>} */
const METERING = ['tokens', 'byModel', 'transcriptOffsets', 'counted', 'estCostUsd'];

/** @param {{ tokens?: Partial<import('../types.js').Tokens> }|null|undefined} x */
function tokenTotal(x) {
  const t = x?.tokens;
  return t ? (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreate || 0) : 0;
}

/**
 * Splitting snapshot from state removed the status-line race, but two HOOK
 * processes can still overlap on the state file — a Stop can sit in its settle
 * wait while the next event fires. Rather than take a lock, re-read at write
 * time and keep the larger value for anything that only ever counts upwards,
 * and the union for anything that only ever accumulates. A counter can then be
 * late, but it can never go backwards.
 *
 * Pass `{ merge: false }` when the write is deliberately a reset.
 */
/**
 * @param {import('../types.js').SessionState} st
 * @param {{ merge?: boolean }} [opts]
 */
export function writeSessionState(st, { merge = true } = {}) {
  st.v = STATE_VERSION;
  st.updatedAt = Date.now();

  if (merge) {
    const disk = readSessionState(st.sessionId);
    if (disk.updatedAt) {
      for (const k of MONOTONIC) st[k] = Math.max(Number(st[k] ?? 0), Number(disk[k] ?? 0));
      st.firedWarnings = [...new Set([...(st.firedWarnings || []), ...(disk.firedWarnings || [])])];
      st.subagentTranscripts = [...new Set([...(st.subagentTranscripts || []), ...(disk.subagentTranscripts || [])])];
      st.lastLedgerCostUsd = Math.max(Number(st.lastLedgerCostUsd || 0), Number(disk.lastLedgerCostUsd || 0));
      if (tokenTotal(disk) > tokenTotal(st)) {
        for (const k of METERING) /** @type {any} */ (st)[k] = /** @type {any} */ (disk)[k];
      }
    }
  }
  // Keys starting with an underscore are process-local scratch, never persisted.
  return writeAtomic(stateFile(st.sessionId), JSON.stringify(st, (k, v) => (k.startsWith('_') ? undefined : v)));
}

/**
 * The merged view the decision engine sees. Snapshot fields win where both
 * exist, because Claude Code's own numbers beat anything we derived ourselves.
 */
/**
 * @param {string} sessionId
 * @returns {import('../types.js').Session}
 */
export function readSession(sessionId) {
  const st = readSessionState(sessionId);
  const snap = readSnapshot(sessionId);
  const merged = { ...st, ...snap };
  merged.sessionId = sessionId;
  merged.startedAt = st.startedAt;
  merged.updatedAt = Math.max(st.updatedAt || 0, snap.updatedAt || 0);
  merged.cwd = st.cwd;
  // Live cost comes from the status line; without one, from priced transcript tokens.
  merged.costUsd = Number(snap.costUsd || 0) || 0;
  merged.estCostUsd = st.estCostUsd ?? null;
  merged.samples = (snap.samples && snap.samples.length) ? snap.samples : (st.samples || []);
  merged.tokens = st.tokens;
  merged.byModel = st.byModel;
  return merged;
}

/** Effective cost for a session, in one place so every call site agrees. */
/**
 * @param {{ costUsd?: number|null, estCostUsd?: number|null }|null|undefined} session
 * @returns {number}
 */
export function effectiveCost(session) {
  return Number(session?.costUsd || 0) || Number(session?.estCostUsd || 0) || 0;
}

/** Keep the sliding window small and bounded. */
/**
 * @template {{ samples?: Array<[number, number]> }} T
 * @param {T} container
 * @param {number} costUsd
 * @param {number} [now]
 * @returns {T}
 */
export function pushSample(container, costUsd, now = Date.now()) {
  const samples = Array.isArray(container.samples) ? container.samples : [];
  const last = samples[samples.length - 1];
  if (!last || now - last[0] > 1000 || costUsd !== last[1]) samples.push([now, costUsd]);
  const cutoff = now - SAMPLE_WINDOW_MS * 2;
  container.samples = samples.filter(s => Array.isArray(s) && s[0] >= cutoff).slice(-MAX_SAMPLES);
  return container;
}

/** USD per minute over the last minute. null when there is not enough data. */
/**
 * @param {{ samples?: unknown }|null|undefined} container
 * @param {number} [now]
 * @returns {number|null}
 */
export function burnRate(container, now = Date.now()) {
  const all = Array.isArray(container?.samples) ? container.samples : [];
  const samples = all.filter(s => Array.isArray(s) && Number.isFinite(s[0]) && s[0] >= now - SAMPLE_WINDOW_MS);
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dtMin = (last[0] - first[0]) / 60_000;
  if (dtMin < 0.15) return null;                 // window too short to trust
  const dUsd = last[1] - first[1];
  if (dUsd < 0) return null;                     // cost reset or clock went backwards
  return dUsd / dtMin;
}

// ---------------------------------------------------------------- ledger ----

function rotateLedgerIfBig() {
  try {
    const f = ledgerFile();
    if (fs.statSync(f).size < LEDGER_MAX_BYTES) return;
    fs.renameSync(f, ledgerArchive());          // keep exactly one generation
  } catch { /* nothing to rotate */ }
}

/** @param {Partial<import('../types.js').LedgerRow>} entry */
export function appendLedger(entry) {
  try {
    if (!ensureDir(homeDir())) return false;
    rotateLedgerIfBig();
    fs.appendFileSync(ledgerFile(), JSON.stringify({ v: STATE_VERSION, ...entry }) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} x */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

/**
 * @param {number} [sinceMs]
 * @returns {import('../types.js').LedgerRow[]}
 */
export function readLedger(sinceMs = 0) {
  /** @type {import('../types.js').LedgerRow[]} */
  const rows = [];
  for (const file of [ledgerArchive(), ledgerFile()]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      const ts = Date.parse(r.ts);
      if (!Number.isFinite(ts)) continue;
      if (sinceMs && ts < sinceMs) continue;
      r._ts = ts;
      r.costUsd = num(r.costUsd);
      r.deltaUsd = num(r.deltaUsd);
      r.estCostUsd = r.estCostUsd == null ? null : num(r.estCostUsd);
      rows.push(r);
    }
  }
  return rows;
}

/**
 * What has been spent TODAY.
 *
 * This must be summed from per-turn deltas, not from session totals: `costUsd`
 * is a session's lifetime cost, so a session opened yesterday and touched today
 * would drag all of yesterday's spend into today's budget and raise a false
 * alarm. A false alarm costs trust exactly like a wrong block does.
 */
/**
 * @param {string|null} [cwd]
 * @param {number} [now]
 * @returns {{ usd: number, sessions: number }}
 */
export function todaySpend(cwd = null, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const rows = readLedger(start.getTime()).filter(r => r.kind === 'turn');
  let usd = 0;
  const sessions = new Set();
  for (const r of rows) {
    if (cwd && r.cwd !== cwd) continue;
    usd += r.deltaUsd;
    sessions.add(r.sessionId);
  }
  return { usd, sessions: sessions.size };
}

/** @param {number} [now] */
export function pruneOldSessions(now = Date.now()) {
  try {
    const dir = sessionsDir();
    const cutoff = now - SESSION_TTL_MS;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        // Leftover .tmp files come from a process that died mid-write.
        if (f.endsWith('.tmp') ? st.mtimeMs < now - 3600_000 : st.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* raced with another prune */ }
    }
  } catch { /* nothing to prune */ }
}

/**
 * @param {number} [maxAgeMs]
 * @param {number} [now]
 * @returns {import('../types.js').Session[]}
 */
export function listRecentSessions(maxAgeMs = 6 * 3600_000, now = Date.now()) {
  /** @type {import('../types.js').Session[]} */
  const out = [];
  try {
    for (const f of fs.readdirSync(sessionsDir())) {
      if (!f.endsWith('.state.json')) continue;
      const id = f.slice(0, -'.state.json'.length);
      const s = readSession(id);
      if (now - (s.updatedAt || 0) > maxAgeMs) continue;
      out.push(s);
    }
  } catch { /* none yet */ }
  return out;
}
