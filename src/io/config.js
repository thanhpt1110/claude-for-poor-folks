/**
 * Config resolution: repo file -> global file -> built-in defaults.
 * Everything is optional; a missing config must still produce a working tool.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveProfiles, getProfile, DEFAULT_PROFILE_ID } from '../core/profiles.js';

export const CONFIG_FILENAME = '.poor-folks.json';

/**
 * Where session state lives.
 *
 * The guard below is not paranoia. On Linux, fs.mkdirSync(..., {recursive:true})
 * under a pseudo-filesystem such as /proc does not fail — it HANGS. A hung
 * status line freezes part of the editor, which is exactly the kind of harm this
 * tool exists to avoid, so a suspicious POOR_FOLKS_HOME is refused rather than trusted.
 */
// /dev/shm is a normal writable tmpfs people deliberately use; only the
// genuinely virtual filesystems are refused.
const PSEUDO_FS = ['/proc/', '/sys/'];
const PSEUDO_EXACT_PREFIX = '/dev/';
const PSEUDO_ALLOW = ['/dev/shm/'];

export function homeDir() {
  const custom = process.env.POOR_FOLKS_HOME;
  if (custom) {
    const resolved = path.resolve(custom);
    const probe = resolved + '/';
    const virtual = PSEUDO_FS.some(p => probe.startsWith(p))
      || (probe.startsWith(PSEUDO_EXACT_PREFIX) && !PSEUDO_ALLOW.some(p => probe.startsWith(p)));
    const safe = path.isAbsolute(resolved) && !virtual;
    if (safe) return resolved;
    return path.join(os.tmpdir(), 'claude-for-poor-folks');
  }
  return path.join(os.homedir(), '.poor-folks');
}

/** @type {Readonly<import('../types.js').Config>} */
export const DEFAULTS = Object.freeze(/** @type {import('../types.js').Config} */ ({
  version: 1,
  profile: null,               // null = infer from the prompt
  profileLabel: null,          // free text when profile === 'other'
  budget: {
    sessionUsd: null,          // null = take the profile's budget
    sessionTokens: null,       // optional, and the only unit that works with no price list
    dailyUsd: null,            // across every session running today, not just this one
    dailyScope: 'repo',        // 'repo' | 'machine'
    warnAtPct: [50, 80],
    burnUsdPerMin: null        // null = take the profile's burn rate
  },
  // USD per million tokens, keyed by model id. Ships EMPTY on purpose: a
  // hard-coded price table goes stale, and a wrong number is worse than none.
  // Only needed for headless runs, where there is no status line to read cost from.
  prices: {},
  // Extra languages for "budget $2" phrases, merged over the built-in en/vi.
  budgetPhrases: {},
  quota: { warnFiveHourPct: 80, warnSevenDayPct: 90 },
  context: { warnPct: null },  // null = take the profile's ctxWarnPct
  cache: { minReadRatio: 0.5, minInputTokens: 150000 },
  fanout: { warnSubagents: 8, warnCompacts: 2 },
  // Per-tool attribution. On by default because "you spent $5" is not actionable
  // and "40 Read calls on one file" is — but it is one more hook process per tool
  // call (measured: ~43ms, of which 29ms is node starting up), so it is a real
  // cost and there is a switch for anyone who would rather not pay it.
  measureTools: true,
  onLimit: 'warn',             // 'warn' | 'ask'   (v1 never denies)
  unattended: false,
  // Off by default on purpose: this is the ONLY setting that puts text in front
  // of the model, and therefore the only one that costs the user tokens.
  askProfile: false,
  quiet: false,
  customProfiles: {}
}));

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObj(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }

/**
 * @template T
 * @param {T} base
 * @param {unknown} patch
 * @returns {T}
 */
