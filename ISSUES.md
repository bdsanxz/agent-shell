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
| 12 | 2026-10-31 | owner review | 0.2.4 | Notify delivery is never read: `delivered: false`/`null` from hcx becomes `notified`, kind detection is a drifted copy, and a tab-name `--notify` misses the live list so it falls back to tagged `hc send`. | Fixed in 0.3.0 |
| 13 | 2026-10-31 | owner review | 0.2.4 | Progress heartbeats type into a busy agent instead of skipping when it is not idle; completion must never use `--if`. | Fixed in 0.3.0 |
| 14 | 2026-10-31 | owner review | 0.2.4 | hcx is optional with a 0.1.3 baseline and an `hc send` fallback that can type into a plain shell; it should be required at 0.3.0 with a contract/capability check and typed notify outcomes. | Fixed in 0.3.0 |
| 15 | 2026-10-31 | owner review | 0.3.0 | Every command needs machine-readable `--json` output (single JSON document, snake_case fields, typed error kinds) so agents do not parse human prose; `--help` must document each shape. | Fixed in 0.4.0 |
| 16 | 2026-10-31 | owner review | 0.3.0 | `install.sh` lags behind `hcx/install.sh`: the token appears on the curl command line, there is no `shasum` fallback, `--from-source` only dies, and there is no `--force` symlink guard. | Fixed in 0.4.0 |
| 17 | 2026-10-31 | owner review | 0.4.0 | `kill` misses grandchildren: only the direct child and supervisor are signalled, so children of `sh -c '...'` survive. | Fixed in 0.5.0 |
| 18 | 2026-10-31 | owner review | 0.4.0 | Default heartbeats cost a turn every 2 minutes even with no new output; no back-off and no `--heartbeat-fixed`. | Fixed in 0.5.0 |
| 19 | 2026-10-31 | owner review | 0.4.0 | A dead supervisor leaves a job `running` forever with no `lost` state. | Fixed in 0.5.0 |
| 20 | 2026-10-31 | owner review | 0.4.0 | `tail`, `show` and heartbeat reads load the whole `output.log`; a multi-GB log costs unbounded memory. | Fixed in 0.5.0 |
| 21 | 2026-10-31 | owner review | 0.4.0 | Job directories and files are world-readable; state root has default modes. | Fixed in 0.5.0 |
| 22 | 2026-10-31 | owner review | 0.4.0 | Job output goes unsanitised into turns: `\r` progress bars, ANSI escapes and control bytes pass through. | Fixed in 0.5.0 |
| 23 | 2026-10-31 | lead review | 0.5.0 | `kill` signals `-pgid` when the leader is gone (`leaderMatches \|\| groupAlive`), so a reused leader PID can hit an unrelated group. | Fixed in 0.5.0 |
