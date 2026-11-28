import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const isWindows = process.platform === "win32";
const tsxBin = path.resolve("node_modules/tsx/dist/cli.mjs");
const viteBin = path.resolve("node_modules/vite/bin/vite.js");

const children = [
  spawn(process.execPath, [tsxBin, "apps/api/src/server.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(process.execPath, [viteBin, "--port", "5174", "--host", "127.0.0.1"], {
    cwd: path.resolve("apps/web"),
    stdio: "inherit",
    env: process.env,
  }),
];

function terminateChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows && child.pid) {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // fallback to direct signal termination
    }
  }
  if (!child.killed) child.kill("SIGTERM");
}

function shutdown() {
  for (const child of children) {
    terminateChildTree(child);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