export function deepMerge(base, patch) {
  if (!isObj(patch)) return base;
  /** @type {any} */
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** @param {string} file @returns {any} */
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Walk up from `startDir` looking for the repo config.
 * @param {string} [startDir]
 * @returns {string|null}
 */
export function findRepoConfig(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 40; i++) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function globalConfigPath() {
  return path.join(homeDir(), 'config.json');
}

/**
 * Settings whose keys are fixed. Everything else at the top level (`prices`,
 * `budgetPhrases`, `customProfiles`) is an open map keyed by model id, language
 * tag, or profile id, so its contents must never be flagged.
 */
export const CLOSED_SECTIONS = ['budget', 'quota', 'context', 'cache', 'fanout'];

/**
 * Object-valued settings whose keys are supplied by the user: model ids,
 * language tags, profile ids. Their contents are never checked. Listed
 * explicitly so that a new section added to DEFAULTS has to be classified as one
 * or the other — a test fails otherwise, rather than the section silently losing
 * its typo checking.
 */
export const OPEN_MAPS = ['prices', 'budgetPhrases', 'customProfiles'];

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let corner = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(prev[j] + 1, prev[j - 1] + 1, corner + (a[i - 1] === b[j - 1] ? 0 : 1));
      corner = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

/**
 * The nearest real setting to something the user typed, or null when nothing is
 * close enough that guessing would help more than it misleads.
 * @param {string} typed
 * @param {string[]} known
 * @returns {string|null}
 */
function nearest(typed, known) {
  let best = null;
  let score = Infinity;
  const lower = typed.toLowerCase();
  // `budgetUsd` is the mistake this function exists for: it is not close enough
  // to any real key by edit distance, but it plainly means the budget section.
  const section = CLOSED_SECTIONS.find(sec => lower.startsWith(sec));
  if (section) {
    const inSection = known.filter(k => k.startsWith(`${section}.`));
    if (inSection.length) {
      // `Budget` on its own used to fall through to edit distance and land on
      // `quiet` — the one setting that silences these warnings, which is the
      // worst possible advice for someone who just mistyped a section name.
      const tail = lower.slice(section.length);
      const hit = tail && inSection.find(k => (k.split('.').pop() || '').toLowerCase().includes(tail));
      return hit || inSection[0];
    }
  }
  for (const k of known) {
    const d = distance(lower, k.toLowerCase().split('.').pop() || k);
    const full = distance(lower, k.toLowerCase());
    const hit = Math.min(d, full);
    if (hit < score) { score = hit; best = k; }
  }
  return score <= Math.max(3, Math.ceil(typed.length / 2)) ? best : null;
}

/**
 * Report settings that do not exist.
 *
 * A wrong VALUE is repaired below and reported. A wrong KEY used to be silently
 * dropped, which is worse: `{"budgetUsd": 0.5}` looks exactly like a budget, so
 * the user believes they are capped at $0.50 while the profile default is what
 * actually runs. Nothing anywhere said otherwise.
 *
 * @param {unknown} raw
 * @param {string[]} warnings
 */
function reportUnknownKeys(raw, warnings) {
  if (!isObj(raw)) return;
  const knownPaths = [
    ...Object.keys(DEFAULTS).filter(k => !CLOSED_SECTIONS.includes(k)),
    ...CLOSED_SECTIONS.flatMap(sec => Object.keys(/** @type {any} */ (DEFAULTS)[sec]).map(k => `${sec}.${k}`))
  ];
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    if (!(key in DEFAULTS)) {
      const guess = nearest(key, knownPaths);
      warnings.push(`${key}: not a setting. ${guess ? `Did you mean "${guess}"? ` : ''}It is being ignored.`);
      continue;
    }
    if (CLOSED_SECTIONS.includes(key) && isObj(value)) {
      const inner = Object.keys(/** @type {any} */ (DEFAULTS)[key]);
      for (const sub of Object.keys(value)) {
        if (inner.includes(sub)) continue;
        const guess = nearest(sub, inner.map(k => `${key}.${k}`));
        warnings.push(`${key}.${sub}: not a setting. ${guess ? `Did you mean "${guess}"? ` : ''}It is being ignored.`);
      }
    }
  }
}

/**
 * Coerce a config into something the engine can actually use.
 *
 * This exists because of a real failure: writing `"warnAtPct": 80` instead of
 * `[80]` — the obvious typo — made `decide()` throw on a spread of a number.
 * Every caller swallows exceptions, so the status line rendered blank, no signal
 * ever fired again, and `doctor` still said everything was fine. A budget tool
 * that dies silently is worse than one that was never installed, so bad values
 * are repaired here and reported rather than trusted.
 *
 * @param {unknown} raw
 * @returns {{config: import('../types.js').Config, warnings: string[]}}
 */
