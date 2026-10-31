// One function per command, plus the help texts. `dispatch` routes them.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError, bool, parseArgs, str, unknownFlags, type Parsed } from "./args.ts";
import { checkNotifyTarget, currentOwner, defaultTarget, notify, type NotifyResult } from "./notify.ts";
import {
  callerOwner,
  defaultHeartbeatMs,
  freshId,
  heartbeatMaxMs,
  isOwnJob,
  jobDir,
  jobsDir,
  nowMs,
  readMeta,
  readStatus,
  readTailDetailed,
  sanitiseOutput,
  shellQuote,
  stateRoot,
  writeMeta,
  writeStatus,
  type Meta,
  type Status,
} from "./store.ts";

export const HELP: Record<string, string> = {
  "": `agent-shell — fire-and-forget shell execution for AI agents (run in background, get progress and done notify turns)

Usage: agent-shell <command> [options] [--help]

Commands:
  run        Start a command in background and return its job id at once
  list       List jobs (running first, then newest done)
  show       Show one job: status plus the tail of its output
  tail       Print the tail of one job's output
  check      Verify one finished job: state, exit, output and notify
  kill       Stop a running job (process group SIGTERM, then SIGKILL)
  clean      Remove finished and lost job directories

How it works:
  1. agent-shell run --name build -- ./scripts/test.sh
     returns at once with a job id; the command keeps running in background
     as the leader of its own process group, so kill stops grandchildren too.
  2. While it runs, your session gets one progress notify turn every 2 minutes
     (by default) with the last output line, so you can tell stuck from working.
     Disable with --no-heartbeat, change with --heartbeat <duration>.
     When the output stops changing, notifies back off (doubling to 30m max,
     env AGENT_SHELL_HEARTBEAT_MAX_MS; --heartbeat-fixed disables back-off);
     the current interval shows in show. A dead supervisor reports state lost.
  3. When it finishes, your session gets one completion notify turn:
     shell job 'build' done (exit 0). Read with: agent-shell show <id>
  4. Read it with \`agent-shell show <id>\` or \`agent-shell tail <id>\`.
     Nobody polls: notify turns are the only wake-up. Jobs are owned
     ($AGENT_SHELL_OWNER else $HC_TERMINAL_ID else $HERDR_PANE_ID else
     ownerless); list/clean default to your own jobs (--all for every job).
  Notify turns go over the old herdr server (\`herdr agent prompt\`) when it runs,
  else herdr-core via \`hcx send --agent-only --no-footer --json\` (needs
  hcx 0.3.0 or newer; hcx refuses a plain shell or unknown kind before sending).
  Heartbeats read the target via hcx ls --json and skip working/blocked
  (busy skips are not failures); completion sends unconditionally.
  The herdr route is skipped silently when no old server runs.

Environment:
  AGENT_SHELL_HOME   state root instead of ~/.local/cache/agent-shell
  XDG_CACHE_HOME     cache root holding agent-shell/ when AGENT_SHELL_HOME is unset
  AGENT_SHELL_HEARTBEAT_MAX_MS   heartbeat back-off cap in ms (default 1800000)
  AGENT_SHELL_DEFAULT_HEARTBEAT_MS   default heartbeat in ms (tests only)
  AGENT_SHELL_OWNER   owner override instead of $HC_TERMINAL_ID / $HERDR_PANE_ID (tests, scripts)

Exit codes:
  0  success
  2  usage error or failed command; the error line says why

Examples:
  agent-shell run --name build -- bun test
  agent-shell run --notify framesmith-lead -- sh -c 'sleep 30; echo done'
  agent-shell list
  agent-shell show sh-1234-5678`,
  run: `agent-shell run — start a command in background, return its job id at once

Usage: agent-shell run [--name <name>] [--notify <target>] [--cwd <dir>] [--heartbeat <duration> | --no-heartbeat] [--heartbeat-fixed] [--wait <duration>] [--json] -- <command...>

  --name <name>      Short job name (kebab-case, e.g. build, test-e2e). Default: job.
  --notify <target>  Who gets the notify turns: a herdr agent name, pane id, hc terminal
                     or tab name (hcx resolves tab names). Notified over the old herdr
                     server when it runs, else via \`hcx send --agent-only --no-footer
                     --json\` (needs hcx 0.3.0 or newer). Default: your own pane
                     ($HERDR_PANE_ID) or terminal ($HC_TERMINAL_ID).
  --cwd <dir>        Directory to run in. Default: current directory.
  --heartbeat <d>    Base progress notify interval with the last output line (e.g. 30s, 2m, 5m).
                     Default: 2m. Minimum: 1s. Use 0 or off to disable. When the last
                     output line is unchanged, the interval doubles up to 30m
                     (env AGENT_SHELL_HEARTBEAT_MAX_MS) and resets on new output.
  --no-heartbeat     No progress notifies; only the completion notify is sent.
  --heartbeat-fixed  Disable back-off; keep the base interval even when idle.
  --wait <d>         Wait up to <d> for the job to finish (e.g. 5s, 2m), print its
                     output and exit status, then exit with the job's exit code
                     (124 on timeout). Default: do not wait.
  <command...>       The command to run (after \`--\`); use \`sh -c '...'\` for shell features.
                     It starts as the leader of its own process group (pgid in meta).

Prints the job id and the notify target, then exits at once unless --wait is given.
Job directories are 0700 and files 0600. The job is owned by
$AGENT_SHELL_OWNER else $HC_TERMINAL_ID else $HERDR_PANE_ID else ownerless;
list/clean default to your own jobs (--all for every job).

With --json, stdout is one JSON object (no table, no prose):
{"id","name","command","command_string","cwd","created_ms","created_at",
"notify_target","notify_warning","heartbeat_ms","heartbeat_fixed",
"heartbeat_current_ms","read_hint","wait"}
"wait" is null without --wait, else {"wait_ms","timed_out","state",
"exit_code","output"}. command_string is POSIX shell-quoted.
Heartbeats read the target via hcx ls --json and skip working/blocked;
completion sends unconditionally (30s timeout, heartbeat 10s).`,
  list: `agent-shell list — list jobs (running first, then newest done)

Usage: agent-shell list [--all] [--json]

  --all    Every job on the machine, with an OWNER column / owner field.
           Default: only your own jobs (same owner: $AGENT_SHELL_OWNER else
           $HC_TERMINAL_ID else $HERDR_PANE_ID else ownerless; pre-0.6.0 jobs
           have no owner and need --all). Without --all at most 20 are shown.
  --json   Machine-readable JSON lines instead of the table (one object per line).

States are running, done, failed, killed and lost (lost: the supervisor died
without writing a final status; its partial output stays readable).

With --json, stdout is JSON lines (this command keeps that shape, as documented):
{"id","name","state","exit","exit_code","cmd","command","heartbeats",
"created_ms","created_at","done_ms","done_at","duration_ms"}
(list --all adds "owner").`,
  show: `agent-shell show — show one job: status plus the tail of its output

Usage: agent-shell show <id> [--tail <n>] [--json]

  --tail <n>   Output lines to include. Default: 30.

States are running, done, failed, killed and lost. Output is sanitised
(CR progress bars collapsed, ANSI and control bytes stripped; the stored
log stays raw) and bounded to the last 256 KiB (truncated reads are marked).

With --json, stdout is one JSON object (no prose):
{"id","name","command","command_string","cwd","created_ms","created_at",
"state","exit_code","duration_ms","done_ms","done_at","error",
"notify_detail","notify_outcome","notify_route","notify_agent","notify_note",
"heartbeat_ms","heartbeat_fixed","heartbeat_current_ms","heartbeats",
"heartbeats_sent","heartbeats_skipped_backoff","heartbeats_skipped_busy",
"heartbeats_failed","last_heartbeat_ms","last_heartbeat_at",
"last_heartbeat_detail","tail_lines_requested","output","lines","line_count",
"truncated","pgid"}.
command_string is POSIX shell-quoted (copy-paste reruns the same command).
Heartbeats print as: heartbeats sent S, skipped K (backoff B, busy U), failed F.`,
  tail: `agent-shell tail — print the tail of one job's output

Usage: agent-shell tail <id> [--lines <n>] [--json]

  --lines <n>   Lines to print. Default: 50.

Output is sanitised (CR collapsed, ANSI stripped; the stored log stays raw)
and bounded to the last 256 KiB (truncated reads are marked).

With --json, stdout is one JSON object (no prose):
{"id","lines_requested","line_count","output","lines","truncated"}.`,
  check: `agent-shell check — verify one finished job before using its result

Usage: agent-shell check <id> [--json]

Prints one line per record check with its concrete value, then a summary
line, then a success line (the job's own outcome, separate from the records):

  ok finished: state is done
  ok exit: 0
  ok output: 12 lines
  ok notify: notified w1:p1
  check sh-1234-5678: 4/4 pass
  ok success: exit 0

Exit 0 only when all four record checks pass and the job succeeded
(state done, exit 0); 1 when any record check fails or the job did not
succeed; 2 when the job is unknown or still running. A killed or lost job
fails the finished check: its output is partial and it never got a completion
notify (lost means the supervisor died; kill on lost only clears orphans).
A job with no notify target prints "ok notify: n/a" (not a failure).
Output shown is sanitised and bounded to the last 256 KiB.

When progress notifies were sent, the last one prints as \`progress notify: ...\`
after the notify line. It is informational and does not change the pass count.

With --json, stdout is one JSON object (no prose) with the same exit codes:
{"id","state","exit_code","output_lines","output_ok","output_detail",
"notify_detail","notify_outcome","notify_route","notify_agent","notify_note",
"notify_ok","progress_notify","heartbeats","heartbeats_sent",
"heartbeats_skipped_backoff","heartbeats_skipped_busy","heartbeats_failed",
"checks","pass","total","success","success_detail"}.
The notify line is ok only for delivered or unconfirmed; unconfirmed prints
as "ok notify: unconfirmed (delivery not verified)". A timed-out completion
(exit null / kind timeout) is unconfirmed, not failed (completion 30s,
heartbeat 10s timeouts).`,
  kill: `agent-shell kill — stop a running job (process group SIGTERM, then SIGKILL)

Usage: agent-shell kill <id> [--json]

Refuses with exit 2 unless the job state is running or lost, leaving a finished
job's result untouched. The job runs as its own process group: kill signals
the whole group (SIGTERM, then SIGKILL), so grandchildren of sh -c die too,
but ONLY when the leader's process start time still matches the recorded
start (no PID/group-reuse kill). When the leader is gone or reused, no
negative-pid signal is ever sent; the job is marked lost with the hint
"pgid <n> not signalled: its leader is gone" (orphans may remain).
Kill on a lost job clears orphans only when the leader still matches.

A killed job gets no completion notify; its partial output stays readable.

With --json, stdout is one JSON object (no prose):
{"id","state","signalled","detail","done_ms","done_at"}.`,
  clean: `agent-shell clean — remove finished and lost job directories

Usage: agent-shell clean [--older-than <duration>] [--all] [--json]

  --older-than <d>   Only remove jobs finished this long ago or more (e.g. 24h, 7d).
                     Default: remove all finished and lost jobs. Running jobs are never removed.
  --all              Every job on the machine. Default: only your own jobs
                     (same owner; pre-0.6.0 jobs need --all).

With --json, stdout is one JSON object (no prose):
{"removed","removed_ids","skipped_other_owner"}.`,
  supervise: `agent-shell supervise — internal: supervise one job to completion, then notify

Usage: agent-shell supervise <id>

Not for agents to call: \`run\` starts this detached by itself.`,
};

