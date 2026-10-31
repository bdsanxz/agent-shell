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
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-json-"));
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

function parseOne(out: string): Record<string, unknown> {
  const lines = out.trim().split("\n");
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function expectIso(v: unknown): void {
  expect(typeof v).toBe("string");
  const s = v as string;
  expect(Number.isNaN(Date.parse(s))).toBe(false);
  expect(s).toContain("T");
}

function expectSnakeKeys(obj: Record<string, unknown>): void {
  for (const k of Object.keys(obj)) {
    expect(k).toMatch(/^[a-z0-9_]+$/);
  }
}

describe("json: run", () => {
  test("text and json both succeed with the same exit code", () => {
    const home = freshHome();
    const text = cli(home, ["run", "--name", "probe", "--", "sh", "-c", "echo hello; exit 0"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("job sh-");
    expect(text.out).toContain("heartbeat");
    const idText = text.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, idText, ['"done"']);
    const home2 = freshHome();
    const json = cli(home2, ["run", "--name", "probe", "--json", "--", "sh", "-c", "echo hello; exit 0"]);
    expect(json.code).toBe(0);
    expect(json.err.trim()).toBe("");
    const obj = parseOne(json.out);
    expectSnakeKeys(obj);
    expect(typeof obj["id"]).toBe("string");
    expect((obj["id"] as string).startsWith("sh-")).toBe(true);
    expect(obj["name"]).toBe("probe");
    expect(obj["command"]).toEqual(["sh", "-c", "echo hello; exit 0"]);
    expect(typeof obj["command_string"]).toBe("string");
    expect(typeof obj["cwd"]).toBe("string");
    expect(typeof obj["created_ms"]).toBe("number");
    expectIso(obj["created_at"]);
    expect(typeof obj["notify_target"]).toBe("string");
    expect("notify_warning" in obj).toBe(true);
    expect("heartbeat_ms" in obj).toBe(true);
    expect(typeof obj["read_hint"]).toBe("string");
    expect(obj["wait"]).toBeNull();
    expect(json.out).not.toContain("job sh-");
    expect(JSON.stringify(obj)).not.toContain("GITHUB_TOKEN");
    const id = obj["id"] as string;
    waitFor(home2, id, ['"done"']);
  });

  test("run --wait json carries wait, exit code and output", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--wait", "5s", "--json", "--", "sh", "-c", "echo inline-ok"]);
    expect(r.code).toBe(0);
    expect(r.err.trim()).toBe("");
    const obj = parseOne(r.out);
    const wait = obj["wait"] as Record<string, unknown>;
    expect(wait["timed_out"]).toBe(false);
    expect(wait["exit_code"]).toBe(0);
    expect(wait["state"]).toBe("done");
    expect(wait["output"] as string).toContain("inline-ok");
    expect(typeof wait["wait_ms"]).toBe("number");
  });

  test("run --wait timeout json exits 124 with timed_out", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--wait", "1s", "--json", "--", "sh", "-c", "sleep 5"]);
    expect(r.code).toBe(124);
    const obj = parseOne(r.out);
    const wait = obj["wait"] as Record<string, unknown>;
    expect(wait["timed_out"]).toBe(true);
    expect(wait["state"]).toBe("running");
    expect(wait["exit_code"]).toBeNull();
    const id = obj["id"] as string;
    expect(cli(home, ["kill", id]).code).toBe(0);
  });

  test("run validation errors honour json with stable kinds", () => {
    const home = freshHome();
    const badCwd = cli(home, ["run", "--cwd", "/no-such-dir-xyz-123", "--json", "--", "sh", "-c", "true"]);
    expect(badCwd.code).toBe(2);
    expect(badCwd.err.trim()).toBe("");
    const e1 = parseOne(badCwd.out);
    expect((e1["error"] as Record<string, unknown>)["kind"]).toBe("not_found");
    const badExe = cli(home, ["run", "--json", "--", "no-such-exe-xyz-123"]);
    expect(badExe.code).toBe(2);
    expect(badExe.err.trim()).toBe("");
    const e2 = parseOne(badExe.out);
    expect((e2["error"] as Record<string, unknown>)["kind"]).toBe("not_found");
    const missing = cli(home, ["run", "--json"]);
    expect(missing.code).toBe(2);
    const e3 = parseOne(missing.out);
    expect((e3["error"] as Record<string, unknown>)["kind"]).toBe("usage");
  });
});