export function validateConfig(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {any} */
  const cfg = deepMerge(DEFAULTS, raw || {});

  reportUnknownKeys(raw, warnings);

  /** @param {unknown} value @param {string} label @param {number|null} fallback */
  const positive = (value, label, fallback) => {
    if (value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      warnings.push(`${label}: expected a positive number, got ${JSON.stringify(value)} — using ${fallback === null ? 'the profile default' : fallback}`);
      return fallback;
    }
    return n;
  };

  cfg.budget = { ...DEFAULTS.budget, ...(cfg.budget || {}) };
  cfg.budget.sessionUsd = positive(cfg.budget.sessionUsd, 'budget.sessionUsd', null);
  cfg.budget.dailyUsd = positive(cfg.budget.dailyUsd, 'budget.dailyUsd', null);
  cfg.budget.sessionTokens = positive(cfg.budget.sessionTokens, 'budget.sessionTokens', null);
  cfg.budget.burnUsdPerMin = positive(cfg.budget.burnUsdPerMin, 'budget.burnUsdPerMin', null);

  const pct = Array.isArray(cfg.budget.warnAtPct) ? cfg.budget.warnAtPct : [cfg.budget.warnAtPct];
  const cleanPct = pct.map(Number).filter((/** @type {number} */ n) => Number.isFinite(n) && n > 0 && n < 100);
  if (Array.isArray(cfg.budget.warnAtPct) && cfg.budget.warnAtPct.length === 0) {
    warnings.push('budget.warnAtPct: an empty list does not silence the warnings — the defaults are used. Set "quiet": true instead.');
  } else if (cleanPct.length !== pct.length) {
    warnings.push(`budget.warnAtPct: expected an array of percentages, got ${JSON.stringify(cfg.budget.warnAtPct)} — using ${JSON.stringify(cleanPct.length ? cleanPct : DEFAULTS.budget.warnAtPct)}`);
  }
  cfg.budget.warnAtPct = cleanPct.length ? cleanPct : [...DEFAULTS.budget.warnAtPct];

  if (cfg.budget.dailyScope !== 'machine') cfg.budget.dailyScope = 'repo';

  cfg.quota = { ...DEFAULTS.quota, ...(cfg.quota || {}) };
  for (const k of /** @type {const} */ (['warnFiveHourPct', 'warnSevenDayPct'])) {
    const n = Number(cfg.quota[k]);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      warnings.push(`quota.${k}: expected 1-100, got ${JSON.stringify(cfg.quota[k])} — using ${DEFAULTS.quota[k]}`);
      cfg.quota[k] = DEFAULTS.quota[k];
    } else cfg.quota[k] = n;
  }

  // The same class of typo that used to kill the tool silently can also kill a
  // single signal silently. Every numeric knob gets checked, not just budgets.
  /** @param {any} obj @param {string} key @param {number} lo @param {number} hi @param {string} label */
  const ranged = (obj, key, lo, hi, label) => {
    if (obj[key] == null) return;
    const n = Number(obj[key]);
    if (!Number.isFinite(n) || n < lo || n > hi) {
      warnings.push(`${label}: expected ${lo}-${hi}, got ${JSON.stringify(obj[key])} — ignoring it`);
      obj[key] = null;
    } else obj[key] = n;
  };
  cfg.cache = { ...DEFAULTS.cache, ...(cfg.cache || {}) };
  ranged(cfg.cache, 'minReadRatio', 0, 1, 'cache.minReadRatio');
  ranged(cfg.cache, 'minInputTokens', 0, 1e12, 'cache.minInputTokens');
  if (cfg.cache.minReadRatio == null) cfg.cache.minReadRatio = DEFAULTS.cache.minReadRatio;
  if (cfg.cache.minInputTokens == null) cfg.cache.minInputTokens = DEFAULTS.cache.minInputTokens;

  cfg.context = { ...DEFAULTS.context, ...(cfg.context || {}) };
  ranged(cfg.context, 'warnPct', 1, 100, 'context.warnPct');

  cfg.fanout = { ...DEFAULTS.fanout, ...(cfg.fanout || {}) };
  ranged(cfg.fanout, 'warnSubagents', 1, 1e6, 'fanout.warnSubagents');
  ranged(cfg.fanout, 'warnCompacts', 1, 1e6, 'fanout.warnCompacts');
  if (cfg.fanout.warnSubagents == null) cfg.fanout.warnSubagents = DEFAULTS.fanout.warnSubagents;
  if (cfg.fanout.warnCompacts == null) cfg.fanout.warnCompacts = DEFAULTS.fanout.warnCompacts;

  if (cfg.onLimit !== 'ask') cfg.onLimit = 'warn';
  cfg.measureTools = cfg.measureTools !== false;
  cfg.unattended = Boolean(cfg.unattended);
  cfg.askProfile = Boolean(cfg.askProfile);
  cfg.quiet = Boolean(cfg.quiet);
  if (typeof cfg.profile !== 'string' || !cfg.profile) cfg.profile = null;
  if (!cfg.prices || typeof cfg.prices !== 'object' || Array.isArray(cfg.prices)) cfg.prices = {};
  if (!cfg.customProfiles || typeof cfg.customProfiles !== 'object' || Array.isArray(cfg.customProfiles)) cfg.customProfiles = {};
  if (!cfg.budgetPhrases || typeof cfg.budgetPhrases !== 'object' || Array.isArray(cfg.budgetPhrases)) cfg.budgetPhrases = {};

  return { config: cfg, warnings };
}

