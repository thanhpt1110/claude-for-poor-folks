import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Assert a value is actually there, and narrow it for the type checker.
 *
 * Type-checking the tests turned a pile of "possibly undefined" complaints into
 * this: the fix is not a cast that silences the checker, it is an assertion the
 * test was already relying on but never stated.
 * @template T
 * @param {T|null|undefined} value
 * @param {string} [message]
 * @returns {T}
 */
export function present(value, message = 'expected a value to be present') {
  assert.ok(value !== null && value !== undefined, message);
  return value;
}

export function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-test-'));
  process.env.POOR_FOLKS_HOME = dir;
  return dir;
}

/** Restores cwd and env even when the assertion in between fails. */
/** @template T @param {() => T} fn @returns {T} */
export function withSandbox(fn) {
  const cwd = process.cwd();
  const home = process.env.POOR_FOLKS_HOME;
  try { return fn(); } finally {
    try { process.chdir(cwd); } catch { /* cwd was deleted */ }
    if (home === undefined) delete process.env.POOR_FOLKS_HOME;
    else process.env.POOR_FOLKS_HOME = home;
  }
}

/** @template T @param {() => T} fn @returns {T} */
export const quiet = fn => {
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = w; }
};

/** A status-line payload with the exact shape Claude Code documents. */
export const STATUSLINE_PAYLOAD = {
  session_id: 'test-session-1',
  transcript_path: '/tmp/transcript.jsonl',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  workspace: { current_dir: '/tmp', project_dir: '/tmp' },
  version: '2.1.235',
  cost: { total_cost_usd: 0.1234, total_duration_ms: 45000 },
  context_window: {
    total_input_tokens: 155000, total_output_tokens: 1200,
    context_window_size: 200000, used_percentage: 33, remaining_percentage: 67,
    current_usage: { input_tokens: 800, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 148000 }
  },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 }
  }
};
