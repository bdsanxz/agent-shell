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
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-test-"));
}

/** A PATH with only the stub dir and the runtime: no real herdr, hc or hcx. */
function minimalPath(bin: string): string {
  return `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

function waitFor(home: string, id: string, want: string[], timeoutMs = 15000): string {
  const statusPath = path.join(home, "jobs", id, "status.json");
  const t0 = Date.now();
  for (;;) {
    const text = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf8") : "";
    if (want.some((w) => text.includes(w))) {
      // The supervisor records done/failed BEFORE notifying, then fills in
      // the notify result. Wait until the pending marker is gone so `check`
      // sees the final notify_detail.
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

describe("run", () => {
  test("returns at once and the job completes on disk", () => {
    const home = freshHome();
    const t0 = Date.now();
    const r = cli(home, ["run", "--name", "probe", "--", "sh", "-c", "echo hello; exit 0"]);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    expect(id.startsWith("sh-")).toBe(true);
    const status = waitFor(home, id, ['"done"']);
    expect(status).toContain('"notified": false');
    const show = cli(home, ["show", id]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("hello");
  });

  test("run --wait prints the output of a quick job", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "quick", "--wait", "5s", "--", "sh", "-c", "echo inline-ok"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("exit 0");
    expect(r.out).toContain("inline-ok");
  });

  test("a failing command is recorded as failed", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "bad", "--", "sh", "-c", "exit 3"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    const status = waitFor(home, id, ['"failed"']);
    expect(status).toContain('"exit_code": 3');
  });

  test("outside herdr the notify is skipped, never blocking", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "true"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("notify skipped");
  });

  test("list, tail, kill and clean work", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "long", "--", "sh", "-c", "sleep 30"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    expect(cli(home, ["list"]).out).toContain(id);
    expect(cli(home, ["kill", id]).code).toBe(0);
    const status = waitFor(home, id, ['"killed"']);
    expect(status).toContain("no completion notify");
    expect(cli(home, ["clean"]).out).toContain("removed 1");
    expect(cli(home, ["list"]).out).toContain("no jobs");
  });

  test("unknown job and bad usage exit 2", () => {
    const home = freshHome();
    expect(cli(home, ["show", "sh-nope"]).code).toBe(2);
    expect(cli(home, ["run"]).code).toBe(2);
    expect(cli(home, ["nope"]).code).toBe(2);
  });
});

describe("heartbeat", () => {
  function loggingHerdrBin(logFile: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-herdr-"));
    fs.writeFileSync(
      path.join(dir, "herdr"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\nexit 0\n`,
    );
    fs.chmodSync(path.join(dir, "herdr"), 0o755);
    return dir;
  }

  function readLog(logFile: string): string {
    try {
      return fs.readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  }

  test("heartbeat defaults to 2m", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "sleep 30"]);
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    expect(r.out).toContain("heartbeat every 2m0s");
    const meta = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "meta.json"), "utf8"));
    expect(meta.heartbeat_ms).toBe(120_000);
    expect(cli(home, ["show", id]).out).toContain("heartbeat 120000ms");
    expect(cli(home, ["kill", id]).code).toBe(0);
  });

  test("--heartbeat and --no-heartbeat set meta; bad values exit 2", () => {
    const home = freshHome();
    const r1 = cli(home, ["run", "--heartbeat", "30s", "--", "sh", "-c", "sleep 30"]);
    const id1 = r1.out.split("\n")[0]!.replace("job ", "").trim();
    expect(JSON.parse(fs.readFileSync(path.join(home, "jobs", id1, "meta.json"), "utf8")).heartbeat_ms).toBe(30_000);
    expect(cli(home, ["kill", id1]).code).toBe(0);

    const r2 = cli(home, ["run", "--no-heartbeat", "--", "sh", "-c", "sleep 30"]);
    const id2 = r2.out.split("\n")[0]!.replace("job ", "").trim();
    expect(r2.out).toContain("heartbeat off");
    expect(JSON.parse(fs.readFileSync(path.join(home, "jobs", id2, "meta.json"), "utf8")).heartbeat_ms).toBeNull();
    expect(cli(home, ["kill", id2]).code).toBe(0);

    expect(cli(home, ["run", "--heartbeat", "500ms", "--", "sh", "-c", "true"]).code).toBe(2);
    expect(cli(home, ["run", "--heartbeat", "bogus", "--", "sh", "-c", "true"]).code).toBe(2);
  });

  test("a running job sends progress notifies with the last line, then done", () => {
    const home = freshHome();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hb-")), "herdr.log");
    const bin = loggingHerdrBin(logFile);
    const r = cli(
      home,
      ["run", "--name", "slow", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3; echo step2"],
      { HERDR_PANE_ID: "w9:p9", PATH: `${bin}:${process.env.PATH ?? ""}` },
    );
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"'], 20000);
    const log = readLog(logFile);
    expect(log).toContain("still running");
    expect(log).toContain("Last line: step1");
    expect(log).toContain(`done (exit 0`);
    const status = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8"));
    expect(status.heartbeats).toBeGreaterThanOrEqual(1);
    expect(cli(home, ["show", id]).out).toContain("heartbeats ");
  });

  test("--no-heartbeat sends only the completion notify", () => {
    const home = freshHome();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hb-")), "herdr.log");
    const bin = loggingHerdrBin(logFile);
    const r = cli(home, ["run", "--no-heartbeat", "--", "sh", "-c", "sleep 2"], {
      HERDR_PANE_ID: "w9:p9",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"'], 20000);
    const log = readLog(logFile);
    expect(log).not.toContain("still running");
    expect(log).toContain("done (exit 0");
    const status = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8"));
    expect(status.heartbeats).toBe(0);
  });
});

describe("check", () => {
  function fakeHerdrBin(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-herdr-"));
    fs.writeFileSync(path.join(dir, "herdr"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(dir, "herdr"), 0o755);
    return dir;
  }

  test("a finished job with delivered notify passes 4/4", () => {
    const home = freshHome();
    const bin = fakeHerdrBin();
    const r = cli(
      home,
      ["run", "--name", "probe", "--", "sh", "-c", "echo hello; exit 0"],
      { HERDR_PANE_ID: "w9:p9", PATH: `${bin}:${process.env.PATH ?? ""}` },
    );
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("ok finished: state is done");
    expect(c.out).toContain("ok exit: 0");
    expect(c.out).toContain("ok output: 1 lines");
    expect(c.out).toContain("ok notify: notified w9:p9");
    expect(c.out).toContain(`check ${id}: 4/4 pass`);
  });

  test("a failed job still reports its recorded exit, notify failure fails the check", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "bad", "--", "sh", "-c", "exit 3"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"failed"']);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(1);
    expect(c.out).toContain("ok finished: state is failed");
    expect(c.out).toContain("ok exit: 3");
    expect(c.out).toContain("ok notify: n/a (no notify target)");
    expect(c.out).toContain("FAIL success: exit 3");
  });

  /** A stub bin with a failing old-herdr server and an hcx 0.3.0 stub that
   * always delivers. No `hc` binary: the hc route is gone. */
  function failingHerdrWithHcxBin(hcxLog: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hcx-"));
    fs.writeFileSync(path.join(dir, "herdr"), "#!/bin/sh\necho 'no herdr server is running' >&2\nexit 1\n");
    fs.writeFileSync(
      path.join(dir, "hcx"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${hcxLog}"\nif [ "$1" = "--version" ]; then printf '%s\\n' '{"hcx":"0.3.0","hc":"0.1.15","contract":1,"capabilities":["no-footer","agent-only","json-delivery"]}'; exit 0; fi\nif [ "$1" = "get" ]; then printf '%s\\n' '{"address":"t7","agent":"muse"}'; exit 0; fi\nif [ "$1" = "send" ]; then printf '%s\\n' '{"status":"idle","turn":3,"started":true,"delivered":true,"route":"hcx-raw","agent":"muse"}'; exit 0; fi\necho "unexpected hcx call: $*" >&2\nexit 9\n`,
    );
    fs.chmodSync(path.join(dir, "herdr"), 0o755);
    fs.chmodSync(path.join(dir, "hcx"), 0o755);
    return dir;
  }

  test("notify falls back to hcx send when herdr fails", () => {
    const home = freshHome();
    const hcxLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hcx-")), "hcx.log");
    const bin = failingHerdrWithHcxBin(hcxLog);
    const r = cli(home, ["run", "--name", "probe", "--", "sh", "-c", "echo hello; exit 0"], {
      HERDR_PANE_ID: "w9:p9",
      PATH: minimalPath(bin),
    });
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("ok notify: notified w9:p9 via hcx send --agent-only --no-footer");
    expect(fs.readFileSync(hcxLog, "utf8")).toContain("send --agent-only --no-footer --json w9:p9");
  });

  test("notify target defaults to the terminal", () => {
    const home = freshHome();
    const hcxLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hcx-")), "hcx.log");
    const bin = failingHerdrWithHcxBin(hcxLog);
    const r = cli(home, ["run", "--name", "probe", "--", "sh", "-c", "echo hello; exit 0"], {
      HC_TERMINAL_ID: "t9",
      PATH: minimalPath(bin),
    });
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("ok notify: notified t9 via hcx send --agent-only --no-footer");
  });

  test("running and unknown jobs exit 2", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "long", "--", "sh", "-c", "sleep 30"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(2);
    expect(c.err).toContain("still running");
    expect(cli(home, ["kill", id]).code).toBe(0);
    waitFor(home, id, ['"killed"']);
    const k = cli(home, ["check", id]);
    expect(k.code).toBe(1);
    expect(k.out).toContain("FAIL finished: state is killed");
    expect(cli(home, ["check", "sh-nope"]).code).toBe(2);
    expect(cli(home, ["clean"]).out).toContain("removed 1");
  });

  test("a missing output log fails the output check", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "probe", "--", "sh", "-c", "echo hi"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    fs.rmSync(path.join(home, "jobs", id, "output.log"));
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(1);
    expect(c.out).toContain("FAIL output: output.log is missing or unreadable");
  });
});

