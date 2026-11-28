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
      timeout: 30_000,
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
  }, 90_000);

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
    let stderrBuf = "";
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Server did not start in time: stdout=${stdoutBuf} stderr=${stderrBuf}`)),
        30_000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        if (stdoutBuf.includes("server.started")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early with code ${code}: ${stderrBuf}`));
      });
    });

    try {
      await started;
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.status).toBe(200);

      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill();
        });
        const http = await import("node:http");
        const { createGracefulShutdown } = await import("../apps/api/src/server.ts");
        const dummyServer = http.createServer((_req, res) => res.end("ok"));
        await new Promise<void>((resolve) => dummyServer.listen(0, "127.0.0.1", () => resolve()));
        let dbClosed = false;
        let shutdownLogs = "";
        const exitCode = await new Promise<number>((resolve) => {
          const shutdown = createGracefulShutdown({
            server: dummyServer,
            db: {
              close: async () => {
                dbClosed = true;
              },
            },
            writeStdout: (line) => {
              shutdownLogs += line;
            },
            exitFn: (code) => resolve(code),
          });
          shutdown("SIGTERM");
        });
        expect(exitCode).toBe(0);
        expect(dbClosed).toBe(true);
        expect(shutdownLogs).toContain("server.shutdown_initiated");
      } else {
        const exitCode = await new Promise<number | null>((resolve) => {
          child.once("exit", (code) => resolve(code));
          child.kill("SIGTERM");
        });
        expect(exitCode).toBe(0);
        expect(stdoutBuf).toContain("server.shutdown_initiated");
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // process already exited
        }
      }
    }
  }, 60_000);

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

  it("Wave 5C (H30, H31, M18, L5): verifies Zod config, shared PG SSL/CA validation, Prometheus metrics, SPDX parser & expanded hygiene rules", async () => {
    const { createPgPoolConfigFromEnv } = await import("@ai-office-suite/database");
    const { loadApiServerConfig } = await import("../apps/api/src/config.ts");
    const { createApiApp } = await import("../apps/api/src/app.ts");
    const { pathToFileURL } = await import("node:url");
    const { isPermissiveOrDualAllowed } = (await import(
      pathToFileURL(path.join(repoRoot, "scripts/check-licenses.mjs")).href
    )) as { isPermissiveOrDualAllowed: (expr: string) => boolean };
    const { scanTextForSecrets, verifySpeechGateSource } = (await import(
      pathToFileURL(path.join(repoRoot, "scripts/check-hygiene.mjs")).href
    )) as {
      scanTextForSecrets: (text: string, file?: string) => string[];
      verifySpeechGateSource: (source: string) => boolean;
    };
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const os = await import("node:os");

    // M18: PG_SSL_MODE=require emits explicit TLS verification warning; invalid CA or mode throws
    const warnings: string[] = [];
    const reqCfg = createPgPoolConfigFromEnv(
      { PG_SSL_MODE: "require", PG_POOL_MAX: "8", PG_STATEMENT_TIMEOUT_MS: "12000" },
      { onWarn: (m) => warnings.push(m) },
    );
    expect(reqCfg.max).toBe(8);
    expect((reqCfg.ssl as { rejectUnauthorized?: boolean })?.rejectUnauthorized).toBe(false);
    expect(warnings.some((w) => w.includes("rejectUnauthorized=false"))).toBe(true);

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "aios-ca-test-"));
    try {
      const caPath = path.join(tmpDir, "ca.pem");
      writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nMIIBFAKECERT\n-----END CERTIFICATE-----\n");
      const strictCfg = createPgPoolConfigFromEnv({ PG_SSL_MODE: "verify-full", PG_SSL_CA_FILE: caPath });
      expect((strictCfg.ssl as { rejectUnauthorized?: boolean; ca?: string })?.rejectUnauthorized).toBe(true);
      expect((strictCfg.ssl as { ca?: string })?.ca).toContain("BEGIN CERTIFICATE");

      expect(() =>
        createPgPoolConfigFromEnv({ PG_SSL_MODE: "disable", PG_SSL_CA_FILE: caPath }),
      ).toThrow(/PG_SSL_CA_FILE/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // L5: Zod config rejects invalid PORT and AUTH_MODE
    expect(() => loadApiServerConfig({ PORT: "not-a-port" })).toThrow(/Invalid PORT/);
    expect(() => loadApiServerConfig({ AUTH_MODE: "magic-bypass" })).toThrow(/Invalid AUTH_MODE/);
    const validCfg = loadApiServerConfig({
      AUTH_MODE: "provisional-local",
      HOST: "127.0.0.1",
      PORT: "4200",
      MAX_CONCURRENT_PDF_EXPORTS: "3",
    });
    expect(validCfg.port).toBe(4200);
    expect(validCfg.maxConcurrentPdfExports).toBe(3);

    // H30: Prometheus text exposition format on /api/metrics + route template logging
    const logs: string[] = [];
    const app = createApiApp({
      inMemory: true,
      enableStructuredLogs: true,
      logSink: (line) => logs.push(line),
      rateLimit: { enabled: false },
    });
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      await fetch(`http://127.0.0.1:${port}/api/health`);
      const promRes = await fetch(`http://127.0.0.1:${port}/api/metrics?format=prometheus`, {
        headers: { "x-workspace-role": "owner" },
      });
      expect(promRes.status).toBe(200);
      expect(promRes.headers.get("content-type")).toContain("text/plain");
      const promBody = await promRes.text();
      expect(promBody).toContain("aios_http_requests_total");
      expect(promBody).toContain('aios_http_responses_total{status_class="2xx"}');
      expect(logs.some((l) => l.includes('"route":"/api/health"'))).toBe(true);
    } finally {
      server.close();
    }

    // H31: Recursive-descent SPDX expression evaluator
    expect(isPermissiveOrDualAllowed("MIT")).toBe(true);
    expect(isPermissiveOrDualAllowed("(MIT OR GPL-3.0-or-later)")).toBe(true);
    expect(isPermissiveOrDualAllowed("(MIT AND Zlib)")).toBe(true);
    expect(isPermissiveOrDualAllowed("Apache-2.0 WITH LLVM-exception")).toBe(true);
    expect(isPermissiveOrDualAllowed("(MIT AND GPL-3.0-only) OR Apache-2.0")).toBe(true);
    expect(isPermissiveOrDualAllowed("(MIT OR Apache-2.0) AND GPL-3.0-only")).toBe(false);
    expect(isPermissiveOrDualAllowed("AGPL-3.0-only")).toBe(false);
    expect(isPermissiveOrDualAllowed("(MIT AND (BSD-3-Clause OR AGPL-3.0-only))")).toBe(true);
    expect(isPermissiveOrDualAllowed("(MIT AND (GPL-3.0-only OR AGPL-3.0-only))")).toBe(false);

    // H31: Expanded secret scanner & comment-stripped speech gate verification
    const fakeFinePat = `github_pat_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"}`;
    const fakeOpenAi = `sk-proj-${"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"}`;
    const fakeSlack = `xoxb-${"123456789012"}-${"abcdefGHIJKL12345"}`;
    const fakeRemotePg = `postgres://prod_admin:${"SuperSecretPass99"}@db.prod-corp.internal:5432/prod_db`;
    expect(scanTextForSecrets(fakeFinePat)).toHaveLength(1);
    expect(scanTextForSecrets(fakeOpenAi)).toHaveLength(1);
    expect(scanTextForSecrets(fakeSlack)).toHaveLength(1);
    expect(scanTextForSecrets(fakeRemotePg)).toHaveLength(1);
    expect(verifySpeechGateSource("// readonly isMock = true\n// new SpeechProviderError(423, 'X', 'Y')")).toBe(false);
    expect(verifySpeechGateSource("readonly isMock = true;\nthrow new SpeechProviderError(423, 'X', 'Y');")).toBe(true);
  });
});
