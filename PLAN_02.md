# PLAN_02: agent-shell 0.2.3 - send untagged to opencode agents

## Finding (investigated live on herdr-core, hc 0.1.15)

`hc ls --json` and `hc get <addr>` report `agent: "zsh"` for a tab that runs `opencode`, because the tab is a login shell wrapper (`argv: ["/bin/zsh","-lic","\"$@\"; exec \"$0\" -li","/bin/zsh","opencode"]`) and `hc` has no opencode classifier. muse, claude-code and pi are classified correctly (`agent: "muse"`, `"claude-code"`, `"pi"`). `hc get <addr>` (address only; a name often returns not_found) also has `foreground: {"argv":[...],"name":"<program>","pid":N}`:

- opencode tab: `agent: zsh`, `foreground.name: "opencode"`, `foreground.argv: ["opencode"]`.
- claude-code tab: `foreground.name` is a version string such as `"2.1.314"` (so the name alone is not a reliable kind, but it is not a shell).
- plain shell tab (idle prompt): `agent: zsh`, `foreground.name: "zsh"`.

Consequence: tools that treat `agent == zsh` as a plain shell (peers `SHELLS`, agent-shell `SHELLS`, hcx send route/agent field) wrongly send opencode agents the tagged `hc send` (or, for hcx, report `agent: zsh`).

## Shared rule (implement identically, in each repo own code)

`effectiveKind(addr)`: take `agent` from `hc ls --json`. If it is NOT in the shell set (zsh, sh, bash, fish, dash, ksh, nu, pwsh) use it. If it IS a shell kind, call `hc get <addr>` and read `foreground.name` (basename, lower case): if it is empty or is itself in the shell set, the target is a plain shell (keep shell kind); otherwise return that foreground program name (for example `opencode`) as the kind. Any failure of `hc get` or unparseable JSON keeps the shell kind (safe default: tagged `hc send`). Only the address form is passed to `hc get` (resolve names to addresses through `hc ls --json` first).

## Steps

1. Read `src/notify.ts` (`SHELLS`, `hcTargetKind`, `hcRoute`), tests, README, `ISSUES.md`. Add `ISSUES.md` row 3 (reporter "owner review", version 0.2.2, "A notify to an opencode agent is sent tagged because hc lists the tab as zsh", status "In progress (0.2.3)").
2. Make `hcTargetKind` apply the shared rule (an opencode tab returns `opencode`). The notify note keeps naming the route.
3. Tests as in the Rules.
4. Bump to 0.2.3; README only where it describes the shell exception; ISSUES row -> "Fixed in 0.2.3".
5. `bunx tsc --noEmit`, `bun test`, `bun run build` twice (identical sha256).

## Rules for the worker

- Work only in this repo. Read every file before changing it. Edit in place; never overwrite a file wholesale.
- All text in the codebase is English. No secrets anywhere. Do not print environment values.
- Tests stub `hc`/`hcx` on PATH as the existing tests do; add cases: real shell (foreground zsh) stays shell, opencode (agent zsh, foreground opencode) becomes opencode, claude-code with a version-string foreground stays claude-code, `hc get` failing keeps shell, unparseable JSON keeps shell.
- No live agent sessions, no commits, pushes, tags, releases or installs: the lead does those.
- Finish with `git diff --stat`.

## Report

Write the report to `/private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan02-agent-shell.md`, then run: `hcx send Zytra "plan02-agent-shell done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan02-agent-shell.md"`
