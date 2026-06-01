#!/bin/bash
# Team standup summary — runs weekdays at 10:03am via crontab
# Queries Jira + GitLab PRs for previous business day activity and DMs @matthieu.neau

set -euo pipefail

LOGFILE="$HOME/.claude/logs/team-standup.log"
CLAUDE="$HOME/.local/bin/claude"

mkdir -p "$(dirname "$LOGFILE")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGFILE"; }

log "Starting team standup summary"

# Cron runs with a minimal environment — restore the standard user PATH
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

PROMPT='You are a scheduled reporting agent. Your job: gather what the AI Platform Training & Serving team worked on the previous business day, then send a Slack DM summary to Matthieu Neau (Slack user ID: U08R9AN0UJ1).

## Step 1 — Determine the previous business day

Use the current system date. Compute the "previous business day":
- If today is Monday → use last Friday
- Otherwise → use yesterday
Format as YYYY-MM-DD for queries.

## Step 2 — Query Jira for team activity

Search for Jira issues updated on the previous business day. Use this JQL (replace DATE with the computed date):
  project in (AIPTS) AND updated >= "DATE" AND updated <= "DATE 23:59" ORDER BY updated DESC

For each returned issue, note: issue key, summary, status, and the name of who updated/commented/transitioned it.

Team members to attribute activity to (by display name as it appears in Jira):
- Marta Andrés (marta.andres)
- Clémence Burnichon (clemence.burnichon)
- Nina Pakhomova (nina.pakhomova)
- Kan Wang (kan.wang)
- Raya Wakil (raya.wakil)
- Gaël Magnan (gael.magnandebornier)
- Dengke Liu (dengke.liu)
- Francis Alcos (francis.alcos)
- Savita Manghnani (savita.manghnani)
- Marie Joe Louca (mariejoe.louca)
- Karim Siala (karim.siala)
- Walid Elbouchikhi (walid.elbouchikhi)
- Askar Aitzhan (askar.aitzhan)
- Donghwan Kim (donghwan.kim)
- Patrick Albert (patrick.albert)
- Louis Fruleux (louis.fruleux)
- Guillaume Deacken (guillaume.deacken)
- Zubair Mohammed (zubair.mohammed)
- Walid Bouainouche (walid.bouainouche)

## Step 3 — Search for PRs / MRs

Use the mcp__datadog__search_pr_insights tool to find PRs opened or merged by team members on or around the previous business day in the dd-source repository. Search by author display name for each team member.

## Step 4 — Compose and send the Slack DM

Write a concise summary grouped by person. Only include team members who had activity. Use this format:

*Team activity — [DAY OF WEEK] [DATE]*

*Marta Andrés*
• [AIPTS-1234] Fix tokenizer bug → _In Review_
• PR: "Add retry logic for LIP client" (opened)

*Kan Wang*
• [AIPTS-1235] Update batch inference config → _Done_

_No activity recorded for: [comma-separated list of names with no activity]_

Use Slack mrkdwn formatting (bold with *, italic with _, bullet with •).
Send the message as a DM by calling slack_send_message with channel = "U08R9AN0UJ1".

If Jira or PR queries return errors, still send the DM noting which source failed and what was found in the other.'

"$CLAUDE" \
    --model haiku \
    --allowedTools "mcp__atlassian__searchJiraIssuesUsingJql,mcp__datadog__search_pr_insights,mcp__slack__slack_send_message" \
    -p "$PROMPT" >> "$LOGFILE" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log "Completed successfully"
else
    log "ERROR: claude exited with code $EXIT_CODE"
fi

exit $EXIT_CODE