describe("json: list", () => {
  test("text is a table, json is JSON lines with snake_case and ISO timestamps", () => {
    const home = freshHome();
    const r1 = cli(home, ["run", "--name", "a", "--", "sh", "-c", "echo hi; exit 0"]);
    const id1 = r1.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id1, ['"done"']);
    const r2 = cli(home, ["run", "--name", "b", "--", "sh", "-c", "sleep 30"]);
    const id2 = r2.out.split("\n")[0]!.replace("job ", "").trim();
    const text = cli(home, ["list"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("ID");
    expect(text.out).toContain(id1);
    expect(text.out).toContain(id2);
    const json = cli(home, ["list", "--json"]);
    expect(json.code).toBe(0);
    expect(json.err.trim()).toBe("");
    expect(json.out).not.toContain("ID ");
    const lines = json.out.trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expectSnakeKeys(obj);
      expect(typeof obj["id"]).toBe("string");
      expect(typeof obj["name"]).toBe("string");
      expect(typeof obj["state"]).toBe("string");
      expect("exit" in obj).toBe(true);
      expect("exit_code" in obj).toBe(true);
      expect(typeof obj["cmd"]).toBe("string");
      expect(Array.isArray(obj["command"])).toBe(true);
      expect(typeof obj["heartbeats"]).toBe("number");
      expect(typeof obj["created_ms"]).toBe("number");
      expectIso(obj["created_at"]);
    }
    expect(cli(home, ["kill", id2]).code).toBe(0);
    expect(cli(home, ["clean"]).out).toContain("removed");
  });

  test("list unknown option honours json with kind usage", () => {
    const home = freshHome();
    const text = cli(home, ["list", "--bogus=x"]);
    expect(text.code).toBe(2);
    expect(text.err).toContain("unknown option");
    const json = cli(home, ["list", "--bogus=x", "--json"]);
    expect(json.code).toBe(2);
    expect(json.err.trim()).toBe("");
    const obj = parseOne(json.out);
    expect((obj["error"] as Record<string, unknown>)["kind"]).toBe("usage");
  });
});

