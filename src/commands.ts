// One function per command, plus the help texts. `dispatch` routes them.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError, bool, parseArgs, str, unknownFlags } from "./args.ts";
import { checkNotifyTarget, currentOwner, defaultTarget, notify, type NotifyResult } from "./notify.ts";
import {
  defaultHeartbeatMs,
  freshId,
  jobDir,
  jobsDir,
  nowMs,
  readMeta,
  readStatus,
  stateRoot,
  tailLog,
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
  kill       Stop a running job (SIGTERM, then SIGKILL)
  clean      Remove finished job directories

How it works:
  1. agent-shell run --name build -- ./scripts/test.sh
     returns at once with a job id; the command keeps running in background.
  2. While it runs, your session gets one progress notify turn every 2 minutes
     (by default) with the last output line, so you can tell stuck from working.
     Disable with --no-heartbeat, change with --heartbeat <duration>.
  3. When it finishes, your session gets one completion notify turn:
     shell job 'build' done (exit 0). Read with: agent-shell show <id>
  4. Read it with \`agent-shell show <id>\` or \`agent-shell tail <id>\`.
     Nobody polls: notify turns are the only wake-up.
  Notify turns go over the old herdr server (\`herdr agent prompt\`) when it runs,
  else herdr-core via \`hcx send --agent-only --no-footer --json\` (needs
  hcx 0.3.0 or newer; hcx refuses a plain shell or unknown kind before sending).

Environment:
  AGENT_SHELL_HOME   state root instead of ~/.local/cache/agent-shell
  XDG_CACHE_HOME     cache root holding agent-shell/ when AGENT_SHELL_HOME is unset

Exit codes:
  0  success
  2  usage error or failed command; the error line says why

Examples:
  agent-shell run --name build -- bun test
  agent-shell run --notify framesmith-lead -- sh -c 'sleep 30; echo done'
  agent-shell list
  agent-shell show sh-1234-5678`,
  run: `agent-shell run — start a command in background, return its job id at once

Usage: agent-shell run [--name <name>] [--notify <target>] [--cwd <dir>] [--heartbeat <duration> | --no-heartbeat] -- <command...>

  --name <name>      Short job name (kebab-case, e.g. build, test-e2e). Default: job.
  --notify <target>  Who gets the notify turns: a herdr agent name, pane id, hc terminal
                     or tab name (hcx resolves tab names). Notified over the old herdr
                     server when it runs, else via \`hcx send --agent-only --no-footer
                     --json\` (needs hcx 0.3.0 or newer). Default: your own pane
                     ($HERDR_PANE_ID) or terminal ($HC_TERMINAL_ID).
  --cwd <dir>        Directory to run in. Default: current directory.
  --heartbeat <d>    Progress notify interval with the last output line (e.g. 30s, 2m, 5m).
                     Default: 2m. Minimum: 1s. Use 0 or off to disable.
  --no-heartbeat     No progress notifies; only the completion notify is sent.
  --wait <d>         Wait up to <d> for the job to finish (e.g. 5s, 2m), print its
                     output and exit status, then exit with the job's exit code
                     (124 on timeout). Default: do not wait.
  <command...>       The command to run (after \`--\`); use \`sh -c '...'\` for shell features.

Prints the job id and the notify target, then exits at once unless --wait is given.`,
  list: `agent-shell list — list jobs (running first, then newest done)

Usage: agent-shell list [--all] [--json]

  --all    Include all finished jobs (default: running plus the 20 newest).
  --json   Machine-readable JSON lines instead of the table.`,
  show: `agent-shell show — show one job: status plus the tail of its output

Usage: agent-shell show <id> [--tail <n>]

  --tail <n>   Output lines to include. Default: 30.`,
  tail: `agent-shell tail — print the tail of one job's output

Usage: agent-shell tail <id> [--lines <n>]

  --lines <n>   Lines to print. Default: 50.`,
  check: `agent-shell check — verify one finished job before using its result

Usage: agent-shell check <id>

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
succeed; 2 when the job is unknown or still running. A killed job fails
the finished check: its output is partial and it never got a completion
notify. A job with no notify target prints "ok notify: n/a" (not a failure).

When progress notifies were sent, the last one prints as \`progress notify: ...\`
after the notify line. It is informational and does not change the pass count.`,
  kill: `agent-shell kill — stop a running job (SIGTERM, then SIGKILL)

Usage: agent-shell kill <id>

Refuses with exit 2 unless the job state is running, leaving a finished
job's result untouched. The child is only signalled when its process start
time still matches the recorded start (no PID-reuse kill).

A killed job gets no completion notify; its partial output stays readable.`,
  clean: `agent-shell clean — remove finished job directories

Usage: agent-shell clean [--older-than <duration>]

  --older-than <d>   Only remove jobs finished this long ago or more (e.g. 24h, 7d).
                     Default: remove all finished jobs. Running jobs are never removed.`,
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
      throw new UsageError(`unknown command "${cmd}"`);
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
  const rank = (s: string) => (s === "running" ? 0 : 1);
  out.sort(
    (a, b) =>
      rank(a.status?.state ?? "") - rank(b.status?.state ?? "") ||
      b.meta.created_ms - a.meta.created_ms,
  );
  return out;
}

