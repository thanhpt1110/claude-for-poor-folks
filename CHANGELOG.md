# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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
