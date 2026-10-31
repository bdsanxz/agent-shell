// Job storage: one directory per job under the state root.
//
// `<root>/jobs/<id>/meta.json`, `output.log`, `status.json`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Owner {
  pane_id: string;
  /** The herdr-core terminal that ran the job, when it runs outside old herdr. */
  terminal_id?: string;
  agent_name: string;
  workspace_id: string;
}

export const DEFAULT_HEARTBEAT_MS = 120_000;

/** The default heartbeat interval, injectable for tests via
 * `AGENT_SHELL_DEFAULT_HEARTBEAT_MS` (milliseconds). */
export function defaultHeartbeatMs(): number {
  const raw = process.env.AGENT_SHELL_DEFAULT_HEARTBEAT_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_HEARTBEAT_MS;
}

/** Max bytes read from the tail of output.log in one go (256 KiB). */
export const LOG_READ_CAP_BYTES = 256 * 1024;

/** Cap for heartbeat back-off, injectable for tests via
 * `AGENT_SHELL_HEARTBEAT_MAX_MS` (milliseconds). */
export const DEFAULT_HEARTBEAT_MAX_MS = 30 * 60 * 1000;
export function heartbeatMaxMs(): number {
  const raw = process.env.AGENT_SHELL_HEARTBEAT_MAX_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 1000) return n;
  }
  return DEFAULT_HEARTBEAT_MAX_MS;
}

export interface Meta {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  created_ms: number;
  owner: Owner;
  /** Caller-scoped owner: AGENT_SHELL_OWNER else HC_TERMINAL_ID else
   * HERDR_PANE_ID else null. Absent (undefined) means a pre-0.6.0 job. */
  owner_id?: string | null;
  notify_target: string;
  /** Interval between progress notifies while running; null disables them. */
  heartbeat_ms: number | null;
  child_pid: number | null;
  supervisor_pid: number | null;
  /** `ps -o lstart` output for the child at spawn; null when unknown. Used to
   * avoid signalling a reused PID. */
  child_lstart?: string | null;
  /** `ps -o lstart` output for the supervisor at start; null when unknown. */
  supervisor_lstart?: string | null;
  /** Process group id of the job child (group leader); null when unknown. */
  pgid?: number | null;
  /** When true, heartbeat back-off is disabled; the base interval stays fixed. */
  heartbeat_fixed?: boolean;
}

export interface Status {
  state: string;
  exit_code: number | null;
  done_ms: number | null;
  duration_ms: number | null;
  notified: boolean;
  notify_detail: string;
  /** Typed notify outcome: delivered | not_started | unconfirmed | plain_shell | failed | skipped_busy ("" when no notify was attempted). */
  notify_outcome: string;
  /** Machine fields from `hcx send --json` when the send ran; null otherwise. */
  notify_route: string | null;
  notify_agent: string | null;
  notify_note: string | null;
  /** Progress notifies sent while the job was running (alias of heartbeats_sent). */
  heartbeats: number;
  /** Breakdown of heartbeat attempts: sent, skipped for back-off, skipped for busy target, failed. */
  heartbeats_sent?: number;
  heartbeats_skipped_backoff?: number;
  heartbeats_skipped_busy?: number;
  heartbeats_failed?: number;
  /** Delayed-then-sent busy beats; old files default to 0. */
  heartbeats_deferred?: number;
  last_heartbeat_ms: number | null;
  last_heartbeat_detail: string;
  /** Start-up failure (missing executable, bad cwd, spawn error); null otherwise. */
  error: string | null;
  /** Current heartbeat interval with back-off applied; null when disabled or unknown. */
  heartbeat_current_ms?: number | null;
}

export function stateRoot(): string {
  if (process.env.AGENT_SHELL_HOME) return process.env.AGENT_SHELL_HOME;
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "agent-shell");
  return path.join(os.homedir(), ".local", "cache", "agent-shell");
}

export function jobsDir(root: string): string {
  return path.join(root, "jobs");
}

export function jobDir(root: string, id: string): string {
  return path.join(jobsDir(root), id);
}

export function nowMs(): number {
  return Date.now();
}

export function readMeta(dir: string): Meta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as Partial<Meta>;
    if (!raw || typeof (raw as Meta).id !== "string") return null;
    return {
      ...(raw as Meta),
      heartbeat_ms: raw.heartbeat_ms === undefined ? defaultHeartbeatMs() : raw.heartbeat_ms,
      pgid: raw.pgid ?? null,
      heartbeat_fixed: raw.heartbeat_fixed ?? false,
    };
  } catch {
    return null;
  }
}

/** Atomic write: temp file in the same directory, then rename. */
function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.tmp.${process.pid}.${Math.floor(Math.random() * 1_000_000)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function writeMeta(dir: string, meta: Meta): void {
  const file = path.join(dir, "meta.json");
  atomicWrite(file, JSON.stringify(meta, null, 2) + "\n");
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort; the file is already written
  }
}

