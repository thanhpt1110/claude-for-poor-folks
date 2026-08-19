/**
 * The status line runs on every render and PreToolUse runs on every tool call.
 * If either is slow the tool is a tax, not a saving.
 *
 * Cold subprocess timings are what a user actually experiences: Claude Code
 * spawns a fresh node process every time. The in-process figure is only useful
 * for spotting algorithmic regressions.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATUSLINE_PAYLOAD } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli', 'index.js');
process.env.POOR_FOLKS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'poorfolks-bench-'));

const WARMUP = 5;
const COLD_RUNS = 40;

/** @param {number[]} samples */
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  /** @param {number} p */
  const at = p => /** @type {number} */ (s[Math.min(s.length - 1, Math.floor(s.length * p))]);
  return { n: s.length, min: /** @type {number} */ (s[0]), p50: at(0.5), p95: at(0.95), max: /** @type {number} */ (s[s.length - 1]) };
}
/** @param {ReturnType<typeof stats>} o */
const fmt = o => `n=${String(o.n).padStart(3)}  min ${o.min.toFixed(1)}  p50 ${o.p50.toFixed(1)}  p95 ${o.p95.toFixed(1)}  max ${o.max.toFixed(1)} ms`;

/** @param {string[]} args @param {string} input @param {number} [runs] */
function timeCold(args, input, runs = COLD_RUNS) {
  for (let i = 0; i < WARMUP; i++) execFileSync(process.execPath, [CLI, ...args], { input, env: process.env });
  const out = [];
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    execFileSync(process.execPath, [CLI, ...args], { input, env: process.env });
    out.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return stats(out);
}

const { runStatusline } = await import('../src/cli/statusline.js');
const payload = JSON.stringify(STATUSLINE_PAYLOAD);

for (let i = 0; i < 50; i++) await runStatusline(payload);          // warm up the JIT
const inProc = [];
for (let i = 0; i < 300; i++) {
  const t = process.hrtime.bigint();
  await runStatusline(payload);
  inProc.push(Number(process.hrtime.bigint() - t) / 1e6);
}
console.log(`statusline, in-process      : ${fmt(stats(inProc))}`);
console.log(`statusline, cold subprocess : ${fmt(timeCold(['statusline'], payload))}`);

const hookPayload = JSON.stringify({ session_id: 'bench', cwd: process.cwd(), tool_name: 'Bash' });
console.log(`PreToolUse hook, cold       : ${fmt(timeCold(['hook', 'PreToolUse'], hookPayload))}`);
console.log(`UserPromptSubmit hook, cold : ${fmt(timeCold(['hook', 'UserPromptSubmit'], JSON.stringify({ session_id: 'bench2', cwd: process.cwd(), user_prompt: 'fix the bug in auth.ts' })))}`);
// Stop deliberately waits for the transcript to stop growing; it runs once per turn.
console.log(`Stop hook, cold             : ${fmt(timeCold(['hook', 'Stop'], hookPayload, 12))}`);

console.log(`\nnode ${process.version} · ${os.cpus()[0].model.trim()} · ${os.cpus().length} cores`);