export async function dispatch(cmd: string, argv: string[]): Promise<number> {
  switch (cmd) {
    case "run":
      return cmdRun(argv);
    case "list":
      return cmdList(argv);
    case "show":
      return cmdShow(argv);
    case "tail":
      return cmdTail(argv);
    case "check":
      return cmdCheck(argv);
    case "kill":
      return cmdKill(argv);
    case "clean":
      return cmdClean(argv);
    case "supervise":
      return cmdSupervise(argv);
    default:
      throw new UsageError(`unknown command "${cmd}"`, "usage", "run agent-shell --help for the command list");
  }
}

function allJobs(root: string): { meta: Meta; status: Status | null }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(jobsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { meta: Meta; status: Status | null }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = readMeta(path.join(jobsDir(root), e.name));
    if (meta) out.push({ meta, status: readStatus(path.join(jobsDir(root), e.name)) });
  }
  const rank = (meta: Meta, status: Status | null) => (effectiveState(meta, status) === "running" ? 0 : 1);
  out.sort((a, b) => rank(a.meta, a.status) - rank(b.meta, b.status) || b.meta.created_ms - a.meta.created_ms);
  return out;
}

function wantsJson(p: Parsed): boolean {
  return p.flags.has("json");
}

function iso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

function printJson(obj: unknown): void {
  console.log(JSON.stringify(obj));
}

/** True when a running job's supervisor is gone or reused: the job is lost. */
function isLost(meta: Meta, status: Status | null): boolean {
  if ((status?.state ?? "running") !== "running") return false;
  const sup = meta.supervisor_pid;
  if (sup === null || sup === undefined) return false;
  return !pidMatches(sup, meta.supervisor_lstart);
}

/** Effective display state: "lost" when the supervisor died mid-run. */
function effectiveState(meta: Meta, status: Status | null): string {
  if (isLost(meta, status)) return "lost";
  return status?.state ?? "running";
}

/** True when a process group still has members (`kill(-pgid, 0)` succeeds). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal a whole process group; true when a signal was sent. */
function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Ensure a directory exists with 0700 (new roots are 0700; existing roots untouched). */
function ensureDir0700(dir: string, isNewRoot: boolean, alwaysChmod: boolean): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (alwaysChmod || isNewRoot) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // best effort
    }
  }
}

