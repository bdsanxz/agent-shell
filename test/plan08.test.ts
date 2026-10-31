import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "../src/store.ts";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-08-"));
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

function metaOf(home: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "meta.json"), "utf8")) as Record<string, unknown>;
}

const VERSION_JSON = '{"hcx":"0.3.0","hc":"0.1.15","contract":1,"capabilities":["no-footer","agent-only","json-delivery"]}';

function hcxStub(logDir: string, opts: { send?: string; lsStatus?: string | null; lsRaw?: string } = {}): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-08-hcx-"));
  const sendKind = opts.send ?? "delivered";
  const sendCase =
    sendKind === "delivered"
      ? `printf '%s\\n' '{"status":"idle","turn":3,"started":true,"delivered":true,"route":"hcx-raw","agent":"muse"}'\nexit 0`
      : sendKind === "timeout"
        ? `printf '%s\\n' '{"error":{"kind":"timeout","message":"hc send timed out after 30 s","hint":"read before resending"}}' >&2\nexit 1`
        : sendKind === "failing"
          ? `printf '%s\\n' '{"error":{"kind":"error","message":"boom","hint":""}}' >&2\nexit 1`
          : `printf '%s\\n' '{"status":"idle","turn":3,"started":true,"delivered":true,"route":"hcx-raw","agent":"muse"}'\nexit 0`;
  const lsCase =
    opts.lsRaw !== undefined
      ? `printf '%s\\n' '${opts.lsRaw}'\nexit 0`
      : opts.lsStatus === null
        ? `printf '%s\\n' '{"agents":[]}'\nexit 0`
        : `printf '%s\\n' '{"agents":[{"address":"t7","status":"${opts.lsStatus ?? "idle"}"}]}'\nexit 0`;
  fs.writeFileSync(
    path.join(bin, "hcx"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logDir}/hcx.log"\nif [ "$1" = "--version" ]; then printf '%s\\n' '${VERSION_JSON}'; exit 0; fi\nif [ "$1" = "ls" ]; then\n${lsCase}\nfi\nif [ "$1" = "send" ]; then\n${sendCase}\nfi\necho "unexpected hcx call: $*" >&2\nexit 9\n`,
  );
  fs.chmodSync(path.join(bin, "hcx"), 0o755);
  return bin;
}

function freshLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-08-log-"));
}

