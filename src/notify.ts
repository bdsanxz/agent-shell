// Notification: one fire-and-forget turn, never `--wait`: `herdr agent
// prompt`, falling back to `hc send` when the old herdr server is stopped.
//
// The target is the pane, agent or terminal that ran the job. Delivery is
// best effort: a failed notify never fails the job, it is recorded instead.

import { spawnSync } from "node:child_process";
import type { Owner } from "./store.ts";

/** Resolve the notify target: explicit `--notify`, else the owner's pane or hc terminal. */
export function defaultTarget(explicit: string | undefined, owner: Owner): string {
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  if (owner.pane_id !== "") return owner.pane_id;
  if ((owner.terminal_id ?? "") !== "") return owner.terminal_id as string;
  return owner.agent_name;
}

/** Capture the owner's herdr and herdr-core context from the environment. */
export function currentOwner(): Owner {
  return {
    pane_id: process.env.HERDR_PANE_ID ?? "",
    terminal_id: process.env.HC_TERMINAL_ID ?? "",
    agent_name: "",
    workspace_id: process.env.HERDR_WORKSPACE_ID ?? "",
  };
}

function haveHerdr(): boolean {
  try {
    const p = spawnSync("sh", ["-c", "command -v herdr"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return p.status === 0 && (p.stdout as string).trim() !== "";
  } catch {
    return false;
  }
}

function haveHc(): boolean {
  try {
    const p = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return p.status === 0 && (p.stdout as string).trim() !== "";
  } catch {
    return false;
  }
}

function herdrNotify(target: string, text: string): string {
  try {
    const p = spawnSync("herdr", ["agent", "prompt", target, text], { encoding: "utf8" });
    if (p.status === 0) return `notified ${target}`;
    const err = (p.stderr as string).trim();
    if (err === "") return `notify to ${target} failed: exit ${p.status}`;
    return `notify to ${target} failed: ${err.split("\n")[0]}`;
  } catch (e) {
    return `notify to ${target} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function hcNotify(target: string, text: string): string {
  try {
    const p = spawnSync("hc", ["send", target, text], { encoding: "utf8" });
    if (p.status === 0) return `notified ${target} via hc send`;
    const err = (p.stderr as string).trim();
    if (err === "") return `notify to ${target} via hc send failed: exit ${p.status}`;
    return `notify to ${target} via hc send failed: ${err.split("\n")[0]}`;
  } catch (e) {
    return `notify to ${target} via hc send failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Send one notification turn. Returns a human-readable detail line. */
export function notify(target: string, text: string): string {
  if (target.trim() === "") return "skipped: no notify target (outside herdr and herdr-core, and no --notify)";
  const herdr = haveHerdr();
  const hc = haveHc();
  if (!herdr && !hc) return "skipped: herdr is not on PATH and hc is not on PATH";
  if (herdr) {
    const done = herdrNotify(target, text);
    if (done.startsWith("notified")) return done;
    if (!hc) return done;
    const fallback = hcNotify(target, text);
    if (fallback.startsWith("notified")) return fallback;
    return `${done}; ${fallback}`;
  }
  return hcNotify(target, text) as string;
}
