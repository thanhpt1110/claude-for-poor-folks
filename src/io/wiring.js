/**
 * Where this tool is wired into Claude Code, and what is missing.
 *
 * Two install channels exist and neither can do everything on its own: a plugin
 * manifest cannot declare a status line, and an npm install does not carry a
 * skill. Rather than pretend the gap is not there, the tool reports it and hands
 * over the one command that closes it.
 *
 * What it deliberately does NOT do is close the gap itself. Someone who
 * installed a plugin agreed to hooks; silently rewriting their settings.json
 * afterwards is how a tool loses the trust it needs to be left installed.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { homeDir } from './config.js';

export const MARKER = '#poor-folks';
export const SKILL_DIR_NAME = 'poor-folks-review';

/** @param {boolean} isGlobal */
export function settingsPath(isGlobal) {
  return isGlobal
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(process.cwd(), '.claude', 'settings.json');
}

/** @param {string} file @returns {any} */
export function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** @param {unknown} entry */
export function isOurs(entry) {
  try { return JSON.stringify(entry ?? null).includes(MARKER); } catch { return false; }
}

/**
 * What is sitting in the status line slot.
 *
 * 'foreign' matters: `install` refuses to replace someone else's status line, so
 * telling that user to run it would be advice that cannot work. They made a
 * choice; `doctor` reports it, and nothing nags them about it.
 *
 * @param {string} [cwd]
 * @returns {'ours'|'foreign'|'none'}
 */
export function statusLineState(cwd = process.cwd()) {
  const files = [path.join(cwd, '.claude', 'settings.json'), settingsPath(true)];
  const lines = files.map(f => readSettings(f).statusLine).filter(Boolean);
  if (lines.some(isOurs)) return 'ours';
  return lines.length ? 'foreign' : 'none';
}

/** @param {string} [cwd] */
export function statusLineWired(cwd = process.cwd()) {
  return statusLineState(cwd) === 'ours';
}

/** Where a standalone skill lives for a given scope. @param {boolean} isGlobal */
export function skillPath(isGlobal) {
  const root = isGlobal ? path.join(os.homedir(), '.claude') : path.join(process.cwd(), '.claude');
  return path.join(root, 'skills', SKILL_DIR_NAME, 'SKILL.md');
}

/**
 * A nudge is shown at most once per project, not once per machine.
 *
 * Per-machine was wrong: the fix is usually a project-scoped `install`, so the
 * next repository still lacks the meter and would never be told. Per-project
 * means each repository hears it exactly once.
 *
 * @param {string} id
 * @param {string} [scope]  usually the project directory
 * @param {{ peek?: boolean }} [opts]  peek reads without recording
 */
export function noticeAlreadyShown(id, scope = process.cwd(), opts = {}) {
  let h = 5381;
  const key = String(scope);
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  const flag = path.join(homeDir(), 'notices', `${id}-${h.toString(36)}`);
  try {
    if (fs.existsSync(flag)) return true;
    if (opts.peek) return false;
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, new Date().toISOString());
    return false;
  } catch {
    return true;   // if we cannot remember, stay quiet rather than nag forever
  }
}
