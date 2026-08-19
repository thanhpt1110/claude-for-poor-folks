# Security

This tool reads your Claude Code session data and edits your `settings.json`. That deserves
a straight answer about what it touches.

## What it reads

- The JSON Claude Code hands the status line and the hooks: cost, context usage, rate-limit
  percentages, the prompt text, tool names.
- Session transcripts under `~/.claude/projects/`, including subagent transcripts. Only the
  `usage` figures on assistant messages are parsed — token counts and model ids.

Your prompts and code pass through the process. They are never stored, never summarised, and
never sent anywhere.

## What it writes

- `~/.poor-folks/` — session counters, a ledger of costs, your global config, and one small
  flag per project under `notices/` recording that a one-time message has already been shown,
  so it is not repeated. Flags age out on the same schedule as session state.
- `.poor-folks.json` in the repo you ran `init` in.
- `.claude/settings.json` — only the status line and hook entries it added, each marked so
  `uninstall` removes exactly those and nothing else. A timestamped backup is written first.
- `.claude/skills/poor-folks-review/SKILL.md` — the review skill, copied there by `install` so
  that an npm install has the same features as the plugin. `uninstall` removes it again, and
  neither command touches a file at that path that it did not write.

## What it never does

- **No network calls.** Not for telemetry, not for prices, not for updates. This is asserted
  by a test that fails if `src/` gains an import of `http`, `https`, `net`, `tls`, `dgram`,
  or a call to `fetch`.
- **No runtime dependencies.** Nothing else is installed, so there is no transitive supply
  chain to trust.
- **No credentials read or written.** It never touches an API key.
- **Nothing added to your conversation** under the default configuration.

## Verifying that yourself

The package ships unminified source and is not compiled, so what runs is what you read:

```bash
npm pack claude-for-poor-folks && tar xzf claude-for-poor-folks-*.tgz
grep -rE "fetch\(|require\(.(node:)?(http|https|net|tls)" package/src/   # expect nothing
```

## Reporting a vulnerability

Email **thanhphantuan1110@gmail.com** with "claude-for-poor-folks" in the subject, or open a
[private security advisory](https://github.com/thanhpt1110/claude-for-poor-folks/security/advisories/new).
Please do not open a public issue for anything that could expose someone's data.

Expect an acknowledgement within a few days. This is a personal project, not a company, and
that is the honest turnaround.

## Supported versions

The latest published version. There is no backport branch.
