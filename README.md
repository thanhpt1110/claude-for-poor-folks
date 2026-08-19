<h1 align="center">claude-for-poor-folks</h1>
<p align="center"><b>Know what your agent is spending — while it spends it.</b></p>
<p align="center">
A budget gate for <a href="https://claude.com/claude-code">Claude Code</a>.<br>
Free · zero runtime dependencies · fully local · adds nothing to your token bill
</p>

<p align="center"><img src="docs/demo.svg" alt="the cost meter going green, amber, red as a retry loop burns the budget" width="900"><br><sub><i>illustration of one session</i></sub></p>

---

## The meter

```
🟢 $0.04/$0.50 bugfix · ctx 12% · 5h 23%              under control
🟡 $0.41/$0.50 bugfix · ctx 78% · 5h 23% · $0.31/m    slow down
🔴 $0.68/$0.50 bugfix · ctx 91% · 5h 88% · ↑$0.91/m   something is looping
   │      │      │       │         │        └ spend per minute
   │      │      │       │         └ 5-hour quota used
   │      │      │       └ context window filled
   │      │      └ task type, inferred from your prompt
   │      └ the cap for that task type
   └ spent this session
```

And a message the moment something is wrong — shown to **you**, never to the model:

```
[poor-folks]
!! Burning $0.91/min (limit $0.30/min)
   At this rate the budget is gone in ~0.1 min.
   -> Usually a retry loop. Check the last minute.
```

**Dollars** if you pay per token, **percent of quota** if you're on a subscription — most
people hit a rate limit, not a bill. Both come from Claude Code itself.

---

## Not another usage report

