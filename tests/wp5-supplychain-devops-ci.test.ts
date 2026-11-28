import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PA_RLS_TABLES } from "@ai-office-suite/database";
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
      packages: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
    };

    // Dynamically verify ALL 21 workspace package.json manifests match package-lock.json 1:1
    const workspacePaths: string[] = [];
    for (const group of ["packages", "platform", "engines", "modules", "apps"]) {
      const groupDir = path.resolve(group);
      for (const entry of readdirSync(groupDir)) {
        const wsDir = path.join(groupDir, entry);
        try {
          if (statSync(path.join(wsDir, "package.json")).isFile()) {
            workspacePaths.push(`${group}/${entry}`);
          }
        } catch {
          // ignore non-package directories
        }
      }
    }
    expect(workspacePaths).toHaveLength(21);

    for (const ws of workspacePaths) {
      const pkg = JSON.parse(readFileSync(path.resolve(ws, "package.json"), "utf8")) as {
        version?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const lockEntry = lock.packages[ws];
      expect(lockEntry, `package-lock.json missing workspace entry '${ws}'`).toBeDefined();
      expect(lockEntry?.version).toBe(pkg.version);
      expect(lockEntry?.dependencies ?? {}).toEqual(pkg.dependencies ?? {});
      if (pkg.devDependencies) {
        expect(lockEntry?.devDependencies ?? {}).toEqual(pkg.devDependencies);
      }
    }

    expect(lock.packages["engines/speech"]?.dependencies).toMatchObject({
      "@ai-office-suite/authorization": "*",
      "@ai-office-suite/shared-contracts": "*",
      "@ai-office-suite/validation": "*",
    });

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

    const dbCliSource = readFileSync(path.resolve("scripts/db-cli.mjs"), "utf8");
    expect(PA_RLS_TABLES).toHaveLength(9);
    expect(dbCliSource).toContain("PA_RLS_TABLES");
    expect(auditReport).toContain("24` tenant-scoped tables");
    expect(auditReport).toContain("POST /api/auth/token");
    expect(runbook).toContain("24` tenant-scoped tables");
    expect(auditReport).toContain("/api/speech");
    expect(auditReport).toContain("paginationQuerySchema");
    expect(auditReport).toContain("expectedRevision");

    expect(licensePolicy).toContain("21` monorepo workspaces");
    expect(licensePolicy).toContain("npm run lint:licenses");
    expect(licensePolicy).toContain("npm run sbom");
  });
});
