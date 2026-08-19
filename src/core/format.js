/** Rendering helpers. Kept free of I/O so they can be tested directly. */

const useColor = () => !process.env.NO_COLOR && process.env.TERM !== 'dumb';
/** @param {string} code @param {unknown} s */
const c = (code, s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));

/** @param {unknown} s */ export const dim = s => c('2', s);
/** @param {unknown} s */ export const bold = s => c('1', s);
/** @param {unknown} s */ export const green = s => c('32', s);
/** @param {unknown} s */ export const yellow = s => c('33', s);
/** @param {unknown} s */ export const red = s => c('31', s);
/** @param {unknown} s */ export const redBold = s => c('1;31', s);

/**
 * @param {import('../types.js').SignalLevel} levelName
 * @param {number} pct
 * @returns {{ icon: string, paint: (s: unknown) => string }}
 */
export function light(levelName, pct) {
  if (levelName === 'critical' || pct >= 100) return { icon: '🔴', paint: redBold };
  if (levelName === 'warn' || pct >= 80) return { icon: '🟡', paint: yellow };
  return { icon: '🟢', paint: green };
}

/** Compact token counts. Lives here, not in io, so core stays dependency-free. */
/** @param {unknown} n */
export function humanTokens(n) {
  const v = Number(n || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(v);
}

/** @param {unknown} n */
export function money(n) {
  const v = Number(n || 0);
  return v >= 10 ? `$${v.toFixed(1)}` : `$${v.toFixed(2)}`;
}

/**
 * One compact line for the Claude Code status bar.
 * @param {Partial<import('../types.js').Session>} state
 * @param {import('../types.js').Decision} decision
 * @param {import('../types.js').Limits} limits
 */
export function statusLine(state, decision, limits) {
  const { icon, paint } = light(decision.levelName, decision.pct);
  /** @type {string[]} */
  const parts = [];

  parts.push(icon);
  if (decision.cost > 0) {
    parts.push(paint(decision.cap > 0 ? `${money(decision.cost)}/${money(decision.cap)}` : money(decision.cost)));
  } else if (state.tokens && state.tokens.messages > 0) {
    // No cost available (headless, or no prices configured): tokens are honest.
    const t = state.tokens;
    parts.push(paint(`${humanTokens(t.input + t.output + t.cacheRead + t.cacheCreate)} tok`));
  } else {
    parts.push(paint(decision.cap > 0 ? `${money(0)}/${money(decision.cap)}` : money(0)));
  }

  const profileName = state.profileLabel || limits.profile?.id || '?';
  parts.push(dim(profileName));

  if (state.ctxPct != null) {
    const ctx = Number(state.ctxPct);
    parts.push(dim('·') + ' ' + (ctx >= (limits.ctxWarnPct ?? 80) ? yellow(`ctx ${ctx.toFixed(0)}%`) : dim(`ctx ${ctx.toFixed(0)}%`)));
  }
  if (state.fiveHourPct != null) {
    const q = Number(state.fiveHourPct);
    parts.push(dim('·') + ' ' + (q >= (limits.fiveHourPct ?? 80) ? yellow(`5h ${q.toFixed(0)}%`) : dim(`5h ${q.toFixed(0)}%`)));
  }
  if (decision.burn != null && decision.burn > 0.01) {
    const b = `${money(decision.burn)}/m`;
    parts.push(dim('·') + ' ' + (decision.burn > (limits.burnUsdPerMin ?? Infinity) ? red(`↑${b}`) : dim(b)));
  }

  const top = decision.signals.find(s => s.level === 'critical') || decision.signals.find(s => s.level === 'warn');
  if (top && !top.code.startsWith('budget') && !top.code.startsWith('burn') && !top.code.startsWith('quota')) {
    parts.push(dim('·') + ' ' + yellow(`⚠ ${top.code.split('.')[0]}`));
  }

  return parts.join(' ');
}

/**
 * Multi-line block for the human. Plain text, never sent to the model.
 * @param {import('../types.js').Signal[]} signals
 * @param {{ prefix?: string }} [opts]
 */
export function signalBlock(signals, { prefix = 'claude-for-poor-folks' } = {}) {
  if (!signals.length) return '';
  const lines = signals.map(s => {
    const mark = s.level === 'critical' ? '!!' : s.level === 'warn' ? '!' : '-';
    return `${mark} ${s.title}\n  ${s.detail}\n  -> ${s.action}`;
  });
  return `[${prefix}]\n${lines.join('\n')}`;
}
