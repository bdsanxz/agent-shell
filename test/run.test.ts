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
    expect(c.out).toContain("FAIL notify: not delivered (skipped: no notify target");
  });

  function failingHerdrWithHcBin(hcLog: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hc-"));
    fs.writeFileSync(path.join(dir, "herdr"), "#!/bin/sh\necho 'no herdr server is running' >&2\nexit 1\n");
    fs.writeFileSync(path.join(dir, "hc"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${hcLog}"\nif [ "$1" = send ]; then exit 0; fi\necho "unexpected hc call: $*" >&2\nexit 9\n`);
    fs.chmodSync(path.join(dir, "herdr"), 0o755);
    fs.chmodSync(path.join(dir, "hc"), 0o755);
    return dir;
  }

  test("notify falls back to hc send when herdr fails", () => {
    const home = freshHome();
    const hcLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hc-")), "hc.log");
    const bin = failingHerdrWithHcBin(hcLog);
    const r = cli(home, ["run", "--name", "probe", "--", "sh", "-c", "echo hello; exit 0"], {
      HERDR_PANE_ID: "w9:p9",
      PATH: minimalPath(bin),
    });
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("ok notify: notified w9:p9 via hc send");
    expect(fs.readFileSync(hcLog, "utf8")).toContain("send w9:p9");
  });

  test("notify target defaults to the hc terminal", () => {
    const home = freshHome();
    const hcLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-hc-")), "hc.log");
    const bin = failingHerdrWithHcBin(hcLog);
    const r = cli(home, ["run", "--name", "probe", "--", "sh", "-c", "echo hello; exit 0"], {
      HC_TERMINAL_ID: "t9",
      PATH: minimalPath(bin),
    });
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("ok notify: notified t9 via hc send");
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

describe("notify route", () => {
  interface Terminal {
    address: string;
    name?: string;
    agent?: string;
  }

  /** A stub bin: `hc ls --json` prints `terminals`, `hc send` and `hcx send` log their
   * arguments. `terminals: null` makes `hc ls` fail, so no kind can be determined. */
  function routeBin(spec: {
    logDir: string;
    herdr?: "ok" | "fail";
    hcx?: "ok" | "fail";
    hc?: "ok" | "fail";
    terminals?: Terminal[] | null;
  }): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-route-"));
    const write = (name: string, body: string) => {
      const p = path.join(bin, name);
      fs.writeFileSync(p, body);
      fs.chmodSync(p, 0o755);
    };
    if (spec.herdr === "ok") write("herdr", "#!/bin/sh\nexit 0\n");
    if (spec.herdr === "fail") write("herdr", "#!/bin/sh\necho 'no herdr server is running' >&2\nexit 1\n");
    if (spec.hcx === "ok") write("hcx", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spec.logDir}/hcx.log"\nexit 0\n`);
    if (spec.hcx === "fail") write("hcx", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spec.logDir}/hcx.log"\necho 'hcx is broken' >&2\nexit 1\n`);
    if (spec.hc === "ok") {
      const listing =
        spec.terminals === null
          ? "echo 'no terminal list' >&2\nexit 1"
          : `printf '%s\\n' '${JSON.stringify({ terminals: spec.terminals ?? [] })}'\nexit 0`;
      write(
        "hc",
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spec.logDir}/hc.log"\nif [ "$1" = ls ]; then\n${listing}\nfi\nexit 0\n`,
      );
    }
    if (spec.hc === "fail") write("hc", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spec.logDir}/hc.log"\necho 'hc is broken' >&2\nexit 1\n`);
    return bin;
  }

  function freshLogDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-route-log-"));
  }

  function readLog(file: string): string {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  /** The `send` calls a stub recorded, without its `ls --json` lookups. */
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
    return cli(home, ["check", id]);
  }

  test("an agent terminal kind is notified untagged via hcx", () => {
    for (const kind of ["muse", "claude-code", "opencode"]) {
      const home = freshHome();
      const logDir = freshLogDir();
      const bin = routeBin({ hcx: "ok", hc: "ok", logDir, terminals: [{ address: "t7", agent: kind }] });
      const c = probeCheck(home, bin, ["--notify", "t7"]);
      expect(`${kind}: ${c.out}`).toContain("ok notify: notified t7 via hcx send");
      expect(`${kind}: ${JSON.stringify(sends(path.join(logDir, "hcx.log")))}`).toContain("send t7 shell job 'probe' done");
      expect(sends(path.join(logDir, "hc.log"))).toHaveLength(0);
    }
  });

  test("a target that matches a terminal name resolves its kind too", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({
      hcx: "ok",
      hc: "ok",
      logDir,
      terminals: [{ address: "t7", name: "Vrax", agent: "muse" }],
    });
    const c = probeCheck(home, bin, ["--notify", "Vrax"]);
    expect(c.out).toContain("ok notify: notified Vrax via hcx send");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(0);
  });

  test("a shell terminal kind keeps the tagged send and never calls hcx", () => {
    for (const kind of ["zsh", "bash"]) {
      const home = freshHome();
      const logDir = freshLogDir();
      const bin = routeBin({ hcx: "ok", hc: "ok", logDir, terminals: [{ address: "t7", agent: kind }] });
      const c = probeCheck(home, bin, ["--notify", "t7"]);
      expect(`${kind}: ${c.out}`).toContain("ok notify: notified t7 via hc send");
      expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(0);
      expect(sends(path.join(logDir, "hc.log"))).toHaveLength(1);
    }
  });

  test("an unknown kind keeps the tagged send and never calls hcx", () => {
    // The target is not in the live terminal list.
    const home1 = freshHome();
    const logDir1 = freshLogDir();
    const bin1 = routeBin({ hcx: "ok", hc: "ok", logDir: logDir1, terminals: [{ address: "t9", agent: "muse" }] });
    const c1 = probeCheck(home1, bin1, ["--notify", "t7"]);
    expect(c1.out).toContain("ok notify: notified t7 via hc send");
    expect(sends(path.join(logDir1, "hcx.log"))).toHaveLength(0);
    expect(sends(path.join(logDir1, "hc.log"))).toHaveLength(1);

    // The terminal list itself is unreadable.
    const home2 = freshHome();
    const logDir2 = freshLogDir();
    const bin2 = routeBin({ hcx: "ok", hc: "ok", logDir: logDir2, terminals: null });
    const c2 = probeCheck(home2, bin2, ["--notify", "t7"]);
    expect(c2.out).toContain("ok notify: notified t7 via hc send");
    expect(sends(path.join(logDir2, "hcx.log"))).toHaveLength(0);
  });

  test("hcx absent uses hc send", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({ hc: "ok", logDir, terminals: [{ address: "t7", agent: "muse" }] });
    const c = probeCheck(home, bin, ["--notify", "t7"]);
    expect(c.out).toContain("ok notify: notified t7 via hc send");
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(1);
  });

  test("a failing hcx falls back to hc send and says so", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({ hcx: "fail", hc: "ok", logDir, terminals: [{ address: "t7", agent: "muse" }] });
    const c = probeCheck(home, bin, ["--notify", "t7"]);
    expect(c.out).toContain("ok notify: notified t7 via hc send (hcx failed: hcx is broken)");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(1);
  });

  test("check prints the last progress notify", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({ hcx: "ok", hc: "ok", logDir });
    const herdr = path.join(bin, "herdr");
    fs.writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logDir}/herdr.log"\nexit 0\n`);
    fs.chmodSync(herdr, 0o755);
    const r = cli(home, ["run", "--name", "slow", "--heartbeat", "1s", "--", "sh", "-c", "echo step1; sleep 3"], {
      HERDR_PANE_ID: "w9:p9",
      PATH: minimalPath(bin),
    });
    expect(r.code).toBe(0);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"'], 20000);
    const c = cli(home, ["check", id]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("progress notify: notified w9:p9");
    expect(readLog(path.join(logDir, "herdr.log"))).toContain("still running");
  });
});