function cmdList(argv: string[]): number {
  const p = parseArgs(argv, ["all", "json"]);
  unknownFlags(p, ["all", "json"]);
  if (bool(p, "help")) {
    console.log(HELP["list"]);
    return 0;
  }
  if (p.positionals.length !== 0) throw new UsageError("list takes no arguments");
  const root = stateRoot();
  let jobs = allJobs(root);
  if (!bool(p, "all") && jobs.length > 20) jobs = jobs.slice(0, 20);
  if (bool(p, "json")) {
    for (const { meta, status } of jobs) {
      console.log(
        JSON.stringify({
          id: meta.id,
          name: meta.name,
          state: status?.state ?? "running",
          exit: status?.exit_code ?? null,
          cmd: meta.command.join(" "),
          heartbeats: status?.heartbeats ?? 0,
        }),
      );
    }
    return 0;
  }
  if (jobs.length === 0) {
    console.log("no jobs");
    return 0;
  }
  console.log(`${"ID".padEnd(22)} ${"NAME".padEnd(12)} ${"STATE".padEnd(8)} COMMAND`);
  for (const { meta, status } of jobs) {
    console.log(
      `${meta.id.padEnd(22)} ${meta.name.padEnd(12)} ${(status?.state ?? "running").padEnd(8)} ${meta.command.join(" ")}`,
    );
  }
  return 0;
}

function parseCount(raw: string | undefined, def: number, flag: string): number {
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw.trim())) throw new UsageError(`bad --${flag} '${raw}': needs a positive integer`);
  const n = parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`bad --${flag} '${raw}': needs a positive integer`);
  return n;
}

function cmdShow(argv: string[]): number {
  const p = parseArgs(argv);
  unknownFlags(p, ["tail"]);
  if (bool(p, "help")) {
    console.log(HELP["show"]);
    return 0;
  }
  const id = p.positionals[0];
  if (!id || p.positionals.length !== 1) throw new UsageError("show needs exactly one <id>");
  const tail = parseCount(str(p, "tail"), 30, "tail");
  const dir = jobDir(stateRoot(), id);
  const meta = readMeta(dir);
  if (!meta) throw new UsageError(`unknown job ${id}`);
  const status = readStatus(dir);
  console.log(`job ${meta.id}`);
  console.log(`name ${meta.name}`);
  console.log(`command ${meta.command.join(" ")}`);
  console.log(`cwd ${meta.cwd}`);
  console.log(`state ${status?.state ?? "running"}`);
  if (status?.exit_code !== null && status?.exit_code !== undefined) console.log(`exit ${status.exit_code}`);
  if (status?.duration_ms !== null && status?.duration_ms !== undefined)
    console.log(`duration_ms ${status.duration_ms}`);
  if (status?.error) console.log(`error ${status.error}`);
  if (status?.notify_detail) console.log(`notify ${status.notify_detail}`);
  if (status?.notify_outcome) console.log(`notify_outcome ${status.notify_outcome}`);
  if (status?.notify_route) console.log(`notify_route ${status.notify_route}`);
  if (status?.notify_agent) console.log(`notify_agent ${status.notify_agent}`);
  if (status?.notify_note) console.log(`notify_note ${status.notify_note}`);
  const hb = meta.heartbeat_ms === undefined ? defaultHeartbeatMs() : meta.heartbeat_ms;
  console.log(`heartbeat ${hb === null ? "off" : `${hb}ms`}`);
  if ((status?.heartbeats ?? 0) > 0) console.log(`heartbeats ${status!.heartbeats}`);
  if (status?.last_heartbeat_detail) console.log(`last_heartbeat ${status.last_heartbeat_detail}`);
  console.log(`--- output (last ${tail} lines) ---`);
  const out = tailLog(dir, tail);
  if (out !== "") console.log(out);
  return 0;
}

