import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-07-"));
}

function jobIdFrom(out: string): string {
  return out.split("\n")[0]!.replace("job ", "").trim();
}

function waitForStatus(home: string, id: string, pred: (s: string) => boolean, timeoutMs = 15000): string {
  const t0 = Date.now();
  for (;;) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8");
    } catch {
      text = "";
    }
    if (text !== "" && pred(text)) {
      if (text.includes("pending: completion notify")) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} stuck pending`);
        Bun.sleepSync(200);
        continue;
      }
      return text;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} timeout waiting: ${text}`);
    Bun.sleepSync(200);
  }
}

function waitForMeta(home: string, id: string, pred: (m: Record<string, unknown>) => boolean, timeoutMs = 10000): Record<string, unknown> {
  const t0 = Date.now();
  for (;;) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "meta.json"), "utf8")) as Record<string, unknown>;
      if (pred(m)) return m;
    } catch {
      // retry
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`meta timeout for ${id}`);
    Bun.sleepSync(100);
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroupQuiet(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // gone
  }
}

describe("0.5.0 item 1: process groups for kill", () => {
  test("kill stops grandchildren of sh -c", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "group", "--", "sh", "-c", "sleep 300 & wait"]);
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    const meta = waitForMeta(home, id, (m) => typeof m["child_pid"] === "number" && (m["child_pid"] as number) > 0);
    const pgid = (meta["pgid"] as number) ?? (meta["child_pid"] as number);
    expect(typeof pgid).toBe("number");
    Bun.sleepSync(500);
    expect(groupAlive(pgid)).toBe(true);
    try {
      const k = cli(home, ["kill", id]);
      expect(k.code).toBe(0);
      expect(k.out).toContain(`killed ${id}`);
      Bun.sleepSync(500);
      expect(groupAlive(pgid)).toBe(false);
      const status = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8"));
      expect(status.state).toBe("killed");
    } finally {
      killGroupQuiet(pgid);
      try {
        cli(home, ["kill", id]);
      } catch {
        // ignore
      }
      try {
        cli(home, ["clean"]);
      } catch {
        // ignore
      }
    }
    const ps = Bun.spawnSync(["sh", "-c", "ps -ax -o command | grep 'sleep 300' | grep -v grep || true"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(ps.stdout.toString().trim()).toBe("");
  });
});

