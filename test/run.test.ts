import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts");

function cli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], {
    env: { ...process.env, AGENT_SHELL_HOME: home, HERDR_PANE_ID: "", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-test-"));
}

function waitFor(home: string, id: string, want: string[], timeoutMs = 15000): string {
  const statusPath = path.join(home, "jobs", id, "status.json");
  const t0 = Date.now();
  for (;;) {
    const text = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf8") : "";
    if (want.some((w) => text.includes(w))) return text;
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
    expect(c.out).toContain("FAIL notify: not delivered (skipped: no notify target");
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
