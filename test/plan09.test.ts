import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts");

function cli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], {
    env: { ...process.env, AGENT_SHELL_HOME: home, HERDR_PANE_ID: "", HC_TERMINAL_ID: "", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-09-"));
}

function freshLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-09-log-"));
}

function minimalPath(bin: string): string {
  return `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

function waitFor(home: string, id: string, want: string[], timeoutMs = 15000): string {
  const statusPath = path.join(home, "jobs", id, "status.json");
  const t0 = Date.now();
  for (;;) {
    const text = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf8") : "";
    if (want.some((w) => text.includes(w))) {
      if (text.includes("pending: completion notify")) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} stuck pending: ${text}`);
        Bun.sleepSync(200);
        continue;
      }
      return text;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} never finished: ${text}`);
    Bun.sleepSync(200);
  }
}

function jobIdFrom(out: string): string {
  return out.split("\n")[0]!.replace("job ", "").trim();
}

function statusOf(home: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8")) as Record<string, unknown>;
}

function readHcxLog(logDir: string): string {
  try {
    return fs.readFileSync(path.join(logDir, "hcx.log"), "utf8");
  } catch {
    return "";
  }
}

const VERSION_JSON = '{"hcx":"0.3.0","hc":"0.1.15","contract":1,"capabilities":["no-footer","agent-only","json-delivery"]}';

/** Stub hcx whose ls --json is busy for the first `busyLsCalls` ls calls, then idle. */
function hcxScripted(logDir: string, busyLsCalls: number, sendKind = "delivered"): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-09-hcx-"));
  fs.writeFileSync(path.join(logDir, "ls.count"), "0");
  fs.writeFileSync(path.join(logDir, "busy_n"), String(busyLsCalls));
  const sendCase =
    sendKind === "delivered"
      ? `printf '%s\\n' '{"status":"idle","turn":3,"started":true,"delivered":true,"route":"hcx-raw","agent":"muse"}'\nexit 0`
      : `printf '%s\\n' '{"error":{"kind":"error","message":"boom","hint":""}}' >&2\nexit 1`;
  fs.writeFileSync(
    path.join(bin, "hcx"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logDir}/hcx.log"\nif [ "$1" = "--version" ]; then printf '%s\\n' '${VERSION_JSON}'; exit 0; fi\n` +
      `if [ "$1" = "ls" ]; then\n` +
      `  c=$(cat "${logDir}/ls.count" 2>/dev/null || echo 0); c=$((c+1)); printf '%s' "$c" > "${logDir}/ls.count"\n` +
      `  n=$(cat "${logDir}/busy_n" 2>/dev/null || echo 0)\n` +
      `  if [ "$c" -le "$n" ]; then printf '%s\\n' '{"agents":[{"address":"t7","status":"working"}]}'; exit 0; fi\n` +
      `  printf '%s\\n' '{"agents":[{"address":"t7","status":"idle"}]}'; exit 0\n` +
      `fi\n` +
      `if [ "$1" = "send" ]; then\n${sendCase}\nfi\n` +
      `echo "unexpected hcx call: $*" >&2\nexit 9\n`,
  );
  fs.chmodSync(path.join(bin, "hcx"), 0o755);
  return bin;
}

function hcxAlways(logDir: string, lsStatus: string, sendKind = "delivered"): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-09-hcx-"));
  const sendCase =
    sendKind === "delivered"
      ? `printf '%s\\n' '{"status":"idle","turn":3,"started":true,"delivered":true,"route":"hcx-raw","agent":"muse"}'\nexit 0`
      : `printf '%s\\n' '{"error":{"kind":"error","message":"boom","hint":""}}' >&2\nexit 1`;
  fs.writeFileSync(
    path.join(bin, "hcx"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logDir}/hcx.log"\nif [ "$1" = "--version" ]; then printf '%s\\n' '${VERSION_JSON}'; exit 0; fi\nif [ "$1" = "ls" ]; then printf '%s\\n' '{"agents":[{"address":"t7","status":"${lsStatus}"}]}'; exit 0; fi\nif [ "$1" = "send" ]; then\n${sendCase}\nfi\necho "unexpected hcx call: $*" >&2\nexit 9\n`,
  );
  fs.chmodSync(path.join(bin, "hcx"), 0o755);
  return bin;
}

