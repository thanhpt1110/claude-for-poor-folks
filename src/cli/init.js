/**
 * `claude-for-poor-folks init` — the one interactive moment in the whole tool.
 *
 * It runs in a real terminal (unlike hooks), so it can actually ask. It runs
 * ONCE PER REPO, not once per session: a gate that interrogates you every time
 * you start work is a gate you will remove.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveRepoConfig, homeDir, DEFAULTS, CONFIG_FILENAME } from '../io/config.js';
import { resolveProfiles } from '../core/profiles.js';
import { money, bold, dim, green } from '../core/format.js';

/**
 * @param {string[]} argv
 * @returns {{ yes: boolean, global: boolean, profile?: string, budget?: number, onLimit?: string, unattended?: boolean }}
 */
function parseArgs(argv) {
  /** @type {any} */
  const args = { yes: false, global: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--global') args.global = true;
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--budget') args.budget = Number(argv[++i]);
    else if (a === '--on-limit') args.onLimit = argv[++i];
    else if (a === '--unattended') args.unattended = true;
  }
  return args;
}

/** @param {string[]} [argv] */
export async function runInit(argv = []) {
  const args = parseArgs(argv);
  const cwd = process.cwd();
  const existing = loadConfig(cwd);
  const profiles = resolveProfiles(existing.customProfiles);

  /** @type {any} */
  const cfg = {
    version: 1,
    profile: args.profile ?? existing.profile ?? null,
    budget: { ...DEFAULTS.budget, ...existing.budget },
    quota: { ...DEFAULTS.quota, ...existing.quota },
    onLimit: args.onLimit ?? existing.onLimit ?? 'warn',
    unattended: args.unattended ?? existing.unattended ?? false,
    askProfile: existing.askProfile ?? true,
    customProfiles: existing.customProfiles || {}
  };
  if (Number.isFinite(args.budget)) cfg.budget.sessionUsd = args.budget;

  // Piped or scripted stdin used to fall into the interactive branch, answer
  // nothing, write nothing and exit 0 — a first-time user got no config and no
  // error. Silence is the one thing this tool must never do.
  const interactive = Boolean(stdin.isTTY);
  if (!args.yes && !interactive) {
    stdout.write(dim('not a terminal — writing the default config. Pass --yes to silence this,\n'))
    stdout.write(dim('or run `claude-for-poor-folks init` from a terminal to be asked.\n'));
  }

  if (!args.yes && interactive) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    /** @param {string} q @param {unknown} def @returns {Promise<string>} */
    const ask = async (q, def) => {
      const a = (await rl.question(`${q} ${dim(`[${def}]`)} `)).trim();
      return a === '' ? String(def) : a;
    };

    stdout.write(`\n${bold('claude-for-poor-folks')} — budget gate for ${bold(path.basename(cwd))}\n`);
    stdout.write(dim('Asked once per repo. Everything stays local.\n\n'));

    stdout.write('Task profiles available:\n');
    for (const p of Object.values(profiles)) {
      stdout.write(`  ${p.id.padEnd(9)} ${money(p.budgetUsd).padStart(6)}  ${dim(p.label)}\n`);
    }
    stdout.write(dim('\nLeave blank for "auto": the profile is inferred from your first prompt,\nand you are only asked when it is genuinely unclear.\n\n'));

    const prof = await ask('1) Default profile for this repo (or blank = auto):', cfg.profile ?? 'auto');
    cfg.profile = (prof === 'auto' || prof === '') ? null : prof;
    if (cfg.profile && !profiles[cfg.profile]) {
      const label = await ask(`   "${cfg.profile}" is new. Describe it:`, cfg.profile);
      const cap = Number(await ask('   Budget for it (USD):', 1.0));
      cfg.customProfiles[cfg.profile] = {
        id: cfg.profile, label, budgetUsd: cap, burnUsdPerMin: Number((cap / 3).toFixed(2)),
        ctxWarnPct: 80, hint: 'User-defined profile.', keywords: { en: [], vi: [] }
      };
    }

    const b = await ask('2) Session budget in USD (blank = the profile default):', cfg.budget.sessionUsd ?? 'profile');
    cfg.budget.sessionUsd = (b === 'profile' || b === '') ? null : Number(b);

    const ol = await ask('3) When a limit is hit — warn / ask:', cfg.onLimit);
    cfg.onLimit = ol === 'ask' ? 'ask' : 'warn';

    const un = await ask('4) Runs unattended (CI, overnight, tmux)? y/N:', cfg.unattended ? 'y' : 'N');
    cfg.unattended = /^y/i.test(un);

    const q5 = await ask('5) Warn when the 5-hour quota passes (%):', cfg.quota.warnFiveHourPct);
    cfg.quota.warnFiveHourPct = Number(q5);

    const ap = await ask('6) May I ask which task type it is, when unclear? Y/n:', cfg.askProfile ? 'Y' : 'n');
    cfg.askProfile = !/^n/i.test(ap);

    rl.close();
  }

  let target;
  if (args.global) {
    fs.mkdirSync(homeDir(), { recursive: true });
    target = path.join(homeDir(), 'config.json');
    fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n');
  } else {
    target = saveRepoConfig(cwd, cfg);
  }

  stdout.write(`\n${green('saved')} ${target}\n`);
  stdout.write(dim(`Next: claude-for-poor-folks install   (wires the status line + hooks)\n`));
  return cfg;
}
