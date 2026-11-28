import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.resolve(rootDir, "node_modules/tsx/dist/cli.mjs");
const viteBin = path.resolve(rootDir, "node_modules/vite/bin/vite.js");

const children = [
  spawn(process.execPath, [tsxBin, "watch", "apps/api/src/server.ts"], {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
    detached: !isWindows,
  }),
  spawn(process.execPath, [viteBin, "--port", "5174", "--host", "127.0.0.1"], {
    cwd: path.resolve(rootDir, "apps/web"),
    stdio: "inherit",
    env: process.env,
    detached: !isWindows,
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
  } else if (!isWindows && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // fallback to direct child termination
    }
  }
  if (!child.killed) child.kill("SIGTERM");
}

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    terminateChildTree(child);
  }
  process.exit(exitCode);
}

for (const child of children) {
  child.on("error", () => shutdown(1));
  child.on("exit", (code, signal) => {
    if (!shuttingDown && (code !== 0 || signal !== null)) {
      shutdown(typeof code === "number" && code !== 0 ? code : 1);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
