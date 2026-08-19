<h1 align="center">claude-for-poor-folks</h1>
<p align="center"><b>Know what your agent is spending — while it spends it.</b></p>
<p align="center">
Budget gate · live cost &amp; quota meter · leak detector for <a href="https://claude.com/claude-code">Claude Code</a><br>
Free and open source · zero runtime dependencies · fully local<br>
<b>Warnings go to you, not to the model — so running it adds nothing to your token bill</b>
</p>

<p align="center"><img src="docs/demo.svg" alt="the cost meter going green, amber, red as a retry loop burns the budget" width="900"><br><sub><i>illustration of the meter across one session</i></sub></p>

---

## What you get, immediately

A line in your status bar:

```
🟢 $0.04/$0.50 bugfix · ctx 12% · 5h 23%              under control
🟡 $0.41/$0.50 bugfix · ctx 78% · 5h 23% · $0.31/m    slow down
🔴 $0.68/$0.50 bugfix · ctx 91% · 5h 88% · ↑$0.91/m   something is looping
   │      │      │       │         │        └ spend per minute
   │      │      │       │         └ 5-hour quota used — the limit most people actually hit
   │      │      │       └ context window filled
   │      │      └ the kind of task, inferred from your prompt
   │      └ the cap for that kind of task
   └ spent so far this session
```

And a message the moment something is wrong — shown to **you**, never to the model:

```
[poor-folks]
!! Burning $0.91/min (limit $0.30/min)
   At this rate the budget is gone in ~0.1 min.
   -> Usually a retry loop. Check the last minute.
```

Dollars if you pay per token. **Percent of your 5-hour and weekly quota if you're on a
subscription** — most Claude Code users never see a bill, they hit a rate limit. Both
numbers come from Claude Code itself, which hands them to the status line on every render.

---

## What it watches

| signal | catches |
|---|---|
| **budget** | 50% / 80% / over, per session |
| **daily budget** | every session today — four tmux panes each under $1 still spend $4 |
| **burn rate** | $/min over 60s — catches a runaway loop *minutes* before the cap does |
| **quota** | 5-hour and weekly windows, for subscription users |
| **context** | compaction approaching, which is an expensive event, not a free one |
| **cache health** | prompt-cache read ratio — the biggest single lever on your bill |
| **fan-out** | subagents spawned, the fastest way to multiply spend |
| **blind meter** | Claude Code sent a payload this version doesn't understand |

That last one matters: a money meter must **never fail silently towards $0.00**, because
that looks exactly like a session that spent nothing.

**It warns. It does not block.** By default no tool call is ever denied — set
`onLimit: "ask"` if you want a confirmation prompt at the cap.

---

## It never asks twice

Asked once per repo, not once per session. And when your prompt already says what you're
doing, it doesn't ask at all:

```
fix the crash in auth.ts when the token expires  →  bugfix,   cap $0.50
refactor the whole src/ tree and migrate to ESM  →  refactor, cap $4.00
just do the thing                                →  unclear: picks a default, says so
```

Whole-word matching only, so *"address the issue"* is not a feature request and *"fixture
setup"* is not a bug fix. Override anywhere with `#refactor`, or state a budget inline:
`add a login endpoint, budget $2.50`.

**Why keywords and not the model?** This runs inside a hook — a plain process with about
40 ms, no network and no model. Claude Code does not hand hooks an LLM, so the only ways to
involve one are to call an API yourself (a key, a bill, and a network call this tool refuses
to make) or to ask the session's own model, which puts text in front of it and charges you
for it. So the default is a free offline guess that fails safe: unsure means the default
profile and a message, never a wrong block.

If you would rather have the model decide — it understands every language, no keyword list
required — set `"askProfile": true`. It asks you once per session through Claude Code's own
question prompt and costs about 60 tokens. That is the whole trade: **free and approximate,
or exact and billed.**

<details>
<summary>The 11 built-in profiles, and adding your own</summary>

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
// .poor-folks.json — your own profiles join detection like the built-ins
{ "customProfiles": {
    "pentest": { "label": "Security testing", "budgetUsd": 3.0, "burnUsdPerMin": 1.0,
                 "keywords": { "en": ["pentest", "exploit", "fuzz"] } } } }
```

`keywords` is keyed by language tag and every language present is searched. Phrases that
introduce an inline budget (`budget $2`) are the same shape, under `budgetPhrases`. Both
ship with English and Vietnamese; adding a language is a key in a config file, not a code
change.
</details>

---

## Install

```bash
npm i -g claude-for-poor-folks
cd your-project
claude-for-poor-folks init       # asks a few questions, once per repo (add --yes to skip)
claude-for-poor-folks install    # wires the status line + hooks
```

Restart Claude Code. That's the whole setup. `pclaude` is a shorter alias.

`claude-for-poor-folks uninstall` removes every line it added to `settings.json` and leaves
a backup. Your budget file and session history stay until you delete them.

<details>
<summary>As a Claude Code plugin instead (no npm)</summary>

```
/plugin marketplace add thanhpt1110/claude-for-poor-folks
/plugin install poor-folks@poor-folks
```

A plugin manifest can declare **hooks** but **not a status line**. You get the gate, the
warnings and the report; for the always-on traffic light, run `install` as above.
</details>

---

## Usage

| command | what it does |
|---|---|
| `claude-for-poor-folks init` | set the budget for this repo (once) |
| `claude-for-poor-folks install` | wire the status line + hooks |
| `claude-for-poor-folks report` | where the money went, and which habit caused it |
| `claude-for-poor-folks status` | current config + live sessions |
| `claude-for-poor-folks doctor` | check the wiring |
| `claude-for-poor-folks uninstall` | undo `install` |

`report` names the habit, not just the number:

```
$4.82 across 11 sessions · 3.1M tokens · avg $0.44/session

