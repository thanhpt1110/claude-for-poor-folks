/**
 * Wire (and un-wire) the tool into Claude Code's settings.json.
 *
 * Two rules:
 *   1. Never clobber a status line the user already has.
 *   2. Uninstall must leave settings.json byte-identical to before install,
 *      apart from what we added. Every entry we write is identifiable by its
 *      command string, so removal is exact.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bold, dim, green, yellow, red } from '../core/format.js';
import { homeDir } from '../io/config.js';

// Appended to every command we write, as a shell comment. The command itself is
// an absolute path that differs between a global npm install and a git checkout,
// so the path cannot be the marker; this can be found and removed exactly.
const MARKER = '#poor-folks';

/** Trailing shell comment: harmless if run through a shell, ignored as argv if not. */
/** @param {string} command */
function withMarker(command) { return `${command} ${MARKER}`; }

const HOOK_EVENTS = [
  { event: 'SessionStart', matcher: null, timeout: 5 },
  { event: 'UserPromptSubmit', matcher: null, timeout: 5 },
  { event: 'PreToolUse', matcher: '*', timeout: 3 },
  { event: 'SubagentStart', matcher: null, timeout: 3 },
  { event: 'SubagentStop', matcher: null, timeout: 5 },
  { event: 'PreCompact', matcher: null, timeout: 3 },
  { event: 'Stop', matcher: null, timeout: 5 },
  { event: 'SessionEnd', matcher: null, timeout: 5 }
];

function cliInvocation() {
  const entry = path.resolve(fileURLToPath(import.meta.url), '..', 'index.js');
  const viaNpxCache = /[\\/]_npx[\\/]/.test(entry);
  if (viaNpxCache) {
    return {
      cmd: 'claude-for-poor-folks',
      warn: 'Running from the npx cache, and that path disappears. Install globally first: npm i -g claude-for-poor-folks'
    };
  }
  return { cmd: `node ${JSON.stringify(entry)}`, warn: null };
}

/** @param {boolean} isGlobal */
function settingsPath(isGlobal) {
  return isGlobal
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(process.cwd(), '.claude', 'settings.json');
}

/** @param {string} file @returns {any} */
function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** @param {string} file @returns {string|null} */
function backup(file) {
  if (!fs.existsSync(file)) return null;
  // slice(0, 15) used to cut mid-way through the milliseconds and leave a
  // trailing dot: settings.json.bak-poorclaude-20260819182744.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = `${file}.bak-poor-folks-${stamp}`;
  fs.copyFileSync(file, bak);
  return bak;
}

/** @param {unknown} entry */
function isOurs(entry) {
  try { return JSON.stringify(entry ?? null).includes(MARKER); } catch { return false; }
}

/** settings.json is hand-edited, so any shape can turn up. Never assume. */
/** @param {unknown} value @returns {any[]} */
function asList(value) { return Array.isArray(value) ? value : []; }

/** @param {string} file @param {any} settings */
function writeSettings(file, settings) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);          // atomic: Claude Code may be reading this
}

/** @param {string[]} [argv] */
export function runInstall(argv = []) {
  const isGlobal = argv.includes('--global');
  const force = argv.includes('--force');
  const file = settingsPath(isGlobal);
  const { cmd, warn } = cliInvocation();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = readSettings(file);
  const bak = backup(file);

  // --- status line ---
  const wanted = { type: 'command', command: withMarker(`${cmd} statusline`), padding: 0 };
  let statusNote;
  if (settings.statusLine && !isOurs(settings.statusLine) && !force) {
    statusNote = yellow('kept your existing statusLine') +
      dim(`\n   To combine, call \`${cmd} statusline\` from your own script (it reads stdin and prints one line).` +
          `\n   Or re-run with --force to replace it.`);
  } else {
    settings.statusLine = wanted;
    statusNote = green('statusLine wired');
  }

  // --- hooks ---
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  /** @type {string[]} */
  const notes = [];
  let added = 0;
  for (const { event, matcher, timeout } of HOOK_EVENTS) {
    const existing = asList(settings.hooks[event]);
    if (!Array.isArray(settings.hooks[event]) && settings.hooks[event] != null) {
      notes.push(yellow(`hooks.${event} was not a list — left untouched`));
      continue;
    }
    const list = (settings.hooks[event] = existing);
    if (list.some(isOurs)) continue;
    /** @type {{ hooks: Array<{type: string, command: string, timeout: number}>, matcher?: string }} */
    const entry = { hooks: [{ type: 'command', command: withMarker(`${cmd} hook ${event}`), timeout }] };
    if (matcher) entry.matcher = matcher;
    list.push(entry);
    added++;
  }

  writeSettings(file, settings);

  process.stdout.write(`\n${bold('claude-for-poor-folks install')}\n`);
  process.stdout.write(`  file    ${file}\n`);
  if (bak) process.stdout.write(`  backup  ${dim(bak)}\n`);
  process.stdout.write(`  ${statusNote}\n`);
  process.stdout.write(`  ${green(`${added} hook(s) added`)} ${dim(`(${HOOK_EVENTS.length - added} already present)`)}\n`);
  for (const n of notes) process.stdout.write(`  ${n}\n`);
  if (warn) process.stdout.write(`  ${yellow(warn)}\n`);
  process.stdout.write(dim(`\n  Restart Claude Code (or /hooks) to pick it up.\n`));
  return { file, added };
}

