// Job storage: one directory per job under the state root.
//
// `<root>/jobs/<id>/meta.json`, `output.log`, `status.json`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Owner {
  pane_id: string;
  agent_name: string;
  workspace_id: string;
}

export interface Meta {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  created_ms: number;
  owner: Owner;
  notify_target: string;
  child_pid: number | null;
  supervisor_pid: number | null;
}

export interface Status {
  state: string;
  exit_code: number | null;
  done_ms: number | null;
  duration_ms: number | null;
  notified: boolean;
  notify_detail: string;
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
    return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as Meta;
  } catch {
    return null;
  }
}

export function writeMeta(dir: string, meta: Meta): void {
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

export function readStatus(dir: string): Status | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")) as Status;
  } catch {
    return null;
  }
}

export function writeStatus(dir: string, status: Status): void {
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status, null, 2) + "\n");
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

/** Last `n` lines of the job log (empty string when no log yet). */
export function tailLog(dir: string, n: number): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "output.log"), "utf8");
  } catch {
    return "";
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - Math.max(1, n))).join("\n");
}
