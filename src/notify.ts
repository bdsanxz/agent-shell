// Notification: one fire-and-forget turn, never `--wait`: `herdr agent
// prompt`, falling back to herdr-core when the old herdr server is stopped.
// On herdr-core an agent target gets `hcx send --no-footer` (untagged, no
// sender footer; needs hcx 0.1.3 or newer); a plain shell keeps `hc send`
// (tagged), since raw text would run as a command in its prompt. The kind
// comes from the live terminal list, and a tab listed as a plain shell is
// checked once more for its foreground program (an opencode tab is an agent,
// not a shell); a target whose kind is unknown also keeps the tagged send. An
// hcx without the flag (older or with an unreadable version) keeps the tagged
// send for an agent target too, with a note saying why.
//
// The target is the pane, agent or terminal that ran the job. Delivery is
// best effort: a failed notify never fails the job, it is recorded instead.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
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

/** The foreground program of a terminal address via `hc get`: the basename of
 * `foreground.name`, lower case. Empty when the get fails, the JSON is
 * unparseable, or the shape has no name. */
function hcForeground(address: string): string {
  try {
    const p = spawnSync("hc", ["get", address], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (p.status !== 0) return "";
    const v = JSON.parse(p.stdout as string) as { foreground?: unknown };
    if (typeof v.foreground !== "object" || v.foreground === null) return "";
    const rec = v.foreground as Record<string, unknown>;
    const name = typeof rec["name"] === "string" ? (rec["name"] as string) : "";
    return basename(name).trim().toLowerCase();
  } catch {
    return "";
  }
}

/** The agent kind behind a target, from `hc ls --json`: "muse", "claude-code",
 * "opencode", ... Empty when the target matches no live terminal or the list is
 * unreadable. A tab whose agent is a shell kind is checked once more with `hc get`:
 * its foreground program wins (an opencode login shell is an agent, not a shell). */
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
      const agent = typeof rec["agent"] === "string" ? (rec["agent"] as string).trim().toLowerCase() : "";
      if (SHELLS.has(agent)) {
        const foreground = hcForeground(address);
        if (foreground !== "" && !SHELLS.has(foreground)) return foreground;
      }
      return agent;
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
  /** The note for this route, such as `notified t9 via hcx send --no-footer`. */
  detail: string;
  /** The short failure reason, for the fallback note. */
  reason: string;
}

/** Whether the installed hcx can send without a footer, else why not. */
interface HcNoFooter {
  ok: boolean;
  reason: string;
}

/** The hcx version from the first line of `hcx --version` ("hcx 0.1.3"), or
 * null when hcx is absent, the call fails, or the line does not parse. */
function hcxVersion(): { major: number; minor: number; patch: number } | null {
  try {
    const p = spawnSync("hcx", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (p.status !== 0) return null;
    const first = (p.stdout as string).split("\n")[0]?.trim() ?? "";
    const m = first.match(/^hcx\s+v?(\d+)\.(\d+)\.(\d+)/);
    if (m === null) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  } catch {
    return null;
  }
}

/** Whether `hcx send --no-footer` is supported here: hcx 0.1.3 or newer.
 * Cached for the process, so a job checks the version at most once — an old
 * hcx would treat `--no-footer` as message text, not a flag. */
let hcxNoFooterResult: HcNoFooter | null = null;

function hcxNoFooter(): HcNoFooter {
  if (hcxNoFooterResult === null) {
    const v = hcxVersion();
    if (v === null) {
      hcxNoFooterResult = { ok: false, reason: "hcx version unknown (--no-footer needs hcx 0.1.3+)" };
    } else if (v.major > 0 || (v.major === 0 && v.minor > 1) || (v.major === 0 && v.minor === 1 && v.patch >= 3)) {
      hcxNoFooterResult = { ok: true, reason: "" };
    } else {
      hcxNoFooterResult = { ok: false, reason: "hcx older than 0.1.3" };
    }
  }
  return hcxNoFooterResult;
}

/** Untagged send with no sender footer: `hcx send --no-footer`. Only called
 * when hcxNoFooter() says the installed hcx supports the flag. */
function hcxNotify(target: string, text: string): HcResult {
  try {
    const p = spawnSync("hcx", ["send", "--no-footer", target, text], { encoding: "utf8" });
    if (p.status === 0) return { ok: true, detail: `notified ${target} via hcx send --no-footer`, reason: "" };
    const err = (p.stderr as string).trim();
    const reason = err === "" ? `exit ${p.status}` : err.split("\n")[0]!;
    return { ok: false, detail: `hcx send to ${target} failed: ${reason}`, reason };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `hcx send to ${target} failed: ${reason}`, reason };
  }
}

/** Route over herdr-core: an agent target gets `hcx send --no-footer` (untagged,
 * no sender footer) when the installed hcx supports it. A shell kind, or a kind
 * that cannot be determined, keeps the tagged `hc send`, as does an hcx without
 * the flag (older or unreadable version): the raw text, or the flag read as
 * text, would run as a command in a shell prompt. A failed no-footer send falls
 * back to the tagged one, and the note names that fallback. */
function hcRoute(target: string, text: string, hasHcx: boolean): string {
  if (!hasHcx) return hcNotify(target, text);
  const kind = hcTargetKind(target);
  if (kind === "" || SHELLS.has(kind)) return hcNotify(target, text);
  const support = hcxNoFooter();
  if (!support.ok) return `${hcNotify(target, text)} (${support.reason})`;
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