function writeFile0600(file: string, text: string): void {
  fs.writeFileSync(file, text);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

function cmdList(argv: string[]): number {
  const p = parseArgs(argv, ["all", "json"]);
  unknownFlags(p, ["all", "json"]);
  if (bool(p, "help")) {
    console.log(HELP["list"]);
    return 0;
  }
  if (p.positionals.length !== 0)
    throw new UsageError("list takes no arguments", "usage", "run agent-shell list --help for usage");
  const root = stateRoot();
  let jobs = allJobs(root);
  const showAll = bool(p, "all");
  if (!showAll) {
    const caller = callerOwner();
    jobs = jobs.filter(({ meta }) => isOwnJob(meta, caller));
    if (jobs.length > 20) jobs = jobs.slice(0, 20);
  }
  if (wantsJson(p)) {
    for (const { meta, status } of jobs) {
      const base: Record<string, unknown> = {
        id: meta.id,
        name: meta.name,
        state: effectiveState(meta, status),
        exit: status?.exit_code ?? null,
        exit_code: status?.exit_code ?? null,
        cmd: shellQuote(meta.command),
        command: meta.command,
        heartbeats: status?.heartbeats ?? status?.heartbeats_sent ?? 0,
        created_ms: meta.created_ms,
        created_at: iso(meta.created_ms),
        done_ms: status?.done_ms ?? null,
        done_at: iso(status?.done_ms ?? null),
        duration_ms: status?.duration_ms ?? null,
      };
      if (showAll) base["owner"] = meta.owner_id ?? null;
      printJson(base);
    }
    return 0;
  }
  if (jobs.length === 0) {
    console.log("no jobs");
    return 0;
  }
  if (showAll) {
    console.log(`${"ID".padEnd(22)} ${"NAME".padEnd(12)} ${"STATE".padEnd(8)} ${"OWNER".padEnd(12)} COMMAND`);
    for (const { meta, status } of jobs) {
      const ownerText = String(meta.owner_id ?? "");
      console.log(
        `${meta.id.padEnd(22)} ${meta.name.padEnd(12)} ${effectiveState(meta, status).padEnd(8)} ${ownerText.padEnd(12)} ${shellQuote(meta.command)}`,
      );
    }
  } else {
    console.log(`${"ID".padEnd(22)} ${"NAME".padEnd(12)} ${"STATE".padEnd(8)} COMMAND`);
    for (const { meta, status } of jobs) {
      console.log(
        `${meta.id.padEnd(22)} ${meta.name.padEnd(12)} ${effectiveState(meta, status).padEnd(8)} ${shellQuote(meta.command)}`,
      );
    }
  }
  return 0;
}

function parseCount(raw: string | undefined, def: number, flag: string): number {
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw.trim()))
    throw new UsageError(`bad --${flag} '${raw}': needs a positive integer`, "usage", `run agent-shell show --help for usage`);
  const n = parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new UsageError(`bad --${flag} '${raw}': needs a positive integer`, "usage", `run agent-shell show --help for usage`);
  return n;
}

function cmdShow(argv: string[]): number {
  const p = parseArgs(argv, ["json"]);
  unknownFlags(p, ["tail", "json"]);
  if (bool(p, "help")) {
    console.log(HELP["show"]);
    return 0;
  }
  const id = p.positionals[0];
  if (!id || p.positionals.length !== 1)
    throw new UsageError("show needs exactly one <id>", "usage", "run agent-shell show --help for usage");
  const tail = parseCount(str(p, "tail"), 30, "tail");
  const dir = jobDir(stateRoot(), id);
  const meta = readMeta(dir);
  if (!meta) throw new UsageError(`unknown job ${id}`, "not_found", "run agent-shell list to see job ids");
  const status = readStatus(dir);
  const state = effectiveState(meta, status);
  const hbBase = meta.heartbeat_ms === undefined ? defaultHeartbeatMs() : meta.heartbeat_ms;
  const hbFixed = meta.heartbeat_fixed ?? false;
  const hbCurrent = status?.heartbeat_current_ms ?? hbBase;
  const hbSent = status?.heartbeats_sent ?? status?.heartbeats ?? 0;
  const hbBackoff = status?.heartbeats_skipped_backoff ?? 0;
  const hbBusy = status?.heartbeats_skipped_busy ?? 0;
  const hbFailed = status?.heartbeats_failed ?? 0;
  const hbSkipped = hbBackoff + hbBusy;
  if (wantsJson(p)) {
    const raw = readTailDetailed(dir, tail);
    const out = sanitiseOutput(raw.text);
    const lines = out === "" ? [] : out.split("\n");
    printJson({
      id: meta.id,
      name: meta.name,
      command: meta.command,
      command_string: shellQuote(meta.command),
      cwd: meta.cwd,
      created_ms: meta.created_ms,
      created_at: iso(meta.created_ms),
      state,
      exit_code: status?.exit_code ?? null,
      duration_ms: status?.duration_ms ?? null,
      done_ms: status?.done_ms ?? null,
      done_at: iso(status?.done_ms ?? null),
      error: status?.error ?? null,
      notify_detail: status?.notify_detail ?? "",
      notify_outcome: status?.notify_outcome ?? "",
      notify_route: status?.notify_route ?? null,
      notify_agent: status?.notify_agent ?? null,
      notify_note: status?.notify_note ?? null,
      heartbeat_ms: hbBase,
      heartbeat_fixed: hbFixed,
      heartbeat_current_ms: hbCurrent,
      heartbeats: status?.heartbeats ?? hbSent,
      heartbeats_sent: hbSent,
      heartbeats_skipped_backoff: hbBackoff,
      heartbeats_skipped_busy: hbBusy,
      heartbeats_failed: hbFailed,
      last_heartbeat_ms: status?.last_heartbeat_ms ?? null,
      last_heartbeat_at: iso(status?.last_heartbeat_ms ?? null),
      last_heartbeat_detail: status?.last_heartbeat_detail ?? "",
      tail_lines_requested: tail,
      output: out,
      lines,
      line_count: lines.length,
      truncated: raw.truncated,
      pgid: meta.pgid ?? null,
    });
    return 0;
  }
  console.log(`job ${meta.id}`);
  console.log(`name ${meta.name}`);
  console.log(`command ${shellQuote(meta.command)}`);
  console.log(`cwd ${meta.cwd}`);
  console.log(`state ${state}`);
  if (state === "lost") console.log(`lost: supervisor died without writing a final status`);
  if (status?.exit_code !== null && status?.exit_code !== undefined) console.log(`exit ${status.exit_code}`);
  if (status?.duration_ms !== null && status?.duration_ms !== undefined)
    console.log(`duration_ms ${status.duration_ms}`);
  if (status?.error) console.log(`error ${status.error}`);
  if (status?.notify_detail) console.log(`notify ${status.notify_detail}`);
  if (status?.notify_outcome) console.log(`notify_outcome ${status.notify_outcome}`);
  if (status?.notify_route) console.log(`notify_route ${status.notify_route}`);
  if (status?.notify_agent) console.log(`notify_agent ${status.notify_agent}`);
  if (status?.notify_note) console.log(`notify_note ${status.notify_note}`);
  console.log(`heartbeat ${hbBase === null ? "off" : `${hbBase}ms`}`);
  if (hbBase !== null) console.log(`heartbeat_current ${hbCurrent === null ? "off" : `${hbCurrent}ms`}`);
  console.log(`heartbeats sent ${hbSent}, skipped ${hbSkipped} (backoff ${hbBackoff}, busy ${hbBusy}), failed ${hbFailed}`);
  if (status?.last_heartbeat_detail) console.log(`last_heartbeat ${status.last_heartbeat_detail}`);
  console.log(`--- output (last ${tail} lines) ---`);
  const rawTail = readTailDetailed(dir, tail);
  if (rawTail.truncated) console.log(`(output truncated at 256 KiB)`);
  const out = sanitiseOutput(rawTail.text);
  if (out !== "") console.log(out);
  return 0;
}

function cmdTail(argv: string[]): number {
  const p = parseArgs(argv, ["json"]);
  unknownFlags(p, ["lines", "json"]);
  if (bool(p, "help")) {
    console.log(HELP["tail"]);
    return 0;
  }
  const id = p.positionals[0];
  if (!id || p.positionals.length !== 1)
    throw new UsageError("tail needs exactly one <id>", "usage", "run agent-shell tail --help for usage");
  const lines = parseCount(str(p, "lines"), 50, "lines");
  const dir = jobDir(stateRoot(), id);
  if (!readMeta(dir)) throw new UsageError(`unknown job ${id}`, "not_found", "run agent-shell list to see job ids");
  const raw = readTailDetailed(dir, lines);
  const out = sanitiseOutput(raw.text);
  if (wantsJson(p)) {
    const arr = out === "" ? [] : out.split("\n");
    printJson({ id, lines_requested: lines, line_count: arr.length, output: out, lines: arr, truncated: raw.truncated });
    return 0;
  }
  if (raw.truncated) console.log(`(output truncated at 256 KiB)`);
  if (out !== "") console.log(out);
  return 0;
}

