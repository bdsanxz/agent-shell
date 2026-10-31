# agent-shell

Fire-and-forget shell execution for AI agents: run in background, get one notify turn when done.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/bdsanxz/agent-shell/main/install.sh | sh
```

It downloads the release's `agent-shell.js` (one bundled file that runs with Bun, no
compile step), checks its SHA-256 against the release's `agent-shell.js.sha256`,
and puts it in `~/.local/bin/agent-shell`.
`agent-shell` needs [Bun](https://bun.sh) on `PATH`.

```sh
install.sh [--version vX.Y.Z] [--dir DIR] [--force]
```

`--version` picks the release (default `latest`, env `AGENT_SHELL_VERSION`);
`--dir` picks the install directory (default `~/.local/bin`, env
`AGENT_SHELL_INSTALL_DIR`); `--force` replaces a symlinked target (a local
dev install is left alone without it). The token for a private repository
never appears on a command line: the public URL is tried first, and only
after a 404 is `GITHUB_TOKEN` (else `gh auth token`) passed through a curl
stdin config. The checksum uses `sha256sum`, else `shasum -a 256`.

## Use

```sh
agent-shell run --name build -- bun test
agent-shell list
agent-shell show sh-1234-5678
agent-shell tail sh-1234-5678 --lines 50
agent-shell check sh-1234-5678
agent-shell kill sh-1234-5678
agent-shell clean --older-than 7d
```

`run` validates `--cwd` and the executable up front (exit 2, no job created),
then returns at once with a job id and exits: the command keeps running in
background under a detached supervisor as the leader of its own process group
(pgid recorded in meta), so `kill` stops grandchildren too. Each job is owned
by `$AGENT_SHELL_OWNER` else `$HC_TERMINAL_ID` else `$HERDR_PANE_ID` else
ownerless (pre-0.6.0 jobs have no owner); `list` and `clean` default to your
own jobs, `--all` means every job on the machine. While it runs, the
supervisor sends one progress notify turn every 2 minutes by default
(`--heartbeat <duration>` changes the base; `--no-heartbeat`,
`--heartbeat 0` and `off` disable it), each carrying the last output line so
you can tell stuck from working. Every progress turn ends with the next
expected beat (`Next progress in ~10s`) using the current (possibly
backed-off) interval. When the last line stops changing, notifies back off:
the interval doubles after each unchanged beat up to 30m
(env `AGENT_SHELL_HEARTBEAT_MAX_MS` for tests) and resets on new output;
`--heartbeat-fixed` disables back-off. Heartbeats read the target status via
`hcx ls --json` (5 s timeout, one call per heartbeat) and defer when it is
`working` or `blocked`: the beat is re-checked every 3 s
(env `AGENT_SHELL_BUSY_POLL_MS` for tests, minimum 200 ms) and sent once idle
with the latest line, ending at 80% of the interval; a still-busy beat counts
as `heartbeats_skipped_busy` as before, a sent-after-wait beat also counts as
`heartbeats_deferred`, and a job finishing mid-wait drops the pending beat.
A back-off-suppressed beat is never deferred. Busy (at deadline) and back-off
skips are not failures. Counters show in `show` and `check`
(`heartbeats sent S (deferred D), skipped K (backoff B, busy U), failed F`)
with `heartbeats` as an alias of sent (old files default `deferred` to 0). The current interval shows
in `show` (`heartbeat_current ...` and `--json heartbeat_current_ms`). When
it finishes, the supervisor records the job as done or failed first, then
sends one completion turn to the notify target (your own pane by default, or
`--notify`). If the supervisor dies without writing a final status, `show`,
`list`, `check` and `clean` report state `lost` (exit null, partial output
readable) instead of running forever; `check` fails it (exit 1), `kill` on
lost clears orphans and keeps `lost`, `clean` removes lost jobs like finished
ones, and no completion notify is invented. A job that cannot start still
sends the completion notify with the start error, recorded in the job's
`error` field. Notify turns go over the old herdr server
(`herdr agent prompt`) when it runs, else herdr-core via
`hcx send --agent-only --no-footer --json` (needs hcx 0.3.0 or newer;
hcx looks the kind up first and refuses a plain shell or unknown kind before
sending, and resolves tab names, so `--notify` takes an address or a tab
name). The old herdr route is skipped silently when no old server runs;
failure details name only routes actually tried. A confirmed send that starts
no turn is recorded as `not_started` (do not resend); an unconfirmed send
(opencode TUI, `delivered: null`) or a timed-out completion send (exit null /
kind timeout, 30 s timeout, heartbeat 10 s) is recorded as `unconfirmed`
(`delivery not verified`) and never resent. Completion sends unconditionally
and never uses `--if idle`. Nothing polls, nothing waits: notify turns are
the only wake-up. Read the output with `show` or `tail` (`--tail`/`--lines`
need a positive integer): both read only the last 256 KiB (truncated reads
are marked) and sanitise the text (CR progress bars collapsed, ANSI and
control bytes stripped; the stored `output.log` stays raw). `command_string`
is POSIX shell-quoted, so copy-paste reruns the same command; `command`
stays the raw argv. Verify a finished job before using its result with
`check` (state, exit, output, completion and last progress notify, plus a
separate `success` line for the job's own outcome). `check` exits 0 only when
the records pass and the job succeeded (exit 0); its notify line is `ok`
only for `delivered` (`ok notify: delivered: ...`) or `unconfirmed`
(`ok notify: unconfirmed (delivery not verified): ...`), and a job with no
notify target reports `notify: n/a`, not a failure.
`run --wait` exits with the job's exit code (124 on timeout). `kill` refuses
unless the job is running or lost (exit 2) and signals the group only when
the leader's start time still matches; when the leader is gone or reused it
never signals `-pgid` and instead marks the job `lost` with the hint
`pgid <n> not signalled: its leader is gone` (orphans may remain).
Job directories are 0700 and files 0600.

Every command takes `--json`: stdout is exactly one JSON document (no table,
no prose, no color), with stable `snake_case` fields covering the human view
(ids, states, exit codes, ISO timestamps, counts, notify outcome and hints).
`list --json` keeps its JSON-lines shape (one object per line). Errors with
`--json` print `{"error":{"kind":...,"message":...,"hint":...}}` on stdout
with the same exit codes; human stderr appears only without `--json`. Kinds
are `usage`, `not_found`, `running`, `not_running` and `failed`. Shapes:

- `run --json`: `{"id","name","command","command_string","cwd","created_ms",
  "created_at","notify_target","notify_warning","heartbeat_ms",
  "heartbeat_fixed","heartbeat_current_ms","heartbeat","read_hint","wait"}`
  (`wait` is null, or `{"wait_ms","timed_out","state","exit_code","output"}`).
  `command_string` is POSIX shell-quoted.
- `list --json`: lines of `{"id","name","state","exit","exit_code","cmd",
  "command","heartbeats","created_ms","created_at","done_ms","done_at",
  "duration_ms"}` (`state` includes `lost`; `list --all --json` adds `owner`).
- `show --json`: the job plus `notify_*`, `heartbeat_ms`, `heartbeat_fixed`,
  `heartbeat_current_ms`, `heartbeats`, `heartbeats_sent`, `heartbeats_deferred`,
  `heartbeats_skipped_backoff`, `heartbeats_skipped_busy`, `heartbeats_failed`,
  `output` (sanitised), `lines`, `line_count`, `truncated`, `pgid` and ISO
  dates (`state` includes `lost`).
- `tail --json`: `{"id","lines_requested","line_count","output","lines",
  "truncated"}` (output sanitised).
- `check --json`: `{"id","state","exit_code","checks","pass","total",
  "success",...}` with `notify_outcome`, `progress_notify`, `heartbeats_*`
  and `truncated` (`state` includes `lost`).
- `kill --json`: `{"id","state","signalled","detail","done_ms","done_at"}`
  (`state` is `killed` or `lost`).
- `clean --json`: `{"removed","removed_ids","skipped_other_owner"}` (removes
  finished and `lost`; default is your own jobs, `--all` is every job).

Run `agent-shell <command> --help` before you first use a command.

## Develop

```sh
bun install
bunx tsc --noEmit
bun test
bun run build   # writes dist/agent-shell.js + dist/agent-shell.js.sha256 (bundling, not compile)
```

`dist/` holds the bundled release asset. Never edit it by hand; rebuild it.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
