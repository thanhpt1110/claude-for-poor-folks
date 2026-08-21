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
import { homeDir, loadConfig } from '../io/config.js';
import { skillPath, SKILL_DIR_NAME, MARKER, settingsPath, readSettings, isOurs, statusLineState } from '../io/wiring.js';


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


/** settings.json is hand-edited, so any shape can turn up. Never assume. */
/** @param {unknown} value @returns {any[]} */
function asList(value) { return Array.isArray(value) ? value : []; }

/** @param {string} file @param {any} settings */
function writeSettings(file, settings) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);          // atomic: Claude Code may be reading this
}

/**
 * Copy the review skill next to the settings we just wired.
 *
 * An npm install has no plugin manifest, so it would otherwise miss the one
 * skill the plugin channel ships. This closes that half of the gap. An existing
 * file that is not ours is left alone.
 * @param {boolean} isGlobal
 * @returns {'installed'|'present'|'foreign'|'missing-source'|'failed'|'skipped'}
 */
function installSkill(isGlobal) {
  const target = skillPath(isGlobal);
  const source = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'skills', 'review', 'SKILL.md');
  if (!fs.existsSync(source)) return 'missing-source';
  try {
    if (fs.existsSync(target)) {
      return fs.readFileSync(target, 'utf8').includes('poor-folks') ? 'present' : 'foreign';
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return 'installed';
  } catch {
    // Reported, never thrown: the hooks and status line are already written and
    // announced by this point, so an unwritable skills directory must not turn a
    // successful install into a stack trace.
    return 'failed';
  }
}

/** @param {string[]} [argv] */
export function runInstall(argv = []) {
  const isGlobal = argv.includes('--global');
  const force = argv.includes('--force');
  // A plugin already supplies the eight hooks, and its copies live in the plugin
  // manifest rather than settings.json, so nothing here can see them to dedupe.
  // Telling a plugin user to run a full `install` therefore wires every hook a
  // second time: doubled banners, doubled latency, and a daily-spend figure
  // inflated by two Stop hooks appending the same delta. This flag exists so the
  // one thing a plugin cannot do — the status line — can be added on its own.
  const statusLineOnly = argv.includes('--status-line-only');
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
  for (const { event, matcher, timeout } of (statusLineOnly ? [] : HOOK_EVENTS)) {
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

  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(file, settings);

  process.stdout.write(`\n${bold('claude-for-poor-folks install')}\n`);
  process.stdout.write(`  file    ${file}\n`);
  if (bak) process.stdout.write(`  backup  ${dim(bak)}\n`);
  process.stdout.write(`  ${statusNote}\n`);
  if (statusLineOnly) {
    process.stdout.write(`  ${dim('hooks left alone (--status-line-only)')}\n`);
    // Without hooks from somewhere, the status line renders defaults forever.
    const anyHooks = Object.values(settings.hooks || {}).some(v => Array.isArray(v) && v.some(isOurs));
    if (!anyHooks) {
      process.stdout.write(`  ${yellow('no hooks found in settings.json')} ${dim('— fine if the plugin supplies them; otherwise run a full `install` or the meter will never update')}\n`);
    }
  } else {
    process.stdout.write(`  ${green(`${added} hook(s) added`)} ${dim(`(${HOOK_EVENTS.length - added} already present)`)}\n`);
  }
  const skill = statusLineOnly ? 'skipped' : installSkill(isGlobal);
  if (skill === 'installed') process.stdout.write(`  ${green('skill added')} ${dim(`/${SKILL_DIR_NAME} — reads the report and names the habits to change (~500-900 tokens, only when you type it)`)}\n`);
  else if (skill === 'present') process.stdout.write(`  ${dim(`skill /${SKILL_DIR_NAME} already present`)}\n`);
  else if (skill === 'foreign') process.stdout.write(`  ${yellow(`a different skill already occupies /${SKILL_DIR_NAME} — left alone`)}\n`);
  else if (skill === 'failed') process.stdout.write(`  ${yellow(`could not write the skill to ${skillPath(isGlobal)} — everything else is wired`)}\n`);

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

  // The skill was copied here by `install`; take it back out. Anything that does
  // not look like ours stays, because it is not ours to delete.
  const skill = skillPath(isGlobal);
  try {
    if (fs.existsSync(skill) && fs.readFileSync(skill, 'utf8').includes('poor-folks')) {
      // Remove the file we wrote, then the directory only if nothing else is in
      // it. Anything a user dropped alongside it is theirs.
      fs.unlinkSync(skill);
      const dir = path.dirname(skill);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      removed++;
    }
  } catch { /* leave anything we are unsure about */ }

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

  // `status` has printed these since the first release, but `doctor` is where
  // people look when something seems wrong, and it answered `ok`. Half of
  // someone's budget file being ignored is the failure this tool exists to
  // prevent, so it is reported here at the same severity `status` uses.
  const cfg = loadConfig(process.cwd());
  for (const w of cfg._warnings || []) lines.push(note(w));
  if ((cfg._warnings || []).length && cfg._sources) {
    if (cfg._sources.repo) lines.push(dim(`      repo config:   ${cfg._sources.repo}`));
    lines.push(dim(`      global config: ${cfg._sources.global}`));
  }

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
    else if (s.statusLine) lines.push(dim(`      ${scope} statusLine: someone else's (left alone)`));
    else lines.push(dim(`      ${scope} statusLine: empty`));
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

  // What to advise depends on something this command cannot see. A plugin's
  // hooks come from its manifest, not from settings.json, so an empty
  // settings.json means either "plugin installed, status line missing" or
  // "nothing installed at all" — and telling a plugin user to run a full
  // install would wire all eight hooks a second time. So say both, and say why
  // it cannot tell.
  const slot = statusLineState();
  const hooksInSettings = [false, true].some(g => {
    const h = readSettings(settingsPath(g)).hooks;
    return h && typeof h === 'object' && Object.values(h).some(v => Array.isArray(v) && v.some(isOurs));
  });

  if (slot !== 'ours' && hooksInSettings) {
    lines.push(note(`hooks are wired but the status line is not — run: claude-for-poor-folks install${slot === 'foreign' ? ' --force' : ' --status-line-only'}`));
  } else if (!wiredSomewhere) {
    lines.push(note('nothing is wired in settings.json.'));
    lines.push(dim('      If you installed the plugin, its hooks come from the plugin manifest and are'));
    lines.push(dim('      invisible here; you only need the status line:'));
    lines.push(dim('        claude-for-poor-folks install --status-line-only'));
    lines.push(dim('      Otherwise you need everything:'));
    lines.push(dim('        claude-for-poor-folks install'));
  }

  process.stdout.write(lines.join('\n') + '\n');
}
