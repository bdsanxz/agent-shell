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

  /** A stub bin: `hc ls --json` prints `terminals`, `hc get <addr>` prints
   * `foreground`, and `hc send` / `hcx send` log their arguments. `hcx --version`
   * prints `hcxVersion` (default `hcx 0.1.3`), so `send --no-footer` is supported
   * unless a test opts out. `terminals: null` makes `hc ls` fail, so no kind can
   * be determined. `foreground: "fail"` and `"bogus"` make `hc get` fail or print
   * unparseable JSON. */
  function routeBin(spec: {
    logDir: string;
    herdr?: "ok" | "fail";
    hcx?: "ok" | "fail";
    hc?: "ok" | "fail";
    hcxVersion?: string;
    terminals?: Terminal[] | null;
    foreground?: { name: string } | "fail" | "bogus";
  }): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-route-"));
    const write = (name: string, body: string) => {
      const p = path.join(bin, name);
      fs.writeFileSync(p, body);
      fs.chmodSync(p, 0o755);
    };
    if (spec.herdr === "ok") write("herdr", "#!/bin/sh\nexit 0\n");
    if (spec.herdr === "fail") write("herdr", "#!/bin/sh\necho 'no herdr server is running' >&2\nexit 1\n");
    if (spec.hcx === "ok" || spec.hcx === "fail") {
      const version = spec.hcxVersion ?? "hcx 0.1.3";
      let body = `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spec.logDir}/hcx.log"\n`;
      body += `if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi\n`;
      if (spec.hcx === "fail") {
        body += "echo 'hcx is broken' >&2\nexit 1\n";
      } else {
        body += 'if [ "$1" = "send" ]; then exit 0; fi\necho "unexpected hcx call: $*" >&2\nexit 9\n';
      }
      write("hcx", body);
    }
    if (spec.hc === "ok") {
      const listing =
        spec.terminals === null
          ? "echo 'no terminal list' >&2\nexit 1"
          : `printf '%s\\n' '${JSON.stringify({ terminals: spec.terminals ?? [] })}'\nexit 0`;
      const get =
        spec.foreground === "fail"
          ? "echo 'no foreground' >&2\nexit 1"
          : spec.foreground === "bogus"
            ? "printf '%s\\n' 'not json'\nexit 0"
            : `printf '%s\\n' '${JSON.stringify({ foreground: spec.foreground ?? {} })}'\nexit 0`;
      write(
        "hc",
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spec.logDir}/hc.log"\nif [ "$1" = ls ]; then\n${listing}\nfi\nif [ "$1" = get ]; then\n${get}\nfi\nexit 0\n`,
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
      expect(`${kind}: ${c.out}`).toContain("ok notify: notified t7 via hcx send --no-footer");
      expect(`${kind}: ${JSON.stringify(sends(path.join(logDir, "hcx.log")))}`).toContain("send --no-footer t7 shell job 'probe' done");
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
    expect(c.out).toContain("ok notify: notified Vrax via hcx send --no-footer");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(0);
  });

  test("an hcx older than 0.1.3 keeps the tagged send and says why", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({
      hcx: "ok",
      hc: "ok",
      hcxVersion: "hcx 0.1.2",
      logDir,
      terminals: [{ address: "t7", agent: "muse" }],
    });
    const c = probeCheck(home, bin, ["--notify", "t7"]);
    expect(c.out).toContain("ok notify: notified t7 via hc send (hcx older than 0.1.3)");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(0);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(1);
  });

  test("an unparseable hcx version keeps the tagged send and says why", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({
      hcx: "ok",
      hc: "ok",
      hcxVersion: "hcx pre-release",
      logDir,
      terminals: [{ address: "t7", agent: "muse" }],
    });
    const c = probeCheck(home, bin, ["--notify", "t7"]);
    expect(c.out).toContain("ok notify: notified t7 via hc send (hcx version unknown");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(0);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(1);
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
      expect(readLog(path.join(logDir, "hcx.log"))).toBe("");
    }
  });

  test("a shell kind with a shell foreground stays a shell: tagged send", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({
      hcx: "ok",
      hc: "ok",
      logDir,
      terminals: [{ address: "t7", agent: "zsh" }],
      foreground: { name: "zsh" },
    });
    const c = probeCheck(home, bin, ["--notify", "t7"]);
    expect(c.out).toContain("ok notify: notified t7 via hc send");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(0);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(1);
    expect(readLog(path.join(logDir, "hcx.log"))).toBe("");
  });

  test("an opencode tab (zsh agent, opencode foreground) is an agent: untagged hcx", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({
      hcx: "ok",
      hc: "ok",
      logDir,
      terminals: [{ address: "t7", agent: "zsh" }],
      foreground: { name: "opencode" },
    });
    const c = probeCheck(home, bin, ["--notify", "t7"]);
    expect(c.out).toContain("ok notify: notified t7 via hcx send --no-footer");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(0);
    expect(readLog(path.join(logDir, "hc.log"))).toContain("get t7");
  });

  test("a claude-code tab with a version-string foreground stays claude-code", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({
      hcx: "ok",
      hc: "ok",
      logDir,
      terminals: [{ address: "t7", agent: "claude-code" }],
      foreground: { name: "2.1.314" },
    });
    const c = probeCheck(home, bin, ["--notify", "t7"]);
    expect(c.out).toContain("ok notify: notified t7 via hcx send --no-footer");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(1);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(0);
  });

  test("a failing hc get keeps the shell kind: tagged send", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({
      hcx: "ok",
      hc: "ok",
      logDir,
      terminals: [{ address: "t7", agent: "zsh" }],
      foreground: "fail",
    });
    const c = probeCheck(home, bin, ["--notify", "t7"]);
    expect(c.out).toContain("ok notify: notified t7 via hc send");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(0);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(1);
  });

  test("an unparseable hc get keeps the shell kind: tagged send", () => {
    const home = freshHome();
    const logDir = freshLogDir();
    const bin = routeBin({
      hcx: "ok",
      hc: "ok",
      logDir,
      terminals: [{ address: "t7", agent: "zsh" }],
      foreground: "bogus",
    });
    const c = probeCheck(home, bin, ["--notify", "t7"]);
    expect(c.out).toContain("ok notify: notified t7 via hc send");
    expect(sends(path.join(logDir, "hcx.log"))).toHaveLength(0);
    expect(sends(path.join(logDir, "hc.log"))).toHaveLength(1);
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
