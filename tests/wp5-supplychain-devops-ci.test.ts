import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("WP-5 Supply Chain, DevOps, CI & Documentation Remediation", () => {
  it("F-25: promotes dual dev+runtime packages (ms@2.1.3) to required scope in SBOM and aligns workspace manifests & lockfile", async () => {
    const { generateCycloneDxSbom } = (await import(
      pathToFileURL(path.resolve("scripts/generate-sbom.mjs")).href
    )) as {
      generateCycloneDxSbom: (baseDir?: string) => {
        components: Array<{ name: string; version: string; scope: string }>;
      };
    };
    const bom = generateCycloneDxSbom(process.cwd());
    const ms213 = bom.components.find((c) => c.name === "ms" && c.version === "2.1.3");
    expect(ms213).toBeDefined();
    expect(ms213?.scope).toBe("required");

    const lock = JSON.parse(readFileSync(path.resolve("package-lock.json"), "utf8")) as {
      packages: Record<string, { dependencies?: Record<string, string> }>;
    };

    const checks: Array<{ ws: string; expected: string[]; absent?: string[] }> = [
      { ws: "platform/database", expected: ["@ai-office-suite/audit", "@ai-office-suite/authorization", "pg"] },
      { ws: "apps/api", expected: ["pg", "express", "cors", "helmet", "zod"] },
      {
        ws: "engines/file-conversion",
        expected: ["@fontsource/inter", "@fontsource/kantumruy-pro", "@fontsource/noto-sans-khmer", "docx", "mammoth"],
      },
      { ws: "engines/intelligence", expected: ["@duckdb/node-api", "echarts"] },
      { ws: "apps/web", expected: ["@fontsource/kantumruy-pro", "@fontsource/noto-sans-khmer"], absent: ["@fontsource/inter"] },
    ];

    for (const { ws, expected, absent } of checks) {
      const pkg = JSON.parse(readFileSync(path.resolve(ws, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const deps = pkg.dependencies ?? {};
      for (const name of expected) {
        expect(deps[name], `${ws} missing ${name}`).toBeTruthy();
      }
      for (const name of absent ?? []) {
        expect(deps[name], `${ws} should not declare ${name}`).toBeUndefined();
      }
      expect(lock.packages[ws]?.dependencies).toEqual(deps);
    }

    const ciYml = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
    expect(ciYml).toContain("npm run sbom");
    expect(ciYml).toContain("v13-pa00-platform-admin.test.ts");
    expect(ciYml).toContain("/api/health");
  });

  it("F-26: enforces full Nginx security headers inside /assets/ and removes DEP0190 shell: isWindows in dev.mjs", () => {
    const nginxConf = readFileSync(path.resolve("docker/nginx.conf"), "utf8");
    const assetsMatch = nginxConf.match(/location\s+\/assets\/\s*\{[\s\S]*?\}/);
    expect(assetsMatch).toBeTruthy();
    const assetsBlock = assetsMatch![0];
    for (const header of [
      "Cache-Control",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "X-Permitted-Cross-Domain-Policies",
      "Content-Security-Policy",
    ]) {
      expect(assetsBlock).toContain(header);
    }

    const devMjs = readFileSync(path.resolve("scripts/dev.mjs"), "utf8");
    expect(devMjs).not.toMatch(/shell\s*:\s*(true|isWindows)/);
    expect(devMjs).toContain("taskkill");
  });

  it("F-29: aligns README, DEVOPS_RUNBOOK, SECURITY_AUDIT_REPORT & DEPENDENCY_LICENSE_POLICY with code and CI", () => {
    const readme = readFileSync(path.resolve("README.md"), "utf8");
    const runbook = readFileSync(path.resolve("documentation/DEVOPS_RUNBOOK.md"), "utf8");
    const auditReport = readFileSync(path.resolve("documentation/SECURITY_AUDIT_REPORT.md"), "utf8");
    const licensePolicy = readFileSync(path.resolve("security/DEPENDENCY_LICENSE_POLICY.md"), "utf8");

    expect(readme.length).toBeGreaterThan(300);
    expect(readme).toContain("Node.js");
    expect(readme).toContain("DEVOPS_RUNBOOK.md");

    expect(runbook).toContain("POSTGRES_APP_PASSWORD");
    expect(runbook).toContain("AI_PROPOSAL_SIGNING_SECRET");
    expect(runbook).toContain("PII_PSEUDONYMIZATION_KEY");
    expect(runbook).toContain("docker-smoke");
    expect(runbook).toContain("npm run bench:check");
    expect(runbook).toContain("metrics:read");

    expect(auditReport).toContain("22` tenant-scoped tables");
    expect(auditReport).toContain("/api/speech");
    expect(auditReport).toContain("paginationQuerySchema");
    expect(auditReport).toContain("expectedRevision");

    expect(licensePolicy).toContain("20` monorepo workspaces");
    expect(licensePolicy).toContain("npm run lint:licenses");
    expect(licensePolicy).toContain("npm run sbom");
  });
});
