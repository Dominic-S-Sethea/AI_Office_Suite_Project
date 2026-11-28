import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("R2-WP5 — QA, Supply Chain, CI/CD, Docker/Nginx, Scripts & Docs", () => {
  it("QA-01 & QA-08: enforces fail-fast compose secrets and fail-closed CI Chromium/PG16/docker-smoke checks", () => {
    const compose = readFileSync(path.resolve("docker-compose.yml"), "utf8");
    expect(compose).toMatch(/JWT_SECRET:\s*\$\{JWT_SECRET:\?/);
    expect(compose).toMatch(/PII_PSEUDONYMIZATION_KEY:\s*\$\{PII_PSEUDONYMIZATION_KEY:\?/);
    expect(compose).toMatch(/AI_PROPOSAL_SIGNING_SECRET:\s*\$\{AI_PROPOSAL_SIGNING_SECRET:\?/);

    const ci = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain('REQUIRE_CHROMIUM: "true"');
    expect(ci).toContain('REQUIRE_LIVE_PG: "true"');
    expect(ci).toContain("PII_PSEUDONYMIZATION_KEY:");
    expect(ci).toContain("AI_PROPOSAL_SIGNING_SECRET:");
    expect(ci).toContain("./scripts/db-cli.mjs");
    expect(ci).toContain("NODE_ENV: 'production'");
  });

  it("QA-03 & QA-11: scopes Nginx security headers out of server{} for /api/, preserves X-Forwarded-Proto, sets no-cache on /, and makes HEALTHCHECK PORT dynamic", () => {
    const nginx = readFileSync(path.resolve("docker/nginx.conf"), "utf8");
    expect(nginx).toMatch(/map\s+\$http_x_forwarded_proto\s+\$forwarded_proto/);

    // Ensure zero add_header directives exist directly in server {} before location blocks (prevents duplicating Express Helmet headers on /api/)
    const serverStart = nginx.indexOf("server {");
    const firstLocation = nginx.indexOf("location ");
    expect(serverStart).toBeGreaterThanOrEqual(0);
    expect(firstLocation).toBeGreaterThan(serverStart);
    const serverHeaderSection = nginx.slice(serverStart, firstLocation);
    expect(serverHeaderSection).not.toContain("add_header");

    const apiBlock = nginx.match(/location\s+\/api\/\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(apiBlock).toContain("proxy_set_header X-Forwarded-Proto $forwarded_proto;");
    expect(apiBlock).toContain("proxy_connect_timeout 10s;");
    expect(apiBlock).toContain("proxy_send_timeout 60s;");

    const rootBlock = nginx.match(/location\s+\/\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(rootBlock).toContain('add_header Cache-Control "no-cache" always;');
    expect(rootBlock).toContain("X-Frame-Options");
    expect(rootBlock).toContain("Content-Security-Policy");

    const dockerfileApi = readFileSync(path.resolve("docker/Dockerfile.api"), "utf8");
    expect(dockerfileApi).toContain("process.env.PORT || 4100");
    expect(dockerfileApi).not.toContain("'http://127.0.0.1:4100/api/ready'");

    const tsconfigTypecheck = JSON.parse(readFileSync(path.resolve("tsconfig.typecheck.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(tsconfigTypecheck.compilerOptions.paths["@ai-office-suite/integration-engine/pg-persistence"]).toEqual([
      "./engines/integration/src/pgPersistence.ts",
    ]);

    const tsconfigApiBuild = JSON.parse(readFileSync(path.resolve("apps/api/tsconfig.build.json"), "utf8")) as {
      include: string[];
    };
    expect(tsconfigApiBuild.include).toContain("../../engines/integration/src/pgPersistence.ts");
  });

  it("QA-05 & QA-06: validates SPDX WITH exceptions, AGPL/LGPL direct checks, valid CycloneDX license metadata & optional platform scopes", async () => {
    const checkLicensesPath = path.resolve("scripts/check-licenses.mjs");
    const { isPermissiveOrDualAllowed } = (await import(pathToFileURL(checkLicensesPath).href)) as {
      isPermissiveOrDualAllowed: (lic: string) => boolean;
    };
    expect(isPermissiveOrDualAllowed("Apache-2.0 WITH LLVM-exception")).toBe(true);
    expect(isPermissiveOrDualAllowed("MIT WITH Commercial-Restriction")).toBe(false);
    expect(isPermissiveOrDualAllowed("Apache-2.0 WITH AGPL-Exception")).toBe(false);

    const checkLicensesSrc = readFileSync(checkLicensesPath, "utf8");
    expect(checkLicensesSrc).toContain("optionalDependencies");
    expect(checkLicensesSrc).toContain("/\\b(?:A|L)?GPL\\b/i");
    expect(checkLicensesSrc).toContain("seen.size === 0");

    const { generateCycloneDxSbom } = (await import(
      pathToFileURL(path.resolve("scripts/generate-sbom.mjs")).href
    )) as {
      generateCycloneDxSbom: (baseDir?: string) => {
        components: Array<{
          name: string;
          version: string;
          scope: string;
          licenses?: Array<{ expression?: string; license?: { name: string } }>;
        }>;
      };
    };
    const bom = generateCycloneDxSbom(process.cwd());
    expect(bom.components).toHaveLength(620);
    expect(bom.components.filter((c) => c.scope === "required")).toHaveLength(339);

    for (const c of bom.components) {
      for (const lic of c.licenses ?? []) {
        if (lic.expression) {
          expect(lic.expression).not.toBe("MIT/X11");
          expect(lic.expression).not.toBe("BSD");
        }
      }
    }

    const ms213 = bom.components.find((c) => c.name === "ms" && c.version === "2.1.3");
    expect(ms213?.scope).toBe("required");
    const androidPolars = bom.components.find((c) => c.name === "nodejs-polars-android-arm64");
    expect(androidPolars?.scope).toBe("optional");
  });

  it("QA-09 & QA-10: verifies dev.mjs crash/process-group hardening, bench-check cwd independence, .env.example & doc parity", () => {
    const devMjs = readFileSync(path.resolve("scripts/dev.mjs"), "utf8");
    expect(devMjs).toContain("fileURLToPath(import.meta.url)");
    expect(devMjs).toContain("detached: !isWindows");
    expect(devMjs).toContain("process.kill(-child.pid");
    expect(devMjs).toContain('child.on("exit"');

    const benchCheck = readFileSync(path.resolve("scripts/bench-check.mjs"), "utf8");
    expect(benchCheck).toContain("fileURLToPath(import.meta.url)");
    expect(benchCheck).toContain("reconciliation.passed");
    expect(benchCheck).toContain("B5000");

    const envExample = readFileSync(path.resolve(".env.example"), "utf8");
    for (const key of [
      "CHROMIUM_NO_SANDBOX",
      "ALLOW_LOCAL_FASTER_WHISPER",
      "FASTER_WHISPER_MODEL",
      "FASTER_WHISPER_PYTHON",
      "ALLOW_LIVE_AI_PROVIDERS",
    ]) {
      expect(envExample).toContain(key);
    }

    const runbook = readFileSync(path.resolve("documentation/DEVOPS_RUNBOOK.md"), "utf8");
    expect(runbook).toContain("DEV_SEED_PASSWORD");
    expect(runbook).toContain("provision-app-role");
    expect(runbook).toContain("format=prometheus");
    expect(runbook).toContain("24` tenant-scoped tables");

    const auditReport = readFileSync(path.resolve("documentation/SECURITY_AUDIT_REPORT.md"), "utf8");
    expect(auditReport).toContain("24` tenant-scoped tables");
    expect(auditReport).toContain("pa_usage_ledger");
    expect(auditReport).toContain("POST /api/auth/token");
    expect(auditReport).toContain("apps/workers");

    const testStrategy = readFileSync(path.resolve("documentation/TEST_STRATEGY.md"), "utf8");
    expect(testStrategy).toContain("43` Active Test Suites");
    expect(testStrategy).toContain("all `21` monorepo workspaces + root");
  });
});
