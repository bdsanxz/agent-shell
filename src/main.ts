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
try {
  if (rest.includes("--help") && rest.length === 1) {
    const text = HELP[cmd];
    if (!text) throw new UsageError(`unknown command "${cmd}"`);
    console.log(text);
    process.exit(0);
  }
  process.exitCode = await dispatch(cmd, rest);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof UsageError) {
    console.error(`agent-shell ${label}: ${msg}\nRun \`agent-shell ${label} --help\` for usage.`);
    process.exitCode = 2;
  } else {
    console.error(`agent-shell ${label}: ${msg}`);
    process.exitCode = 1;
  }
}