describe("json: show and tail", () => {
  test("show text and json cover the same job", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "probe", "--", "sh", "-c", "echo hello; exit 0"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const text = cli(home, ["show", id]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`job ${id}`);
    expect(text.out).toContain("heartbeat");
    expect(text.out).toContain("hello");
    const json = cli(home, ["show", id, "--json"]);
    expect(json.code).toBe(0);
    expect(json.err.trim()).toBe("");
    const obj = parseOne(json.out);
    expectSnakeKeys(obj);
    expect(obj["id"]).toBe(id);
    expect(obj["name"]).toBe("probe");
    expect(obj["command"]).toEqual(["sh", "-c", "echo hello; exit 0"]);
    expect(typeof obj["command_string"]).toBe("string");
    expect(typeof obj["cwd"]).toBe("string");
    expectIso(obj["created_at"]);
    expect(obj["state"]).toBe("done");
    expect(obj["exit_code"]).toBe(0);
    expect(typeof obj["duration_ms"]).toBe("number");
    expectIso(obj["done_at"]);
    expect("error" in obj).toBe(true);
    expect(typeof obj["notify_detail"]).toBe("string");
    expect(typeof obj["notify_outcome"]).toBe("string");
    expect("notify_route" in obj).toBe(true);
    expect("heartbeat_ms" in obj).toBe(true);
    expect(typeof obj["heartbeats"]).toBe("number");
    expect(typeof obj["output"]).toBe("string");
    expect((obj["output"] as string)).toContain("hello");
    expect(obj["tail_lines_requested"]).toBe(30);
    expect(obj["line_count"]).toBe(1);
  });

  test("tail text and json", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "echo one; echo two"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const text = cli(home, ["tail", id]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("one");
    const json = cli(home, ["tail", id, "--json"]);
    expect(json.code).toBe(0);
    expect(json.err.trim()).toBe("");
    const obj = parseOne(json.out);
    expect(obj["id"]).toBe(id);
    expect(obj["lines_requested"]).toBe(50);
    expect(obj["line_count"]).toBe(2);
    expect(obj["lines"]).toEqual(["one", "two"]);
    expect((obj["output"] as string)).toContain("one");
  });

  test("show and tail errors honour json with not_found and usage", () => {
    const home = freshHome();
    const unknown = cli(home, ["show", "sh-nope", "--json"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err.trim()).toBe("");
    expect((parseOne(unknown.out)["error"] as Record<string, unknown>)["kind"]).toBe("not_found");
    const unknownTail = cli(home, ["tail", "sh-nope", "--json"]);
    expect(unknownTail.code).toBe(2);
    expect((parseOne(unknownTail.out)["error"] as Record<string, unknown>)["kind"]).toBe("not_found");
    const badTail = cli(home, ["show", "sh-nope", "--tail", "abc", "--json"]);
    expect(badTail.code).toBe(2);
    expect((parseOne(badTail.out)["error"] as Record<string, unknown>)["kind"]).toBe("usage");
    const missing = cli(home, ["show", "--json"]);
    expect(missing.code).toBe(2);
    expect((parseOne(missing.out)["error"] as Record<string, unknown>)["kind"]).toBe("usage");
    const textCode = cli(home, ["show", "sh-nope"]).code;
    expect(textCode).toBe(unknown.code);
  });
});

describe("json: check", () => {
  test("check text and json agree on a passing job", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "echo hi; exit 0"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const text = cli(home, ["check", id]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("4/4 pass");
    const json = cli(home, ["check", id, "--json"]);
    expect(json.code).toBe(0);
    expect(json.err.trim()).toBe("");
    const obj = parseOne(json.out);
    expectSnakeKeys(obj);
    expect(obj["id"]).toBe(id);
    expect(obj["state"]).toBe("done");
    expect(obj["exit_code"]).toBe(0);
    expect(obj["output_lines"]).toBe(1);
    expect(obj["output_ok"]).toBe(true);
    expect(typeof obj["notify_detail"]).toBe("string");
    expect(typeof obj["notify_outcome"]).toBe("string");
    expect(obj["notify_ok"]).toBe(true);
    expect(typeof obj["progress_notify"]).toBe("string");
    expect(obj["checks"]).toHaveLength(4);
    expect(obj["pass"]).toBe(4);
    expect(obj["total"]).toBe(4);
    expect(obj["success"]).toBe(true);
  });

  test("check json fails with exit 1 on a failed job", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "exit 3"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"failed"']);
    const text = cli(home, ["check", id]);
    expect(text.code).toBe(1);
    const json = cli(home, ["check", id, "--json"]);
    expect(json.code).toBe(1);
    expect(json.err.trim()).toBe("");
    const obj = parseOne(json.out);
    expect(obj["success"]).toBe(false);
    expect(obj["exit_code"]).toBe(3);
    expect(obj["pass"]).toBe(4);
  });

  test("check errors honour json: running and not_found", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "sleep 30"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    const running = cli(home, ["check", id, "--json"]);
    expect(running.code).toBe(2);
    expect(running.err.trim()).toBe("");
    expect((parseOne(running.out)["error"] as Record<string, unknown>)["kind"]).toBe("running");
    expect(cli(home, ["check", id]).code).toBe(2);
    expect(cli(home, ["kill", id]).code).toBe(0);
    const unknown = cli(home, ["check", "sh-nope", "--json"]);
    expect(unknown.code).toBe(2);
    expect((parseOne(unknown.out)["error"] as Record<string, unknown>)["kind"]).toBe("not_found");
  });
});