function cmdCheck(argv: string[]): number {
  const p = parseArgs(argv, ["json"]);
  unknownFlags(p, ["json"]);
  if (bool(p, "help")) {
    console.log(HELP["check"]);
    return 0;
  }
  const id = p.positionals[0];
  if (!id || p.positionals.length !== 1)
    throw new UsageError("check needs exactly one <id>", "usage", "run agent-shell check --help for usage");
  const dir = jobDir(stateRoot(), id);
  const meta = readMeta(dir);
  if (!meta) throw new UsageError(`unknown job ${id}`, "not_found", "run agent-shell list to see job ids");
  const status = readStatus(dir);
  const state = effectiveState(meta, status);
  if (state === "running")
    throw new UsageError(
      `job ${id} is still running; check it after its notify turn arrives`,
      "running",
      "wait for its notify turn, then run agent-shell check again",
    );
  const finishedOk = state === "done" || state === "failed";
  const finishedDetail =
    state === "killed"
      ? "finished: state is killed (partial output kept, no completion notify)"
      : state === "lost"
        ? "finished: state is lost (supervisor died without writing a final status; partial output kept, no completion notify)"
        : `finished: state is ${state}`;
  const code = status?.exit_code;
  const exitOk = code !== null && code !== undefined;
  const exitDetail = exitOk ? `exit: ${code}` : "exit: no exit code recorded";
  let lines: string[] | null = null;
  let truncated = false;
  try {
    fs.statSync(path.join(dir, "output.log"));
    const raw = readTailDetailed(dir, 1000000);
    truncated = raw.truncated;
    const clean = sanitiseOutput(raw.text);
    const all = clean.split("\n");
    if (all.length === 1 && all[0] === "") lines = [];
    else {
      if (all.length > 0 && all[all.length - 1] === "") all.pop();
      lines = all;
    }
  } catch {
    try {
      fs.statSync(path.join(dir, "output.log"));
      lines = [];
    } catch {
      lines = null;
    }
  }
  const outputOk = lines !== null;
  const outputDetail = outputOk
    ? `output: ${lines!.length} lines${truncated ? " (truncated at 256 KiB)" : ""}`
    : "output: output.log is missing or unreadable";
  const detail = status?.notify_detail ?? "";
  const noTarget = detail.includes("no notify target") || (meta.notify_target ?? "") === "";
  let notifyOk: boolean;
  let notifyDetail: string;
  if (noTarget) {
    notifyOk = true;
    notifyDetail = "notify: n/a (no notify target)";
  } else {
    const outcome = status?.notify_outcome ?? "";
    if (outcome === "delivered") {
      notifyOk = true;
      notifyDetail = `notify: delivered: ${detail}`;
    } else if (outcome === "unconfirmed") {
      notifyOk = true;
      notifyDetail = `notify: unconfirmed (delivery not verified): ${detail}`;
    } else if (outcome !== "") {
      notifyOk = false;
      notifyDetail = `notify: not delivered [${outcome}] (${detail || "no notify recorded"})`;
    } else {
      const notified = status?.notified === true;
      notifyOk = notified;
      notifyDetail = notified ? `notify: ${detail}` : `notify: not delivered (${detail || "no notify recorded"})`;
    }
  }
  const lastProgress = status?.last_heartbeat_detail ?? "";
  const checks = [
    { name: "finished", ok: finishedOk, detail: finishedDetail },
    { name: "exit", ok: exitOk, detail: exitDetail },
    { name: "output", ok: outputOk, detail: outputDetail },
    { name: "notify", ok: notifyOk, detail: notifyDetail },
  ];
  const pass = checks.filter((c) => c.ok).length;
  const success = state === "done" && code === 0;
  const successDetail =
    success
      ? "ok success: exit 0"
      : code === null || code === undefined
        ? `FAIL success: state is ${state} with no exit code`
        : `FAIL success: exit ${code} (state is ${state})`;
  const exitCode = pass === 4 && success ? 0 : 1;
  const hbSent = status?.heartbeats_sent ?? status?.heartbeats ?? 0;
  const hbBackoff = status?.heartbeats_skipped_backoff ?? 0;
  const hbBusy = status?.heartbeats_skipped_busy ?? 0;
  const hbFailed = status?.heartbeats_failed ?? 0;
  const hbSkipped = hbBackoff + hbBusy;
  const hbLine = `heartbeats sent ${hbSent}, skipped ${hbSkipped} (backoff ${hbBackoff}, busy ${hbBusy}), failed ${hbFailed}`;
  if (wantsJson(p)) {
    printJson({
      id,
      state,
      exit_code: code ?? null,
      output_lines: lines === null ? null : lines.length,
      output_ok: outputOk,
      output_detail: outputDetail,
      truncated,
      notify_detail: detail,
      notify_outcome: status?.notify_outcome ?? "",
      notify_route: status?.notify_route ?? null,
      notify_agent: status?.notify_agent ?? null,
      notify_note: status?.notify_note ?? null,
      notify_ok: notifyOk,
      notify_detail_line: notifyDetail,
      progress_notify: lastProgress,
      heartbeats: status?.heartbeats ?? hbSent,
      heartbeats_sent: hbSent,
      heartbeats_skipped_backoff: hbBackoff,
      heartbeats_skipped_busy: hbBusy,
      heartbeats_failed: hbFailed,
      checks,
      pass,
      total: 4,
      success,
      success_detail: successDetail,
    });
    return exitCode;
  }
  let humanPass = 0;
  const line = (ok: boolean, text: string) => {
    console.log(`${ok ? "ok" : "FAIL"} ${text}`);
    if (ok) humanPass++;
  };
  line(finishedOk, finishedDetail);
  line(exitOk, exitDetail);
  line(outputOk, outputDetail);
  line(notifyOk, notifyDetail);
  if (lastProgress !== "") console.log(`progress notify: ${lastProgress}`);
  console.log(hbLine);
  console.log(`check ${id}: ${humanPass}/4 pass`);
  console.log(successDetail);
  return exitCode;
}

/** `ps -o lstart` for a pid, or null when the process is gone/unreadable. */
function procStartTime(pid: number): string | null {
  try {
    const p = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    });
    if (p.status !== 0) return null;
    const s = (p.stdout as string).trim();
    return s === "" ? null : s;
  } catch {
    return null;
  }
}

/** True when pid is alive AND still the same process we started (when we know
 * the start time). A stored null means "unknown": fall back to a liveness check. */
function pidMatches(pid: number, stored: string | null | undefined): boolean {
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    return false;
  }
  if (!alive) return false;
  if (stored === null || stored === undefined) return true;
  const cur = procStartTime(pid);
  if (cur === null) return false;
  return cur === stored;
}

