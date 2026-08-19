/**
 * Fallback meter for when there is no status line — headless `claude -p`, CI,
 * anything unattended. Verified against Claude Code's own per-model totals.
 *
 * Three things here were each found the hard way, by comparing against a real
 * session instead of trusting the obvious reading of the file:
 *
 *   1. One assistant message is written to the transcript SEVERAL times, and the
 *      copies are not identical: `output_tokens` grows as the message streams
 *      (2 -> 579 -> ...). Summing rows double-counts; keeping the first row
 *      loses almost all output. The correct rule is to track the maximum seen
 *      per message id and accumulate only the increase.
 *
 *   2. Subagents do not appear in the main transcript at all. They write to
 *      <project>/<session-id>/subagents/agent-*.jsonl. Miss those and a
 *      fan-out session under-reports by whatever the subagents cost — measured
 *      at 41% of one real session, on the single most expensive thing an agent
 *      does.
 *
 *   3. The files only grow, so each is read from its own stored byte offset.
 *
 * This file counts tokens. It deliberately does not know prices: a hard-coded
 * price table goes stale, and a wrong number is worse than an honest count.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_TRACKED_MESSAGES = 128;   // streaming updates only ever touch recent ids

/**
 * Never decode more than this in one go.
 *
 * `Buffer.toString('utf8')` throws above Node's ~512 MB string cap, and the
 * throw was being swallowed — so a single very large transcript counted as ZERO
 * tokens with no error. Reading zero because something failed is the exact
 * direction this tool must never fail in, so large files are consumed in
 * chunks instead.
 */
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

/** @returns {import('../types.js').Tokens} */
export function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 };
}

/**
 * @param {import('../types.js').Tokens} a
 * @param {import('../types.js').Tokens} b
 * @returns {import('../types.js').Tokens}
 */
export function addTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    messages: a.messages + b.messages
  };
}

/**
 * Main transcript plus every subagent transcript belonging to it.
 *
 * `known` are paths Claude Code told us about directly (SubagentStop carries
 * `agent_transcript_path`), which is authoritative. The directory scan below is
 * a fallback: the `<session-id>/subagents/` layout is an undocumented internal
 * detail and may move.
 * @param {string|null|undefined} mainPath
 * @param {string[]} [known]
 * @returns {string[]}
 */
export function sessionTranscripts(mainPath, known = []) {
  if (!mainPath) return [...new Set(known)].filter(Boolean);
  const files = [mainPath, ...known.filter(Boolean)];
  const subDir = path.join(path.dirname(mainPath), path.basename(mainPath, '.jsonl'), 'subagents');
  try {
    for (const f of fs.readdirSync(subDir)) {
      if (f.endsWith('.jsonl')) files.push(path.join(subDir, f));
    }
  } catch { /* no subagents: the common case */ }
  return [...new Set(files)];
}

/**
 * @param {Record<string, import('../types.js').UsageSnapshot>} counted
 * @returns {Record<string, import('../types.js').UsageSnapshot>}
 */
function trim(counted) {
  const keys = Object.keys(counted);
  if (keys.length <= MAX_TRACKED_MESSAGES) return counted;
  /** @type {Record<string, import('../types.js').UsageSnapshot>} */
  const out = {};
  for (const k of keys.slice(-MAX_TRACKED_MESSAGES)) {
    const v = counted[k];
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Read one file from `offset` and return only what is genuinely new.
 * `counted` maps message id -> highest usage already accounted for.
 * @param {string} file
 * @param {number} [offset]
 * @param {Record<string, import('../types.js').UsageSnapshot>} [counted]
 * @returns {{ offset: number, tokens: import('../types.js').Tokens, byModel: import('../types.js').ByModel, counted: Record<string, import('../types.js').UsageSnapshot> }}
 */
export function readFileDelta(file, offset = 0, counted = {}) {
  const result = { offset, tokens: emptyTokens(), byModel: /** @type {import('../types.js').ByModel} */ ({}), counted };
  /** @type {import('node:fs').Stats} */
  let stat;
  try { stat = fs.statSync(file); } catch { return result; }
  if (stat.size < offset) result.offset = 0;          // truncated or rotated
  if (stat.size <= result.offset) return result;

  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(stat.size - result.offset, MAX_CHUNK_BYTES);
      const buf = Buffer.allocUnsafe(len);
      // readSync may legally return fewer bytes than asked for, and the buffer
      // is uninitialised, so decoding the whole thing would splice garbage into
      // the text and advance the offset by a wrong amount.
      const read = fs.readSync(fd, buf, 0, len, result.offset);
      text = buf.subarray(0, Math.max(0, read)).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return result; }

  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) {
    // A whole chunk with no newline means one absurdly long line. Skipping it is
    // the only way to make progress; losing one line beats stalling forever.
    if (text.length >= MAX_CHUNK_BYTES) result.offset += Buffer.byteLength(text, 'utf8');
    return result;
  }
  const complete = text.slice(0, lastNl);
  result.offset += Buffer.byteLength(complete, 'utf8') + 1;

  for (const line of complete.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'assistant') continue;
    const msg = row.message || {};
    const u = msg.usage;
    if (!u) continue;
    const id = msg.id || row.requestId;
    if (!id) continue;

    const cur = {
      input: Number(u.input_tokens || 0),
      output: Number(u.output_tokens || 0),
      cacheRead: Number(u.cache_read_input_tokens || 0),
      cacheCreate: Number(u.cache_creation_input_tokens || 0)
    };
    const prev = counted[id];
    const delta = {
      input: Math.max(0, cur.input - (prev?.input || 0)),
      output: Math.max(0, cur.output - (prev?.output || 0)),
      cacheRead: Math.max(0, cur.cacheRead - (prev?.cacheRead || 0)),
      cacheCreate: Math.max(0, cur.cacheCreate - (prev?.cacheCreate || 0)),
      messages: prev ? 0 : 1
    };
    counted[id] = {
      input: Math.max(cur.input, prev?.input || 0),
      output: Math.max(cur.output, prev?.output || 0),
      cacheRead: Math.max(cur.cacheRead, prev?.cacheRead || 0),
      cacheCreate: Math.max(cur.cacheCreate, prev?.cacheCreate || 0)
    };
    if (!delta.messages && !delta.input && !delta.output && !delta.cacheRead && !delta.cacheCreate) continue;

    result.tokens = addTokens(result.tokens, delta);
    const model = msg.model || 'unknown';
    result.byModel[model] = addTokens(result.byModel[model] ?? emptyTokens(), delta);
  }
  result.counted = trim(counted);
  return result;
}