refactor   $2.41  ██████████░░░░░░░░  2 sessions
feature    $1.60  ███████░░░░░░░░░░░  4 sessions
bugfix     $0.81  ███░░░░░░░░░░░░░░░  5 sessions

where it leaks
  • 3 sessions hit compaction, $1.90 total. Compaction re-reads everything;
    a fresh session is usually cheaper and sharper.
  • Prompt-cache read ratio: 41% (poor). Cache reads cost ~1/10 of fresh
    input — this ratio is the single biggest lever on the bill.
```

---

## Accuracy

Measured against a real headless session that also spawned a subagent on a second model:

| | Claude Code | this tool |
|---|---|---|
| output tokens | 2,675 | 2,675 |
| cache read | 124,270 | 124,270 |
| cache write | 67,347 | 67,347 |
| cost | $0.549989 | **$0.549989** — 0.00% delta |

The undocumented Claude Code behaviours that had to be handled to get there are in
[CHANGELOG.md](CHANGELOG.md), and are worth reading if you are building something similar.

**Why it costs you nothing to run.** Hooks can return text on two channels, and only one
of them reaches the model:

| channel | model can read it | billed |
|---|---|---|
| `additionalContext` | yes | **yes** |
| `systemMessage` | **no** | **no** |

Every warning goes out on `systemMessage`. The single feature that used the other channel
is off by default. Asserted across all eight hook events in `test/integrity.test.js`.

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
  "prices": {},                 // needed only for headless runs, see below
  "customProfiles": {}
}
```

`init --global` writes the same shape to `~/.poor-folks/config.json` as your default.
A bad value is repaired **and reported** — a config typo must never leave the tool
silently dead.
</details>

---

## How it works

```
status line ──(cost, context, quota)──> snapshot file ─┐
     └── runs anyway, so metering is free              ├──> decision engine
transcript .jsonl + subagents ──(tokens)──> state file ┘
     └── the fallback meter for headless runs (claude -p, CI)
```

- **No proxy, no daemon, no API key.** It reads what Claude Code already computes.
- **No price table shipped.** Prices go stale; a wrong number is worse than an honest token
  count. Interactive cost comes from Claude Code. For headless dollars, add your own:
  ```jsonc
  { "prices": { "claude-opus-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } } }
  ```
- **It never touches your prompt.** Several tools offer to shrink your context to save
  money. Prompt caching matches an exact byte prefix — cache reads cost ~0.1× fresh input,
  writes 1.25×. Rewriting history invalidates the cache from that point on: a 150k prefix
  over 30 turns is about **$1.35** with cache hits and about **$8.10** without. Cutting 40%
  of your input can *multiply* your bill. This measures the cache instead, and tells you
  when it breaks.

<details>
<summary>Overhead, and types with no build step</summary>

`npm run bench`, ranges over four runs on one shared VM — a single run is noise and
absolute numbers drift per machine:

| | p50 | p95 |
|---|---|---|
| status line, in-process | 0.2 ms | 0.3 ms |
| status line, cold subprocess | 38–43 ms | 45–49 ms |
| `PreToolUse` hook, cold | 43–46 ms | 47–52 ms |
| `Stop` hook, cold | 283–285 ms | 288–292 ms |

`Stop` waits for the transcript to stop growing, once per turn, against a 5-second timeout.

The source is JavaScript with JSDoc types, checked by `tsc --checkJs --noEmit` under
`strict`. Nothing is emitted, so the file that runs is the file you read — which matters
for a tool that asks you to trust it with your `settings.json`. Compiling TypeScript would
mean committing `dist/` (the plugin marketplace copies the repo, not the npm tarball), and
running `.ts` directly measured 103 ms against 37 ms of cold start and drops Node 20 and 22.
</details>

---

## Design rules

| | |
|---|---|
| **Never break a session** | every hook exits 0, even if a module fails to load |
| **Never block a tool call** | it warns; it asks only if you opted in |
| **Never spend your tokens** | the default puts nothing in front of the model |
| **Never ask twice** | once per repo; never when your prompt already said it |
| **Never touch the prompt** | measuring is safe; rewriting history costs you the cache |
| **Never ship a price table** | an honest token count beats a stale dollar figure |
| **Never fail towards zero** | a blind meter says so instead of reading $0.00 |
| **Never phone home** | no network calls anywhere — asserted in the tests |

---

## If something looks wrong

| symptom | do this |
|---|---|
| no status line after install | restart Claude Code, then `claude-for-poor-folks doctor` |
| `doctor` says nothing is wired | run `install` from the repo root, not a subdirectory |
| the meter reads $0.00 | normal in headless runs (`claude -p`) — there is no status line to read cost from; add `prices` for dollars, or read the token count |
| a warning fires too often | raise the cap in `.poor-folks.json`, or set `"quiet": true` |
| you want it gone | `claude-for-poor-folks uninstall` |

Anything else: [open an issue](https://github.com/thanhpt1110/claude-for-poor-folks/issues).
Include the output of `claude-for-poor-folks doctor`; it contains no private data.

## Requirements

Node ≥ 20 · Claude Code ≥ 2.1 · Linux, macOS, Windows *(CI runs all nine combinations)*

**No runtime dependencies** — installing this pulls nothing else, and the hooks run on plain
`node`. Contributors get `typescript` and `@types/node` for the type check; nobody who
installs the tool ever downloads them.

## License

MIT — see [CONTRIBUTING.md](CONTRIBUTING.md) to work on it.
