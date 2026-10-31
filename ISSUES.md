# Issues

Every issue reported against `agent-shell` is logged here first, then worked. Newest last.

| # | Reported | Reporter | Version | Issue | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-31 | owner review | 0.2.1 | Notify turns carry the `<hc from>` tag. | Fixed in 0.2.2 |
| 2 | 2026-10-31 | owner review | 0.2.1 | A failed notify is easy to miss. | Fixed in 0.2.2 |
| 3 | 2026-10-31 | owner review | 0.2.2 | A notify to an opencode agent is sent tagged because hc lists the tab as zsh. | Fixed in 0.2.3 |
| 4 | 2026-10-31 | owner review | 0.2.2 | Notifications carry a sender footer naming the receiver as the sender. | Fixed in 0.2.3 |
| 5 | 2026-10-31 | owner review | 0.2.3 | `--no-heartbeat`, `--heartbeat 0` and `off` do nothing: a stored `null` is read back as the 2-minute default, so long jobs send unwanted progress turns. | Fixed in 0.2.4 |
| 6 | 2026-10-31 | owner review | 0.2.3 | `kill` on a finished job signals stale PIDs (PID reuse can kill an unrelated process) and rewrites the recorded result. | Fixed in 0.2.4 |
| 7 | 2026-10-31 | owner review | 0.2.3 | A job that cannot start (missing executable, bad `--cwd`) sends no completion notify and has no separate error field; `run` does not validate up front. | Fixed in 0.2.4 |
| 8 | 2026-10-31 | owner review | 0.2.3 | The completion notify is sent before the `done`/`failed` result is recorded, and notify subprocesses have no timeouts. | Fixed in 0.2.4 |
| 9 | 2026-10-31 | owner review | 0.2.3 | Exit codes mislead: `check` returns 0 for a failed job, `run --wait` always returns 0 (even on timeout), and "no notify target" fails the check. | Fixed in 0.2.4 |
| 10 | 2026-10-31 | owner review | 0.2.3 | Non-atomic status/meta writes can expose an empty file; the supervisor abandons the child when the status is unreadable. | Fixed in 0.2.4 |
| 11 | 2026-10-31 | owner review | 0.2.3 | `--tail abc` (non-integer) silently falls back to 30 instead of exiting 2. | Fixed in 0.2.4 |