function cmdKill(argv: string[]): number {
  const p = parseArgs(argv, ["json"]);
  unknownFlags(p, ["json"]);
  if (bool(p, "help")) {
    console.log(HELP["kill"]);
    return 0;
  }
  const id = p.positionals[0];
  if (!id || p.positionals.length !== 1)
    throw new UsageError("kill needs exactly one <id>", "usage", "run agent-shell kill --help for usage");
  const dir = jobDir(stateRoot(), id);
  const meta = readMeta(dir);
  if (!meta) throw new UsageError(`unknown job ${id}`, "not_found", "run agent-shell list to see job ids");
  const status = readStatus(dir);
  const state = effectiveState(meta, status);
  if (state !== "running" && state !== "lost")
    throw new UsageError(
      `job ${id} is not running (state is ${state}); refusing to kill a finished job`,
      "not_running",
      "use agent-shell show to read its result",
    );
  const pgid = meta.pgid ?? meta.child_pid ?? null;
  const leaderPid = meta.child_pid;
  const leaderMatches =
    leaderPid !== null && leaderPid !== undefined && pidMatches(leaderPid, meta.child_lstart);
  const supMatches =
    meta.supervisor_pid !== null &&
    meta.supervisor_pid !== undefined &&
    pidMatches(meta.supervisor_pid, meta.supervisor_lstart);
  let signalled = false;
  // Hardening: signal -pgid ONLY when the leader still matches. A gone or
  // reused leader PID must never trigger a group signal, even if some group
  // with that number still exists.
  const termGroupMatching = (): void => {
    if (pgid === null || pgid === undefined) return;
    if (!leaderMatches) return;
    if (signalGroup(pgid, "SIGTERM")) signalled = true;
    else {
      try {
        process.kill(leaderPid as number, "SIGTERM");
        signalled = true;
      } catch {
        // gone
      }
    }
  };
  const killGroupMatching = (): void => {
    if (pgid === null || pgid === undefined) return;
    if (!leaderMatches) return;
    try {
      process.kill(-(pgid as number), 0);
      if (signalGroup(pgid as number, "SIGKILL")) signalled = true;
    } catch {
      try {
        process.kill(leaderPid as number, 0);
        try {
          process.kill(leaderPid as number, "SIGKILL");
          signalled = true;
        } catch {
          // gone
        }
      } catch {
        // gone
      }
    }
  };
  const stopSupervisor = (): void => {
    if (!supMatches) return;
    try {
      process.kill(meta.supervisor_pid as number, "SIGTERM");
      signalled = true;
    } catch {
      // gone
    }
  };
  const stopSupervisorKill = (): void => {
    if (!supMatches) return;
    try {
      process.kill(meta.supervisor_pid as number, 0);
      try {
        process.kill(meta.supervisor_pid as number, "SIGKILL");
        signalled = true;
      } catch {
        // gone
      }
    } catch {
      // gone
    }
  };
  const writeLost = (detail: string): void => {
    const prev = readStatus(dir);
    writeStatus(dir, {
      state: "lost",
      exit_code: null,
      done_ms: null,
      duration_ms: null,
      notified: false,
      notify_detail: detail,
      notify_outcome: "",
      notify_route: null,
      notify_agent: null,
      notify_note: null,
      heartbeats: prev?.heartbeats ?? prev?.heartbeats_sent ?? 0,
      heartbeats_sent: prev?.heartbeats_sent ?? prev?.heartbeats ?? 0,
      heartbeats_skipped_backoff: prev?.heartbeats_skipped_backoff ?? 0,
      heartbeats_skipped_busy: prev?.heartbeats_skipped_busy ?? 0,
      heartbeats_failed: prev?.heartbeats_failed ?? 0,
      last_heartbeat_ms: prev?.last_heartbeat_ms ?? null,
      last_heartbeat_detail: prev?.last_heartbeat_detail ?? detail,
      error: prev?.error ?? null,
      heartbeat_current_ms: prev?.heartbeat_current_ms ?? null,
    });
  };
  if (state === "lost") {
    if (leaderMatches) {
      termGroupMatching();
      const t0 = Date.now();
      while (Date.now() - t0 < 500) {
        if (pgid === null || pgid === undefined || !groupAlive(pgid)) break;
        Bun.sleepSync(50);
      }
      killGroupMatching();
      const detail = signalled ? "supervisor died; orphan group members removed" : "supervisor died; no live group members";
      writeLost(detail);
      if (wantsJson(p)) {
        printJson({ id, state: "lost", signalled, detail, done_ms: null, done_at: null });
        return 0;
      }
      console.log(`lost ${id}`);
      return 0;
    }
    const detail =
      pgid === null || pgid === undefined
        ? "supervisor died; no group to signal"
        : `pgid ${pgid} not signalled: its leader is gone; supervisor died`;
    writeLost(detail);
    if (wantsJson(p)) {
      printJson({ id, state: "lost", signalled: false, detail, done_ms: null, done_at: null });
      return 0;
    }
    console.log(`lost ${id}`);
    console.log(detail);
    return 0;
  }
  if (!leaderMatches) {
    if (leaderPid === null || leaderPid === undefined) {
      stopSupervisor();
      const t0e = Date.now();
      while (Date.now() - t0e < 500) {
        let supGone = true;
        if (supMatches) {
          try {
            process.kill(meta.supervisor_pid as number, 0);
            supGone = false;
          } catch {
            supGone = true;
          }
        }
        if (supGone) break;
        Bun.sleepSync(50);
      }
      stopSupervisorKill();
      const prevE = readStatus(dir);
      const doneMsE = nowMs();
      const detailE = signalled ? "killed by user; no completion notify" : "no live process found";
      writeStatus(dir, {
        state: "killed",
        exit_code: null,
        done_ms: doneMsE,
        duration_ms: null,
        notified: false,
        notify_detail: detailE,
        notify_outcome: "",
        notify_route: null,
        notify_agent: null,
        notify_note: null,
        heartbeats: prevE?.heartbeats ?? prevE?.heartbeats_sent ?? 0,
        heartbeats_sent: prevE?.heartbeats_sent ?? prevE?.heartbeats ?? 0,
        heartbeats_skipped_backoff: prevE?.heartbeats_skipped_backoff ?? 0,
        heartbeats_skipped_busy: prevE?.heartbeats_skipped_busy ?? 0,
        heartbeats_failed: prevE?.heartbeats_failed ?? 0,
        last_heartbeat_ms: prevE?.last_heartbeat_ms ?? null,
        last_heartbeat_detail: prevE?.last_heartbeat_detail ?? "",
        error: prevE?.error ?? null,
        heartbeat_current_ms: prevE?.heartbeat_current_ms ?? null,
      });
      if (wantsJson(p)) {
        printJson({ id, state: "killed", signalled, detail: detailE, done_ms: doneMsE, done_at: iso(doneMsE) });
        return 0;
      }
      console.log(`killed ${id}`);
      return 0;
    }
    stopSupervisor();
    const detail =
      pgid === null || pgid === undefined
        ? "not signalled: its leader is gone (no group recorded)"
        : `pgid ${pgid} not signalled: its leader is gone`;
    writeLost(detail);
    if (wantsJson(p)) {
      printJson({ id, state: "lost", signalled: false, detail, done_ms: null, done_at: null });
      return 0;
    }
    console.log(`lost ${id}`);
    console.log(detail);
    return 0;
  }
  termGroupMatching();
  stopSupervisor();
  const t0 = Date.now();
  while (Date.now() - t0 < 500) {
    const groupGone = pgid === null || pgid === undefined || !groupAlive(pgid);
    let supGone = true;
    if (supMatches) {
      try {
        process.kill(meta.supervisor_pid as number, 0);
        supGone = false;
      } catch {
        supGone = true;
      }
    }
    if (groupGone && supGone) break;
    Bun.sleepSync(50);
  }
  killGroupMatching();
  stopSupervisorKill();
  const prev = readStatus(dir);
  const doneMs = nowMs();
  const detail = signalled ? "killed by user; no completion notify" : "no live process found";
  writeStatus(dir, {
    state: "killed",
    exit_code: null,
    done_ms: doneMs,
    duration_ms: null,
    notified: false,
    notify_detail: detail,
    notify_outcome: "",
    notify_route: null,
    notify_agent: null,
    notify_note: null,
    heartbeats: prev?.heartbeats ?? prev?.heartbeats_sent ?? 0,
    heartbeats_sent: prev?.heartbeats_sent ?? prev?.heartbeats ?? 0,
    heartbeats_skipped_backoff: prev?.heartbeats_skipped_backoff ?? 0,
    heartbeats_skipped_busy: prev?.heartbeats_skipped_busy ?? 0,
    heartbeats_failed: prev?.heartbeats_failed ?? 0,
    last_heartbeat_ms: prev?.last_heartbeat_ms ?? null,
    last_heartbeat_detail: prev?.last_heartbeat_detail ?? "",
    error: prev?.error ?? null,
    heartbeat_current_ms: prev?.heartbeat_current_ms ?? null,
  });
  if (wantsJson(p)) {
    printJson({ id, state: "killed", signalled, detail, done_ms: doneMs, done_at: iso(doneMs) });
    return 0;
  }
  console.log(`killed ${id}`);
  return 0;
}