/**
 * @param {string} [cwd]
 * @returns {import('../types.js').Config}
 */
export function loadConfig(cwd) {
  const globalCfg = readJsonSafe(globalConfigPath()) || {};
  const repoPath = findRepoConfig(cwd);
  const repoCfg = repoPath ? (readJsonSafe(repoPath) || {}) : {};
  const { config, warnings } = validateConfig(deepMerge(globalCfg, repoCfg));
  config._sources = { global: globalConfigPath(), repo: repoPath };
  config._warnings = warnings;
  return config;
}

/**
 * Collapse config + chosen profile into the concrete numbers the policy uses.
 * Config values always win over profile defaults.
 */
/**
 * @param {import('../types.js').Config} config
 * @param {string|null} [profileId]
 * @returns {import('../types.js').Limits}
 */
export function effectiveLimits(config, profileId) {
  const profiles = resolveProfiles(config.customProfiles);
  const profile = getProfile(profiles, profileId || config.profile || DEFAULT_PROFILE_ID);
  return {
    profile,
    sessionUsd: config.budget?.sessionUsd ?? profile.budgetUsd,
    sessionTokens: config.budget?.sessionTokens ?? null,
    dailyUsd: config.budget?.dailyUsd ?? null,
    dailyScope: config.budget?.dailyScope ?? 'repo',
    warnAtPct: config.budget?.warnAtPct ?? DEFAULTS.budget.warnAtPct,
    burnUsdPerMin: config.budget?.burnUsdPerMin ?? profile.burnUsdPerMin,
    ctxWarnPct: config.context?.warnPct ?? profile.ctxWarnPct,
    fiveHourPct: config.quota?.warnFiveHourPct ?? DEFAULTS.quota.warnFiveHourPct,
    sevenDayPct: config.quota?.warnSevenDayPct ?? DEFAULTS.quota.warnSevenDayPct,
    minCacheReadRatio: config.cache?.minReadRatio ?? DEFAULTS.cache.minReadRatio,
    cacheMinInputTokens: config.cache?.minInputTokens ?? DEFAULTS.cache.minInputTokens,
    warnSubagents: config.fanout?.warnSubagents ?? DEFAULTS.fanout.warnSubagents,
    warnCompacts: config.fanout?.warnCompacts ?? DEFAULTS.fanout.warnCompacts
  };
}

/**
 * @param {string} dir
 * @param {import('../types.js').Config} config
 */
export function saveRepoConfig(dir, config) {
  const file = path.join(dir, CONFIG_FILENAME);
  const { _sources, ...clean } = config;
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
  return file;
}
