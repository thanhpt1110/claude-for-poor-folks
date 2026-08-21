# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Per-tool attribution. `report` now shows which tools moved the bytes, and flags
  tool calls that repeated identical input — the one form of waste nothing else
  can see. A transcript records that a file was read; it never records that the
  same file was read forty times. Measured at the hook via a new `PostToolUse`
  handler, using the size of the payload as it arrived rather than re-serialising
  `tool_response`, so a 200 kB tool result costs the same to measure as a 2-byte
  one (43 ms vs 42 ms, measured).
- It is reported in bytes, not tokens. This package ships no tokeniser, so it
  does not convert one into the other and present a guess as a measurement. The
  byte figure is `Buffer.byteLength` of the payload as it arrived — the first
  draft used the string length, which counts UTF-16 code units and undercounted
  CJK and emoji payloads by up to 3x while still being printed under the word
  "bytes".
- The repeat headline states how many sessions it is summing, and uses no ordinal:
  an earlier draft said "moved a second time" next to "called 10 times identically"
  in the same sentence, and said "the session" for a figure summed across the whole
  reporting window. Its total is also taken from the session's own uncapped count,
  not from the twelve largest groups the ledger keeps, which reported twelve
  re-sends for a session that made fifteen.
- Repeats are counted as re-sends, not as calls: a call made three times is two
  re-sends, and the bytes charged to it are the two repeats' share, not all three.
  The "worst" line names the largest single identical group rather than a per-tool
  total, so it cannot describe calls with different inputs as identical.
- Repeated calls are identified by a fingerprint of the tool's input. The input
  itself is never recorded. A `Bash` input is a command line and an `Edit` input
  is your source, so an earlier draft that kept a 160-character sample put a live
  credential into `ledger.jsonl` and into `report --json` — falsifying two
  sentences in SECURITY.md. `report` now tells you a call repeated and how much
  it moved, and deliberately cannot tell you what was in it.
- The cost of it is one more hook process per tool call: ~43 ms, of which ~29 ms
  is node starting up. That is roughly double the previous per-tool-call hook
  overhead, so `doctor` now states the number, and `"measureTools": false` turns
  it off for anyone who would rather not pay it.
- A test now asserts that both install routes declare the same hook events. They
  live in two hand-edited files — `HOOK_EVENTS` and the plugin manifest — and
  nothing had connected them, so adding an event to one and forgetting the other
  gave plugin users a quietly different tool.

### Fixed

- A setting that does not exist is now reported instead of dropped in silence.
  `{"budgetUsd": 0.5}` looks exactly like a budget, is not one, and left the
  profile default running — so the user believed they were capped at $0.50 while
  something else was enforced, and nothing anywhere said otherwise. Unknown keys
  are now named, with the real setting suggested (`budget.sessionUsd`), at both
  the top level and inside `budget`, `quota`, `context`, `cache` and `fanout`.
  Maps that legitimately hold arbitrary keys — `prices`, `budgetPhrases`,
  `customProfiles` — are never flagged.
- Config warnings now reach a human where they are actually being read.
  `validateConfig` has repaired bad values and recorded why since the first
  release, and `status` has printed them for just as long — but `doctor` said
  `ok` on a broken config and the session banner said nothing, which are the two
  places people look. `doctor` now lists every ignored setting and the file it
  came from, and the banner says how many there are. Both are `systemMessage`,
  so neither costs a token.

## [0.1.1] — 2026-08-20

Initial public release.

- Budget gate, live cost/quota meter and leak detector for Claude Code.
- Zero runtime dependencies; nothing leaves the machine; no network calls.
- Adds no text to the conversation under the default configuration, verified across
  every hook event.
- Metering verified against Claude Code's own totals on real sessions, including one
  that spawned a subagent on a second model: token counts exact, cost delta 0.00%.
- Task detection is an offline keyword heuristic keyed by language tag; adding a
  language is a key in a config file, not a code change. Set `askProfile: true` if you
  would rather the model classify — it understands every language and costs about 60
  tokens per session.

### Added