function cmdClean(argv: string[]): number {
  const p = parseArgs(argv, ["all", "json"]);
  unknownFlags(p, ["older-than", "all", "json"]);
  if (bool(p, "help")) {
    console.log(HELP["clean"]);
    return 0;
  }
  if (p.positionals.length !== 0)
    throw new UsageError("clean takes no arguments", "usage", "run agent-shell clean --help for usage");
  const root = stateRoot();
  const older = str(p, "older-than");
  const cutoff = older !== undefined ? nowMs() - parseDurationMs(older) : null;
  const showAll = bool(p, "all");
  const caller = callerOwner();
  let removed = 0;
  const removedIds: string[] = [];
  let skippedOtherOwner = 0;
  for (const { meta, status } of allJobs(root)) {
    if (effectiveState(meta, status) === "running") continue;
    if (cutoff !== null) {
      const done = status?.done_ms ?? meta.created_ms;
      if (done > cutoff) continue;
    }
    if (!showAll && !isOwnJob(meta, caller)) {
      skippedOtherOwner++;
      continue;
    }
    fs.rmSync(jobDir(root, meta.id), { recursive: true, force: true });
    removed++;
    removedIds.push(meta.id);
  }
  if (wantsJson(p)) {
    printJson({ removed, removed_ids: removedIds, skipped_other_owner: skippedOtherOwner });
    return 0;
  }
  if (skippedOtherOwner > 0) {
    console.log(`removed ${removed} jobs, skipped ${skippedOtherOwner} other-owner jobs`);
  } else {
    console.log(`removed ${removed} jobs`);
  }
  return 0;
}

function parseDurationMs(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!m) throw new UsageError(`bad duration '${s}': use like 24h, 7d, 30m`, "usage", "use a number with ms, s, m, h or d");
  const v = parseInt(m[1]!, 10);
  const unit = m[2] ?? "s";
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return v * mult[unit]!;
}

/** Parse the --heartbeat value. Returns null when heartbeats are disabled. */
function parseHeartbeatMs(raw: string | undefined, disabled: boolean): number | null {
  if (disabled) return null;
  if (raw === undefined) return defaultHeartbeatMs();
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "off" || v === "no" || v === "none" || v === "never" || v === "disabled") return null;
  const ms = parseDurationMs(raw.trim());
  if (ms === 0) return null;
  if (ms < 1000) throw new UsageError(`bad --heartbeat '${raw}': minimum is 1s`, "usage", "use off to disable or at least 1s");
  return ms;
}

/** Last non-empty sanitised line of the job log ("" when nothing yet). Bounded. */
function lastOutputLine(dir: string): string {
  const raw = readTailDetailed(dir, 20).text;
  const clean = sanitiseOutput(raw);
  return clean.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
}

/** Status fields for a notify result: `notified` is true for delivered or
 * unconfirmed (both pass `check`); the rest carry the typed outcome. */
function statusFromNotify(r: NotifyResult) {
  return {
    notified: r.outcome === "delivered" || r.outcome === "unconfirmed",
    notify_detail: r.detail,
    notify_outcome: r.outcome,
    notify_route: r.route,
    notify_agent: r.agent,
    notify_note: r.note,
  };
}

/** Short elapsed label like 45.0s, 2m5s or 1h3m. */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function sanitizeName(name: string): string {
  let out = name
    .split("")
    .map((c) => (/[A-Za-z0-9]/.test(c) ? c.toLowerCase() : "-"))
    .join("");
  while (out.includes("--")) out = out.replaceAll("--", "-");
  out = out.replace(/^-+|-+$/g, "").slice(0, 48);
  return out === "" ? "job" : out;
}

function resolveExecutable(cmd: string): string | null {
  try {
    const w = (Bun as unknown as { which?: (c: string) => string | null }).which;
    if (typeof w === "function") return w.call(Bun, cmd);
  } catch {
    // fall through to PATH search
  }
  if (cmd.includes("/")) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const d of pathEnv.split(":")) {
    if (d === "") continue;
    const full = path.join(d, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      const st = fs.statSync(full);
      if (st.isFile()) return full;
    } catch {
      // next
    }
  }
  return null;
}