/** @param {string[]} [argv] */
export function runUninstall(argv = []) {
  const isGlobal = argv.includes('--global');
  const file = settingsPath(isGlobal);
  if (!fs.existsSync(file)) {
    process.stdout.write(`nothing to remove: ${file} does not exist\n`);
    return;
  }
  const settings = readSettings(file);
  const bak = backup(file);
  let removed = 0;

  if (settings.statusLine && isOurs(settings.statusLine)) { delete settings.statusLine; removed++; }
  const hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) ? settings.hooks : {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;          // not ours, not our business
    const before = hooks[event].length;
    hooks[event] = hooks[event].filter(e => !isOurs(e));
    removed += before - hooks[event].length;
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(file, settings);
  process.stdout.write(`removed ${removed} entr${removed === 1 ? 'y' : 'ies'} from ${file}\n`);
  if (bak) process.stdout.write(dim(`backup: ${bak}\n`));
  process.stdout.write(dim(`Left alone: ${homeDir()} (session history) and .poor-folks.json (your budget).\n`));
  process.stdout.write(dim(`Delete those by hand if you want nothing left.\n`));
}

/** @param {string[]} [_argv] */
export async function runDoctor(_argv = []) {
  /** @type {string[]} */
  const lines = [];
  /** @param {string} s */ const ok = s => `${green('ok')}    ${s}`;
  /** @param {string} s */ const bad = s => `${red('fail')}  ${s}`;
  /** @param {string} s */ const note = s => `${yellow('note')}  ${s}`;

  // A fresh, correct install has nothing in the global settings. Reporting that
  // in amber made a working setup look broken, so only the scope that is
  // actually wired is called out, and the other is stated as a plain fact.
  let wiredSomewhere = false;
  for (const isGlobal of [false, true]) {
    const file = settingsPath(isGlobal);
    const scope = isGlobal ? 'global' : 'project';
    if (!fs.existsSync(file)) { lines.push(dim(`      ${scope} settings: none (${file})`)); continue; }
    const s = readSettings(file);
    if (isOurs(s.statusLine)) { lines.push(ok(`${scope} statusLine wired`)); wiredSomewhere = true; }
    else lines.push(dim(`      ${scope} statusLine: someone else's (left alone)`));
    const hooks = (s.hooks && typeof s.hooks === 'object' && !Array.isArray(s.hooks)) ? s.hooks : {};
    const events = Object.entries(hooks)
      .filter(([, v]) => Array.isArray(v) && v.some(isOurs))
      .map(([k]) => k);
    const odd = Object.entries(hooks).filter(([, v]) => !Array.isArray(v)).map(([k]) => k);
    if (odd.length) lines.push(note(`${scope} hooks.${odd.join(', ')} is not a list — hand-edited? left alone`));
    if (events.length) { lines.push(ok(`${scope} hooks: ${events.join(', ')}`)); wiredSomewhere = true; }
    else lines.push(dim(`      ${scope} hooks: none`));
  }

  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.writeFileSync(path.join(homeDir(), '.probe'), 'x');
    fs.unlinkSync(path.join(homeDir(), '.probe'));
    lines.push(ok(`state dir writable (${homeDir()})`));
  } catch (e) {
    lines.push(bad(`state dir not writable (${homeDir()}): ${e instanceof Error ? e.message : String(e)}`));
  }

  const { runStatusline } = await import('./statusline.js');
  const sample = JSON.stringify({
    session_id: 'doctor', workspace: { current_dir: process.cwd() },
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    cost: { total_cost_usd: 0.42 },
    context_window: { used_percentage: 33, current_usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 90000, cache_creation_input_tokens: 5000 } },
    rate_limits: { five_hour: { used_percentage: 21 }, seven_day: { used_percentage: 40 } }
  });
  const t0 = process.hrtime.bigint();
  const line = await runStatusline(sample);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // The figures below are invented input for the self-test. Saying so matters:
  // an unlabelled "$0.42" in a diagnostic reads as money you have spent.
  lines.push(ok(`statusline renders in ${ms.toFixed(1)} ms`));
  lines.push(dim(`      sample output (made-up numbers, not your spend): ${line}`));

  if (!wiredSomewhere) {
    lines.push(note('nothing is wired yet — run: claude-for-poor-folks install'));
  }

  process.stdout.write(lines.join('\n') + '\n');
}