describe("0.6.0 item 1: jobs are owned", () => {
  test("two owners never touch each other's records by default", () => {
    const home = freshHome();
    const r1 = cli(home, ["run", "--name", "a", "--", "sh", "-c", "echo hi"], { AGENT_SHELL_OWNER: "alice" });
    expect(r1.code).toBe(0);
    const idA = jobIdFrom(r1.out);
    waitFor(home, idA, ['"done"']);
    const r2 = cli(home, ["run", "--name", "b", "--", "sh", "-c", "echo hi"], { AGENT_SHELL_OWNER: "bob" });
    expect(r2.code).toBe(0);
    const idB = jobIdFrom(r2.out);
    waitFor(home, idB, ['"done"']);
    expect(metaOf(home, idA)["owner_id"]).toBe("alice");
    expect(metaOf(home, idB)["owner_id"]).toBe("bob");
    const listAlice = cli(home, ["list"], { AGENT_SHELL_OWNER: "alice" });
    expect(listAlice.code).toBe(0);
    expect(listAlice.out).toContain(idA);
    expect(listAlice.out).not.toContain(idB);
    const listBob = cli(home, ["list"], { AGENT_SHELL_OWNER: "bob" });
    expect(listBob.out).toContain(idB);
    expect(listBob.out).not.toContain(idA);
    const listAll = cli(home, ["list", "--all"], { AGENT_SHELL_OWNER: "alice" });
    expect(listAll.out).toContain(idA);
    expect(listAll.out).toContain(idB);
    expect(listAll.out).toContain("OWNER");
    const listAllJson = cli(home, ["list", "--all", "--json"], { AGENT_SHELL_OWNER: "alice" });
    const lines = listAllJson.out.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const byId = new Map(lines.map((o) => [o["id"], o]));
    expect(byId.get(idA)?.["owner"]).toBe("alice");
    expect(byId.get(idB)?.["owner"]).toBe("bob");
    const listDefaultJson = cli(home, ["list", "--json"], { AGENT_SHELL_OWNER: "alice" });
    expect(listDefaultJson.out).not.toContain('"owner"');
    const showCross = cli(home, ["show", idA], { AGENT_SHELL_OWNER: "bob" });
    expect(showCross.code).toBe(0);
    expect(cli(home, ["check", idA], { AGENT_SHELL_OWNER: "bob" }).code).toBe(0);
    const cleanAlice = cli(home, ["clean", "--json"], { AGENT_SHELL_OWNER: "alice" });
    expect(cleanAlice.code).toBe(0);
    const cleaned = JSON.parse(cleanAlice.out) as Record<string, unknown>;
    expect(cleaned["removed"]).toBe(1);
    expect(cleaned["removed_ids"]).toEqual([idA]);
    expect(cleaned["skipped_other_owner"]).toBe(1);
    expect(fs.existsSync(path.join(home, "jobs", idA))).toBe(false);
    expect(fs.existsSync(path.join(home, "jobs", idB))).toBe(true);
    const cleanAll = cli(home, ["clean", "--all", "--json"], { AGENT_SHELL_OWNER: "alice" });
    const cleanedAll = JSON.parse(cleanAll.out) as Record<string, unknown>;
    expect(cleanedAll["removed"]).toBe(1);
    expect(cleanedAll["skipped_other_owner"]).toBe(0);
  });

  test("owner precedence: AGENT_SHELL_OWNER else HC_TERMINAL_ID else HERDR_PANE_ID else null", () => {
    const home = freshHome();
    const r1 = cli(home, ["run", "--", "sh", "-c", "true"], {
      AGENT_SHELL_OWNER: "override",
      HC_TERMINAL_ID: "t1",
      HERDR_PANE_ID: "p1",
    });
    expect(metaOf(home, jobIdFrom(r1.out))["owner_id"]).toBe("override");
    const r2 = cli(home, ["run", "--", "sh", "-c", "true"], { HC_TERMINAL_ID: "t1", HERDR_PANE_ID: "p1" });
    expect(metaOf(home, jobIdFrom(r2.out))["owner_id"]).toBe("t1");
    const r3 = cli(home, ["run", "--", "sh", "-c", "true"], { HERDR_PANE_ID: "p1" });
    expect(metaOf(home, jobIdFrom(r3.out))["owner_id"]).toBe("p1");
    const r4 = cli(home, ["run", "--", "sh", "-c", "true"], {});
    expect(metaOf(home, jobIdFrom(r4.out))["owner_id"]).toBeNull();
    const ownerlessList = cli(home, ["list", "--json"], {});
    const ids = ownerlessList.out.trim().split("\n").map((l) => (JSON.parse(l) as Record<string, unknown>)["id"]);
    expect(ids).toHaveLength(1);
  });

  test("pre-0.6.0 jobs without owner_id need --all", () => {
    const home = freshHome();
    const dir = path.join(home, "jobs", "sh-legacy-1");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id: "sh-legacy-1",
        name: "legacy",
        command: ["sh", "-c", "true"],
        cwd: process.cwd(),
        created_ms: Date.now(),
        owner: { pane_id: "", agent_name: "", workspace_id: "" },
        notify_target: "",
        heartbeat_ms: null,
        child_pid: null,
        supervisor_pid: null,
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({ state: "done", exit_code: 0, done_ms: Date.now(), duration_ms: 10, notified: false, notify_detail: "", notify_outcome: "", heartbeats: 0 }) + "\n",
    );
    expect(cli(home, ["list"], { AGENT_SHELL_OWNER: "alice" }).out).not.toContain("sh-legacy-1");
    expect(cli(home, ["list", "--all"], { AGENT_SHELL_OWNER: "alice" }).out).toContain("sh-legacy-1");
    expect(cli(home, ["show", "sh-legacy-1"], { AGENT_SHELL_OWNER: "alice" }).code).toBe(0);
    const cleanDefault = cli(home, ["clean", "--json"], { AGENT_SHELL_OWNER: "alice" });
    expect((JSON.parse(cleanDefault.out) as Record<string, unknown>)["removed"]).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
    expect(cli(home, ["clean", "--all"], { AGENT_SHELL_OWNER: "alice" }).out).toContain("removed 1");
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("0.6.0 item 2: heartbeats actually arrive", () => {
  for (const lsStatus of ["done", "silent", "idle", "live"]) {
    test(`heartbeat sends when status is ${lsStatus} (no --if idle)`, () => {
      const home = freshHome();
      const logDir = freshLogDir();
      const bin = hcxStub(logDir, { send: "delivered", lsStatus });
      const r = cli(
        home,
        ["run", "--name", "hb", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3; echo step2"],
        { PATH: minimalPath(bin) },
      );
      expect(r.code).toBe(0);
      const id = jobIdFrom(r.out);
      waitFor(home, id, ['"done"'], 20000);
      const log = fs.readFileSync(path.join(logDir, "hcx.log"), "utf8");
      expect(log).not.toContain("--if idle");
      expect(log.split("\n").filter((l) => l.startsWith("ls ")).length).toBeGreaterThanOrEqual(1);
      const st = statusOf(home, id);
      expect(st["heartbeats_sent"] as number).toBeGreaterThanOrEqual(1);
      expect(st["heartbeats"] as number).toBe(st["heartbeats_sent"] as number);
    }, 20000);
  }

  for (const lsStatus of ["working", "blocked"]) {
    test(`heartbeat skips when status is ${lsStatus}`, () => {
      const home = freshHome();
      const logDir = freshLogDir();
      const bin = hcxStub(logDir, { send: "delivered", lsStatus });
      const r = cli(
        home,
        ["run", "--name", "hb", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3; echo step2"],
        { PATH: minimalPath(bin) },
      );
      const id = jobIdFrom(r.out);
      waitFor(home, id, ['"done"'], 20000);
      const log = fs.readFileSync(path.join(logDir, "hcx.log"), "utf8");
      expect(log).not.toContain("--if idle");
      const sends = log.split("\n").filter((l) => l.startsWith("send ") && l.includes("still running"));
      expect(sends).toHaveLength(0);
      const st = statusOf(home, id);
      expect(st["heartbeats_sent"] as number).toBe(0);
      expect(st["heartbeats_skipped_busy"] as number).toBeGreaterThanOrEqual(1);
      expect(st["heartbeats_failed"] as number).toBe(0);
      expect(String(st["last_heartbeat_detail"])).toContain("busy");
      const c = cli(home, ["check", id]);
      expect(c.code).toBe(0);
      expect(c.out).toContain("ok notify: delivered:");
    }, 20000);
  }

  test("completion sends unconditionally even when busy", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxStub(logDir, { send: "delivered", lsStatus: "working" });
    const r = cli(home, ["run", "--name", "hb", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3"], {
      PATH: minimalPath(bin),
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const log = fs.readFileSync(path.join(logDir, "hcx.log"), "utf8");
    const completions = log.split("\n").filter((l) => l.startsWith("send ") && l.includes("done (exit"));
    expect(completions).toHaveLength(1);
    expect(completions[0]).not.toContain("--if idle");
    expect(statusOf(home, id)["notify_outcome"]).toBe("delivered");
  }, 20000);

  test("unknown status sends (fail-open)", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxStub(logDir, { send: "delivered", lsStatus: null });
    const r = cli(home, ["run", "--name", "hb", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3"], {
      PATH: minimalPath(bin),
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    expect(statusOf(home, id)["heartbeats_sent"] as number).toBeGreaterThanOrEqual(1);
  }, 20000);
});

describe("0.6.0 item 3: quiet old-server route", () => {
  function herdrFailingBin(hcxLogDir: string, herdrLog: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-08-herdr-"));
    fs.writeFileSync(
      path.join(dir, "herdr"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${herdrLog}"\necho '{"id":"cli:agent:prompt","error":{"code":"server_not_running","message":"no herdr server is running"}}' >&2\nexit 1\n`,
    );
    fs.chmodSync(path.join(dir, "herdr"), 0o755);
    const hcx = hcxStub(hcxLogDir, { send: "delivered", lsStatus: "idle" });
    for (const f of fs.readdirSync(hcx)) {
      fs.copyFileSync(path.join(hcx, f), path.join(dir, f));
    }
    return dir;
  }

  test("server_not_running is skipped silently and only hcx detail shows", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const herdrLog = path.join(freshLogDir(), "herdr.log");
    const bin = herdrFailingBin(logDir, herdrLog);
    const r = cli(home, ["run", "--name", "q", "--notify", "t7", "--", "sh", "-c", "echo hi"], {
      PATH: minimalPath(bin),
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"']);
    const st = statusOf(home, id);
    expect(st["notify_outcome"]).toBe("delivered");
    expect(String(st["notify_detail"])).not.toContain("server_not_running");
    expect(String(st["notify_detail"])).toContain("hcx send");
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("ok notify: delivered:");
  });

  test("herdr route is tried once per process then skipped", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const herdrLog = path.join(freshLogDir(), "herdr.log");
    const bin = herdrFailingBin(logDir, herdrLog);
    const r = cli(
      home,
      ["run", "--name", "hb", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3; echo step2"],
      { PATH: minimalPath(bin) },
    );
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const herdrCalls = fs.existsSync(herdrLog) ? fs.readFileSync(herdrLog, "utf8").trim().split("\n").filter(Boolean) : [];
    expect(herdrCalls.length).toBe(1);
    const st = statusOf(home, id);
    expect(String(st["notify_detail"])).not.toContain("server_not_running");
  }, 20000);
});

describe("0.6.0 item 4: heartbeat counters", () => {
  test("sent, backoff, busy and failed are tracked with alias and compact line", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxStub(logDir, { send: "delivered", lsStatus: "idle" });
    const r = cli(
      home,
      ["run", "--name", "hb", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo start; sleep 6"],
      { PATH: minimalPath(bin), AGENT_SHELL_HEARTBEAT_MAX_MS: "4000" },
    );
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const st = statusOf(home, id);
    expect(typeof st["heartbeats_sent"]).toBe("number");
    expect(typeof st["heartbeats_skipped_backoff"]).toBe("number");
    expect(typeof st["heartbeats_skipped_busy"]).toBe("number");
    expect(typeof st["heartbeats_failed"]).toBe("number");
    expect(st["heartbeats"] as number).toBe(st["heartbeats_sent"] as number);
    expect(st["heartbeats_skipped_backoff"] as number).toBeGreaterThanOrEqual(1);
    expect(String(st["last_heartbeat_detail"])).not.toBe("");
    const show = cli(home, ["show", id]);
    expect(show.out).toMatch(/heartbeats sent \d+, skipped \d+ \(backoff \d+, busy \d+\), failed \d+/);
    const showJson = JSON.parse(cli(home, ["show", id, "--json"]).out) as Record<string, unknown>;
    expect(showJson["heartbeats_sent"]).toBe(st["heartbeats_sent"]);
    expect(showJson["heartbeats"]).toBe(st["heartbeats_sent"]);
    const check = cli(home, ["check", id]);
    expect(check.out).toMatch(/heartbeats sent \d+, skipped \d+ \(backoff \d+, busy \d+\), failed \d+/);
    const checkJson = JSON.parse(cli(home, ["check", id, "--json"]).out) as Record<string, unknown>;
    expect(checkJson["heartbeats_sent"]).toBe(st["heartbeats_sent"]);
    expect(checkJson["heartbeats_skipped_backoff"]).toBe(st["heartbeats_skipped_backoff"]);
  }, 20000);

  test("busy and failed heartbeats count separately", () => {
    const busyHome = freshHome();
    const busyLog = freshLogDir();
    const busyBin = hcxStub(busyLog, { send: "delivered", lsStatus: "blocked" });
    const rb = cli(busyHome, ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo hi; sleep 3"], {
      PATH: minimalPath(busyBin),
    });
    const idB = jobIdFrom(rb.out);
    waitFor(busyHome, idB, ['"done"'], 20000);
    const sb = statusOf(busyHome, idB);
    expect(sb["heartbeats_sent"] as number).toBe(0);
    expect(sb["heartbeats_skipped_busy"] as number).toBeGreaterThanOrEqual(1);
    expect(sb["heartbeats_failed"] as number).toBe(0);
    const failHome = freshHome();
    const failLog = freshLogDir();
    const failBin = hcxStub(failLog, { send: "failing", lsStatus: "idle" });
    const rf = cli(failHome, ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo hi; sleep 3"], {
      PATH: minimalPath(failBin),
    });
    const idF = jobIdFrom(rf.out);
    waitFor(failHome, idF, ['"done"'], 20000);
    const sf = statusOf(failHome, idF);
    expect(sf["heartbeats_failed"] as number).toBeGreaterThanOrEqual(1);
  }, 30000);
});

describe("0.6.0 item 5: honest notify outcomes", () => {
  test("completion timeout is unconfirmed and passes check", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxStub(logDir, { send: "timeout", lsStatus: "idle" });
    const r = cli(home, ["run", "--notify", "t7", "--", "sh", "-c", "echo hi"], { PATH: minimalPath(bin) });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"']);
    const st = statusOf(home, id);
    expect(st["notify_outcome"]).toBe("unconfirmed");
    expect(String(st["notify_detail"])).toContain("timed out");
    expect(String(st["notify_detail"])).toContain("delivery not verified");
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("ok notify: unconfirmed (delivery not verified)");
  });

  test("heartbeat timeout is failed, completion timeout stays unconfirmed", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxStub(logDir, { send: "timeout", lsStatus: "idle" });
    const r = cli(home, ["run", "--notify", "t7", "--heartbeat", "1s", "--", "sh", "-c", "echo hi; sleep 3"], {
      PATH: minimalPath(bin),
    });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"'], 20000);
    const st = statusOf(home, id);
    expect(st["notify_outcome"]).toBe("unconfirmed");
    expect(st["heartbeats_failed"] as number).toBeGreaterThanOrEqual(1);
    expect(cli(home, ["check", id]).code).toBe(0);
  }, 20000);

  test("delivered stays ok notify delivered", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = hcxStub(logDir, { send: "delivered", lsStatus: "idle" });
    const r = cli(home, ["run", "--notify", "t7", "--", "sh", "-c", "echo hi"], { PATH: minimalPath(bin) });
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"']);
    expect(cli(home, ["check", id]).out).toContain("ok notify: delivered:");
  });
});

describe("0.6.0 item 6: command_string round-trips", () => {
  test("shellQuote handles the POSIX edge cases", () => {
    expect(shellQuote(["sh", "-c", "echo hi"])).toBe("sh -c 'echo hi'");
    expect(shellQuote(["sh", "-c", "echo started; sleep 40"])).toBe("sh -c 'echo started; sleep 40'");
    expect(shellQuote(["echo", "a b", ""])).toBe("echo 'a b' ''");
    expect(shellQuote(["foo'bar"])).toBe("'foo'\\''bar'");
    expect(shellQuote(["a-b_c@d:e,f+g%h.i/j"])).toBe("a-b_c@d:e,f+g%h.i/j");
  });

  test("run and show use quoted command_string, command array unchanged", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--json", "--", "sh", "-c", "echo started; sleep 1"], {});
    const obj = JSON.parse(r.out) as Record<string, unknown>;
    expect(obj["command"]).toEqual(["sh", "-c", "echo started; sleep 1"]);
    expect(obj["command_string"]).toBe("sh -c 'echo started; sleep 1'");
    const id = obj["id"] as string;
    waitFor(home, id, ['"done"']);
    const show = JSON.parse(cli(home, ["show", id, "--json"]).out) as Record<string, unknown>;
    expect(show["command_string"]).toBe("sh -c 'echo started; sleep 1'");
    expect(show["command"]).toEqual(["sh", "-c", "echo started; sleep 1"]);
    const textShow = cli(home, ["show", id]);
    expect(textShow.out).toContain("command sh -c 'echo started; sleep 1'");
  });
});
