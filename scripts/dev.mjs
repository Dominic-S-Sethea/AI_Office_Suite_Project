import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";

const children = [
  spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "apps/api/src/server.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(npmCmd, ["run", "dev", "--workspace=@ai-office-suite/web"], {
    stdio: "inherit",
    shell: isWindows,
    env: process.env,
  }),
];

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
