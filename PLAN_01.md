# PLAN_01: agent-shell 0.2.2 - untagged notifications

Goal: the notify turns that `agent-shell` sends (progress every 2 minutes, completion) reach the agent without the `<hc from="...">` tag, the same way `peers` and the roster launcher already do.

## Background

- `src/notify.ts` (line ~60) sends with `hc send <target> <text>`. `hc` wraps it in a `<hc from="tNN">...</hc>` tag.
- `hcx send <tab|tNN> "text"` sends the same text untagged and appends a sender footer (`— from <name> · reply: hcx send <name> "..."`). It exists on this machine (`hcx --help`).
- `peers` (`/Users/budisantoso/Dev/bdsanxz/SWE/peers/src/herdr.ts`, around lines 206-235) is the reference for the pattern: use `hcx send` when it exists and the target is an agent; a failed untagged send is retried the old way; a plain shell target (`zsh`, `sh`, `bash`) always gets the old tagged send, because it would run the footer as a command.

## Steps

1. Create `ISSUES.md` in the repo root (table: `#`, reported, reporter, version, issue, status; see `/Users/budisantoso/Dev/bdsanxz/SWE/peers/ISSUES.md` for the format). Row 1: "Notify turns carry the `<hc from>` tag (0.2.1)", reporter "owner review", status "In progress (0.2.2)". Row 2: "A failed notify is easy to miss", status "In progress (0.2.2)" if you do step 4, else "Open".
2. Read `src/notify.ts`, `src/commands.ts`, the tests under `test/`, and the peers reference above.
3. In `src/notify.ts` send with `hcx send <target> <text>` when `hcx` is on PATH and the target is not a plain shell; on a non-zero exit retry with `hc send` and say so in the returned note; without `hcx` use `hc send` as today. The returned note names the route (`via hcx send`, `via hc send (hcx failed: ...)`). Keep the herdr-pane route unchanged.
4. Make a failed notify visible: `agent-shell show <id>` and `check <id>` must print the notify result of the last progress and the completion notify (they already keep some state; read how). If this needs a state format change, keep old job directories readable. Skip this step and say why if it would be a large change.
5. Tests: stub `hcx` and `hc` on PATH like the existing tests do. Cases: hcx present (text arrives untagged route), hcx absent, hcx failing (falls back, note says so), plain-shell target (tagged route, hcx not called), and the step 4 output if done.
6. Bump `package.json` to `0.2.2`; update README (notify section) and `--help` text where they describe the notify route.
7. Run `bunx tsc --noEmit`, `bun test`, `bun run build` twice (identical sha256 of `dist/`'s output file).

## Rules for the worker

- Work only in `/Users/budisantoso/Dev/bdsanxz/SWE/agent-shell`. Read every file before changing it. Edit files in place; never overwrite a file wholesale.
- All text in the codebase (strings, comments, help, README, tests) is English.
- No secrets in code, tests, logs or the report. Do not print environment values.
- No live tests that start real agent sessions. No commits, pushes, tags, releases or installs: the lead does those.
- Finish with `git diff --stat`.

## Report

Write the report (what changed, commands run and their output as printed, test counts, sha256, open questions) to `/private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan01-agent-shell.md`, then run:
`hcx send Zytra "plan01-agent-shell done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan01-agent-shell.md"`