describe("0.6.1 item 1: deferred busy beats", () => {
  test("busy then idle defers and sends once with the latest line", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxScripted(logDir, 2, "delivered");
    const r = cli(
      home,
      ["run", "--name", "hb", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "for i in 1 2 3 4 5; do echo tick$i; sleep 0.3; done; sleep 4"],
      { PATH: minimalPath(bin), AGENT_SHELL_BUSY_POLL_MS: "200" },
    );
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const st = statusOf(home, id);
    expect(st["heartbeats_sent"] as number).toBeGreaterThanOrEqual(1);
    expect(st["heartbeats_deferred"] as number).toBe(1);
    expect(st["heartbeats_failed"] as number).toBe(0);
    const log = readHcxLog(logDir);
    const sends = log.split("\n").filter((l) => l.startsWith("send ") && l.includes("still running"));
    expect(sends.length).toBeGreaterThanOrEqual(1);
    const deferredSend = sends.find((l) => l.includes("tick5"));
    expect(deferredSend).toBeDefined();
    expect(deferredSend!).toContain("Next progress in");
  }, 20000);

  test("deadline reached while still busy counts skipped_busy", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxAlways(logDir, "working", "delivered");
    const r = cli(home, ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo hi; sleep 3"], {
      PATH: minimalPath(bin),
      AGENT_SHELL_BUSY_POLL_MS: "200",
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const st = statusOf(home, id);
    expect(st["heartbeats_sent"] as number).toBe(0);
    expect(st["heartbeats_deferred"] as number).toBe(0);
    expect(st["heartbeats_skipped_busy"] as number).toBeGreaterThanOrEqual(1);
    expect(st["heartbeats_failed"] as number).toBe(0);
    expect(String(st["last_heartbeat_detail"])).toContain("busy");
  }, 20000);

  test("job finishing during the wait drops the pending beat without counting", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxAlways(logDir, "working", "delivered");
    const r = cli(home, ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo hi; sleep 1.3"], {
      PATH: minimalPath(bin),
      AGENT_SHELL_BUSY_POLL_MS: "200",
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const st = statusOf(home, id);
    expect(st["heartbeats_sent"] as number).toBe(0);
    expect(st["heartbeats_deferred"] as number).toBe(0);
    expect(st["heartbeats_skipped_busy"] as number).toBe(0);
    expect(st["heartbeats_skipped_backoff"] as number).toBe(0);
    expect(st["heartbeats_failed"] as number).toBe(0);
    expect(st["notify_outcome"]).toBe("delivered");
    const log = readHcxLog(logDir);
    const heartbeats = log.split("\n").filter((l) => l.startsWith("send ") && l.includes("still running"));
    expect(heartbeats).toHaveLength(0);
  }, 20000);

  test("back-off beat is never deferred", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxAlways(logDir, "working", "delivered");
    const r = cli(home, ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo start; sleep 9"], {
      PATH: minimalPath(bin),
      AGENT_SHELL_BUSY_POLL_MS: "200",
      AGENT_SHELL_HEARTBEAT_MAX_MS: "4000",
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const st = statusOf(home, id);
    expect(st["heartbeats_deferred"] as number).toBe(0);
    expect(st["heartbeats_skipped_backoff"] as number).toBeGreaterThanOrEqual(1);
    expect(st["heartbeats_skipped_busy"] as number).toBeGreaterThanOrEqual(1);
  }, 20000);

  test("back-off-suppressed beat with idle target is not deferred either", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxAlways(logDir, "idle", "delivered");
    const r = cli(home, ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo start; sleep 5"], {
      PATH: minimalPath(bin),
      AGENT_SHELL_HEARTBEAT_MAX_MS: "4000",
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const st = statusOf(home, id);
    expect(st["heartbeats_deferred"] as number).toBe(0);
    expect(st["heartbeats_skipped_backoff"] as number).toBeGreaterThanOrEqual(1);
  }, 20000);
});