/**
 * Everything new across the main transcript and its subagents.
 * @param {string|null|undefined} mainPath
 * @param {Record<string, number>} [offsets]  file path -> byte offset (mutated copy returned)
 * @param {Record<string, import('../types.js').UsageSnapshot>} [counted]  message id -> highest usage counted
 * @param {string[]} [known]
 * @returns {{ tokens: import('../types.js').Tokens, byModel: import('../types.js').ByModel, offsets: Record<string, number>, counted: Record<string, import('../types.js').UsageSnapshot>, files: number }}
 */
export function readSessionDelta(mainPath, offsets = {}, counted = {}, known = []) {
  const result = {
    tokens: emptyTokens(),
    byModel: /** @type {import('../types.js').ByModel} */ ({}),
    offsets: /** @type {Record<string, number>} */ ({ ...offsets }),
    counted,
    files: 0
  };
  for (const file of sessionTranscripts(mainPath, known)) {
    // Loop because one read is capped at MAX_CHUNK_BYTES; a large transcript
    // needs several passes and must not be left half-counted.
    let guard = 0;
    for (;;) {
      const from = result.offsets[file] ?? 0;
      const d = readFileDelta(file, from, result.counted);
      result.offsets[file] = d.offset;
      result.counted = d.counted;
      result.tokens = addTokens(result.tokens, d.tokens);
      for (const [model, t] of Object.entries(d.byModel)) {
        result.byModel[model] = addTokens(result.byModel[model] ?? emptyTokens(), t);
      }
      if (d.offset <= from || ++guard > 512) break;   // no progress, or absurdly large
    }
    result.files++;
  }
  return result;
}

/** Full recount from scratch. Used by `report`, where accuracy beats speed. */
/**
 * @param {string|null|undefined} mainPath
 * @param {string[]} [known]
 */
export function readSessionTotals(mainPath, known = []) {
  return readSessionDelta(mainPath ?? null, {}, {}, known);
}

/**
 * Fraction of input served from cache. The single biggest lever on the bill.
 * @param {Partial<import('../types.js').Tokens>|null|undefined} tokens
 * @returns {number|null}
 */
export function cacheReadRatio(tokens) {
  if (!tokens) return null;
  const cacheRead = tokens.cacheRead ?? 0;
  const total = cacheRead + (tokens.cacheCreate ?? 0) + (tokens.input ?? 0);
  return total > 0 ? cacheRead / total : null;
}

/**
 * Dollars, but only if the user supplied prices. Shape (USD per million tokens):
 *   "prices": { "claude-opus-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } }
 * Returns null when prices are unknown — an honest gap beats a stale number.
 */
/**
 * @param {import('../types.js').ByModel|null|undefined} byModel
 * @param {Record<string, import('../types.js').PriceEntry>|null|undefined} prices
 * @returns {number|null}
 */
export function estimateCost(byModel, prices) {
  if (!prices || !Object.keys(prices).length) return null;
  let total = 0;
  let priced = false;
  for (const [model, t] of Object.entries(byModel || {})) {
    const p = prices[model] ?? prices[String(model).replace(/\[.*\]$/, '')];
    if (!p) continue;
    priced = true;
    total += (t.input / 1e6) * (p.input ?? 0)
      + (t.output / 1e6) * (p.output ?? 0)
      + (t.cacheRead / 1e6) * (p.cacheRead ?? (p.input ?? 0) * 0.1)
      + (t.cacheCreate / 1e6) * (p.cacheWrite ?? (p.input ?? 0) * 1.25);
  }
  return priced ? total : null;
}

