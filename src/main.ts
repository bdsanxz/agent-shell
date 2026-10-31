import { UsageError } from "./args.ts";
import { HELP, dispatch } from "./commands.ts";
import pkg from "../package.json" with { type: "json" };

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "--version" || cmd === "-V" || cmd === "version") {
  console.log(`agent-shell ${pkg.version}`);
  process.exit(0);
}
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  const cmdHelp = cmd ? HELP[""] : undefined;
  console.log(cmdHelp ?? HELP[""]);
  process.exit(cmd ? 0 : 2);
}
const label = cmd;
const wantsJsonErr = process.argv.slice(2).some((a) => a === "--json" || a.startsWith("--json="));
function jsonError(kind: string, message: string, hint?: string): void {
  const error: Record<string, string> = { kind, message };
  if (hint !== undefined && hint !== "") error["hint"] = hint;
  console.log(JSON.stringify({ error }));
}
try {
  if (rest.includes("--help") && rest.length === 1) {
    const text = HELP[cmd];
    if (!text) throw new UsageError(`unknown command "${cmd}"`, "usage", "run agent-shell --help for the command list");
    console.log(text);
    process.exit(0);
  }
  process.exitCode = await dispatch(cmd, rest);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof UsageError) {
    if (wantsJsonErr) {
      jsonError(e.kind ?? "usage", msg, e.hint);
      process.exitCode = 2;
    } else {
      console.error(`agent-shell ${label}: ${msg}\nRun \`agent-shell ${label} --help\` for usage.`);
      process.exitCode = 2;
    }
  } else {
    if (wantsJsonErr) {
      jsonError("failed", msg);
      process.exitCode = 1;
    } else {
      console.error(`agent-shell ${label}: ${msg}`);
      process.exitCode = 1;
    }
  }
}
