# agent-shell

Fire-and-forget shell execution for AI agents: run in background, get one notify turn when done.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/bdsanxz/agent-shell/main/install.sh | sh
```

It downloads the release's `agent-shell.js` (one bundled file that runs with Bun, no
compile step), checks its SHA-256, and puts it in `~/.local/bin/agent-shell`.
`agent-shell` needs [Bun](https://bun.sh) on `PATH`.

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
background under a detached supervisor. While it runs, the supervisor sends one
progress notify turn every 2 minutes by default (`--heartbeat <duration>`
changes it; `--no-heartbeat`, `--heartbeat 0` and `off` disable it), each
carrying the last output line so you can tell stuck from working. When it
finishes, the supervisor records the job as done or failed first, then sends
one completion turn to the notify target (your own pane by default, or
`--notify`). A job that cannot start still sends the completion notify with
the start error, recorded in the job's `error` field. Notify turns go over the old herdr server
(`herdr agent prompt`) when it runs, else herdr-core via
`hcx send --agent-only --no-footer --json` (needs hcx 0.3.0 or newer;
hcx looks the kind up first and refuses a plain shell or unknown kind before
sending, and resolves tab names, so `--notify` takes an address or a tab
name). A confirmed send that starts no turn is recorded as `not_started`
(do not resend); an unconfirmed send (opencode TUI, `delivered: null`) is
recorded as `unconfirmed` and never resent. Progress notifies use
`--if idle`, so a busy agent is skipped instead of interrupted; completion
never uses `--if`. Nothing polls, nothing waits: notify turns are the only
wake-up. Read the output with `show` or `tail` (`--tail`/`--lines` need a
positive integer), and verify a finished job before using its result with
`check` (state, exit, output, completion and last progress notify, plus a
separate `success` line for the job's own outcome). `check` exits 0 only when
the records pass and the job succeeded (exit 0); its notify line is `ok`
only for `delivered` or `unconfirmed`, and a job with no notify target
reports `notify: n/a`, not a failure. `run --wait` exits with the job's exit
code (124 on timeout). `kill` refuses unless the job is running (exit 2) and
only signals the child when its start time still matches.

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