async function cmdRun(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ["no-heartbeat", "heartbeat-fixed", "json"]);
  unknownFlags(p, ["name", "notify", "cwd", "heartbeat", "no-heartbeat", "heartbeat-fixed", "wait", "json"]);
  if (bool(p, "help")) {
    console.log(HELP["run"]);
    return 0;
  }
  if (p.positionals.length === 0)
    throw new UsageError("run needs a command after `--`", "usage", "run agent-shell run -- -- <command> for usage");
  const heartbeatMs = parseHeartbeatMs(str(p, "heartbeat"), bool(p, "no-heartbeat"));
  const heartbeatFixed = bool(p, "heartbeat-fixed");
  const waitRaw = str(p, "wait");
  const waitMs = waitRaw === undefined ? undefined : parseDurationMs(waitRaw.trim());
  const cwd = str(p, "cwd") ?? process.cwd();
  try {
    const st = fs.statSync(cwd);
    if (!st.isDirectory()) throw new UsageError(`bad --cwd '${cwd}': not a directory`, "usage", "use a directory that exists");
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`bad --cwd '${cwd}': no such directory`, "not_found", "use a directory that exists");
  }
  const exe = p.positionals[0]!;
  if (resolveExecutable(exe) === null)
    throw new UsageError(`cannot start '${exe}': executable not found on PATH`, "not_found", "check the command name or install it");
  const root = stateRoot();
  const rootExisted = fs.existsSync(root);
  const jobsExisted = fs.existsSync(jobsDir(root));
  const id = freshId(root);
  const dir = jobDir(root, id);
  ensureDir0700(root, !rootExisted, false);
  ensureDir0700(jobsDir(root), !jobsExisted, false);
  ensureDir0700(dir, true, true);
  const owner = currentOwner();
  const target = defaultTarget(str(p, "notify"), owner);
  const ownerId = callerOwner();
  const meta: Meta = {
    id,
    name: sanitizeName(str(p, "name") ?? "job"),
    command: p.positionals,
    cwd,
    created_ms: nowMs(),
    owner,
    owner_id: ownerId,
    notify_target: target,
    heartbeat_ms: heartbeatMs,
    child_pid: null,
    supervisor_pid: null,
    child_lstart: null,
    supervisor_lstart: null,
    pgid: null,
    heartbeat_fixed: heartbeatFixed,
  };
  writeMeta(dir, meta);
  writeStatus(dir, {
    state: "running",
    exit_code: null,
    done_ms: null,
    duration_ms: null,
    notified: false,
    notify_detail: "",
    notify_outcome: "",
    notify_route: null,
    notify_agent: null,
    notify_note: null,
    heartbeats: 0,
    heartbeats_sent: 0,
    heartbeats_skipped_backoff: 0,
    heartbeats_skipped_busy: 0,
    heartbeats_failed: 0,
    last_heartbeat_ms: null,
    last_heartbeat_detail: "",
    error: null,
    heartbeat_current_ms: heartbeatMs,
  });
  writeFile0600(path.join(dir, "output.log"), "");
  spawnSupervisor(id);
  const notifyWarning = checkNotifyTarget(str(p, "notify"));
  const heartbeatLabel = heartbeatMs === null ? "off" : `every ${formatElapsed(heartbeatMs)}`;
  const readHint = `agent-shell show ${id}`;
  const json = wantsJson(p);
  if (!json) {
    console.log(`job ${id}`);
    if (target === "") {
      console.log(`notify skipped (no herdr pane and no --notify); read with: agent-shell show ${id}`);
    } else {
      console.log(`notify ${target}`);
    }
    if (notifyWarning !== null) console.log(notifyWarning);
    console.log(`heartbeat ${heartbeatLabel}`);
    console.log(`read with: ${readHint}`);
  }
  if (waitMs === undefined) {
    if (json) {
      printJson({
        id,
        name: meta.name,
        command: meta.command,
        command_string: shellQuote(meta.command),
        cwd,
        created_ms: meta.created_ms,
        created_at: iso(meta.created_ms),
        notify_target: target,
        notify_warning: notifyWarning,
        heartbeat_ms: heartbeatMs,
        heartbeat_fixed: heartbeatFixed,
        heartbeat_current_ms: heartbeatMs,
        heartbeat: heartbeatLabel,
        read_hint: readHint,
        wait: null,
      });
    }
    return 0;
  }
  const deadline = Date.now() + waitMs;
  let status = readStatus(dir);
  while (effectiveState(meta, status) === "running" && Date.now() < deadline) {
    await Bun.sleep(200);
    status = readStatus(dir);
  }
  const waitState = effectiveState(meta, status);
  if (waitState === "running") {
    if (json) {
      printJson({
        id,
        name: meta.name,
        command: meta.command,
        command_string: shellQuote(meta.command),
        cwd,
        created_ms: meta.created_ms,
        created_at: iso(meta.created_ms),
        notify_target: target,
        notify_warning: notifyWarning,
        heartbeat_ms: heartbeatMs,
        heartbeat_fixed: heartbeatFixed,
        heartbeat_current_ms: status?.heartbeat_current_ms ?? heartbeatMs,
        heartbeat: heartbeatLabel,
        read_hint: readHint,
        wait: { wait_ms: waitMs, timed_out: true, state: "running", exit_code: null, output: "" },
      });
      return 124;
    }
    console.log(`still running after ${formatElapsed(waitMs)}; read with: agent-shell show ${id}`);
    return 124;
  }
  const out = sanitiseOutput(readTailDetailed(dir, 30).text);
  const code = status?.exit_code;
  const finalCode =
    typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1;
  if (json) {
    printJson({
      id,
      name: meta.name,
      command: meta.command,
      command_string: shellQuote(meta.command),
      cwd,
      created_ms: meta.created_ms,
      created_at: iso(meta.created_ms),
      notify_target: target,
      notify_warning: notifyWarning,
      heartbeat_ms: heartbeatMs,
      heartbeat_fixed: heartbeatFixed,
      heartbeat_current_ms: status?.heartbeat_current_ms ?? heartbeatMs,
      heartbeat: heartbeatLabel,
      read_hint: readHint,
      wait: {
        wait_ms: waitMs,
        timed_out: false,
        state: waitState,
        exit_code: code ?? null,
        output: out,
      },
    });
    return finalCode;
  }
  if (out.trim() !== "") console.log(`--- output (last 30 lines) ---\n${out}`);
  console.log(`exit ${status?.exit_code ?? "?"}`);
  return finalCode;
}