describe("json: kill and clean", () => {
  test("kill text and json", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "sleep 30"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    const json = cli(home, ["kill", id, "--json"]);
    expect(json.code).toBe(0);
    expect(json.err.trim()).toBe("");
    const obj = parseOne(json.out);
    expect(obj["id"]).toBe(id);
    expect(obj["state"]).toBe("killed");
    expect(typeof obj["signalled"]).toBe("boolean");
    expect(typeof obj["detail"]).toBe("string");
    expectIso(obj["done_at"]);
    const home2 = freshHome();
    const r2 = cli(home2, ["run", "--", "sh", "-c", "sleep 30"]);
    const id2 = r2.out.split("\n")[0]!.replace("job ", "").trim();
    const text = cli(home2, ["kill", id2]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`killed ${id2}`);
  });

  test("kill errors honour json: not_running and not_found", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "exit 0"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const finished = cli(home, ["kill", id, "--json"]);
    expect(finished.code).toBe(2);
    expect(finished.err.trim()).toBe("");
    expect((parseOne(finished.out)["error"] as Record<string, unknown>)["kind"]).toBe("not_running");
    expect(cli(home, ["kill", id]).code).toBe(2);
    const unknown = cli(home, ["kill", "sh-nope", "--json"]);
    expect(unknown.code).toBe(2);
    expect((parseOne(unknown.out)["error"] as Record<string, unknown>)["kind"]).toBe("not_found");
  });

  test("clean text and json", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--", "sh", "-c", "exit 0"]);
    const id = r.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home, id, ['"done"']);
    const json = cli(home, ["clean", "--json"]);
    expect(json.code).toBe(0);
    expect(json.err.trim()).toBe("");
    const obj = parseOne(json.out);
    expect(obj["removed"]).toBe(1);
    expect(obj["removed_ids"]).toEqual([id]);
    const home2 = freshHome();
    const r2 = cli(home2, ["run", "--", "sh", "-c", "exit 0"]);
    const id2 = r2.out.split("\n")[0]!.replace("job ", "").trim();
    waitFor(home2, id2, ['"done"']);
    const text = cli(home2, ["clean"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("removed 1");
  });
});

describe("json: help, secrecy and shape", () => {
  test("every command help documents its json shape", () => {
    for (const cmd of ["run", "list", "show", "tail", "check", "kill", "clean"]) {
      const h = cli(freshHome(), [cmd, "--help"]);
      expect(h.code).toBe(0);
      expect(h.out).toContain("--json");
      expect(h.out).toContain("With --json");
    }
  });

  test("json never prints secrets or the environment", () => {
    const home = freshHome();
    const secretEnv = { GITHUB_TOKEN: "secret-token-xyz-123", SUPER_SECRET: "shhh" };
    const r = cli(home, ["run", "--json", "--", "sh", "-c", "exit 0"], secretEnv);
    expect(r.out).not.toContain("secret-token-xyz-123");
    expect(r.out).not.toContain("shhh");
    const id = (parseOne(r.out)["id"] as string);
    waitFor(home, id, ['"done"']);
    for (const args of [["show", id, "--json"], ["tail", id, "--json"], ["check", id, "--json"], ["list", "--json"], ["clean", "--json"]] as string[][]) {
      const out = cli(home, args, secretEnv).out;
      expect(out).not.toContain("secret-token-xyz-123");
      expect(out).not.toContain("shhh");
    }
  });

  test("unknown command honours json with kind usage", () => {
    const home = freshHome();
    const text = cli(home, ["nope"]);
    expect(text.code).toBe(2);
    const json = cli(home, ["nope", "--json"]);
    expect(json.code).toBe(2);
    expect(json.err.trim()).toBe("");
    expect((parseOne(json.out)["error"] as Record<string, unknown>)["kind"]).toBe("usage");
  });
});
