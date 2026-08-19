/**
 * Shared shapes for the whole package.
 *
 * This file has no runtime code — it exists so every module can say what it
 * actually accepts and returns. That matters most at the boundary with Claude
 * Code: the handler used to read `payload.how`, a field that does not exist,
 * and nothing caught it until a real session was captured. The payload types
 * below are transcribed from `test/fixtures/hook-payloads.json`, which was
 * recorded from a live session, so an invented field name is now a type error.
 *
 * @module types
 */

/**
 * @typedef {object} Tokens
 * @property {number} input        tokens billed at full price
 * @property {number} output
 * @property {number} cacheRead    served from cache, ~1/10 the price of input
 * @property {number} cacheCreate  written to cache, ~1.25x the price of input
 * @property {number} messages     assistant messages these came from
 */

/** @typedef {Record<string, Tokens>} ByModel */

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} label
 * @property {number} budgetUsd       soft ceiling for one session of this work
 * @property {number} burnUsdPerMin   "too fast" threshold; catches runaway loops
 * @property {number} ctxWarnPct      context fill % at which compaction is near
 * @property {string} [hint]
 * @property {Record<string, string[]>} [keywords]  language tag -> phrases; any tag
 */

/** @typedef {Record<string, Profile>} Profiles */

/**
 * USD per million tokens. Ships empty on purpose: a stale price table is worse
 * than an honest token count.
 * @typedef {object} PriceEntry
 * @property {number} [input]
 * @property {number} [output]
 * @property {number} [cacheRead]
 * @property {number} [cacheWrite]
 */

/**
 * @typedef {object} BudgetConfig
 * @property {number|null} sessionUsd
 * @property {number|null} sessionTokens
 * @property {number|null} dailyUsd
 * @property {'repo'|'machine'} dailyScope
 * @property {number[]} warnAtPct
 * @property {number|null} burnUsdPerMin
 */

/**
 * @typedef {object} Config
 * @property {number} version
 * @property {string|null} profile
 * @property {string|null} [profileLabel]
 * @property {BudgetConfig} budget
 * @property {{ warnFiveHourPct: number, warnSevenDayPct: number }} quota
 * @property {{ warnPct: number|null }} context
 * @property {{ minReadRatio: number, minInputTokens: number }} cache
 * @property {{ warnSubagents: number, warnCompacts: number }} fanout
 * @property {'warn'|'ask'} onLimit
 * @property {boolean} unattended
 * @property {boolean} askProfile    the only setting that adds tokens
 * @property {boolean} quiet
 * @property {Record<string, PriceEntry>} prices
 * @property {Record<string, string[]>} budgetPhrases  extra languages for "budget $2"
 * @property {Record<string, Partial<Profile>>} customProfiles
 * @property {{ global: string, repo: string|null }} [_sources]
 * @property {string[]} [_warnings]
 */

/**
 * Config and the chosen profile, collapsed into the numbers the engine uses.
 * @typedef {object} Limits
 * @property {Profile} profile
 * @property {number} sessionUsd
 * @property {number|null} sessionTokens
 * @property {number|null} dailyUsd
 * @property {'repo'|'machine'} dailyScope
 * @property {number[]} warnAtPct
 * @property {number} burnUsdPerMin
 * @property {number} ctxWarnPct
 * @property {number} fiveHourPct
 * @property {number} sevenDayPct
 * @property {number} minCacheReadRatio
 * @property {number} cacheMinInputTokens
 * @property {number} warnSubagents
 * @property {number} warnCompacts
 */

/** @typedef {{ input: number, output: number, cacheRead: number, cacheCreate: number }} UsageSnapshot */