describe("hcx notify (0.3.0 contract)", () => {
  type SendBehavior =
    | "delivered"
    | "not_started"
    | "unconfirmed"
    | "plain_shell"
    | "timeout"
    | "not_found"
    | "failing";
  type GetBehavior = "ok" | "not_found";

  const VERSION_JSON = '{"hcx":"0.3.0","hc":"0.1.15","contract":1,"capabilities":["no-footer","agent-only","json-delivery"]}';
  const OLD_VERSION_JSON = '{"hcx":"0.1.2","hc":"0.1.15","contract":0,"capabilities":["no-footer"]}';

  /** A stub bin with no herdr and no hc: only hcx. `send` always answers
   * with `sendBehavior`; `get` answers `getBehavior`. Every hcx argv line
   * is appended to `hcx.log` in `logDir`. */
  function hcxBin(spec: { logDir: string; send?: SendBehavior; get?: GetBehavior; versionJson?: string }): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hcx-"));
    const send = spec.send ?? "delivered";
    const get = spec.get ?? "ok";
    const versionJson = spec.versionJson ?? VERSION_JSON;
    const sendCase =
      send === "delivered"
        ? `printf '%s\\n' '{"status":"idle","turn":3,"started":true,"delivered":true,"route":"hcx-raw","agent":"muse"}'\nexit 0`
        : send === "not_started"
          ? `printf '%s\\n' '{"status":"idle","turn":3,"started":false,"delivered":false,"route":"hcx-raw","agent":"muse","note":"did not start a turn; it may still have arrived, read before resending"}'\nexit 0`
          : send === "unconfirmed"
            ? `printf '%s\\n' '{"status":null,"turn":0,"started":null,"delivered":null,"route":"hcx-raw","agent":"opencode","note":"opencode reports no turn status"}'\nexit 0`
            : send === "plain_shell"
              ? `printf '%s\\n' '{"error":{"kind":"plain_shell","message":"tab t7 is a plain shell; refusing --agent-only send","hint":""}}' >&2\nexit 4`
              : send === "timeout"
                ? `printf '%s\\n' '{"error":{"kind":"timeout","message":"hc send timed out after 30 s; the message may have landed, do not retry automatically","hint":"read before resending; never retry a timed-out send blindly"}}' >&2\nexit 1`
                : send === "not_found"
                  ? `printf '%s\\n' '{"error":{"kind":"not_found","message":"no such terminal ghost","hint":""}}' >&2\nexit 3`
                  : `printf '%s\\n' '{"error":{"kind":"error","message":"boom","hint":""}}' >&2\nexit 1`;
    const getCase =
      get === "ok"
        ? `printf '%s\\n' '{"address":"t7","agent":"muse"}'\nexit 0`
        : `printf '%s\\n' '{"error":{"kind":"not_found","message":"no such terminal ghost","hint":""}}' >&2\nexit 3`;
    fs.writeFileSync(
      path.join(bin, "hcx"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spec.logDir}/hcx.log"\nif [ "$1" = "--version" ]; then printf '%s\\n' '${versionJson}'; exit 0; fi\nif [ "$1" = "get" ]; then\n${getCase}\nfi\nif [ "$1" = "send" ]; then\n${sendCase}\nfi\necho "unexpected hcx call: $*" >&2\nexit 9\n`,
    );
    fs.chmodSync(path.join(bin, "hcx"), 0o755);
    return bin;
  }

  function freshLogDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hcx-log-"));
  }

  function readLog(file: string): string {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  /** The `send` calls the stub recorded. */
  function sends(file: string): string[] {
    return readLog(file)
      .split("\n")
      .filter((l) => l.startsWith("send "));
  }

  function runProbe(home: string, bin: string, args: string[], extraEnv: Record<string, string> = {}) {
    return cli(home, ["run", "--name", "probe", ...args, "--", "sh", "-c", "echo hello; exit 0"], {
      PATH: minimalPath(bin),
      ...extraEnv,
    });
  }

  /** Run one quick job and return its finished `check` output. */
  function probeCheck(home: string, bin: string, args: string[], extraEnv: Record<string, string> = {}) {
    const r = runProbe(home, bin, args, extraEnv);
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    return { check: cli(home, ["check", id]), id };
  }

  function statusOf(home: string, id: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8")) as Record<string, unknown>;
  }

  test("delivered is notified over hcx with argv and no shell", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "delivered" });
    const { check, id } = probeCheck(home, bin, ["--notify", "t7"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain("ok notify: notified t7 via hcx send --agent-only --no-footer");
    const logged = sends(path.join(logDir, "hcx.log"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("send --agent-only --no-footer --json t7");
    const st = statusOf(home, id);
    expect(st.notify_outcome).toBe("delivered");
    expect(st.notified).toBe(true);
    expect(st.notify_route).toBe("hcx-raw");
    expect(st.notify_agent).toBe("muse");
    expect(cli(home, ["show", id]).out).toContain("notify_outcome delivered");
  });

  test("not_started (delivered:false) is never resent and fails the check", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "not_started" });
    const { check, id } = probeCheck(home, bin, ["--notify", "t7"]);
    expect(check.code).toBe(1);
    expect(check.out).toContain("FAIL notify: not delivered [not_started]");
    expect(check.out).toContain("do not resend");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
    const st = statusOf(home, id);
    expect(st.notify_outcome).toBe("not_started");
    expect(st.notified).toBe(false);
    expect(cli(home, ["show", id]).out).toContain("notify_outcome not_started");
  });

  test("unconfirmed (delivered:null, opencode) passes the check and is never resent", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "unconfirmed" });
    const { check, id } = probeCheck(home, bin, ["--notify", "t7"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain("ok notify: notified t7 (unconfirmed:");
    expect(check.out).toContain("never resend");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
    const st = statusOf(home, id);
    expect(st.notify_outcome).toBe("unconfirmed");
    expect(st.notified).toBe(true);
    expect(st.notify_agent).toBe("opencode");
    expect(st.notify_note).toBe("opencode reports no turn status");
    expect(cli(home, ["show", id]).out).toContain("notify_outcome unconfirmed");
  });

  test("plain_shell (exit 4) is queued, not delivered, never retried", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "plain_shell" });
    const { check, id } = probeCheck(home, bin, ["--notify", "t7"]);
    expect(check.code).toBe(1);
    expect(check.out).toContain("FAIL notify: not delivered [plain_shell]");
    expect(check.out).toContain("queued, not delivered");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
    const st = statusOf(home, id);
    expect(st.notify_outcome).toBe("plain_shell");
    expect(st.notified).toBe(false);
  });

  test("timeout is failed and never retried", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "timeout" });
    const { check, id } = probeCheck(home, bin, ["--notify", "t7"]);
    expect(check.code).toBe(1);
    expect(check.out).toContain("FAIL notify: not delivered [failed]");
    expect(check.out).toContain("may have landed, never retry");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
    expect(statusOf(home, id).notify_outcome).toBe("failed");
  });

  test("not_found is queued and fails the check", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "not_found" });
    const { check } = probeCheck(home, bin, ["--notify", "ghost"]);
    expect(check.code).toBe(1);
    expect(check.out).toContain("FAIL notify: not delivered [failed]");
    expect(check.out).toContain("not found");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
  });

  test("a tab-name --notify goes straight to hcx with no local lookup", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "delivered" });
    const { check } = probeCheck(home, bin, ["--notify", "Vrax"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain("ok notify: notified Vrax via hcx send --agent-only --no-footer");
    const logged = sends(path.join(logDir, "hcx.log"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Vrax");
  });

  test("an unknown --notify warns at run but still runs the job", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "delivered", get: "not_found" });
    const r = runProbe(home, bin, ["--notify", "ghost"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('warning: hcx cannot find notify target "ghost"');
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    expect(cli(home, ["check", id]).code).toBe(0);
  });

  test("missing hcx is not delivered with the install hint and never types", () => {
    const home = freshHome();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-nohcx-"));
    const r = runProbe(home, bin, ["--notify", "t7"]);
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(1);
    expect(c.out).toContain("FAIL notify: not delivered [failed]");
    expect(c.out).toContain("install hcx >= 0.3.0");
    expect(statusOf(home, id).notify_outcome).toBe("failed");
  });

  test("an old hcx is not delivered with the install hint and sends nothing", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "delivered", versionJson: OLD_VERSION_JSON });
    const { check, id } = probeCheck(home, bin, ["--notify", "t7"]);
    expect(check.code).toBe(1);
    expect(check.out).toContain("install hcx >= 0.3.0");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(0);
    expect(statusOf(home, id).notify_outcome).toBe("failed");
  });

  test("heartbeats use --if idle, completion never does", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "delivered" });
    const r = cli(home, ["run", "--name", "slow", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3; echo step2"], {
      PATH: minimalPath(bin),
    });
    expect(r.code).toBe(0);
    const outLines = r.out.split("\n");
    const id = outLines[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"'], 20000);
    const logged = readLog(path.join(logDir, "hcx.log")).split("\n").filter((l) => l.startsWith("send "));
    expect(logged.length).toBeGreaterThanOrEqual(2);
    const heartbeats = logged.filter((l) => l.includes("still running"));
    const completions = logged.filter((l) => l.includes("done (exit"));
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(completions).toHaveLength(1);
    for (const h of heartbeats) {
      expect(h).toContain("--agent-only --no-footer --json --if idle");
    }
    for (const c of completions) {
      expect(c).toContain("--agent-only --no-footer --json");
      expect(c).not.toContain("--if idle");
    }
    const st = statusOf(home, id);
    expect(st.heartbeats as number).toBeGreaterThanOrEqual(1);
  });

  test("a skipped heartbeat (busy agent) is not a failure and is not retried", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hcx-"));
    fs.writeFileSync(
      path.join(bin, "hcx"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logDir}/hcx.log"\nif [ "$1" = "--version" ]; then printf '%s\\n' '${VERSION_JSON}'; exit 0; fi\nif [ "$1" = "get" ]; then printf '%s\\n' '{"address":"t7","agent":"muse"}'; exit 0; fi\nif [ "$1" = "send" ]; then\ncase "$*" in\n*"--if idle"*) printf '%s\\n' '{"status":"working","turn":3,"started":false,"delivered":false,"route":"hcx-raw","agent":"muse","note":"did not start a turn; it may still have arrived, read before resending"}'; exit 0;;\n*) printf '%s\\n' '{"status":"idle","turn":4,"started":true,"delivered":true,"route":"hcx-raw","agent":"muse"}'; exit 0;;\nesac\nfi\necho "unexpected hcx call: $*" >&2\nexit 9\n`,
    );
    fs.chmodSync(path.join(bin, "hcx"), 0o755);
    const target = "t7";
    const r = cli(
      home,
      ["run", "--name", "slow", "--notify", target, "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3; echo step2"],
      { PATH: minimalPath(bin) },
    );
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"'], 20000);
    const logged = readLog(path.join(logDir, "hcx.log")).split("\n").filter((l) => l.startsWith("send "));
    const heartbeats = logged.filter((l) => l.includes("still running"));
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    for (const h of heartbeats) expect(h).toContain("--if idle");
    const st = statusOf(home, id);
    expect(st.heartbeats).toBe(0);
    expect(String(st.last_heartbeat_detail)).toContain("started no turn");
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("ok notify: notified t7 via hcx send --agent-only --no-footer");
  });

  test("check prints the last progress notify", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxBin({ logDir, send: "delivered" });
    const r = cli(home, ["run", "--name", "slow", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3"], {
      PATH: minimalPath(bin),
    });
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"'], 20000);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("progress notify: notified t7 via hcx send --agent-only --no-footer");
    expect(readLog(path.join(logDir, "hcx.log"))).toContain("still running");
  });
});