describe("0.6.1 item 2: next progress wording", () => {
  test("plain heartbeat ends with Next progress in ~1s", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxAlways(logDir, "idle", "delivered");
    const r = cli(
      home,
      ["run", "--name", "hb", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 1; echo step2; sleep 2"],
      { PATH: minimalPath(bin) },
    );
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const log = readHcxLog(logDir);
    const sends = log.split("\n").filter((l) => l.startsWith("send ") && l.includes("still running"));
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const s of sends) expect(s).toContain("Next progress in ~");
    expect(sends.some((s) => s.includes("Next progress in ~1s"))).toBe(true);
  }, 20000);

  test("backed-off heartbeat uses the doubled interval", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxAlways(logDir, "idle", "delivered");
    const r = cli(home, ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo start; sleep 5"], {
      PATH: minimalPath(bin),
      AGENT_SHELL_HEARTBEAT_MAX_MS: "4000",
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const log = readHcxLog(logDir);
    const sends = log.split("\n").filter((l) => l.startsWith("send ") && l.includes("still running"));
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends.some((s) => s.includes("Next progress in ~2s"))).toBe(true);
  }, 20000);

  test("fixed heartbeat keeps the base interval", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxAlways(logDir, "idle", "delivered");
    const r = cli(
      home,
      ["run", "--notify", "t7", "--heartbeat", "1s", "--heartbeat-fixed", "--", "sh", "-c", "echo start; sleep 4"],
      { PATH: minimalPath(bin) },
    );
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const log = readHcxLog(logDir);
    const sends = log.split("\n").filter((l) => l.startsWith("send ") && l.includes("still running"));
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const s of sends) expect(s).toContain("Next progress in ~1s");
  }, 20000);

  test("completion text is unchanged", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxAlways(logDir, "idle", "delivered");
    const r = cli(home, ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo hi; sleep 2"], {
      PATH: minimalPath(bin),
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const log = readHcxLog(logDir);
    const completions = log.split("\n").filter((l) => l.startsWith("send ") && l.includes("done (exit"));
    expect(completions).toHaveLength(1);
    expect(completions[0]).not.toContain("Next progress");
  }, 20000);
});

describe("0.6.1 item 3: deferred counter in show/check", () => {
  test("show and check print deferred and expose it in json", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxScripted(logDir, 2, "delivered");
    const r = cli(
      home,
      ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "for i in 1 2 3; do echo tick$i; sleep 0.3; done; sleep 4"],
      { PATH: minimalPath(bin), AGENT_SHELL_BUSY_POLL_MS: "200" },
    );
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const st = statusOf(home, id);
    expect(st["heartbeats_deferred"] as number).toBe(1);
    const show = cli(home, ["show", id]);
    expect(show.out).toMatch(/heartbeats sent \d+ \(deferred \d+\), skipped \d+ \(backoff \d+, busy \d+\), failed \d+/);
    expect(show.out).toContain("(deferred 1)");
    const showJson = JSON.parse(cli(home, ["show", id, "--json"]).out) as Record<string, unknown>;
    expect(showJson["heartbeats_deferred"]).toBe(1);
    const check = cli(home, ["check", id]);
    expect(check.out).toMatch(/heartbeats sent \d+ \(deferred \d+\), skipped \d+ \(backoff \d+, busy \d+\), failed \d+/);
    const checkJson = JSON.parse(cli(home, ["check", id, "--json"]).out) as Record<string, unknown>;
    expect(checkJson["heartbeats_deferred"]).toBe(1);
  }, 20000);

  test("old status files default deferred to 0", () => {
    const home = freshHome();
    const dir = path.join(home, "jobs", "sh-legacy-deferred");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id: "sh-legacy-deferred",
        name: "legacy",
        command: ["sh", "-c", "true"],
        cwd: process.cwd(),
        created_ms: Date.now(),
        owner: { pane_id: "", agent_name: "", workspace_id: "" },
        owner_id: null,
        notify_target: "t7",
        heartbeat_ms: 1000,
        heartbeat_fixed: false,
        child_pid: null,
        supervisor_pid: null,
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({
        state: "done",
        exit_code: 0,
        done_ms: Date.now(),
        duration_ms: 10,
        notified: true,
        notify_detail: "notified t7",
        notify_outcome: "delivered",
        heartbeats: 1,
        heartbeats_sent: 1,
        heartbeats_skipped_backoff: 0,
        heartbeats_skipped_busy: 0,
        heartbeats_failed: 0,
        last_heartbeat_ms: Date.now(),
        last_heartbeat_detail: "notified t7",
        error: null,
        heartbeat_current_ms: 1000,
      }) + "\n",
    );
    const showJson = JSON.parse(cli(home, ["show", "sh-legacy-deferred", "--json"]).out) as Record<string, unknown>;
    expect(showJson["heartbeats_deferred"]).toBe(0);
    expect(cli(home, ["show", "sh-legacy-deferred"]).out).toContain("(deferred 0)");
    expect((JSON.parse(cli(home, ["check", "sh-legacy-deferred", "--json"]).out) as Record<string, unknown>)["heartbeats_deferred"]).toBe(0);
  });
});
