# PLAN_05: agent-shell 0.3.0 - notify through hcx 0.3.0

Source: review /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-review-peers-agentshell.md (Part 3 and Part 2 item 7). Read it, then README.md, ISSUES.md, src/notify.ts, src/commands.ts, test/run.test.ts.

## The hcx 0.3.0 contract to use (read /Users/budisantoso/Dev/bdsanxz/SWE/hcx/README.md and /Users/budisantoso/Dev/bdsanxz/SWE/hcx/src/send.ts, lib.ts, passthrough.ts first)
- Send with argv, no shell: `hcx send --agent-only --no-footer --json <address> "<text>"`. hcx looks the kind up first and refuses a plain shell or unknown kind BEFORE sending (error JSON on stderr/stdout in hc's shape `{"error":{"kind","message","hint"}}`, kind `plain_shell`, exit 4). Success prints hc's JSON plus `delivered` (true / false / null), `route`, `agent`, `note`.
- Map the result: `delivered: true` = notified; `delivered: false` = stored but message not started, do not resend; `delivered: null` = unconfirmed (opencode TUI), never resend; exit 4 / kind `plain_shell` = queued, not delivered because the target is a plain shell or unknown; kind `timeout` or any other nonzero exit after the send may have landed = notification failed, NEVER retry automatically; kind `not_found` = target not found, queued.
- hcx is a required dependency. Detect it once per process with `hcx --version --json` (parse `contract` >= 1 and `capabilities` containing `agent-only` and `no-footer`); cache the answer. Missing or older hcx: do not fall back to typing into anything; report the notification as not delivered with the hint `install hcx >= 0.3.0` (the message/job result stays stored).
- Delete the code this replaces: shell-kind sets, hc foreground / effective-kind lookups, hc target-kind lookups, the confirm-delivery parser, HC_TERMINAL_ID plumbing for the hc route, the hcx version-parse for --no-footer, and the tests that only covered them. Keep behaviour the tests still describe (wording of messages stays unless the plan says otherwise).

## Steps
1. ISSUES.md rows (reporter "owner review", version 0.2.4, "In progress (0.3.0)").
2. Replace the hc paths in `src/notify.ts` (`hcNotify`, `hcxNotify`, `hcTargetKind`, `hcForeground`, shell sets, the hcx >= 0.1.3 version check) with one `hcxNotify` returning a typed result `{ outcome: "delivered" | "not_started" | "unconfirmed" | "plain_shell" | "failed", detail }` instead of strings tested with `startsWith("notified")`. Keep the old `herdr agent prompt` route for the old herdr server unchanged.
3. Record the typed outcome, `route`, `agent` and `note` in status (`notify_outcome`, `notify_detail`) and show unconfirmed / not_started / plain_shell distinctly in `show` and `check` (check's notify line is "ok" only for delivered or unconfirmed; "FAIL" with the reason for the others). A tab-name `--notify` now works because hcx resolves tab names; validate `--notify` at `run` with a warning when hcx cannot find it (do not fail the run).
4. Heartbeats go through `hcx send --agent-only --no-footer --json --if idle` so a busy agent is skipped (a skipped heartbeat is not a failure and not retried); completion never uses `--if`. Check hcx's own --help for the exact `--if` semantics and what it prints when skipped.
5. Tests: a fake `hcx` stub on PATH for each outcome (as in the contract), heartbeat with `--if idle` argv, completion without it, missing/old hcx, tab-name notify, typed outcomes in status and check.
6. README: hcx 0.3.0 is required for notifications; remove the 0.1.3 baseline text.
7. Bump to 0.3.0, ISSUES rows "Fixed in 0.3.0".

## Rules
- Work only in /Users/budisantoso/Dev/bdsanxz/SWE/agent-shell. Read each file before editing; edit in place. English only. No secrets. No live sessions or real terminal messaging (stub hcx/hc/herdr). No commits, pushes, tags, installs.
- Run `bunx tsc --noEmit`, `bun test`, build twice (identical, report sha256), `git diff --stat`, and report the lines removed vs added in src/.
- Write the report to /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-as05.md then: `hcx send --no-footer Zytra "as05 done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-as05.md"`