describe("0.2.4 fixes", () => {
  function loggingHerdrBin(logFile: string, delayMs = 0): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-herdr-"));
    const delay = delayMs > 0 ? `sleep ${(delayMs / 1000).toString()}\n` : "";
    fs.writeFileSync(path.join(dir, "herdr"), `#!/bin/sh\n${delay}printf '%s\\n' "$*" >> "${logFile}"\nexit 0\n`);
    fs.chmodSync(path.join(dir, "herdr"), 0o755);
    return dir;
  }

  test("--no-heartbeat stays off even with a short default", () => {
    const home = freshHome();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hb-")), "herdr.log");
    const bin = loggingHerdrBin(logFile);
    const env = {
      HERDR_PANE_ID: "w9:p9",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AGENT_SHELL_DEFAULT_HEARTBEAT_MS: "1000",
    };
    const r = cli(home, ["run", "--no-heartbeat", "--", "sh", "-c", "sleep 3"], env);
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    expect(r.out).toContain("heartbeat off");
    expect(JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "meta.json"), "utf8")).heartbeat_ms).toBeNull();
    expect(cli(home, ["show", id], env).out).toContain("heartbeat off");
    waitFor(home, id, ['"done"'], 20000);
    let log = "";
    try {
      log = fs.readFileSync(logFile, "utf8");
    } catch {
      log = "";
    }
    expect(log).not.toContain("still running");
    expect(log).toContain("done (exit 0");
    expect(JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8")).heartbeats).toBe(0);
  });

  test("--heartbeat 0 and off disable heartbeats in meta", () => {
    const home = freshHome();
    for (const v of ["0", "off"]) {
      const r = cli(home, ["run", "--heartbeat", v, "--", "sh", "-c", "sleep 30"]);
      expect(r.code).toBe(0);
      const id = r.out.split("\n")[0]!.replace("job ", "").trim();
      expect(JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "meta.json"), "utf8")).heartbeat_ms).toBeNull();
      expect(cli(home, ["show", id]).out).toContain("heartbeat off");
      expect(cli(home, ["kill", id]).code).toBe(0);
    }
  });

  test("kill refuses on finished jobs and leaves the result untouched", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "exit 0"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const before = fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8");
    const k = cli(home, ["kill", id]);
    expect(k.code).toBe(2);
    expect(k.err).toContain("not running");
    expect(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8")).toBe(before);
    const k2 = cli(home, ["kill", "sh-nope"]);
    expect(k2.code).toBe(2);
  });

  test("kill does not signal a PID that was reused", () => {
    const home = freshHome();
    const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const otherPid = sleeper.pid;
    try {
      const dir = path.join(home, "jobs", "sh-9999-reuse");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          id: "sh-9999-reuse",
          name: "reuse",
          command: ["sh", "-c", "sleep 30"],
          cwd: process.cwd(),
          created_ms: Date.now(),
          owner: { pane_id: "", agent_name: "", workspace_id: "" },
          notify_target: "",
          heartbeat_ms: null,
          child_pid: otherPid,
          supervisor_pid: null,
          child_lstart: "bogus mismatch for test",
          supervisor_lstart: null,
        }) + "\n",
      );
      fs.writeFileSync(
        path.join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          exit_code: null,
          done_ms: null,
          duration_ms: null,
          notified: false,
          notify_detail: "",
          heartbeats: 0,
          last_heartbeat_ms: null,
          last_heartbeat_detail: "",
          error: null,
        }) + "\n",
      );
      const k = cli(home, ["kill", "sh-9999-reuse"]);
      expect(k.code).toBe(0);
      let alive = true;
      try {
        process.kill(otherPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).state).toBe("killed");
    } finally {
      try {
        sleeper.kill();
      } catch {
        // gone
      }
    }
  });

  test("run validates --cwd and the executable up front", () => {
    const home = freshHome();
    const badCwd = cli(home, ["run", "--cwd", "/no-such-dir-xyz-123", "--", "sh", "-c", "true"]);
    expect(badCwd.code).toBe(2);
    expect(badCwd.err).toContain("bad --cwd");
    const badExe = cli(home, ["run", "--", "no-such-exe-xyz-123"]);
    expect(badExe.code).toBe(2);
    expect(badExe.err).toContain("executable not found");
    const jobsDir = path.join(home, "jobs");
    const entries = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : [];
    expect(entries).toHaveLength(0);
  });

  test("a start failure sends the completion notify and records the error", () => {
    const home = freshHome();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hb-")), "herdr.log");
    const bin = loggingHerdrBin(logFile);
    const dir = path.join(home, "jobs", "sh-9999-badstart");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id: "sh-9999-badstart",
        name: "badstart",
        command: ["sh", "-c", "true"],
        cwd: "/no-such-dir-xyz-123",
        created_ms: Date.now(),
        owner: { pane_id: "w9:p9", agent_name: "", workspace_id: "" },
        notify_target: "w9:p9",
        heartbeat_ms: null,
        child_pid: null,
        supervisor_pid: null,
        child_lstart: null,
        supervisor_lstart: null,
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({
        state: "running",
        exit_code: null,
        done_ms: null,
        duration_ms: null,
        notified: false,
        notify_detail: "",
        heartbeats: 0,
        last_heartbeat_ms: null,
        last_heartbeat_detail: "",
        error: null,
      }) + "\n",
    );
    fs.writeFileSync(path.join(dir, "output.log"), "");
    const r = cli(home, ["supervise", "sh-9999-badstart"], {
      HERDR_PANE_ID: "w9:p9",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(r.code).toBe(0);
    const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
    expect(status.state).toBe("failed");
    expect(status.error).toContain("could not start");
    expect(status.notify_detail).toContain("notified w9:p9");
    expect(fs.readFileSync(logFile, "utf8")).toContain("failed to start");
  });

  test("done is recorded before the completion notify", () => {
    const home = freshHome();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hb-")), "herdr.log");
    const bin = loggingHerdrBin(logFile, 2000);
    const r = cli(home, ["run", "--no-heartbeat", "--", "sh", "-c", "exit 0"], {
      HERDR_PANE_ID: "w9:p9",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    Bun.sleepSync(800);
    const mid = fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8");
    expect(mid).toContain('"done"');
    expect(mid).not.toContain('"running"');
    waitFor(home, id, ['"done"'], 20000);
    const fin = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8"));
    expect(fin.notified).toBe(true);
  });

  test("check fails a failed job even when its records pass", () => {
    const home = freshHome();
    const bin = loggingHerdrBin(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hb-")), "herdr.log"));
    const r = cli(home, ["run", "--", "sh", "-c", "exit 3"], {
      HERDR_PANE_ID: "w9:p9",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"failed"']);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(1);
    expect(c.out).toContain("check " + id + ": 4/4 pass");
    expect(c.out).toContain("FAIL success: exit 3");
  });

  test("run --wait returns the job exit code and 124 on timeout", () => {
    const home = freshHome();
    const ok = cli(home, ["run", "--wait", "5s", "--", "sh", "-c", "exit 0"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("exit 0");
    const bad = cli(home, ["run", "--wait", "5s", "--", "sh", "-c", "exit 3"]);
    expect(bad.code).toBe(3);
    expect(bad.out).toContain("exit 3");
    const slow = cli(home, ["run", "--wait", "1s", "--", "sh", "-c", "sleep 5"]);
    expect(slow.code).toBe(124);
    expect(slow.out).toContain("still running");
    const id = slow.out.split("\n")[0]!.replace("job ", "").trim();
    expect(cli(home, ["kill", id]).code).toBe(0);
  });

  test("check reports n/a for a job with no notify target", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "exit 0"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("ok notify: n/a (no notify target)");
    expect(c.out).toContain("ok success: exit 0");
  });

  test("supervisor keeps the child when the status is unreadable", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--heartbeat", "1s", "--", "sh", "-c", "sleep 3; echo done"]);
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    Bun.sleepSync(1500);
    fs.rmSync(path.join(home, "jobs", id, "status.json"), { force: true });
    waitFor(home, id, ['"done"'], 20000);
    const show = cli(home, ["show", id]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("done");
    expect(cli(home, ["clean"]).out).toContain("removed 1");
  });

  test("writes leave no temp files behind", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "exit 0"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const dir = path.join(home, "jobs", id);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(leftovers).toHaveLength(0);
  });

  test("--tail abc and --lines abc exit 2", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "echo hi"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    expect(cli(home, ["show", id, "--tail", "abc"]).code).toBe(2);
    expect(cli(home, ["show", id, "--tail", "abc"]).err).toContain("needs a positive integer");
    expect(cli(home, ["tail", id, "--lines", "abc"]).code).toBe(2);
    expect(cli(home, ["tail", id, "--lines", "1.5"]).code).toBe(2);
  });
});
