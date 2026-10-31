# PLAN_04: agent-shell 0.2.4 - correctness fixes from the review

Source: review report at /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-review-peers-agentshell.md (Part 2, items 1, 2, 3, 5, 6, plus 13, 14 partly). Read that part first, then `README.md`, `ISSUES.md`, `src/*.ts`, `test/*.ts`.

Steps, each with tests that fail before the fix:
1. Add one ISSUES.md row per step (reporter "owner review", version 0.2.3, status "In progress (0.2.4)").
2. `--no-heartbeat`, `--heartbeat 0` and `off` really disable heartbeats: treat a stored `null` as off, not as the default, at all three places (`store.ts`, `commands.ts` twice). Test with a job that outlives the default interval (inject a short default for the test).
3. `kill` refuses unless the job state is `running` (clear message, exit 2, result untouched). Record the child's start time at spawn and verify the pid still matches before signalling.
4. A job that cannot start (missing executable, bad `--cwd`) sends the completion notify with the start error, stores it in a separate `error` field, and `run` validates `--cwd` and the executable up front (exit 2, no job created).
5. Write the final `done`/`failed` status BEFORE the completion notify (notify result updated afterwards); add 8 s timeouts to every notify subprocess (`spawnSync`).
6. Exit codes: `check` returns 1 when the job exited nonzero or failed (keep record checks separate and print a `success` line); `run --wait` returns the job's exit code and 124 on timeout; "no notify target" is "n/a", not a failure.
7. Atomic status/meta writes (write temp file, rename); at `commands.ts:620` distinguish an unreadable status from "not running" so the supervisor does not abandon the child.
8. `--tail abc` (non-integer) is refused with exit 2.
9. Bump `package.json` to 0.2.4, update README, ISSUES rows to "Fixed in 0.2.4".
Do NOT do heartbeat back-off, process groups, JSON output, log chunk reading or hcx migration: later plans.

## Rules
- Work only in /Users/budisantoso/Dev/bdsanxz/SWE/agent-shell. Read each file before editing; edit in place, never overwrite wholesale. English only. No secrets. No live agent sessions, no real terminal messaging (stub hc/hcx as existing tests do). No commits, pushes, tags, installs: the lead does them.
- Run `bunx tsc --noEmit`, `bun test`, the build twice (identical bytes, report sha256), finish with `git diff --stat`.
- Write a report (changes per step, commands and output, counts, sha256, open questions) to /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-as04.md, then run: `hcx send --no-footer Zytra "as04 done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-as04.md"`