function cmdTail(argv: string[]): number {
  const p = parseArgs(argv);
  unknownFlags(p, ["lines"]);
  if (bool(p, "help")) {
    console.log(HELP["tail"]);
    return 0;
  }
  const id = p.positionals[0];
  if (!id || p.positionals.length !== 1) throw new UsageError("tail needs exactly one <id>");
  const lines = parseCount(str(p, "lines"), 50, "lines");
  const dir = jobDir(stateRoot(), id);
  if (!readMeta(dir)) throw new UsageError(`unknown job ${id}`);
  const out = tailLog(dir, lines);
  if (out !== "") console.log(out);
  return 0;
}

function cmdCheck(argv: string[]): number {
  const p = parseArgs(argv);
  unknownFlags(p, []);
  if (bool(p, "help")) {
    console.log(HELP["check"]);
    return 0;
  }
  const id = p.positionals[0];
  if (!id || p.positionals.length !== 1) throw new UsageError("check needs exactly one <id>");
  const dir = jobDir(stateRoot(), id);
  const meta = readMeta(dir);
  if (!meta) throw new UsageError(`unknown job ${id}`);
  const status = readStatus(dir);
  const state = status?.state ?? "running";
  if (state === "running")
    throw new UsageError(`job ${id} is still running; check it after its notify turn arrives`);
  let pass = 0;
  const line = (ok: boolean, text: string) => {
    console.log(`${ok ? "ok" : "FAIL"} ${text}`);
    if (ok) pass++;
  };
  line(
    state === "done" || state === "failed",
    state === "killed"
      ? `finished: state is killed (partial output kept, no completion notify)`
      : `finished: state is ${state}`,
  );
  const code = status?.exit_code;
  line(code !== null && code !== undefined, code !== null && code !== undefined ? `exit: ${code}` : `exit: no exit code recorded`);
  const logPath = path.join(dir, "output.log");
  let lines: string[] | null = null;
  try {
    const text = fs.readFileSync(logPath, "utf8");
    const all = text.split("\n");
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    lines = all;
  } catch {
    lines = null;
  }
  line(lines !== null, lines !== null ? `output: ${lines.length} lines` : `output: output.log is missing or unreadable`);
  const detail = status?.notify_detail ?? "";
  const noTarget = detail.includes("no notify target") || (meta.notify_target ?? "") === "";
  if (noTarget) {
    line(true, `notify: n/a (no notify target)`);
  } else {
    const outcome = status?.notify_outcome ?? "";
    const okOutcome = outcome === "delivered" || outcome === "unconfirmed";
    if (outcome !== "") {
      line(okOutcome, okOutcome ? `notify: ${detail}` : `notify: not delivered [${outcome}] (${detail || "no notify recorded"})`);
    } else {
      const notified = status?.notified === true;
      line(notified, notified ? `notify: ${detail}` : `notify: not delivered (${detail || "no notify recorded"})`);
    }
  }
  // The last progress notify is informational: a failure here is visible, but only
  // the completion notify decides whether the job's result is trusted.
  const lastProgress = status?.last_heartbeat_detail ?? "";
  if (lastProgress !== "") console.log(`progress notify: ${lastProgress}`);
  console.log(`check ${id}: ${pass}/4 pass`);
  const success = state === "done" && code === 0;
  if (success) {
    console.log(`ok success: exit 0`);
  } else if (code === null || code === undefined) {
    console.log(`FAIL success: state is ${state} with no exit code`);
  } else {
    console.log(`FAIL success: exit ${code} (state is ${state})`);
  }
  return pass === 4 && success ? 0 : 1;
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
  const p = parseArgs(argv);
  unknownFlags(p, []);
  if (bool(p, "help")) {
    console.log(HELP["kill"]);
    return 0;
  }
  const id = p.positionals[0];
  if (!id || p.positionals.length !== 1) throw new UsageError("kill needs exactly one <id>");
  const dir = jobDir(stateRoot(), id);
  const meta = readMeta(dir);
  if (!meta) throw new UsageError(`unknown job ${id}`);
  const status = readStatus(dir);
  const state = status?.state ?? "running";
  if (state !== "running") throw new UsageError(`job ${id} is not running (state is ${state}); refusing to kill a finished job`);
  let killed = false;
  const targets: Array<{ pid: number | null | undefined; stored: string | null | undefined }> = [
    { pid: meta.child_pid, stored: meta.child_lstart },
    { pid: meta.supervisor_pid, stored: meta.supervisor_lstart },
  ];
  for (const t of targets) {
    if (t.pid === null || t.pid === undefined) continue;
    if (!pidMatches(t.pid, t.stored)) continue;
    try {
      process.kill(t.pid, "SIGTERM");
      killed = true;
    } catch {
      // already gone
    }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 500) {
    if (
      targets.every((t) => {
        if (t.pid === null || t.pid === undefined) return true;
        if (!pidMatches(t.pid, t.stored)) return true;
        try {
          process.kill(t.pid, 0);
          return false;
        } catch {
          return true;
        }
      })
    )
      break;
    Bun.sleepSync(50);
  }
  for (const t of targets) {
    if (t.pid === null || t.pid === undefined) continue;
    if (!pidMatches(t.pid, t.stored)) continue;
    try {
      process.kill(t.pid, 0);
      try {
        process.kill(t.pid, "SIGKILL");
      } catch {
        // gone
      }
      killed = true;
    } catch {
      // gone
    }
  }
  const prev = readStatus(dir);
  writeStatus(dir, {
    state: "killed",
    exit_code: null,
    done_ms: nowMs(),
    duration_ms: null,
    notified: false,
    notify_detail: killed ? "killed by user; no completion notify" : "no live process found",
    notify_outcome: "",
    notify_route: null,
    notify_agent: null,
    notify_note: null,
    heartbeats: prev?.heartbeats ?? 0,
    last_heartbeat_ms: prev?.last_heartbeat_ms ?? null,
    last_heartbeat_detail: prev?.last_heartbeat_detail ?? "",
    error: prev?.error ?? null,
  });
  console.log(`killed ${id}`);
  return 0;
}