/** Detach `supervise <id>`: stdio ignored, new session, no wait. */
function spawnSupervisor(id: string): void {
  const script = process.argv[1];
  if (!script) throw new Error("cannot find own script (argv[1])");
  const child = spawn(process.execPath, [script, "supervise", id], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}

function cmdSupervise(argv: string[]): Promise<number> {
  const p = parseArgs(argv);
  if (bool(p, "help")) {
    console.log(HELP["supervise"]);
    return Promise.resolve(0);
  }
  const id = p.positionals[0];
  if (!id || p.positionals.length !== 1) throw new UsageError("supervise needs exactly one <id>");
  return supervise(id);
}

async function supervise(id: string): Promise<number> {
  const root = stateRoot();
  const dir = jobDir(root, id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`unknown job ${id}`);
  meta.supervisor_pid = process.pid;
  meta.supervisor_lstart = procStartTime(process.pid);
  writeMeta(dir, meta);
  const started = nowMs();
  const heartbeatMs = meta.heartbeat_ms === undefined ? defaultHeartbeatMs() : meta.heartbeat_ms;
  const heartbeatFixed = meta.heartbeat_fixed ?? false;
  const heartbeatCap = heartbeatMaxMs();
  let currentInterval: number | null = heartbeatMs;
  const logPath = path.join(dir, "output.log");
  const logFd = fs.openSync(logPath, "a");
  try {
    fs.chmodSync(logPath, 0o600);
  } catch {
    // best effort
  }
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const st = fs.statSync(meta.cwd);
    if (!st.isDirectory()) throw new Error(`bad cwd '${meta.cwd}': not a directory`);
    if (resolveExecutable(meta.command[0] as string) === null)
      throw new Error(`executable not found '${meta.command[0]}'`);
    child = spawn(meta.command[0] as string, meta.command.slice(1), {
      cwd: meta.cwd,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.on("error", () => {
      // Handled via exitPromise; prevent an uncaught 'error' crash.
    });
  } catch (e) {
    fs.closeSync(logFd);
    const msg = e instanceof Error ? e.message : String(e);
    const startError = `could not start '${shellQuote(meta.command)}': ${msg}`;
    const failedAt = nowMs();
    writeStatus(dir, {
      state: "failed",
      exit_code: -1,
      done_ms: failedAt,
      duration_ms: failedAt - started,
      notified: false,
      notify_detail: "pending: completion notify not sent yet",
      notify_outcome: "",
      notify_route: null,
      notify_agent: null,
      notify_note: null,
      heartbeats: 0,
      heartbeats_sent: 0,
      heartbeats_skipped_backoff: 0,
      heartbeats_skipped_busy: 0,
      heartbeats_failed: 0,
      last_heartbeat_ms: null,
      last_heartbeat_detail: "",
      error: startError,
      heartbeat_current_ms: heartbeatMs,
    });
    const text = `shell job '${meta.name}' failed to start: ${msg}. Read with: agent-shell show ${meta.id}`;
    const result = notify(meta.notify_target, text);
    const cur = readStatus(dir);
    if (cur && (cur.state === "killed" || cur.state === "lost")) return 0;
    writeStatus(dir, {
      state: "failed",
      exit_code: -1,
      done_ms: failedAt,
      duration_ms: failedAt - started,
      ...statusFromNotify(result),
      heartbeats: 0,
      heartbeats_sent: 0,
      heartbeats_skipped_backoff: 0,
      heartbeats_skipped_busy: 0,
      heartbeats_failed: 0,
      last_heartbeat_ms: null,
      last_heartbeat_detail: "",
      error: startError,
      heartbeat_current_ms: heartbeatMs,
    });
    return 0;
  }
  if (!child || child.pid === undefined) {
    fs.closeSync(logFd);
    const startError = `could not start '${shellQuote(meta.command)}': spawn failed`;
    const failedAt = nowMs();
    writeStatus(dir, {
      state: "failed",
      exit_code: -1,
      done_ms: failedAt,
      duration_ms: failedAt - started,
      ...statusFromNotify(notify(meta.notify_target, `shell job '${meta.name}' failed to start. Read with: agent-shell show ${meta.id}`)),
      heartbeats: 0,
      heartbeats_sent: 0,
      heartbeats_skipped_backoff: 0,
      heartbeats_skipped_busy: 0,
      heartbeats_failed: 0,
      last_heartbeat_ms: null,
      last_heartbeat_detail: "",
      error: startError,
      heartbeat_current_ms: heartbeatMs,
    });
    return 0;
  }
  meta.child_pid = child.pid;
  meta.child_lstart = procStartTime(child.pid);
  meta.pgid = child.pid;
  writeMeta(dir, meta);

  let heartbeatsSent = 0;
  let heartbeatsSkippedBackoff = 0;
  let heartbeatsSkippedBusy = 0;
  let heartbeatsFailed = 0;
  let lastHeartbeatMs: number | null = null;
  let lastHeartbeatDetail = "";
  let finished = false;
  let exitCode: number | undefined;
  const exitPromise = new Promise<number>((resolve) => {
    let settled = false;
    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      finished = true;
      exitCode = code;
      resolve(code);
    };
    child!.on("error", () => done(-1));
    child!.on("exit", (code: number | null) => {
      if (code !== null && code !== undefined) done(code);
      else done(1);
    });
  });

  // Progress notifies while the command runs: last output line every heartbeatMs.
  // Heartbeats read the target status via `hcx ls --json` (5s timeout, one
  // call per heartbeat) and skip when it is working or blocked; a busy skip
  // counts as skipped, not failed. Completion sends unconditionally. Neither
  // uses `--if idle` or retries. When the last line is unchanged and
  // back-off is enabled, skip the notify and double the interval up to the
  // cap; reset on new output. Skipped heartbeats are not failures. Skipped
  // entirely when disabled or no target. The wait races the heartbeat
  // interval against process exit, so a job shorter than the interval
  // finishes at once with no progress notify. An unreadable status (null) is
  // not "not running": keep supervising.
  if (heartbeatMs !== null && meta.notify_target !== "") {
    const done = exitPromise.then(
      () => {},
      () => {},
    );
    let prevLine: string | null = null;
    let unchangedStreak = 0;
    const writeRunning = (): void => {
      writeStatus(dir, {
        state: "running",
        exit_code: null,
        done_ms: null,
        duration_ms: null,
        notified: false,
        notify_detail: "",
        notify_outcome: "",
        notify_route: null,
        notify_agent: null,
        notify_note: null,
        heartbeats: heartbeatsSent,
        heartbeats_sent: heartbeatsSent,
        heartbeats_skipped_backoff: heartbeatsSkippedBackoff,
        heartbeats_skipped_busy: heartbeatsSkippedBusy,
        heartbeats_failed: heartbeatsFailed,
        last_heartbeat_ms: lastHeartbeatMs,
        last_heartbeat_detail: lastHeartbeatDetail,
        error: null,
        heartbeat_current_ms: currentInterval,
      });
    };
    for (;;) {
      await Promise.race([done, Bun.sleep(currentInterval as number)]);
      if (finished) break;
      const cur = readStatus(dir);
      if (cur && cur.state !== "running") return 0;
      const elapsed = nowMs() - started;
      const last = lastOutputLine(dir);
      if (!heartbeatFixed && prevLine !== null && last === prevLine) {
        unchangedStreak++;
        const next = Math.min((currentInterval as number) * 2, heartbeatCap);
        currentInterval = next;
        if (unchangedStreak >= 2) {
          heartbeatsSkippedBackoff++;
          lastHeartbeatMs = nowMs();
          lastHeartbeatDetail = `skipped: no new output (next heartbeat in ${formatElapsed(next)})`;
          writeRunning();
          if (finished) break;
          continue;
        }
      } else {
        unchangedStreak = 0;
        currentInterval = heartbeatMs;
      }
      prevLine = last;
      const hbText =
        `shell job '${meta.name}' still running (${formatElapsed(elapsed)} elapsed). ` +
        (last !== "" ? `Last line: ${last.slice(0, 160)}. ` : `No output yet. `) +
        `No action needed; completion will notify. Read with: agent-shell tail ${meta.id}`;
      const hbResult = notify(meta.notify_target, hbText, { ifIdle: true });
      if (hbResult.outcome === "delivered" || hbResult.outcome === "unconfirmed") heartbeatsSent++;
      else if (hbResult.outcome === "skipped_busy") heartbeatsSkippedBusy++;
      else heartbeatsFailed++;
      lastHeartbeatMs = nowMs();
      lastHeartbeatDetail = hbResult.detail;
      writeRunning();
      if (finished) break;
    }
  }

  const code = exitCode ?? (await exitPromise);
  fs.closeSync(logFd);
  // A kill that landed while the child exited wins: keep the killed/lost state.
  const cur = readStatus(dir);
  if (cur && (cur.state === "killed" || cur.state === "lost")) return 0;
  const done = nowMs();
  // Record the final state BEFORE notifying, so a receiver that wakes early
  // never sees "still running". The notify result is filled in afterwards.
  const finalState = code === 0 ? "done" : "failed";
  writeStatus(dir, {
    state: finalState,
    exit_code: code,
    done_ms: done,
    duration_ms: done - started,
    notified: false,
    notify_detail: "pending: completion notify not sent yet",
    notify_outcome: "",
    notify_route: null,
    notify_agent: null,
    notify_note: null,
    heartbeats: heartbeatsSent,
    heartbeats_sent: heartbeatsSent,
    heartbeats_skipped_backoff: heartbeatsSkippedBackoff,
    heartbeats_skipped_busy: heartbeatsSkippedBusy,
    heartbeats_failed: heartbeatsFailed,
    last_heartbeat_ms: lastHeartbeatMs,
    last_heartbeat_detail: lastHeartbeatDetail,
    error: null,
    heartbeat_current_ms: currentInterval,
  });
  const lastLine = lastOutputLine(dir);
  const secs = ((done - started) / 1000).toFixed(1);
  let text = `shell job '${meta.name}' done (exit ${code}, ${secs}s). Read with: agent-shell show ${meta.id}`;
  if (lastLine !== "") text += ` Last line: ${lastLine.slice(0, 160)}`;
  const result = notify(meta.notify_target, text);
  const raced = readStatus(dir);
  if (raced && (raced.state === "killed" || raced.state === "lost")) return 0;
  writeStatus(dir, {
    state: finalState,
    exit_code: code,
    done_ms: done,
    duration_ms: done - started,
    ...statusFromNotify(result),
    heartbeats: heartbeatsSent,
    heartbeats_sent: heartbeatsSent,
    heartbeats_skipped_backoff: heartbeatsSkippedBackoff,
    heartbeats_skipped_busy: heartbeatsSkippedBusy,
    heartbeats_failed: heartbeatsFailed,
    last_heartbeat_ms: lastHeartbeatMs,
    last_heartbeat_detail: lastHeartbeatDetail,
    error: null,
    heartbeat_current_ms: currentInterval,
  });
  return 0;
}
