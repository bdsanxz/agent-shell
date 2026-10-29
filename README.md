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

`run` returns at once with a job id and exits: the command keeps running in
background under a detached supervisor. While it runs, the supervisor sends one
progress `herdr agent prompt` turn every 2 minutes by default (`--heartbeat
<duration>` changes it, `--no-heartbeat` disables it), each carrying the last
output line so you can tell stuck from working. When it finishes, the supervisor
sends one completion turn to the notify target (your own pane by default, or
`--notify`) and records the job as done or failed. Nothing polls, nothing waits:
notify turns are the only wake-up. Read the output with `show` or `tail`, and
verify a finished job before using its result with `check` (state, exit, output
and notify).

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
