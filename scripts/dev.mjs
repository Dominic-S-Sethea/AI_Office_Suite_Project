import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "apps/api/src/server.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn("npm.cmd", ["run", "dev", "--workspace=@ai-office-suite/web"], {
    stdio: "inherit",
    shell: true,
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