export function readStatus(dir: string): Status | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")) as Partial<Status>;
    if (!raw || typeof (raw as Status).state !== "string") return null;
    const sent = raw.heartbeats_sent ?? raw.heartbeats ?? 0;
    return {
      ...(raw as Status),
      heartbeats: raw.heartbeats ?? sent,
      heartbeats_sent: sent,
      heartbeats_skipped_backoff: raw.heartbeats_skipped_backoff ?? 0,
      heartbeats_skipped_busy: raw.heartbeats_skipped_busy ?? 0,
      heartbeats_failed: raw.heartbeats_failed ?? 0,
      heartbeats_deferred: raw.heartbeats_deferred ?? 0,
      last_heartbeat_ms: raw.last_heartbeat_ms ?? null,
      last_heartbeat_detail: raw.last_heartbeat_detail ?? "",
      error: raw.error ?? null,
      notify_outcome: raw.notify_outcome ?? "",
      notify_route: raw.notify_route ?? null,
      notify_agent: raw.notify_agent ?? null,
      notify_note: raw.notify_note ?? null,
      heartbeat_current_ms: raw.heartbeat_current_ms ?? null,
    };
  } catch {
    return null;
  }
}

/** Caller identity for job ownership: AGENT_SHELL_OWNER else HC_TERMINAL_ID
 * else HERDR_PANE_ID else null. Empty strings count as unset. */
export function callerOwner(): string | null {
  const override = (process.env.AGENT_SHELL_OWNER ?? "").trim();
  if (override !== "") return override;
  const hc = (process.env.HC_TERMINAL_ID ?? "").trim();
  if (hc !== "") return hc;
  const pane = (process.env.HERDR_PANE_ID ?? "").trim();
  if (pane !== "") return pane;
  return null;
}

/** True when a stored job belongs to the current caller. Legacy jobs (no
 * owner_id key) belong to nobody: only --all shows them. */
export function isOwnJob(meta: Meta, caller: string | null): boolean {
  if (!("owner_id" in meta) || (meta as unknown as Record<string, unknown>)["owner_id"] === undefined) return false;
  return (meta.owner_id ?? null) === caller;
}

/** POSIX shell quoting: single-quote any argument with characters outside
 * [A-Za-z0-9_@%+=:,./-] (or empty), escaping embedded single quotes. */
export function shellQuote(argv: string[]): string {
  return argv
    .map((a) => {
      if (a !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) return a;
      return `'${a.replace(/'/g, `'\\''`)}'`;
    })
    .join(" ");
}

export function writeStatus(dir: string, status: Status): void {
  const file = path.join(dir, "status.json");
  atomicWrite(file, JSON.stringify(status, null, 2) + "\n");
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

/** A short unique job id: `sh-<millis>-<pid>`, plus a suffix when taken. */
export function freshId(root: string): string {
  const base = `sh-${nowMs()}-${process.pid}`;
  for (let n = 0; n < 100; n++) {
    const id = n === 0 ? base : `${base}-${n}`;
    if (!fs.existsSync(jobDir(root, id))) return id;
  }
  return `${base}-${nowMs() % 100000}`;
}

/** Read at most the last LOG_READ_CAP_BYTES of output.log, then take the
 * last `n` lines. Returns the text plus whether the read hit the cap. */
export function readTailDetailed(dir: string, n: number, cap = LOG_READ_CAP_BYTES): { text: string; truncated: boolean } {
  const file = path.join(dir, "output.log");
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { text: "", truncated: false };
  }
  if (size <= 0) return { text: "", truncated: false };
  const truncated = size > cap;
  const start = truncated ? size - cap : 0;
  const len = truncated ? cap : size;
  let chunk = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      chunk = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: "", truncated: false };
  }
  // When cut mid-file, the first line is partial; drop it.
  if (truncated) {
    const nl = chunk.indexOf("\n");
    if (nl >= 0) chunk = chunk.slice(nl + 1);
  }
  const lines = chunk.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out = lines.slice(Math.max(0, lines.length - Math.max(1, n))).join("\n");
  return { text: out, truncated };
}

/** Last `n` lines of the job log (empty string when no log yet).
 * Bounded: reads at most LOG_READ_CAP_BYTES from the end. */
export function tailLog(dir: string, n: number): string {
  return readTailDetailed(dir, n).text;
}

/** Collapse `\r` progress bars (keep text after the last `\r` on a line),
 * strip ANSI CSI/OSC escapes and other control characters except `\n` and `\t`. */
export function sanitiseOutput(text: string): string {
  const lines = text.split("\n").map((line) => {
    const afterCr = line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line;
    const ESC = "\u001b";
    let s = afterCr.replace(new RegExp(ESC + "\\][^\u0007" + ESC + "]*(?:\u0007|" + ESC + "\\\\)", "g"), "");
    s = s.replace(new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g"), "");
    s = s.replace(new RegExp(ESC + "[()#%*+][0-9A-Za-z]", "g"), "");
    s = s.replace(new RegExp(ESC + ".", "g"), "");
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    return s;
  });
  return lines.join("\n");
}
