#!/bin/bash
# LLM Observability daily report — runs weekdays at 8:57am via crontab
# Finds apps using >1B tokens/week in Datadog LLM Obs and sends a context summary as a Slack DM

set -euo pipefail

LOGFILE="$HOME/.claude/logs/llm-obs-report.log"
CLAUDE="$HOME/.local/bin/claude"

mkdir -p "$(dirname "$LOGFILE")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGFILE"; }

log "Starting LLM Observability report"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

PROMPT='You are a scheduled reporting agent. Your job: identify AI product teams with high LLM token usage in Datadog LLM Observability, gather rich context on what each team is building and their current pain points, then DM a summary to Matthieu Neau (Slack user ID: U08R9AN0UJ1).

## Step 1 — List all LLM Observability applications and their weekly token usage

Use mcp__datadog__aggregate_spans to query token usage per ml_app over the last 7 days.
- Group by: ml_app (the application name tag in LLM Obs)
- Sum: @ml_obs.input_tokens and @ml_obs.output_tokens (total = input + output)
- Time range: last 7 days (now-7d to now)

Keep only applications where total tokens > 1,000,000,000 (1 billion).

## Step 2 — Gather context on each high-usage application

For each application above the 1B threshold, gather as much context as possible by running these queries in parallel:

a) Recent traces: use mcp__datadog__search_llmobs_spans to find a sample of recent spans for this app. Look at the prompts, completions, and metadata to understand what the app does.

b) Error patterns: use mcp__datadog__find_llmobs_error_spans to find recent errors and failure modes. These reveal current pain points.

c) Model usage: from the spans, note which LLM models (GPT-4, Claude, etc.) are being used and at what ratio.

d) Usage trend: compare this week vs last week token volume to identify if usage is growing, stable, or declining.

Synthesize for each app:
- What the service appears to do (inferred from prompts/completions/metadata)
- What is being explored or experimented with (unusual prompt patterns, model switches, A/B testing signals)
- Current pain points (errors, high latency, retries, failed tool calls)
- Token volume and week-over-week trend

## Step 3 — Compose and send the Slack DM

Format the report as:

*LLM Observability — High-Usage Apps (>1B tokens/week) — [DATE]*

*[App Name]* — [X.X]B tokens this week ([+/-X%] WoW)
• *What it does:* [1-2 sentence description]
• *Being explored:* [experiments, model switches, prompt changes]
• *Pain points:* [errors, latency issues, failure modes]
• *Models:* [list of LLM models used and rough split]

---

[repeat for each app]

_[N] apps above 1B token threshold out of [total] observed._

Use Slack mrkdwn formatting. Send as DM to U08R9AN0UJ1 via slack_send_message with channel = "U08R9AN0UJ1".

If a query fails, skip that data point and note it in the report rather than aborting.'

"$CLAUDE" \
    --model haiku \
    --allowedTools "mcp__datadog__aggregate_spans,mcp__datadog__search_llmobs_spans,mcp__datadog__find_llmobs_error_spans,mcp__datadog__get_llmobs_span_details,mcp__datadog__expand_llmobs_spans,mcp__slack__slack_send_message" \
    -p "$PROMPT" >> "$LOGFILE" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log "Completed successfully"
else
    log "ERROR: claude exited with code $EXIT_CODE"
fi

exit $EXIT_CODE