- `/poor-folks:review` — a skill bundled with the plugin. It runs `report --json` and has the
  model turn the figures into a short, ranked list of habits worth changing. Numbers are the
  tool's job; interpretation is the model's.
  - It is **explicit-invocation only** (`disable-model-invocation: true`), so it can never be
    pulled into a session automatically. It is the one part of this package that puts text in
    front of a model, at roughly 500–900 tokens, and its description says so before you run it.
    A test fails if that guard is ever removed.

- `doctor` now says what is actually there and what to do about it. It called an empty
  status-line slot "someone else's", and it told anyone with nothing in `settings.json` to run
  a full `install` — which, for someone who installed the plugin, would wire all eight hooks a
  second time. It cannot see a plugin's hooks (they live in the manifest), so it now says so
  and gives both commands with the reason for each.
- `install --status-line-only` — adds the status line without touching hooks. A plugin
  already supplies the hooks from its manifest, where nothing here can see them to skip, so a
  full install would wire all eight a second time: doubled banners, doubled latency, and a
  daily total inflated by two `Stop` hooks appending the same delta.
- Feature parity between the two install routes. npm users get the review skill (`install`
  copies it in, `uninstall` takes it back out, and a file it did not write is never touched);
  plugin users get the CLI on their PATH through `bin/`, and are told **once** that the status
  line needs one more command. A plugin manifest cannot declare a status line, so rather than
  edit someone's `settings.json` unasked, the tool states the gap and hands over the command —
  once per project, and never to someone already running a status line of their own, since
  `install` would refuse to replace it.
  One honest exception to that parity: the `bin/` shim is a `sh` script, exercised by the
  suite on Linux and macOS only. On Windows it is skipped rather than assumed, so plugin users
  there should install through npm — a route whose entry point (`src/cli/index.js`, run through
  npm's own shim) *is* covered by the Windows CI jobs.

### Fixed

- `report --json` embedded ANSI colour codes inside JSON strings. Findings are now structured
  (`{ code, severity, message, data }`) and carry no colour; the text renderer adds it.
- Per-model cost showed `$0.00` when no prices were configured, next to a session total of
  several dollars — "not known" rendered as "nothing". It now reports `null` and shows tokens.
- `install --status-line-only` warns when nothing in `settings.json` supplies the hooks, since
  a status line without them renders defaults forever, and no longer leaves an empty `hooks`
  key behind.
- One-time notice flags are pruned on the same schedule as session state instead of
  accumulating one file per project seen, and `SECURITY.md` now discloses that they are written.

### Notes on Claude Code's undocumented behaviour

Measured while building the meter, and recorded because anyone writing a similar tool
will meet them. None of this is documented upstream.

| Behaviour | Consequence for a metering tool |
|---|---|
| One assistant message is written to the session transcript **several times**, with `output_tokens` growing as it streams (2 → 579 → …) | Summing rows double-counts; keeping the first row loses almost all output. Track the maximum per message id and accumulate only the increase. |
| Subagents do **not** appear in the main transcript | Their path arrives on `SubagentStop.agent_transcript_path`. Missing it under-reported one measured session by **41%**. |
| The `Stop` hook fires **before** the final assistant message reaches disk | Without a bounded wait, every session under-reports by its last turn. |
| `SessionStart` carries `source`, not `how`; `UserPromptSubmit` carries `prompt`, not `user_prompt` | Reading an invented field is silent — the code does nothing and no error is raised. Payload fixtures are captured from live sessions for this reason. |
| Hook output on `systemMessage` is **not visible to the model**; `additionalContext` **is** | Only the latter costs tokens. Verified by injecting markers and asking the model to read them back. |
| Hooks have no network and no model | Task detection has to be a local heuristic, or it has to bill the user. Hence the keyword map, and `askProfile` as the opt-in alternative. |
| `fs.mkdirSync(…, { recursive: true })` under `/proc` on Linux **hangs** rather than failing | A hung status line freezes part of the editor, so a suspicious state directory is refused rather than trusted. |
| A transcript above Node's ~512 MB string cap throws inside `Buffer.toString('utf8')` | Swallowed, it silently reports zero tokens. Reads are chunked. |

[0.1.1]: https://github.com/thanhpt1110/claude-for-poor-folks/releases/tag/v0.1.1
