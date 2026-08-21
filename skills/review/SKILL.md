---
description: Read this repository's own spend report and say which habits are costing money. Explicit invocation only — it puts a report into the conversation, which costs roughly 500-900 tokens.
disable-model-invocation: true
---

# Spend review

You are reading a cost report and turning it into a short list of changes worth making.

**This skill costs the user tokens.** It is invoked by hand, never automatically, and it is
the only part of `claude-for-poor-folks` that puts anything in front of a model. Keep the
output short: a long answer is money spent to be told what to do.

## 1. Get the data

Run this. `$ARGUMENTS` is an optional number of days; default to 30.

```bash
claude-for-poor-folks report --json --days ${ARGUMENTS:-30} 2>/dev/null \
  || node "${CLAUDE_PLUGIN_ROOT}/src/cli/index.js" report --json --days ${ARGUMENTS:-30}
```

If it prints `no data yet`, stop and say so: there is nothing to review until some sessions
have ended. Do not speculate about spending that was never measured.

## 2. Read it

The JSON has `totalUsd`, `totalTokens`, `sessions`, `byProfile`, `byRepo`, `byModel`, and
`leaks` — an array of `{ code, severity, message, data }`.

Interpret `leaks` with this, and do not invent causes beyond it:

| code | what it means | what usually causes it |
|---|---|---|
| `cache` | prompt-cache read ratio. Cache reads cost about a tenth of fresh input, so this is the largest single lever | editing files that are already in context, a tool that injects a timestamp or a random id, switching model or effort mid-session |
| `compaction` | a session was compacted, which re-reads and re-summarises everything | one session carrying several unrelated tasks |
| `fanout` | many subagents; each carries its own context and bills separately | delegating work that the main thread could have done in a few tool calls |
| `repeat-calls` | the same input was sent to the same tool more than once. `data.resent` counts only the sends after the first; `data.worst[0]` is the largest single identical group | a loop re-reading a file it already read, a check repeated after every edit, a subagent re-fetching what the parent already had. What was in the calls is deliberately not recorded, so reason from the tool name and the counts |
| `over-budget` | sessions finished past their cap | the cap is wrong for that kind of work, or the task was classified wrongly |
| `blind-meter` | the tool stopped understanding Claude Code's payload | the tool is out of date; the dollar figures for those sessions are not trustworthy |

Also look at the data itself, not only at `leaks`:

- **Which tools moved the bytes.** `toolStats` gives per-tool `calls`, `bytes` and `ms`. Bytes
  are measured at the hook, not converted into tokens, so treat them as a relative signal
  between tools rather than as a cost. A tool with few calls but most of the bytes is a
  different problem from one with many small calls.
- **Concentration.** If one entry in `byProfile` or `byRepo` holds most of `totalUsd`, that is
  where any change pays off. A 20% saving on the largest line beats eliminating the smallest.
- **Cost per session.** `totalUsd / sessions` against the caps in `.poor-folks.json`. If the
  average is far under the cap, the caps are decorative; if it is at the cap, they are binding.
- **Model mix.** If `byModel` shows expensive work that reads rather than reasons, a cheaper
  model for that part is usually the largest available saving.

## 3. Answer

At most six lines. Nothing else.

- One line: the total, the period, and where the money is concentrated.
- Then at most three changes, ordered by money saved, each in one line: **what to change**,
  and roughly **what it saves**, grounded in a number from the report.
- If there is nothing worth changing, say that in one line. That is a valid and useful answer.

Never invent a figure. Every number you state must appear in the JSON or be arithmetic on it.
If the report says cost data is missing (headless sessions with no prices configured), talk in
tokens rather than dollars and say why.

## Example of the right shape

```
$4.82 over 30 days, 50% of it in `refactor` sessions in the api repo.

1. Split refactor work into fresh sessions — 2 of them hit compaction ($2.41), which
   re-reads the whole conversation each time.
2. Cache read ratio is 69%; check whether a tool in that flow injects a changing value.
   Getting it to ~90% would cut roughly a third off the input cost.
3. One session spawned 7 subagents. Each carries its own context — do that only when the
   work genuinely fans out.
```
