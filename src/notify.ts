// Notification: one fire-and-forget turn, never `--wait`: `herdr agent
// prompt`, falling back to herdr-core via hcx 0.3.0 when the old herdr server
// is stopped. On herdr-core the only route is `hcx send --agent-only
// --no-footer --json`: hcx looks the kind up first and refuses a plain shell
// or an unknown kind BEFORE sending (kind `plain_shell`, exit 4). Success
// prints hc's JSON plus `delivered` (true / false / null), `route`, `agent`
// and `note`. There is no `hc send` fallback: typing raw text into a shell
// would run it as a command.
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
    const p = spawnSync("sh", ["-c", "command -v herdr"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });
    return p.status === 0 && (p.stdout as string).trim() !== "";
  } catch {
    return false;
  }
}

/** Send timeouts: completion 30s, heartbeat 10s, `hcx ls` pre-check 5s. */
export const COMPLETION_TIMEOUT_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const HCX_LS_TIMEOUT_MS = 5_000;

/** The typed notify outcome. `delivered` is a confirmed turn, `not_started`
 * is a confirmed send that started no turn (do not resend), `unconfirmed` is
 * `delivered: null` (opencode TUI or shell with no turn status, never resend)
 * or a completion send that timed out (exit null / kind timeout: it may have
 * landed, never resend), `plain_shell` is the pre-send refusal (exit 4,
 * queued not delivered), `skipped_busy` is a heartbeat skipped because the
 * target is working or blocked (not a failure), and `failed` is anything
 * else (never retry automatically). */
export type NotifyOutcome =
  | "delivered"
  | "not_started"
  | "unconfirmed"
  | "plain_shell"
  | "skipped_busy"
  | "failed";

/** Cached per process: true once the old herdr route has shown the server is
 * not running, so later notifies skip it silently. */
let herdrUnavailableCached = false;

/** Reset the herdr-route cache (tests only). */
export function resetHerdrCacheForTests(): void {
  herdrUnavailableCached = false;
}

function isServerNotRunning(text: string): boolean {
  return text.includes("server_not_running");
}

/** One notify attempt: the outcome plus the human-readable detail line, and
 * the machine fields from `hcx send --json` when the send ran. */
export interface NotifyResult {
  outcome: NotifyOutcome;
  detail: string;
  route: string | null;
  agent: string | null;
  note: string | null;
}

/** Whether this hcx can do the 0.3.0 route, else why not. Cached per process. */
interface HcxSupport {
  ok: boolean;
  reason: string;
}

let hcxSupportResult: HcxSupport | null = null;

/** hcx 0.3.0 or newer: `hcx --version --json` with `contract` >= 1 and
 * `capabilities` containing `agent-only` and `no-footer`. An older hcx would
 * read `--agent-only` as message text, so this gate cannot be skipped. */
export function hcxSupport(): HcxSupport {
  if (hcxSupportResult === null) {
    hcxSupportResult = checkHcxSupport();
  }
  return hcxSupportResult;
}

/** Reset the cached support (tests only). */
export function resetHcxSupportForTests(): void {
  hcxSupportResult = null;
}