[**ccusage**](https://github.com/ccusage/ccusage) is the tool most people already use, and it
is very good. Run both — they answer different questions.

| | ccusage | this |
|---|---|---|
| Question it answers | *what did I spend?* | *when should I stop?* |
| Cost accuracy | identical — verified token-for-token on the same session | identical |
| Numbers on screen | more: today, billing block, $/hr | fewer, but against a **cap** |
| Agents | 20+ (Codex, Gemini, Copilot…) | Claude Code only |
| A budget | — | per session · per day · **per task type** |
| Warnings | — | 8 signals, each with what to do next |
| Leak detection | — | cache ratio · compaction · subagent fan-out |
| Hooks | status line | 8 lifecycle events |

**Use ccusage to see the bill. Use this to not get one.**

---

## Install

```bash
npm i -g claude-for-poor-folks
cd your-project
claude-for-poor-folks init       # a few questions, once per repo (--yes to skip)
claude-for-poor-folks install    # wires the status line + hooks
```

- Restart Claude Code. That's the whole setup.
- `pclaude` is a shorter alias for the same binary.
- `uninstall` removes every line it added to `settings.json` and leaves a backup.

<details>
<summary>Or install it as a Claude Code plugin, without npm</summary>

```
/plugin marketplace add thanhpt1110/claude-for-poor-folks
/plugin install poor-folks@poor-folks
```

A plugin manifest can declare hooks but **not** a status line. You get the gate, the warnings
and the report; for the always-on traffic light, run `install` as above.
</details>

---

## Commands

| | |
|---|---|
| `init` | set the budget for this repo |
| `install` | wire the status line + hooks |
| `report` | where the money went, and which habit caused it |
| `status` | current config + live sessions |
| `doctor` | check the wiring |
| `uninstall` | undo `install` |

```
$ claude-for-poor-folks report

$4.82 across 11 sessions · 3.1M tokens

refactor   $2.41  ██████████░░░░░░░░  2 sessions
feature    $1.60  ███████░░░░░░░░░░░  4 sessions
bugfix     $0.81  ███░░░░░░░░░░░░░░░  5 sessions

where it leaks
  • 3 sessions hit compaction, $1.90 total — a fresh session is cheaper.
  • Prompt-cache read ratio 41% (poor) — the biggest lever on the bill.
```

---

## What it watches

| signal | catches |
|---|---|
| **budget** | 50% / 80% / over, per session |
| **daily budget** | four tmux panes, each under $1, still spend $4 |
| **burn rate** | $/min over 60s — a runaway loop, minutes before the cap |
| **quota** | 5-hour and weekly windows |
| **context** | compaction approaching — an expensive event, not a free one |
| **cache health** | read ratio; cache reads cost ~1/10 of fresh input |
| **fan-out** | subagents spawned, the fastest way to multiply spend |
| **blind meter** | Claude Code sent a payload this version doesn't understand |

Two things it will never do:

- **Block a tool call.** It warns. Set `onLimit: "ask"` if you want a confirmation instead.
- **Read $0.00 because it broke.** A meter that stops understanding its input says so.

---

## It never asks twice

```
fix the crash in auth.ts when the token expires  →  bugfix,   cap $0.50
refactor the whole src/ tree and migrate to ESM  →  refactor, cap $4.00
just do the thing                                →  unclear: picks a default, says so
```

- Asked **once per repo**, never once per session.
- Whole words only — *"address the issue"* is not a feature request.
- Override anywhere with `#refactor`.
- State a budget inline: `add a login endpoint, budget $2.50`.

<details>
<summary>The 11 profiles, adding your own, and why it isn't the model doing this</summary>

| profile | cap | for |
|---|---|---|
| `discuss` | $0.20 | brainstorming, comparing options |
| `docs` | $0.30 | README, changelog, comments |
| `bugfix` | $0.50 | one defect, known file |
| `review` | $0.80 | reading a diff |
| `data` | $0.80 | SQL, dataframes, analysis |
| `test` | $1.00 | run/fix tests, CI red |
| `research` | $1.00 | reading the codebase to understand it |
| `ops` | $1.00 | deploy, docker, infra |
| `feature` | $1.50 | new behaviour across a few files |
| `refactor` | $4.00 | migrations, wide rewrites |
| `other` | $1.00 | free text — name it, it's remembered |

```jsonc
// .poor-folks.json
{ "customProfiles": {
    "pentest": { "label": "Security testing", "budgetUsd": 3.0, "burnUsdPerMin": 1.0,
                 "keywords": { "en": ["pentest", "exploit", "fuzz"] } } } }
```

`keywords` and `budgetPhrases` are keyed by language tag, and every language present is
searched. English and Vietnamese ship; adding one is a key in a config file.

**Why keywords and not the model?** This runs in a hook — about 40 ms, no network, no model.
Claude Code does not hand hooks an LLM. The alternatives both cost something: call an API
(a key, a bill, a network call this tool refuses to make), or ask the session's own model,
which bills you. So the default is a free offline guess that fails safe.

Prefer the model? Set `"askProfile": true`. It understands every language, asks once through
Claude Code's own prompt, and costs about 60 tokens per session. **Free and approximate, or
exact and billed.**
</details>

---

## Proof

**It adds nothing to your bill.** Warnings go out on the one hook channel the model cannot
read, so they are shown to you and never billed. Asserted across all eight hook events in
`test/integrity.test.js`.

<details>
<summary>How that was established</summary>

A test session injected a distinct marker on each channel, then asked the model to read them
back:

| channel | model could read it | billed |
|---|---|---|
| `additionalContext` | yes | **yes** |
| `systemMessage` | **no** | **no** |

The one feature that used `additionalContext` is off by default.
</details>

**The numbers are right.** A real headless session that also spawned a subagent on a second model:

| | Claude Code | this |
|---|---|---|
| output tokens | 2,675 | 2,675 |
| cache read | 124,270 | 124,270 |
| cache write | 67,347 | 67,347 |
| cost | $0.549989 | **$0.549989** — 0.00% delta |

The undocumented Claude Code behaviours behind that number are in
[CHANGELOG.md](CHANGELOG.md) — worth reading if you're building something similar.

---

## How it works

```
status line ──(cost, context, quota)──> snapshot file ─┐
     └── runs anyway, so metering is free              ├──> decision engine
transcript .jsonl + subagents ──(tokens)──> state file ┘
     └── the fallback meter for headless runs (claude -p, CI)
```

- **No proxy, no daemon, no API key.** It reads what Claude Code already computes.
- **No price table shipped.** Prices go stale; a stale number is worse than an honest token
  count. Add your own under `prices` if you want dollars in headless runs.
- **It never touches your prompt.** Other tools offer to shrink your context to save money —
  that invalidates the prompt cache and usually costs *more*.

<details>
<summary>Why shrinking your context makes it more expensive</summary>

- Prompt caching matches an exact byte prefix.
- Cache reads cost ~0.1× fresh input; cache writes 1.25×.
- Rewriting history invalidates the cache from that point on.
- A 150k prefix over 30 turns: about **$1.35** with cache hits, about **$8.10** without.

Cutting 40% of your input can multiply your bill. This measures the cache instead, and tells
you when it breaks.
</details>

<details>
<summary>Overhead, and types with no build step</summary>

`npm run bench`, ranges over four runs on one shared VM:

| | p50 | p95 |
|---|---|---|
| status line, in-process | 0.2 ms | 0.3 ms |
| status line, cold subprocess | 38–43 ms | 45–49 ms |
| `PreToolUse` hook, cold | 43–46 ms | 47–52 ms |
| `Stop` hook, cold | 283–285 ms | 288–292 ms |

`Stop` waits for the transcript to stop growing, once per turn, against a 5-second timeout.

The source is JavaScript with JSDoc types, checked by `tsc --checkJs --noEmit` under `strict`.
Nothing is emitted, so the file that runs is the file you read. Compiling TypeScript would
mean committing `dist/`, because the plugin marketplace copies the repo rather than the npm
tarball; running `.ts` directly measured 103 ms against 37 ms of cold start and drops Node 20.
</details>

---

## Configuration

<details>
<summary><code>.poor-folks.json</code>, at the root of your repo</summary>

```jsonc
{
  "profile": null,              // null = infer from your prompt
  "budget": {
    "sessionUsd": 1.00,         // null = the profile's default
    "dailyUsd": null,           // across every session today
    "dailyScope": "repo",       // "repo" | "machine"
    "sessionTokens": null,      // works with no prices at all
    "warnAtPct": [50, 80],
    "burnUsdPerMin": null
  },
  "quota":   { "warnFiveHourPct": 80, "warnSevenDayPct": 90 },
  "onLimit": "warn",            // "warn" | "ask" — never denies a tool call
  "unattended": false,          // CI / overnight: never ask anything
  "askProfile": false,          // the only setting that adds tokens (~60/session)
  "quiet": false,
  "prices": {},
  "customProfiles": {}
}
```

- `init --global` writes the same shape to `~/.poor-folks/config.json` as your default.
- A bad value is repaired **and reported** — a typo must never leave the tool silently dead.
</details>

---

## Rules this is held to

<details>
<summary>Eight things it will never do</summary>

| | |
|---|---|
| Never break a session | every hook exits 0, even if a module fails to load |
| Never block a tool call | it warns; it asks only if you opted in |
| Never spend your tokens | the default puts nothing in front of the model |
| Never ask twice | once per repo; never when your prompt already said it |
| Never touch the prompt | measuring is safe; rewriting history costs you the cache |
| Never ship a price table | an honest token count beats a stale dollar figure |
| Never fail towards zero | a blind meter says so instead of reading $0.00 |
| Never phone home | no network calls anywhere — asserted in the tests |
</details>

---

## If something looks wrong

| symptom | do this |
|---|---|
| no status line after install | restart Claude Code, then `doctor` |
| `doctor` says nothing is wired | run `install` from the repo root |
| the meter reads $0.00 | normal in headless runs — no status line to read cost from; add `prices`, or read the token count |
| a warning fires too often | raise the cap, or set `"quiet": true` |
| you want it gone | `uninstall` |

[Open an issue](https://github.com/thanhpt1110/claude-for-poor-folks/issues) and include the
output of `doctor` — it contains no private data.

## Requirements

- Node ≥ 20 · Claude Code ≥ 2.1
- Linux, macOS, Windows — CI runs all nine combinations
- **No runtime dependencies.** Contributors get `typescript` and `@types/node` for the type
  check; nobody who installs the tool downloads them.

## License

MIT · [CONTRIBUTING.md](CONTRIBUTING.md)
