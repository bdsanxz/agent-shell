# PLAN_07: agent-shell 0.5.0 - resilience for long jobs

Source: review /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-review-peers-agentshell.md (agent-shell items: process groups for kill, heartbeat back-off, supervisor-death detection, bounded log reads, permissions, output sanitising). Read it, then README.md, ISSUES.md, src/ (all files), test/run.test.ts, test/json.test.ts.

## Items
1. **Process groups for kill.** The supervisor starts the job as the leader of its own process group (detached/setsid) and `kill` signals the whole group (SIGTERM, then SIGKILL after the grace period), so children of `sh -c '...'` die too. Keep the existing start-time guard against PID reuse (verify the leader's start time before signalling the group). Record the pgid in meta/status. A job whose leader already exited but whose group still has members is still killed. Test with a job that spawns a background child (`sh -c 'sleep 300 & wait'`) and assert no process of that group survives.
2. **Heartbeat back-off.** Progress notifies are skipped when the last output line is unchanged since the previous heartbeat for N consecutive beats; interval doubles after each unchanged beat up to a cap (default 30m, env AGENT_SHELL_HEARTBEAT_MAX_MS for tests), and resets to the base interval on any new output. An explicit `--heartbeat <duration>` is the base. `--heartbeat-fixed` (new flag) disables back-off. Show the current interval in `show` (text and --json: `heartbeat_current_ms`). Skipped-for-idle and back-off skips are not failures.
3. **Supervisor-death detection ("lost").** If the supervisor process dies without writing a final status (kill -9, reboot), `show`, `list`, `check` and `clean` detect it: status says running but the supervisor PID is gone or its start time differs. Report state `lost` (exit_code null, partial output readable), never "running forever". `check` fails a lost job (exit 1) with the reason; `kill` on a lost job removes any orphan group members and marks it lost; `clean` removes lost jobs like finished ones. No completion notify is invented for a lost job. Add `lost` to --json state values and help.
4. **Bounded log reads.** `tail`, `show` and heartbeat last-line never read an entire output.log: read only the last chunk (seek from the end, e.g. 256 KiB max, enough lines for --tail), so a multi-GB log costs constant memory. State when output was truncated at the read cap. Test with a log larger than the cap.
5. **Permissions.** Job directories 0700 and files 0600 (state root too), created that way; existing roots are left as they are but new jobs follow. Test with fs.statSync modes.
6. **Output sanitising.** Text shown by `show`/`tail`/`check` and the heartbeat last line collapses carriage-return progress bars (keep text after the last \r on a line), strips ANSI escape sequences (CSI/OSC) and other control characters except \n and \t. The stored output.log stays raw. --json fields hold the sanitised text and a `raw_available: true` hint is not needed. Test with an ANSI+\r fixture.

## Steps
1. ISSUES.md rows (reporter "owner review", version 0.4.0, "In progress (0.5.0)") one per item.
2. Implement items in the order above; tests for each (stub tools only; real child processes are fine for kill and lost tests, using sleep, and must be cleaned up even when a test fails).
3. README and every affected --help (text and JSON shape). Bump package.json to 0.5.0, ISSUES rows "Fixed in 0.5.0".

## Rules
- Work only in /Users/budisantoso/Dev/bdsanxz/SWE/agent-shell. Read each file before editing; edit in place, never overwrite wholesale. English only. No secrets. No live sessions or real terminal messaging (stub hcx/hc/herdr). No commits, pushes, tags, installs.
- Human output stays byte-identical except where an item says otherwise (new state `lost`, back-off line in show, sanitising).
- Run `bunx tsc --noEmit`, `bun test` (run it twice; report any flaky test by name), build twice (identical, report sha256), `git diff --stat`, and lines removed vs added in src/. Make sure no test leaves stray processes (check `ps` for sleep leftovers).
- Write the report to /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-as07.md and end your last message with its path (terminal messaging may be blocked in your sandbox; that is fine).

## Addendum: harden `kill` against PID/group reuse (lead review)

Problem: in `kill`, the group is signalled when `leaderMatches || groupAlive(pgid)`. If the leader is gone and its PID was reused by an unrelated process that became its own group leader, `groupAlive(pgid)` is true and `kill -pgid` hits that unrelated group.

Fix: signal a process group ONLY when the leader's start time still matches (`leaderMatches`). When the leader no longer matches (gone or reused), never signal `-pgid`; instead find members that are provably ours and signal only those: record each descendant is not possible, so use this rule: if the leader does not match, do not signal any group; mark the job `lost` (or finished if status says so), and print a hint that orphan children may remain (`pgid <n> not signalled: its leader is gone`). Apply the same rule to `lost` handling and `clean`. Keep the SIGTERM -> grace -> SIGKILL flow for the matching case.

Tests: (1) leader alive and matching: group incl. a background child dies (existing test). (2) leader killed externally with SIGKILL while its child survives: `kill` does not signal the group, reports the hint, state becomes `lost`, and an unrelated process in a different group is untouched. (3) a stub that simulates a reused PID (meta child_lstart mismatch) never calls `process.kill` with a negative pid (spy or wrapper). Update README/help/ISSUES (new row, Fixed in 0.5.0). Re-run tsc, bun test twice, build twice; update the report file.

Report to the lead with: hcx send --no-footer t3 "as07 done (kill hardening), report: <report path>" (raw address t3, no --agent-only/--json). No commits, pushes, tags, installs.