/**
 * Written only by the status line.
 * @typedef {object} Snapshot
 * @property {number} v
 * @property {string} sessionId
 * @property {number} updatedAt
 * @property {boolean|null} recognized   did we understand the payload at all
 * @property {number} [unrecognizedRuns]
 * @property {number} costUsd
 * @property {number} ctxPct
 * @property {number|null} ctxSize
 * @property {string|null} model
 * @property {string|null} modelName
 * @property {number|null} durationMs
 * @property {UsageSnapshot|null} lastUsage
 * @property {number|null} fiveHourPct
 * @property {number|null} fiveHourResetsAt
 * @property {number|null} sevenDayPct
 * @property {number|null} sevenDayResetsAt
 * @property {Array<[number, number]>} samples   [epochMs, costUsd]
 */

/**
 * Written only by the hooks.
 * @typedef {object} SessionState
 * @property {number} v
 * @property {string} sessionId
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {string|null} cwd
 * @property {string|null} profile
 * @property {string|null} profileLabel
 * @property {'config'|'explicit'|'detected'|'asked'|'fallback'|null} profileSource
 * @property {number|null} budgetUsd
 * @property {'prompt'|null} [budgetSource]
 * @property {number} promptCount
 * @property {number} toolCount
 * @property {number} subagentCount
 * @property {number} compactCount
 * @property {Record<string, number>} [agentTypes]
 * @property {Tokens} tokens
 * @property {ByModel} byModel
 * @property {number|null} estCostUsd
 * @property {string|null} transcriptPath
 * @property {Record<string, number>} transcriptOffsets
 * @property {Record<string, UsageSnapshot>} counted
 * @property {string[]} [subagentTranscripts]
 * @property {string[]} firedWarnings
 * @property {number} lastLedgerCostUsd
 * @property {Array<[number, number]>} samples
 */

/** The two halves merged, as the decision engine sees a session. @typedef {Snapshot & SessionState} Session */

/** @typedef {'ok'|'notice'|'warn'|'critical'} SignalLevel */

/**
 * @typedef {object} Signal
 * @property {string} code
 * @property {SignalLevel} level
 * @property {string} title    what happened
 * @property {string} detail   why it matters
 * @property {string} action   what to do about it
 * @property {Record<string, any>} data
 */

/**
 * @typedef {object} Decision
 * @property {Signal[]} signals
 * @property {number} level
 * @property {SignalLevel} levelName
 * @property {number} pct
 * @property {number} cost
 * @property {number} cap
 * @property {number|null} burn
 * @property {number} now
 */

/**
 * A retrospective finding from `report`. No colour: the text renderer adds it.
 * @typedef {object} Leak
 * @property {string} code                       stable identifier, e.g. "cache"
 * @property {'notice'|'warn'} severity
 * @property {string} message                    one sentence, already readable
 * @property {Record<string, any>} [data]        the numbers behind the sentence
 */

/**
 * @typedef {object} Detection
 * @property {string} profileId
 * @property {'certain'|'high'|'low'} confidence
 * @property {number} score
 * @property {string|null} runnerUp
 * @property {string[]} matched
 * @property {number|null} budgetUsd   a budget stated in the prompt itself
 */

/**
 * A thin row per turn (what "spent today" is summed from) or one fat row per
 * session (what `report` reads).
 * @typedef {object} LedgerRow
 * @property {number} [v]
 * @property {'turn'|'session'} kind
 * @property {string} ts
 * @property {string} sessionId
 * @property {string} [cwd]
 * @property {number} costUsd
 * @property {number} deltaUsd
 * @property {number|null} [estCostUsd]
 * @property {number} [budgetUsd]
 * @property {string|null} [model]
 * @property {string|null} [profile]
 * @property {string|null} [profileLabel]
 * @property {string|null} [profileSource]
 * @property {number} [promptCount]
 * @property {number} [toolCount]
 * @property {number} [subagentCount]
 * @property {number} [compactCount]
 * @property {number|null} [ctxPct]
 * @property {number|null} [fiveHourPct]
 * @property {number|null} [sevenDayPct]
 * @property {boolean|null} [recognized]
 * @property {string|null} [transcriptPath]
 * @property {Tokens|null} [tokens]
 * @property {ByModel|null} [byModel]
 * @property {number} [_ts]
 * @property {boolean} [partial]
 * @property {boolean} [reconciled]
 */