function checkHcxSupport(): HcxSupport {
  try {
    const p = spawnSync("hcx", ["--version", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8000,
    });
    if (p.status !== 0) {
      const err = ((p.stderr as string) ?? "").trim() || ((p.stdout as string) ?? "").trim();
      const why = err === "" ? `exit ${p.status}` : err.split("\n")[0]!;
      return { ok: false, reason: `hcx --version --json failed (${why})` };
    }
    let v: unknown;
    try {
      v = JSON.parse(p.stdout as string);
    } catch {
      return { ok: false, reason: "hcx version output is not JSON" };
    }
    if (typeof v !== "object" || v === null) return { ok: false, reason: "hcx version output is not JSON" };
    const rec = v as Record<string, unknown>;
    const contract = typeof rec["contract"] === "number" ? (rec["contract"] as number) : 0;
    const caps = Array.isArray(rec["capabilities"])
      ? (rec["capabilities"] as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    if (contract >= 1 && caps.includes("agent-only") && caps.includes("no-footer")) {
      return { ok: true, reason: "" };
    }
    return { ok: false, reason: "hcx is older than 0.3.0 (needs contract 1 with agent-only and no-footer)" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT/i.test(msg)) return { ok: false, reason: "hcx is not on PATH" };
    return { ok: false, reason: `hcx version check failed (${msg.split("\n")[0]})` };
  }
}

function herdrNotify(target: string, text: string, timeoutMs: number, isCompletion: boolean): NotifyResult {
  try {
    const p = spawnSync("herdr", ["agent", "prompt", target, text], { encoding: "utf8", timeout: timeoutMs });
    if (p.status === 0) return { outcome: "delivered", detail: `notified ${target}`, route: null, agent: null, note: null };
    const err = ((p.stderr as string) ?? "").trim();
    const reason = err === "" ? `exit ${p.status}` : err.split("\n")[0]!;
    if (p.status === null && isCompletion) {
      return {
        outcome: "unconfirmed",
        detail: `notify to ${target} timed out after ${Math.round(timeoutMs / 1000)}s (delivery not verified; the message may have landed, never retry): ${reason}`,
        route: null,
        agent: null,
        note: null,
      };
    }
    return { outcome: "failed", detail: `notify to ${target} failed: ${reason}`, route: null, agent: null, note: null };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const first = reason.split("\n")[0]!;
    if (isCompletion && (/timed out|timeout|ETIMEDOUT|exit null/i.test(first) || /spawnSync.*timeout/i.test(reason))) {
      return {
        outcome: "unconfirmed",
        detail: `notify to ${target} timed out after ${Math.round(timeoutMs / 1000)}s (delivery not verified; the message may have landed, never retry): ${first}`,
        route: null,
        agent: null,
        note: null,
      };
    }
    return { outcome: "failed", detail: `notify to ${target} failed: ${first}`, route: null, agent: null, note: null };
  }
}

/** Read the target's status via `hcx ls --json` (one call, 5s timeout).
 * Matches the terminal address or name. Returns the lowercase status, or
 * null when unknown (ls failed, timed out, or no match): callers send
 * anyway (fail-open). */
function hcxTargetStatus(target: string): string | null {
  let p: ReturnType<typeof spawnSync>;
  try {
    p = spawnSync("hcx", ["ls", "--json"], { encoding: "utf8", timeout: HCX_LS_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (p.status !== 0) return null;
  const raw = ((p.stdout as string) ?? "").trim();
  if (raw === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  let items: unknown[] | null = null;
  if (Array.isArray(v)) items = v;
  else if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    for (const key of ["agents", "terminals", "panes", "items", "list", "tabs", "sessions"]) {
      if (Array.isArray(rec[key])) {
        items = rec[key] as unknown[];
        break;
      }
    }
    if (!items) {
      for (const val of Object.values(rec)) {
        if (Array.isArray(val)) {
          items = val as unknown[];
          break;
        }
      }
    }
  }
  if (!items) return null;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const candidates: string[] = [];
    for (const key of ["address", "pane", "pane_id", "name", "terminal", "terminal_id", "id", "tab", "title"]) {
      const val = rec[key];
      if (typeof val === "string" && val !== "") candidates.push(val);
    }
    if (!candidates.includes(target)) continue;
    const status = rec["status"];
    if (typeof status === "string" && status !== "") return status.toLowerCase();
    return null;
  }
  return null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/** The hc-shape error hcx prints (`{"error":{"kind","message","hint"}}`), from
 * stdout or stderr. Null when neither side parses to that shape. */
function parseHcxError(stdout: string, stderr: string): { kind: string; message: string; hint: string } | null {
  for (const side of [stdout, stderr]) {
    const v = tryParseJson(side.trim());
    if (!v) continue;
    const err = v["error"];
    if (typeof err !== "object" || err === null) continue;
    const rec = err as Record<string, unknown>;
    if (typeof rec["kind"] !== "string") continue;
    return {
      kind: rec["kind"] as string,
      message: typeof rec["message"] === "string" ? (rec["message"] as string) : "",
      hint: typeof rec["hint"] === "string" ? (rec["hint"] as string) : "",
    };
  }
  return null;
}

/** One `hcx send --agent-only --no-footer --json` attempt, argv with no
 * shell. Heartbeats first read the target status via `hcx ls --json` (5s
 * timeout) and skip when it is `working` or `blocked`; completion sends
 * unconditionally. Never uses `--if idle` and never retries: a nonzero exit
 * after the send may have landed. */
function hcxNotify(target: string, text: string, isHeartbeat: boolean): NotifyResult {
  if (isHeartbeat) {
    const st = hcxTargetStatus(target);
    if (st === "working" || st === "blocked") {
      return {
        outcome: "skipped_busy",
        detail: `skipped: target ${target} is ${st} (busy; heartbeat skipped)`,
        route: null,
        agent: null,
        note: null,
      };
    }
  }
  const timeoutMs = isHeartbeat ? HEARTBEAT_TIMEOUT_MS : COMPLETION_TIMEOUT_MS;
  const args = ["send", "--agent-only", "--no-footer", "--json", target, text];
  let p: ReturnType<typeof spawnSync>;
  try {
    p = spawnSync("hcx", args, { encoding: "utf8", timeout: timeoutMs });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const first = reason.split("\n")[0]!;
    if (!isHeartbeat && (/timed out|timeout|ETIMEDOUT/i.test(first) || /spawnSync.*timeout/i.test(reason))) {
      return {
        outcome: "unconfirmed",
        detail: `notify to ${target} timed out after ${Math.round(timeoutMs / 1000)}s (delivery not verified; the message may have landed, never retry): ${first}`,
        route: null,
        agent: null,
        note: null,
      };
    }
    return {
      outcome: "failed",
      detail: `notify to ${target} failed: ${first} (never retried; the send may have landed)`,
      route: null,
      agent: null,
      note: null,
    };
  }
  const stdout = (p.stdout as string) ?? "";
  const stderr = (p.stderr as string) ?? "";
  if (p.status === 0) {
    const v = tryParseJson(stdout.trim());
    if (v) {
      const delivered = v["delivered"];
      const route = typeof v["route"] === "string" ? (v["route"] as string) : null;
      const agent = typeof v["agent"] === "string" ? (v["agent"] as string) : null;
      const note = typeof v["note"] === "string" ? (v["note"] as string) : null;
      if (delivered === true) {
        return { outcome: "delivered", detail: `notified ${target} via hcx send --agent-only --no-footer`, route, agent, note };
      }
      if (delivered === false) {
        const why = note ?? "did not start a turn; it may still have arrived, read before resending";
        const who = agent ? ` (agent ${agent})` : "";
        if (isHeartbeat) {
          return {
            outcome: "skipped_busy",
            detail: `skipped: target ${target} busy (started no turn${who}: ${why}; heartbeat skipped)`,
            route,
            agent,
            note,
          };
        }
        return {
          outcome: "not_started",
          detail: `notify to ${target} started no turn${who}: ${why} (do not resend)`,
          route,
          agent,
          note,
        };
      }
      if (delivered === null) {
        const why = note ?? "hc reports no turn status";
        const who = agent ? `agent ${agent}, ` : "";
        return {
          outcome: "unconfirmed",
          detail: `notified ${target} (unconfirmed: ${who}${why}; never resend) via hcx send --agent-only --no-footer`,
          route,
          agent,
          note,
        };
      }
    }
    const err = ((stderr as string) ?? "").trim();
    const reason = err === "" ? `exit ${p.status}` : err.split("\n")[0]!;
    return { outcome: "failed", detail: `notify to ${target} failed: ${reason} (never retried)`, route: null, agent: null, note: null };
  }
  const parsed = parseHcxError(stdout, stderr);
  if (parsed !== null) {
    const msg = parsed.message === "" ? parsed.kind : parsed.message;
    const hint = parsed.hint === "" ? "" : ` (${parsed.hint})`;
    if (parsed.kind === "plain_shell") {
      return {
        outcome: "plain_shell",
        detail: `queued, not delivered: ${target} is a plain shell or unknown kind (${msg})${hint}`,
        route: null,
        agent: null,
        note: null,
      };
    }
    if (parsed.kind === "not_found") {
      return {
        outcome: "failed",
        detail: `queued: target ${target} not found (${msg})${hint}`,
        route: null,
        agent: null,
        note: null,
      };
    }
    if (parsed.kind === "timeout") {
      if (!isHeartbeat) {
        return {
          outcome: "unconfirmed",
          detail: `notify to ${target} timed out after ${Math.round(timeoutMs / 1000)}s (delivery not verified; the message may have landed, never retry): ${msg}${hint}`,
          route: null,
          agent: null,
          note: null,
        };
      }
      return {
        outcome: "failed",
        detail: `notify to ${target} failed: ${msg}${hint} (timed out; the message may have landed, never retry)`,
        route: null,
        agent: null,
        note: null,
      };
    }
    return {
      outcome: "failed",
      detail: `notify to ${target} failed: ${msg} (kind ${parsed.kind})${hint} (never retried; the send may have landed)`,
      route: null,
      agent: null,
      note: null,
    };
  }
  if (p.status === null && !isHeartbeat) {
    const errText = (stderr.trim() === "" ? stdout.trim() : stderr.trim()).split("\n")[0] ?? "";
    const reason = errText === "" ? `exit null` : errText;
    return {
      outcome: "unconfirmed",
      detail: `notify to ${target} timed out after ${Math.round(timeoutMs / 1000)}s (delivery not verified; the message may have landed, never retry): ${reason}`,
      route: null,
      agent: null,
      note: null,
    };
  }
  const errText = (stderr.trim() === "" ? stdout.trim() : stderr.trim()).split("\n")[0] ?? "";
  const reason = errText === "" ? `exit ${p.status}` : errText;
  return {
    outcome: "failed",
    detail: `notify to ${target} failed: ${reason} (never retried; the send may have landed)`,
    route: null,
    agent: null,
    note: null,
  };
}

/** Send one notification turn. Heartbeats pass `{ ifIdle: true }`: the target
 * status is read via `hcx ls --json` (5s timeout, one call per heartbeat) and
 * the heartbeat is skipped when it is `working` or `blocked` (a busy skip
 * counts as skipped, not failed). Completion sends unconditionally. Neither
 * route uses `--if idle` or retries after a send that may have landed. The
 * old herdr route is tried once per process; when it reports
 * `server_not_running` it is skipped silently afterwards, and failure details
 * describe only routes actually tried. */
export function notify(target: string, text: string, opts?: { ifIdle?: boolean }): NotifyResult {
  const isHeartbeat = opts?.ifIdle === true;
  const timeoutMs = isHeartbeat ? HEARTBEAT_TIMEOUT_MS : COMPLETION_TIMEOUT_MS;
  const isCompletion = !isHeartbeat;
  if (target.trim() === "") {
    return { outcome: "failed", detail: "skipped: no notify target (outside herdr and herdr-core, and no --notify)", route: null, agent: null, note: null };
  }
  const herdr = haveHerdr();
  const support = hcxSupport();
  if ((!herdr || herdrUnavailableCached) && !support.ok) {
    if (/not on PATH/.test(support.reason) && !herdr) {
      return {
        outcome: "failed",
        detail: "skipped: herdr is not on PATH and hcx is not on PATH (install hcx >= 0.3.0)",
        route: null,
        agent: null,
        note: null,
      };
    }
    if (!herdr || herdrUnavailableCached) {
      return {
        outcome: "failed",
        detail: `notify to ${target} not delivered: ${support.reason} (install hcx >= 0.3.0)`,
        route: null,
        agent: null,
        note: null,
      };
    }
  }
  let herdrDetail: string | null = null;
  if (herdr && !herdrUnavailableCached) {
    const done = herdrNotify(target, text, timeoutMs, isCompletion);
    if (done.outcome === "delivered") return done;
    if (isCompletion && done.outcome === "unconfirmed") return done;
    if (isServerNotRunning(done.detail)) {
      herdrUnavailableCached = true;
      herdrDetail = null;
    } else {
      herdrDetail = done.detail;
      if (!support.ok) {
        const hint = /not on PATH/.test(support.reason) ? "install hcx >= 0.3.0" : `${support.reason} (install hcx >= 0.3.0)`;
        return { outcome: "failed", detail: `${done.detail}; ${hint}`, route: null, agent: null, note: null };
      }
    }
  }
  if (!support.ok) {
    if (herdrDetail !== null) {
      const hint = /not on PATH/.test(support.reason) ? "install hcx >= 0.3.0" : `${support.reason} (install hcx >= 0.3.0)`;
      return { outcome: "failed", detail: `${herdrDetail}; ${hint}`, route: null, agent: null, note: null };
    }
    return {
      outcome: "failed",
      detail: `notify to ${target} not delivered: ${support.reason} (install hcx >= 0.3.0)`,
      route: null,
      agent: null,
      note: null,
    };
  }
  const fallback = hcxNotify(target, text, isHeartbeat);
  if (fallback.outcome === "delivered" || fallback.outcome === "unconfirmed" || fallback.outcome === "skipped_busy") return fallback;
  if (herdrDetail !== null) {
    return { outcome: "failed", detail: `${herdrDetail}; ${fallback.detail}`, route: fallback.route, agent: fallback.agent, note: fallback.note };
  }
  return fallback;
}

/** Warn when hcx cannot find an explicit `--notify` target. Returns the
 * warning line, or null when the target looks fine. Never fails the run:
 * the completion notify still reports the real result. */
export function checkNotifyTarget(explicit: string | undefined): string | null {
  if (explicit === undefined || explicit.trim() === "") return null;
  const target = explicit.trim();
  const support = hcxSupport();
  if (!support.ok) return null;
  if (haveHerdr()) return null;
  try {
    const p = spawnSync("hcx", ["get", target], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000 });
    if (p.status === 0) return null;
    const parsed = parseHcxError((p.stdout as string) ?? "", (p.stderr as string) ?? "");
    const msg = parsed !== null && parsed.message !== "" ? parsed.message : (((p.stderr as string) ?? "").trim().split("\n")[0] ?? "");
    const why = msg === "" ? `exit ${p.status}` : msg;
    return `warning: hcx cannot find notify target "${target}" (${why}); the job still runs and the completion notify will report it`;
  } catch {
    return null;
  }
}
