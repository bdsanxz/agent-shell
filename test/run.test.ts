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