/**
 * Every hook event carries these. Transcribed from a captured session, and
 * `test/payloads.test.js` fails if a field appears in the capture without being
 * declared here — otherwise "transcribed from reality" decays into a comment.
 * @typedef {object} HookPayloadBase
 * @property {string} hook_event_name
 * @property {string} session_id
 * @property {string} cwd
 * @property {string} [transcript_path]
 * @property {string} [prompt_id]
 * @property {string} [permission_mode]
 * @property {{ level?: string }} [effort]   an object, not a string
 */

/**
 * The field is `source`. There is no `how`.
 *
 * An earlier version of this file declared `how?: undefined` and the commit
 * claimed that made `payload.how` a compile error. It did not: declaring a
 * property — even as `undefined` — is what PERMITS reading it. Leaving the
 * field out entirely is what makes the read an error (TS2339). A guard nobody
 * tested is exactly the failure this project keeps finding.
 * @typedef {HookPayloadBase & {
 *   source?: 'startup'|'resume'|'clear'|'compact'|'fork'
 * }} SessionStartPayload
 */

/** The field is `prompt`. There is no `user_prompt`, for the same reason. */
/** @typedef {HookPayloadBase & { prompt?: string }} UserPromptSubmitPayload */
/** @typedef {HookPayloadBase & { tool_name?: string, tool_input?: any, tool_use_id?: string, tool_response?: any, duration_ms?: number }} ToolPayload */
/** @typedef {HookPayloadBase & { agent_id?: string, agent_type?: string }} SubagentStartPayload */
/** @typedef {HookPayloadBase & { agent_id?: string, agent_type?: string, agent_transcript_path?: string }} SubagentStopPayload */
/** @typedef {HookPayloadBase & { last_assistant_message?: string, stop_hook_active?: boolean, background_tasks?: unknown[], session_crons?: unknown[] }} StopPayload */
/** @typedef {HookPayloadBase & { reason?: string }} SessionEndPayload */

/**
 * @typedef {SessionStartPayload & UserPromptSubmitPayload & ToolPayload &
 *   SubagentStartPayload & SubagentStopPayload & StopPayload & SessionEndPayload} HookPayload
 */

/**
 * What Claude Code hands the status line on stdin. It already contains cost,
 * context usage and rate-limit percentages, which is why metering is free.
 * @typedef {object} StatusLinePayload
 * @property {string} [session_id]
 * @property {string} [transcript_path]
 * @property {{ id?: string, display_name?: string }} [model]
 * @property {{ current_dir?: string, project_dir?: string }} [workspace]
 * @property {string} [cwd]
 * @property {string} [version]
 * @property {{ total_cost_usd?: number, total_duration_ms?: number }} [cost]
 * @property {{
 *   total_input_tokens?: number, total_output_tokens?: number,
 *   context_window_size?: number, used_percentage?: number,
 *   current_usage?: { input_tokens?: number, output_tokens?: number,
 *                     cache_read_input_tokens?: number, cache_creation_input_tokens?: number }
 * }} [context_window]
 * @property {{
 *   five_hour?: { used_percentage?: number, resets_at?: number },
 *   seven_day?: { used_percentage?: number, resets_at?: number }
 * }} [rate_limits]
 */

/** What a hook may return. `additionalContext` is the only field the model can read. */
/**
 * @typedef {object} HookResult
 * @property {string} [systemMessage]   shown to the human; the model cannot read it
 * @property {{ hookEventName: string, additionalContext?: string,
 *              permissionDecision?: 'allow'|'deny'|'ask',
 *              permissionDecisionReason?: string }} [hookSpecificOutput]
 */

export {};
