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
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-name-"));
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

const VERSION_JSON = '{"hcx":"0.3.0","hc":"0.1.15","contract":1,"capabilities":["no-footer","agent-only","json-delivery"]}';

describe("job name case is kept", () => {
  test("run --name job-Pia stores job-Pia, not job-pia", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "job-Pia", "--json", "--", "sh", "-c", "echo hi; exit 0"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.out) as Record<string, unknown>;
    expect(obj["name"]).toBe("job-Pia");
    const id = obj["id"] as string;
    const meta = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta["name"]).toBe("job-Pia");
    waitFor(home, id, ['"done"']);
    expect(cli(home, ["clean"]).code).toBe(0);
  });

  test("invalid names are sanitised but keep case", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "Hello World!", "--json", "--", "sh", "-c", "echo hi; exit 0"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.out) as Record<string, unknown>;
    expect(obj["name"]).toBe("Hello-World");
    const id = obj["id"] as string;
    waitFor(home, id, ['"done"']);
    expect(cli(home, ["clean"]).code).toBe(0);
  });
});

describe("job lookup by name is case-insensitive", () => {
  test("show/tail/check resolve a name in any case", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "job-Pia", "--", "sh", "-c", "echo hello; exit 0"]);
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"']);
    const show = cli(home, ["show", "JOB-PIA", "--json"]);
    expect(show.code).toBe(0);
    const showObj = JSON.parse(show.out) as Record<string, unknown>;
    expect(showObj["id"]).toBe(id);
    expect(showObj["name"]).toBe("job-Pia");
    expect(showObj["output"] as string).toContain("hello");
    const tail = cli(home, ["tail", "job-pia", "--json"]);
    expect(tail.code).toBe(0);
    expect((JSON.parse(tail.out) as Record<string, unknown>)["id"]).toBe(id);
    const check = cli(home, ["check", "JoB-pIa", "--json"]);
    expect(check.code).toBe(0);
    expect((JSON.parse(check.out) as Record<string, unknown>)["id"]).toBe(id);
    expect(cli(home, ["clean"]).code).toBe(0);
  });

  test("kill resolves a name in any case", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "KillMe", "--", "sh", "-c", "sleep 30"]);
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    const k = cli(home, ["kill", "killme", "--json"]);
    expect(k.code).toBe(0);
    expect((JSON.parse(k.out) as Record<string, unknown>)["id"]).toBe(id);
    waitFor(home, id, ['"killed"']);
    expect(cli(home, ["clean"]).code).toBe(0);
  });

  test("not_found hint lists available ids and names", () => {
    const home = freshHome();
    const r = cli(home, ["run", "--name", "hintprobe", "--", "sh", "-c", "echo hi; exit 0"]);
    expect(r.code).toBe(0);
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"']);
    const unknown = cli(home, ["show", "sh-nope-xyz", "--json"]);
    expect(unknown.code).toBe(2);
    const obj = JSON.parse(unknown.out) as Record<string, unknown>;
    expect((obj["error"] as Record<string, unknown>)["kind"]).toBe("not_found");
    const hint = (obj["error"] as Record<string, unknown>)["hint"] as string;
    expect(hint).toContain(id);
    expect(hint).toContain("hintprobe");
    expect(cli(home, ["clean"]).code).toBe(0);
  });
});

describe("checkNotifyTarget uses hcx get --json and warns cleanly", () => {
  test("plain hcx: prefix is stripped and get is called with --json", () => {
    const home = freshHome();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-get-log-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-get-bin-"));
    fs.writeFileSync(
      path.join(bin, "hcx"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logDir}/hcx.log"\n` +
        `if [ "$1" = "--version" ]; then printf '%s\\n' '${VERSION_JSON}'; exit 0; fi\n` +
        `if [ "$1" = "get" ]; then echo "hcx: no such terminal ghost" >&2; exit 3; fi\n` +
        `if [ "$1" = "send" ]; then printf '%s\\n' '{"status":"idle","turn":3,"started":true,"delivered":true,"route":"hcx-raw","agent":"muse"}'; exit 0; fi\n` +
        `echo "unexpected hcx call: $*" >&2\nexit 9\n`,
    );
    fs.chmodSync(path.join(bin, "hcx"), 0o755);
    const r = cli(home, ["run", "--name", "probe", "--notify", "ghost", "--", "sh", "-c", "echo hello; exit 0"], {
      PATH: minimalPath(bin),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('warning: hcx cannot find notify target "ghost" (no such terminal ghost)');
    expect(r.out).not.toContain("hcx: no such");
    const logged = fs.readFileSync(path.join(logDir, "hcx.log"), "utf8");
    const getLine = logged.split("\n").find((l) => l.startsWith("get "));
    expect(getLine).toBeDefined();
    expect(getLine).toContain("--json");
    const id = jobIdFrom(r.out);
    waitFor(home, id, ['"done"']);
    expect(cli(home, ["clean"]).code).toBe(0);
  });
});
