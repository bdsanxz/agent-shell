import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url));

const ASSET = "agent-shell.js";

function fakeAsset(): string {
  return '#!/bin/sh\nprintf "agent-shell 0.4.0\\n"\n';
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function makeRelease(asset: string, body: string, sums?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-shell-fake-release-"));
  writeFileSync(join(dir, asset), body);
  chmodSync(join(dir, asset), 0o755);
  writeFileSync(join(dir, `${asset}.sha256`), sums ?? `${sha256Hex(body)}  ${asset}\n`);
  return dir;
}

function testEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.AGENT_SHELL_VERSION;
  delete env.AGENT_SHELL_INSTALL_DIR;
  delete env.AGENT_SHELL_FORCE;
  delete env.AGENT_SHELL_ASSET;
  delete env.AGENT_SHELL_BASE_URL;
  return Object.assign(env, extra);
}

function runInstaller(args: string[], extraEnv: Record<string, string>): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["sh", INSTALL, ...args], {
    env: testEnv(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout?.toString() ?? "", err: proc.stderr?.toString() ?? "" };
}

describe("install.sh against a fake release", () => {
  test("installs the asset when the hash matches", () => {
    const body = fakeAsset();
    const release = makeRelease(ASSET, body);
    const dir = mkdtempSync(join(tmpdir(), "agent-shell-install-"));
    const run = runInstaller(["--dir", dir], { AGENT_SHELL_BASE_URL: `file://${release}` });
    expect(run.code).toBe(0);
    expect(run.err).toContain(`installed ${dir}/agent-shell`);
    expect(run.err).toContain("not on PATH");
    expect(run.out).toContain("agent-shell 0.4.0");
    expect(readFileSync(join(dir, "agent-shell"), "utf8")).toBe(body);
    expect(statSync(join(dir, "agent-shell")).mode & 0o111).not.toBe(0);
  });

  test("a hash mismatch refuses and leaves the old file untouched", () => {
    const release = makeRelease(ASSET, fakeAsset(), `${"0".repeat(64)}  ${ASSET}\n`);
    const dir = mkdtempSync(join(tmpdir(), "agent-shell-install-"));
    writeFileSync(join(dir, "agent-shell"), "old agent-shell\n");
    const run = runInstaller(["--dir", dir], { AGENT_SHELL_BASE_URL: `file://${release}` });
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("checksum mismatch");
    expect(readFileSync(join(dir, "agent-shell"), "utf8")).toBe("old agent-shell\n");
  });

  test("a foreign symlink needs --force", () => {
    const body = fakeAsset();
    const release = makeRelease(ASSET, body);
    const dir = mkdtempSync(join(tmpdir(), "agent-shell-install-"));
    const target = join(dir, "dev-agent-shell");
    writeFileSync(target, "dev build\n");
    symlinkSync(target, join(dir, "agent-shell"));
    const refused = runInstaller(["--dir", dir], { AGENT_SHELL_BASE_URL: `file://${release}` });
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("symlink");
    expect(refused.err).toContain(target);
    expect(lstatSync(join(dir, "agent-shell")).isSymbolicLink()).toBe(true);
    const forced = runInstaller(["--dir", dir, "--force"], { AGENT_SHELL_BASE_URL: `file://${release}` });
    expect(forced.code).toBe(0);
    expect(lstatSync(join(dir, "agent-shell")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "agent-shell"), "utf8")).toBe(body);
  });

  test("shasum is used when sha256sum is missing", () => {
    const body = fakeAsset();
    const release = makeRelease(ASSET, body);
    const dir = mkdtempSync(join(tmpdir(), "agent-shell-install-"));
    const bin = mkdtempSync(join(tmpdir(), "agent-shell-fakebin-"));
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "bun"), 0o755);
    const run = runInstaller(["--dir", dir], {
      AGENT_SHELL_BASE_URL: `file://${release}`,
      PATH: `${bin}:/usr/bin:/bin`,
    });
    expect(run.code).toBe(0);
    expect(readFileSync(join(dir, "agent-shell"), "utf8")).toBe(body);
  });

  test("404 then token via stdin config, token never in argv", () => {
    const body = fakeAsset();
    const hash = sha256Hex(body);
    const shaBody = `${hash}  ${ASSET}\n`;
    const releaseJson = `{
  "assets": [
    {
      "url": "https://api.github.com/repos/bdsanxz/agent-shell/releases/assets/1",
      "name": "agent-shell.js",
      "id": 1
    },
    {
      "url": "https://api.github.com/repos/bdsanxz/agent-shell/releases/assets/2",
      "name": "agent-shell.js.sha256",
      "id": 2
    }
  ]
}`;
    const bin = mkdtempSync(join(tmpdir(), "agent-shell-fakecurl-"));
    const curlLog = join(mkdtempSync(join(tmpdir(), "agent-shell-curllog-")), "curl.log");
    const stdinLog = join(mkdtempSync(join(tmpdir(), "agent-shell-stdinlog-")), "stdin.log");
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${curlLog}"
case "$*" in
  *'%{http_code}'*) printf '404'; exit 0 ;;
esac
case "$*" in
  *' -K '*|*' -K'|*'-K '*)
    cat > "${stdinLog}"
    OUT=""; PREV=""
    for a in "$@"; do
      if [ "$PREV" = "-o" ]; then OUT="$a"; fi
      PREV="$a"
    done
    URL=""
    for a in "$@"; do URL="$a"; done
    case "$URL" in
      */releases/latest|*/releases/tags/*) printf '%s' '${releaseJson}' > "$OUT"; exit 0 ;;
      */assets/1) printf '%s' '${body.replaceAll("'", "'\"'\"'")}' > "$OUT"; exit 0 ;;
      */assets/2) echo "${shaBody.trim()}" > "$OUT"; exit 0 ;;
      *) echo "unexpected URL $URL" >&2; exit 9 ;;
    esac
    ;;
  *) exit 22 ;;
esac
`,
    );
    chmodSync(join(bin, "curl"), 0o755);
    const dir = mkdtempSync(join(tmpdir(), "agent-shell-install-"));
    const secret = "secret-token-xyz-123";
    const run = runInstaller(["--dir", dir], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_TOKEN: secret,
    });
    expect(run.code).toBe(0);
    expect(readFileSync(join(dir, "agent-shell"), "utf8")).toBe(body);
    const logged = readFileSync(curlLog, "utf8");
    expect(logged).not.toContain(secret);
    expect(logged).toContain("-K -");
    expect(readFileSync(stdinLog, "utf8")).toContain(secret);
  });

  test("unknown option exits 2", () => {
    const run = runInstaller(["--bogus"], { AGENT_SHELL_BASE_URL: "file:///nonexistent" });
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("unknown option");
  });

  test("--help documents --force and omits --from-source", () => {
    const run = runInstaller(["--help"], {});
    expect(run.code).toBe(0);
    expect(run.out).toContain("--force");
    expect(run.out).toContain("--dir");
    expect(run.out).toContain("--version");
    expect(run.out).not.toContain("--from-source");
  });
});