describe("0.5.0 item 2: heartbeat back-off", () => {
  function stubHerdrBin(logFile: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-07-herdr-"));
    fs.writeFileSync(path.join(dir, "herdr"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\nexit 0\n`);
    fs.chmodSync(path.join(dir, "herdr"), 0o755);
    return dir;
  }

  test("interval doubles on unchanged output up to the cap, resets on new output", () => {
    const home = freshHome();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-07-hb-")), "herdr.log");
    const bin = stubHerdrBin(logFile);
    const env = {
      HERDR_PANE_ID: "w9:p9",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AGENT_SHELL_HEARTBEAT_MAX_MS: "4000",
    };
    const r = cli(home, ["run", "--name", "backoff", "--heartbeat", "1s", "--", "sh", "-c", "echo start; sleep 6"], env);
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    try {
      waitForStatus(home, id, (s) => s.includes("skipped: no new output"), 15000);
      const status = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8"));
      expect((status.heartbeat_current_ms as number) > 1000).toBe(true);
      expect((status.heartbeat_current_ms as number) <= 4000).toBe(true);
      const show = cli(home, ["show", id, "--json"], env);
      expect(show.code).toBe(0);
      const obj = JSON.parse(show.out) as Record<string, unknown>;
      expect(typeof obj["heartbeat_current_ms"]).toBe("number");
      expect((obj["heartbeat_current_ms"] as number) > 1000).toBe(true);
      expect(show.out).not.toContain("skipped-fail");
      const textShow = cli(home, ["show", id], env);
      expect(textShow.out).toContain("heartbeat_current");
    } finally {
      try {
        cli(home, ["kill", id], env);
      } catch {
        // ignore
      }
      try {
        waitForStatus(home, id, (s) => s.includes('"killed"') || s.includes('"done"'), 10000);
      } catch {
        // ignore
      }
      try {
        cli(home, ["clean"], env);
      } catch {
        // ignore
      }
    }
  });

  test("--heartbeat-fixed disables back-off", () => {
    const home = freshHome();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-07-hb-")), "herdr.log");
    const bin = stubHerdrBin(logFile);
    const env = {
      HERDR_PANE_ID: "w9:p9",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AGENT_SHELL_HEARTBEAT_MAX_MS: "8000",
    };
    const r = cli(
      home,
      ["run", "--name", "fixed", "--heartbeat", "1s", "--heartbeat-fixed", "--", "sh", "-c", "echo start; sleep 4"],
      env,
    );
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    try {
      Bun.sleepSync(3500);
      const status = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "status.json"), "utf8"));
      expect(status.heartbeat_current_ms).toBe(1000);
      expect(String(status.last_heartbeat_detail ?? "")).not.toContain("skipped: no new output");
      const meta = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "meta.json"), "utf8"));
      expect(meta.heartbeat_fixed).toBe(true);
    } finally {
      try {
        cli(home, ["kill", id], env);
      } catch {
        // ignore
      }
      try {
        cli(home, ["clean"], env);
      } catch {
        // ignore
      }
    }
  });
});

describe("0.5.0 item 3: supervisor-death lost", () => {
  test("dead supervisor reports lost, kill clears orphans, clean removes", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "lostprobe", "--", "sh", "-c", "sleep 30"]);
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    const meta = waitForMeta(home, id, (m) => typeof m["supervisor_pid"] === "number" && (m["supervisor_pid"] as number) > 0);
    const sup = meta["supervisor_pid"] as number;
    const pgid = (meta["pgid"] as number) ?? (meta["child_pid"] as number);
    try {
      try {
        process.kill(sup, "SIGKILL");
      } catch {
        // already gone
      }
      Bun.sleepSync(800);
      const show = cli(home, ["show", id]);
      expect(show.code).toBe(0);
      expect(show.out).toContain("state lost");
      const showJson = cli(home, ["show", id, "--json"]);
      expect(JSON.parse(showJson.out).state).toBe("lost");
      const list = cli(home, ["list"]);
      expect(list.out).toContain(id);
      expect(list.out).toContain("lost");
      const listJson = cli(home, ["list", "--json"]);
      expect(listJson.out).toContain('"lost"');
      const check = cli(home, ["check", id]);
      expect(check.code).toBe(1);
      expect(check.out).toContain("lost");
      const kill = cli(home, ["kill", id]);
      expect(kill.code).toBe(0);
      expect(groupAlive(pgid)).toBe(false);
      const after = cli(home, ["show", id, "--json"]);
      expect(JSON.parse(after.out).state).toBe("lost");
      const clean = cli(home, ["clean"]);
      expect(clean.code).toBe(0);
      expect(clean.out).toContain("removed 1");
      expect(fs.existsSync(path.join(home, "jobs", id))).toBe(false);
    } finally {
      killGroupQuiet(pgid);
      try {
        cli(home, ["clean"]);
      } catch {
        // ignore
      }
    }
  });
});

describe("0.5.0 item 4: bounded log reads", () => {
  test("a log larger than the cap is truncated, not read whole", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "big", "--", "sh", "-c", "echo hi"]);
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    waitForStatus(home, id, (s) => s.includes('"done"'));
    const logPath = path.join(home, "jobs", id, "output.log");
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(`line-${String(i).padStart(5, "0")}-` + "x".repeat(80));
    fs.writeFileSync(logPath, lines.join("\n") + "\n");
    const size = fs.statSync(logPath).size;
    expect(size > 256 * 1024).toBe(true);
    const tail = cli(home, ["tail", id, "--lines", "5", "--json"]);
    expect(tail.code).toBe(0);
    const t = JSON.parse(tail.out) as Record<string, unknown>;
    expect(t["truncated"]).toBe(true);
    expect(t["lines"]).toEqual(lines.slice(-5));
    const show = cli(home, ["show", id, "--json"]);
    const s = JSON.parse(show.out) as Record<string, unknown>;
    expect(s["truncated"]).toBe(true);
    const text = cli(home, ["show", id, "--tail", "5"]);
    expect(text.out).toContain("output truncated at 256 KiB");
    const tailText = cli(home, ["tail", id, "--lines", "5"]);
    expect(tailText.out).toContain("output truncated at 256 KiB");
    expect(cli(home, ["clean"]).out).toContain("removed 1");
  });
});

describe("0.5.0 item 5: permissions 0700/0600", () => {
  test("new job dirs are 0700 and files 0600", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "perm", "--", "sh", "-c", "echo hi"]);
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    waitForStatus(home, id, (s) => s.includes('"done"'));
    const dir = path.join(home, "jobs", id);
    const dirMode = fs.statSync(dir).mode & 0o777;
    expect(dirMode).toBe(0o700);
    for (const f of ["meta.json", "status.json", "output.log"]) {
      const m = fs.statSync(path.join(dir, f)).mode & 0o777;
      expect(m).toBe(0o600);
    }
    expect(cli(home, ["clean"]).out).toContain("removed 1");
  });
});

describe("0.5.0 item 6: output sanitising", () => {
  test("show/tail/check sanitise, the log stays raw", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "san", "--", "sh", "-c", "echo hi"]);
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    waitForStatus(home, id, (s) => s.includes('"done"'));
    const logPath = path.join(home, "jobs", id, "output.log");
    const raw = "[31mred[0m\rplain\nfoo[2Kbar\nbaz\tqux\n";
    fs.writeFileSync(logPath, raw);
    const show = cli(home, ["show", id]);
    expect(show.out).toContain("plain");
    expect(show.out).toContain("foobar");
    expect(show.out).toContain("baz");
    expect(show.out).not.toContain("");
    const tailJson = cli(home, ["tail", id, "--json"]);
    const t = JSON.parse(tailJson.out) as Record<string, unknown>;
    expect(t["output"] as string).toContain("plain");
    expect(t["output"] as string).not.toContain("");
    const showJson = cli(home, ["show", id, "--json"]);
    const s = JSON.parse(showJson.out) as Record<string, unknown>;
    expect(s["output"] as string).toContain("plain");
    expect(s["output"] as string).not.toContain("");
    expect(fs.readFileSync(logPath, "utf8")).toBe(raw);
    const check = cli(home, ["check", id]);
    expect(check.code).toBe(0);
    expect(check.out).toContain("ok output:");
    expect(cli(home, ["clean"]).out).toContain("removed 1");
  });
});

describe("0.5.0 addendum: kill never signals a gone leader's group", () => {
  test("externally SIGKILLed leader: kill reports hint, marks lost, spares the orphan and an unrelated group", () => {
    const home = freshHome();
    const id = "sh-hardening-test";
    const dir = path.join(home, "jobs", id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fakeSup = nodeSpawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    fakeSup.unref();
    const fakeSupPid = fakeSup.pid as number;
    const leaderProc = nodeSpawn("sh", ["-c", "sleep 300 & wait"], { detached: true, stdio: "ignore" });
    leaderProc.unref();
    const leader = leaderProc.pid as number;
    const pgid = leader;
    const unrelated = nodeSpawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    unrelated.unref();
    const unrelatedPgid = unrelated.pid as number;
    try {
      Bun.sleepSync(800);
      expect(groupAlive(pgid)).toBe(true);
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          id,
          name: "hard",
          command: ["sh", "-c", "sleep 300 & wait"],
          cwd: process.cwd(),
          created_ms: Date.now(),
          owner: { pane_id: "", agent_name: "", workspace_id: "" },
          notify_target: "",
          heartbeat_ms: null,
          heartbeat_fixed: false,
          child_pid: leader,
          supervisor_pid: fakeSupPid,
          // Bogus start time so leaderMatches is false even while the
          // SIGKILLed leader lingers as a zombie (parent has not reaped it).
          child_lstart: "bogus mismatch for hardening test",
          supervisor_lstart: null,
          pgid,
        }) + "\n",
      );
      fs.chmodSync(path.join(dir, "meta.json"), 0o600);
      fs.writeFileSync(
        path.join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          exit_code: null,
          done_ms: null,
          duration_ms: null,
          notified: false,
          notify_detail: "",
          notify_outcome: "",
          notify_route: null,
          notify_agent: null,
          notify_note: null,
          heartbeats: 0,
          last_heartbeat_ms: null,
          last_heartbeat_detail: "",
          error: null,
          heartbeat_current_ms: null,
        }) + "\n",
      );
      fs.chmodSync(path.join(dir, "status.json"), 0o600);
      try {
        process.kill(leader, "SIGKILL");
      } catch {
        // already gone
      }
      Bun.sleepSync(800);
      expect(groupAlive(pgid)).toBe(true);
      const k = cli(home, ["kill", id]);
      expect(k.code).toBe(0);
      expect(k.out).toContain(`lost ${id}`);
      expect(k.out).toContain(`pgid ${pgid} not signalled: its leader is gone`);
      expect(groupAlive(pgid)).toBe(true);
      try {
        process.kill(unrelatedPgid, 0);
      } catch {
        throw new Error("unrelated sleep was killed; group signal leaked");
      }
      const show = cli(home, ["show", id, "--json"]);
      expect(JSON.parse(show.out).state).toBe("lost");
      expect(JSON.parse(cli(home, ["kill", id, "--json"]).out).signalled).toBe(false);
    } finally {
      killGroupQuiet(pgid);
      for (const pid of [fakeSupPid, unrelatedPgid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // gone
        }
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("reused-PID stub (lstart mismatch) never signals -pgid", () => {
    const home = freshHome();
    const sleeper = nodeSpawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    const otherPid = sleeper.pid as number;
    try {
      const dir = path.join(home, "jobs", "sh-9999-reuse2");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          id: "sh-9999-reuse2",
          name: "reuse",
          command: ["sh", "-c", "sleep 30"],
          cwd: process.cwd(),
          created_ms: Date.now(),
          owner: { pane_id: "", agent_name: "", workspace_id: "" },
          notify_target: "",
          heartbeat_ms: null,
          heartbeat_fixed: false,
          child_pid: otherPid,
          supervisor_pid: null,
          child_lstart: "bogus mismatch for test",
          supervisor_lstart: null,
          pgid: otherPid,
        }) + "\n",
      );
      fs.chmodSync(path.join(dir, "meta.json"), 0o600);
      fs.writeFileSync(
        path.join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          exit_code: null,
          done_ms: null,
          duration_ms: null,
          notified: false,
          notify_detail: "",
          notify_outcome: "",
          notify_route: null,
          notify_agent: null,
          notify_note: null,
          heartbeats: 0,
          last_heartbeat_ms: null,
          last_heartbeat_detail: "",
          error: null,
          heartbeat_current_ms: null,
        }) + "\n",
      );
      fs.chmodSync(path.join(dir, "status.json"), 0o600);
      const k = cli(home, ["kill", "sh-9999-reuse2"]);
      expect(k.code).toBe(0);
      expect(k.out).toContain("lost sh-9999-reuse2");
      expect(k.out).toContain(`pgid ${otherPid} not signalled: its leader is gone`);
      let alive = true;
      try {
        process.kill(otherPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).state).toBe("lost");
    } finally {
      try {
        sleeper.kill("SIGKILL");
      } catch {
        // gone
      }
      try {
        process.kill(otherPid, "SIGKILL");
      } catch {
        // gone
      }
    }
  });
});
