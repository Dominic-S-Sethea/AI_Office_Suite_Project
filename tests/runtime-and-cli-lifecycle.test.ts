import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());

async function runNodeScript(args: string[], envOverrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      env,
      timeout: 15_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("Wave 1 Server Lifecycle & CLI Governance Suite (C9)", () => {
  it("enforces fail-closed startup guards in apps/api/src/server.ts (production loopback, missing DB/JWT, invalid TRUST_PROXY/PG_SSL_MODE)", async () => {
    const prodProto = await runNodeScript(["apps/api/src/server.ts"], {
      NODE_ENV: "production",
      AUTH_MODE: "provisional-local",
      DATABASE_URL: undefined,
    });
    expect(prodProto.code).not.toBe(0);
    expect(prodProto.stderr).toContain("PROVISIONAL_AUTH_LOOPBACK_ONLY");

    const nonLoopbackProto = await runNodeScript(["apps/api/src/server.ts"], {
      NODE_ENV: "development",
      AUTH_MODE: "provisional-local",
      HOST: "0.0.0.0",
      DATABASE_URL: undefined,
    });
    expect(nonLoopbackProto.code).not.toBe(0);
    expect(nonLoopbackProto.stderr).toContain("PROVISIONAL_AUTH_LOOPBACK_ONLY");

    const missingDb = await runNodeScript(["apps/api/src/server.ts"], {
      NODE_ENV: "development",
      AUTH_MODE: "jwt-pg",
      DATABASE_URL: undefined,
      JWT_SECRET: "a".repeat(40),
    });
    expect(missingDb.code).not.toBe(0);
    expect(missingDb.stderr).toContain("DATABASE_URL is required");

    const badTrustProxy = await runNodeScript(["apps/api/src/server.ts"], {
      NODE_ENV: "development",
      AUTH_MODE: "provisional-local",
      TRUST_PROXY: "invalid-hop",
    });
    expect(badTrustProxy.code).not.toBe(0);
    expect(badTrustProxy.stderr).toContain("Invalid TRUST_PROXY");

    const badSsl = await runNodeScript(["apps/api/src/server.ts"], {
      NODE_ENV: "development",
      AUTH_MODE: "jwt-pg",
      DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
      JWT_SECRET: "x".repeat(40),
      PG_SSL_MODE: "verify_full_typo",
    });
    expect(badSsl.code).not.toBe(0);
    expect(badSsl.stderr).toContain("Invalid PG_SSL_MODE");
  });

  it("boots server.ts cleanly in provisional-local loopback mode and exits 0 promptly on SIGTERM", async () => {
    const port = 41900 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, ["apps/api/src/server.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        AUTH_MODE: "provisional-local",
        HOST: "127.0.0.1",
        PORT: String(port),
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start in time: ${stdoutBuf}`)), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        if (stdoutBuf.includes("server.started")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early with code ${code}`));
      });
    });

    await started;
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.kill("SIGTERM");
    });
    expect(exitCode).toBe(0);
    expect(stdoutBuf).toContain("server.shutdown_initiated");
  });

  it("verifies db-cli.mjs production seed refusal, invalid usage handling, check-hygiene.mjs, and check-licenses.mjs", async () => {
    const badCmd = await runNodeScript(["scripts/db-cli.mjs", "invalid-cmd"], {});
    expect(badCmd.code).not.toBe(0);
    expect(badCmd.stderr).toContain("Usage:");

    const prodSeed = await runNodeScript(["scripts/db-cli.mjs", "seed-dev"], {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/unused",
    });
    expect(prodSeed.code).not.toBe(0);
    expect(prodSeed.stderr).toContain("REFUSED: seed-dev cannot execute when NODE_ENV=production");

    const hygiene = await runNodeScript(["scripts/check-hygiene.mjs"], {});
    expect(hygiene.code).toBe(0);
    expect(hygiene.stdout).toContain("PASS:");

    const licenses = await runNodeScript(["scripts/check-licenses.mjs"], {});
    expect(licenses.code).toBe(0);
    expect(licenses.stdout).toContain("PASS:");
  });
});