function cmdClean(argv: string[]): number {
  const p = parseArgs(argv);
  unknownFlags(p, ["older-than"]);
  if (bool(p, "help")) {
    console.log(HELP["clean"]);
    return 0;
  }
  if (p.positionals.length !== 0) throw new UsageError("clean takes no arguments");
  const root = stateRoot();
  const older = str(p, "older-than");
  const cutoff = older !== undefined ? nowMs() - parseDurationMs(older) : null;
  let removed = 0;
  for (const { meta, status } of allJobs(root)) {
    if ((status?.state ?? "running") === "running") continue;
    if (cutoff !== null) {
      const done = status?.done_ms ?? meta.created_ms;
      if (done > cutoff) continue;
    }
    fs.rmSync(jobDir(root, meta.id), { recursive: true, force: true });
    removed++;
  }
  console.log(`removed ${removed} jobs`);
  return 0;
}

function parseDurationMs(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!m) throw new UsageError(`bad duration '${s}': use like 24h, 7d, 30m`);
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
  if (ms < 1000) throw new UsageError(`bad --heartbeat '${raw}': minimum is 1s`);
  return ms;
}

/** Last non-empty line of the job log ("" when nothing yet). */
function lastOutputLine(dir: string): string {
  return tailLog(dir, 5).split("\n").filter((l) => l.trim() !== "").pop() ?? "";
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
  const p = parseArgs(argv, ["no-heartbeat"]);
  unknownFlags(p, ["name", "notify", "cwd", "heartbeat", "no-heartbeat", "wait"]);
  if (bool(p, "help")) {
    console.log(HELP["run"]);
    return 0;
  }
  if (p.positionals.length === 0) throw new UsageError("run needs a command after `--`");
  const heartbeatMs = parseHeartbeatMs(str(p, "heartbeat"), bool(p, "no-heartbeat"));
  const waitRaw = str(p, "wait");
  const waitMs = waitRaw === undefined ? undefined : parseDurationMs(waitRaw.trim());
  const cwd = str(p, "cwd") ?? process.cwd();
  try {
    const st = fs.statSync(cwd);
    if (!st.isDirectory()) throw new UsageError(`bad --cwd '${cwd}': not a directory`);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`bad --cwd '${cwd}': no such directory`);
  }
  const exe = p.positionals[0]!;
  if (resolveExecutable(exe) === null) throw new UsageError(`cannot start '${exe}': executable not found on PATH`);
  const root = stateRoot();
  const id = freshId(root);
  const dir = jobDir(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const owner = currentOwner();
  const target = defaultTarget(str(p, "notify"), owner);
  const meta: Meta = {
    id,
    name: sanitizeName(str(p, "name") ?? "job"),
    command: p.positionals,
    cwd,
    created_ms: nowMs(),
    owner,
    notify_target: target,
    heartbeat_ms: heartbeatMs,
    child_pid: null,
    supervisor_pid: null,
    child_lstart: null,
    supervisor_lstart: null,
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
    last_heartbeat_ms: null,
    last_heartbeat_detail: "",
    error: null,
  });
  fs.writeFileSync(path.join(dir, "output.log"), "");
  spawnSupervisor(id);
  console.log(`job ${id}`);
  if (target === "") {
    console.log(`notify skipped (no herdr pane and no --notify); read with: agent-shell show ${id}`);
  } else {
    console.log(`notify ${target}`);
  }
  const notifyWarning = checkNotifyTarget(str(p, "notify"));
  if (notifyWarning !== null) console.log(notifyWarning);
  console.log(`heartbeat ${heartbeatMs === null ? "off" : `every ${formatElapsed(heartbeatMs)}`}`);
  console.log(`read with: agent-shell show ${id}`);
  if (waitMs === undefined) return 0;
  const deadline = Date.now() + waitMs;
  let status = readStatus(dir);
  while ((status?.state ?? "running") === "running" && Date.now() < deadline) {
    await Bun.sleep(200);
    status = readStatus(dir);
  }
  if ((status?.state ?? "running") === "running") {
    console.log(`still running after ${formatElapsed(waitMs)}; read with: agent-shell show ${id}`);
    return 124;
  }
  const out = tailLog(dir, 30);
  if (out.trim() !== "") console.log(`--- output (last 30 lines) ---\n${out}`);
  console.log(`exit ${status?.exit_code ?? "?"}`);
  const code = status?.exit_code;
  if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255) return code;
  return 1;
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
  const logPath = path.join(dir, "output.log");
  const logFd = fs.openSync(logPath, "a");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(meta.command, {
      cwd: meta.cwd,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
  } catch (e) {
    fs.closeSync(logFd);
    const msg = e instanceof Error ? e.message : String(e);
    const startError = `could not start '${meta.command.join(" ")}': ${msg}`;
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
      last_heartbeat_ms: null,
      last_heartbeat_detail: "",
      error: startError,
    });
    const text = `shell job '${meta.name}' failed to start: ${msg}. Read with: agent-shell show ${meta.id}`;
    const result = notify(meta.notify_target, text);
    const cur = readStatus(dir);
    if (cur && cur.state === "killed") return 0;
    writeStatus(dir, {
      state: "failed",
      exit_code: -1,
      done_ms: failedAt,
      duration_ms: failedAt - started,
      ...statusFromNotify(result),
      heartbeats: 0,
      last_heartbeat_ms: null,
      last_heartbeat_detail: "",
      error: startError,
    });
    return 0;
  }
  meta.child_pid = proc.pid;
  meta.child_lstart = procStartTime(proc.pid);
  writeMeta(dir, meta);

  let heartbeats = 0;
  let lastHeartbeatMs: number | null = null;
  let lastHeartbeatDetail = "";
  let finished = false;
  let exitCode: number | undefined;
  proc.exited.then(
    (c) => {
      finished = true;
      exitCode = c;
    },
    () => {
      finished = true;
    },
  );

  // Progress notifies while the command runs: last output line every heartbeatMs,
  // via `hcx send --if idle` so a busy agent is skipped (a skipped heartbeat
  // is not a failure and is not retried). Completion never uses `--if`.
  // Skipped entirely when disabled or when there is no notify target.
  // The wait races the heartbeat interval against process exit, so a job
  // shorter than the interval finishes at once with no progress notify.
  // An unreadable status (null) is not "not running": keep supervising.
  if (heartbeatMs !== null && meta.notify_target !== "") {
    const done = proc.exited.then(
      () => {},
      () => {},
    );
    for (;;) {
      await Promise.race([done, Bun.sleep(heartbeatMs)]);
      if (finished) break;
      if ((proc.exitCode ?? null) !== null) break;
      const cur = readStatus(dir);
      if (cur && cur.state !== "running") return 0;
      const elapsed = nowMs() - started;
      const last = lastOutputLine(dir);
      const hbText =
        `shell job '${meta.name}' still running (${formatElapsed(elapsed)} elapsed). ` +
        (last !== "" ? `Last line: ${last.slice(0, 160)}. ` : `No output yet. `) +
        `No action needed; completion will notify. Read with: agent-shell tail ${meta.id}`;
      const hbResult = notify(meta.notify_target, hbText, { ifIdle: true });
      if (hbResult.outcome === "delivered" || hbResult.outcome === "unconfirmed") heartbeats++;
      lastHeartbeatMs = nowMs();
      lastHeartbeatDetail = hbResult.detail;
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
        heartbeats,
        last_heartbeat_ms: lastHeartbeatMs,
        last_heartbeat_detail: lastHeartbeatDetail,
        error: null,
      });
      if (finished) break;
    }
  }

  const code = exitCode ?? (await proc.exited);
  fs.closeSync(logFd);
  // A kill that landed while the child exited wins: keep the killed state.
  const cur = readStatus(dir);
  if (cur && cur.state === "killed") return 0;
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
    heartbeats,
    last_heartbeat_ms: lastHeartbeatMs,
    last_heartbeat_detail: lastHeartbeatDetail,
    error: null,
  });
  const lastLine = lastOutputLine(dir);
  const secs = ((done - started) / 1000).toFixed(1);
  let text = `shell job '${meta.name}' done (exit ${code}, ${secs}s). Read with: agent-shell show ${meta.id}`;
  if (lastLine !== "") text += ` Last line: ${lastLine.slice(0, 160)}`;
  const result = notify(meta.notify_target, text);
  const raced = readStatus(dir);
  if (raced && raced.state === "killed") return 0;
  writeStatus(dir, {
    state: finalState,
    exit_code: code,
    done_ms: done,
    duration_ms: done - started,
    ...statusFromNotify(result),
    heartbeats,
    last_heartbeat_ms: lastHeartbeatMs,
    last_heartbeat_detail: lastHeartbeatDetail,
    error: null,
  });
  return 0;
}
