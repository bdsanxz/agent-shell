// Notification: one fire-and-forget turn, never `--wait`: `herdr agent
// prompt`, falling back to herdr-core when the old herdr server is stopped.
// On herdr-core an agent target gets `hcx send` (untagged, with a sender
// footer); a plain shell keeps `hc send` (tagged), since it would run the
// footer as a command. The kind comes from the live terminal list, so a target
// whose kind is unknown also keeps the tagged send.
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

function haveHcx(): boolean {
  try {
    const p = spawnSync("sh", ["-c", "command -v hcx"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return p.status === 0 && (p.stdout as string).trim() !== "";
  } catch {
    return false;
  }
}

/** Plain shells: an untagged footer would run as a command, so they keep `hc send`. */
const SHELLS = new Set(["zsh", "sh", "bash", "fish", "dash", "ksh", "nu", "pwsh"]);

/** The agent kind behind a target, from `hc ls --json`: "muse", "claude-code", "zsh",
 * ... Empty when the target matches no live terminal or the list is unreadable. */
function hcTargetKind(target: string): string {
  try {
    const p = spawnSync("hc", ["ls", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (p.status !== 0) return "";
    const v = JSON.parse(p.stdout as string) as { terminals?: unknown };
    if (!Array.isArray(v.terminals)) return "";
    const want = target.trim().toLowerCase();
    for (const t of v.terminals) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const address = typeof rec["address"] === "string" ? (rec["address"] as string) : "";
      const name = typeof rec["name"] === "string" ? (rec["name"] as string) : "";
      if (address.toLowerCase() !== want && name.toLowerCase() !== want) continue;
      return typeof rec["agent"] === "string" ? (rec["agent"] as string).trim().toLowerCase() : "";
    }
    return "";
  } catch {
    return "";
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

interface HcResult {
  ok: boolean;
  /** The note for this route, such as `notified t9 via hcx send`. */
  detail: string;
  /** The short failure reason, for the fallback note. */
  reason: string;
}

/** Untagged send: `hcx` adds the sender footer instead of a `<hc from>` tag. */
function hcxNotify(target: string, text: string): HcResult {
  try {
    const p = spawnSync("hcx", ["send", target, text], { encoding: "utf8" });
    if (p.status === 0) return { ok: true, detail: `notified ${target} via hcx send`, reason: "" };
    const err = (p.stderr as string).trim();
    const reason = err === "" ? `exit ${p.status}` : err.split("\n")[0]!;
    return { ok: false, detail: `hcx send to ${target} failed: ${reason}`, reason };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `hcx send to ${target} failed: ${reason}`, reason };
  }
}

/** Route over herdr-core: `hcx send` (untagged) only for a target whose live terminal
 * kind is a known agent. A shell kind, or a kind that cannot be determined, keeps the
 * tagged `hc send`: the hcx footer would run as a command in a shell prompt. A failed
 * untagged send falls back to the tagged one, and the note names that fallback. */
function hcRoute(target: string, text: string, hasHcx: boolean): string {
  if (!hasHcx) return hcNotify(target, text);
  const kind = hcTargetKind(target);
  if (kind === "" || SHELLS.has(kind)) return hcNotify(target, text);
  const plain = hcxNotify(target, text);
  if (plain.ok) return plain.detail;
  const tagged = hcNotify(target, text);
  if (tagged.startsWith("notified")) return `${tagged} (hcx failed: ${plain.reason})`;
  return `${plain.detail}; ${tagged}`;
}

/** Send one notification turn. Returns a human-readable detail line. */
export function notify(target: string, text: string): string {
  if (target.trim() === "") return "skipped: no notify target (outside herdr and herdr-core, and no --notify)";
  const herdr = haveHerdr();
  const hc = haveHc();
  const hcx = haveHcx();
  if (!herdr && !hc && !hcx) return "skipped: herdr is not on PATH and neither hc nor hcx is on PATH";
  if (herdr) {
    const done = herdrNotify(target, text);
    if (done.startsWith("notified")) return done;
    if (!hc && !hcx) return done;
    const fallback = hcRoute(target, text, hcx);
    if (fallback.startsWith("notified")) return fallback;
    return `${done}; ${fallback}`;
  }
  return hcRoute(target, text, hcx);
}
