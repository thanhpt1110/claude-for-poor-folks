/**
 * Read the user's first prompt and decide whether we already know what kind of
 * work this is. The point is to NOT ask when the answer is already on screen —
 * a gate that asks a question the user just answered is friction, and friction
 * is why budget tools get uninstalled.
 *
 * Everything here is a pure function over a string. No I/O.
 */

import { resolveProfiles, DEFAULT_PROFILE_ID } from './profiles.js';

const MIN_SCORE = 2.0;   // below this we genuinely do not know
const MARGIN = 0.8;      // top must beat the runner-up by this much

/**
 * Longer, more specific phrases are worth more than single common words.
 * @param {string} keyword
 */
function weightOf(keyword) {
  return 1 + Math.min(keyword.length / 12, 1.5);
}

/**
 * Lowercase, and turn every run of non-letters/digits into a single space so a
 * keyword can be tested with a space on BOTH sides.
 *
 * Testing only one side matched keywords inside longer words: "address the
 * issue" fired `add` and was classified as a feature, "fixture setup" fired
 * `fix` and became a bug fix. Both produced a confident, wrong budget.
 * \p{L} keeps accented and non-Latin scripts intact, so the same rule works for
 * every language in a profile's keyword map.
 */
/** @param {unknown} text */
function normalize(text) {
  return ` ${String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

/**
 * Explicit override the user can type anywhere in the prompt:
 *   #refactor   [profile:refactor]   profile=refactor
 * Explicit always wins over inference.
 */
/**
 * @param {unknown} prompt
 * @param {import('../types.js').Profiles} profiles
 * @returns {string|null}
 */
export function detectExplicitProfile(prompt, profiles) {
  const text = String(prompt || '');
  const ids = Object.keys(profiles);
  const patterns = [
    /\[profile\s*[:=]\s*([a-z0-9_-]+)\]/i,
    /\bprofile\s*[:=]\s*([a-z0-9_-]+)/i,
    /(?:^|\s)#([a-z0-9_-]+)/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const found = m?.[1]?.toLowerCase();
    if (found && ids.includes(found)) return found;
  }
  return null;
}

/**
 * Words that introduce an amount, keyed by language tag — the same open shape a
 * profile's `keywords` uses.
 *
 * This was a hardcoded English-and-Vietnamese regex while profile detection had
 * already become language-agnostic, so a user adding a German profile got their
 * task recognised but not "budget 3 euro". Data, not code.
 * @type {Record<string, string[]>}
 */
export const BUDGET_PHRASES = {
  en: ['budget', 'max', 'cap', 'limit', 'at most', 'no more than'],
  vi: ['ngân sách', 'ngan sach', 'giới hạn', 'gioi han', 'tối đa', 'toi da']
};

/** @param {string} text */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds a budget stated in the prompt itself: "budget $2", "max $0.50",
 * "limit 3". Extra languages come from `budgetPhrases` in the config.
 * @param {unknown} prompt
 * @param {Record<string, string[]>} [extraPhrases]  merged over the built-ins
 * @returns {number|null}
 */
export function detectBudget(prompt, extraPhrases) {
  const text = String(prompt || '').toLowerCase();
  const phrases = Object.values({ ...BUDGET_PHRASES, ...(extraPhrases || {}) })
    .flat()
    .filter(Boolean)
    .map(escapeRe)
    .sort((a, b) => b.length - a.length);      // longest first, so "at most" beats "max"
  if (!phrases.length) return null;

  const lead = phrases.join('|');
  const amount = '(\\d+(?:[.,]\\d+)?)';
  const patterns = [
    new RegExp(`(?:${lead})\\D{0,12}\\$?\\s*${amount}`),
    new RegExp(`\\$\\s*${amount}\\s*(?:${lead})`)
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const n = Number(String(m[1]).replace(',', '.'));
      if (Number.isFinite(n) && n > 0 && n < 10000) return n;
    }
  }
  return null;
}

/**
 * @param {unknown} prompt
 * @param {Record<string, Partial<import('../types.js').Profile>>} [customProfiles]
 * @param {Record<string, string[]>} [budgetPhrases]  extra languages for "budget N"
 * @returns {import('../types.js').Detection}
 */
export function detectProfile(prompt, customProfiles = {}, budgetPhrases) {
  const profiles = resolveProfiles(customProfiles);
  const budgetUsd = detectBudget(prompt, budgetPhrases);

  const explicit = detectExplicitProfile(prompt, profiles);
  if (explicit) {
    return { profileId: explicit, confidence: 'certain', score: Infinity, runnerUp: null, matched: [`#${explicit}`], budgetUsd };
  }

  const text = normalize(prompt);
  if (text.trim().length < 3) {
    return { profileId: DEFAULT_PROFILE_ID, confidence: 'low', score: 0, runnerUp: null, matched: [], budgetUsd };
  }

  /** @type {Array<{id: string, score: number, matched: string[]}>} */
  const scores = [];
  for (const p of Object.values(profiles)) {
    let score = 0;
    /** @type {string[]} */
    const matched = [];
    // Every language in the map is searched, whatever its tag. Nothing here
    // knows which languages exist, so adding one needs no code change.
    const keywords = p.keywords ?? {};
    for (const phrases of Object.values(keywords)) {
      for (const kw of phrases ?? []) {
        if (!kw) continue;
        if (text.includes(normalize(kw))) {
          score += weightOf(kw);
          matched.push(kw);
        }
      }
    }
    if (score > 0) scores.push({ id: p.id, score, matched });
  }

  if (scores.length === 0) {
    return { profileId: DEFAULT_PROFILE_ID, confidence: 'low', score: 0, runnerUp: null, matched: [], budgetUsd };
  }

  scores.sort((a, b) => b.score - a.score);
  const top = /** @type {{id: string, score: number, matched: string[]}} */ (scores[0]);
  const second = scores[1] ?? { id: null, score: 0 };
  const confident = top.score >= MIN_SCORE && (top.score - second.score) >= MARGIN;

  return {
    profileId: top.id,
    confidence: confident ? 'high' : 'low',
    score: Number(top.score.toFixed(2)),
    runnerUp: second.id,
    matched: [...new Set(top.matched)],
    budgetUsd
  };
}

/**
 * Should the gate bother the user at all?
 * @param {import('../types.js').Detection} detection
 * @param {Partial<import('../types.js').Config>|null|undefined} config
 */
export function shouldAsk(detection, config) {
  if (config?.askProfile === false) return false;
  if (config?.unattended) return false;              // nobody is there to answer
  return detection.confidence === 'low';
}
