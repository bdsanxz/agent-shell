// Notification: one fire-and-forget `herdr agent prompt`, never `--wait`.
//
// The target is the pane or agent that ran the job. Delivery is best
// effort: a failed notify never fails the job, it is recorded instead.

import { spawnSync } from "node:child_process";
import type { Owner } from "./store.ts";

/** Resolve the notify target: explicit `--notify`, else the owner's pane. */
export function defaultTarget(explicit: string | undefined, owner: Owner): string {
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  if (owner.pane_id !== "") return owner.pane_id;
  return owner.agent_name;
}

/** Capture the owner's herdr context from the environment. */
export function currentOwner(): Owner {
  return {
    pane_id: process.env.HERDR_PANE_ID ?? "",
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

/** Send one notification turn. Returns a human-readable detail line. */
export function notify(target: string, text: string): string {
  if (target.trim() === "") return "skipped: no notify target (outside herdr and no --notify)";
  if (!haveHerdr()) return "skipped: herdr is not on PATH";
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
