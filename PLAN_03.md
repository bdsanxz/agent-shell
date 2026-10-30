# PLAN_03: agent-shell 0.2.3 - notifications without the sender footer

This extends the uncommitted 0.2.3 work (PLAN_02 is done in the working tree; keep it, version stays 0.2.3).

## Problem

A job started from an agent's own terminal sends its progress and completion notifications to that same terminal with `hcx send`, which appends a footer taken from `HC_TERMINAL_ID`. The agent sees, every 2 minutes:

```
shell job 'x' still running (12m2s elapsed)... Read with: agent-shell tail sh-...
— from Sari · reply: hcx send Sari "..."
```

The footer names the receiver as the sender and invites a reply to itself. A notification is not a conversation between agents; it needs no footer. `hcx send --no-footer` (alias `--raw`, available since hcx 0.1.3) sends the text as given, untagged, with no footer.

## Steps

1. Read `src/notify.ts` (`hcxNotify`, `hcRoute`, `haveHcx`), the tests, README (notify section, around line 35), `ISSUES.md`. Add `ISSUES.md` row 4 (reporter "owner review", version 0.2.2, "Notifications carry a sender footer naming the receiver as the sender", status "In progress (0.2.3)").
2. In `hcxNotify` send `hcx send --no-footer <target> <text>` (flag before the target). Only do this when the installed hcx supports it: read the first line of `hcx --version` (`hcx 0.1.3` or newer; parse major.minor.patch). With an older or unparseable hcx, an agent target keeps the tagged `hc send` (an old hcx would treat the flag as message text), and say so in the note, for example `notified t9 via hc send (hcx older than 0.1.3)`. Cache the version check for the process. Shells and unknown kinds stay on tagged `hc send`: raw text would be typed into a prompt as a command.
3. The note for the new route reads `notified <target> via hcx send --no-footer`; keep the failure fallback to the tagged send as is.
4. Tests (stub hcx/hc on PATH like the existing tests): the recorded hcx argv is `send --no-footer <target> <text>`; hcx 0.1.2 stub (version line `hcx 0.1.2`) -> tagged `hc send`, hcx not asked to send; unparseable version -> tagged; shell kind -> tagged and hcx send not called; hcx failing -> falls back as before. Update tests that expected the old argv.
5. README: the notify section says agent targets get an untagged send with no footer (needs hcx 0.1.3 or newer); `--help` only if it describes the route. ISSUES row -> "Fixed in 0.2.3".
6. `bunx tsc --noEmit`, `bun test`, `bun run build` twice (identical sha256).

## Rules for the worker

- Work only in `/Users/budisantoso/Dev/bdsanxz/SWE/agent-shell`. Read every file before changing it. Edit in place; never overwrite a file wholesale.
- All text in the codebase is English. No secrets. Do not print environment values.
- No live agent sessions, no commits, pushes, tags, releases or installs: the lead does those.
- Finish with `git diff --stat`.

## Report

Write the report to `/private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan03-agent-shell.md`, then run: `hcx send Zytra "plan03-agent-shell done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan03-agent-shell.md"`
