import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPermissiveOrDualAllowed } from "./check-licenses.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function parseSriIntegrity(integrity) {
  if (typeof integrity !== "string") return [];
  const parts = integrity.trim().split(/\s+/);
  const hashes = [];
  for (const part of parts) {
    const idx = part.indexOf("-");
    if (idx <= 0) continue;
    const algRaw = part.slice(0, idx).toLowerCase();
    const b64 = part.slice(idx + 1);
    const algMap = {
      sha512: "SHA-512",
      sha384: "SHA-384",
      sha256: "SHA-256",
      sha1: "SHA-1",
    };
    const alg = algMap[algRaw];
    if (!alg) continue;
    try {
      const hex = Buffer.from(b64, "base64").toString("hex");
      if (hex.length > 0) hashes.push({ alg, content: hex });
    } catch {
      // skip malformed integrity hash
    }
  }
  return hashes;
}

function buildPurl(pkgName, version) {
  const encodedName = pkgName.startsWith("@")
    ? `%40${pkgName.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(pkgName);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function extractPackageNameFromLockPath(lockPath, entry) {
  if (typeof entry.name === "string" && entry.name.trim()) return entry.name.trim();
  const marker = "node_modules/";
  const lastIdx = lockPath.lastIndexOf(marker);
  if (lastIdx === -1) return null;
  return lockPath.slice(lastIdx + marker.length);
}

/**
 * Generates a zero-dependency CycloneDX 1.5 JSON SBOM from package.json and package-lock.json
 * for TF-11 supply-chain verification (NFR-04 / NFR-T37 / NFR-T38).
 */
export function generateCycloneDxSbom(baseDir = rootDir) {
  const rootPkg = JSON.parse(readFileSync(path.join(baseDir, "package.json"), "utf8"));
  const lockRaw = readFileSync(path.join(baseDir, "package-lock.json"), "utf8");
  const lock = JSON.parse(lockRaw);
  const lockSha256 = createHash("sha256").update(lockRaw).digest("hex");

  const packagesMap = lock.packages ?? {};
  const seen = new Map();

  for (const [lockPath, entry] of Object.entries(packagesMap)) {
    if (!lockPath || lockPath === "") continue;
    if (entry.link === true) continue; // local workspace symlink
    if (!lockPath.includes("node_modules/")) continue;

    const name = extractPackageNameFromLockPath(lockPath, entry);
    const version = typeof entry.version === "string" ? entry.version : "0.0.0";
    if (!name || name.startsWith("@ai-office-suite/")) continue;

    const dedupKey = `${name}@${version}`;
    const licenseStr =
      typeof entry.license === "string" && entry.license.trim() ? entry.license.trim() : undefined;
    const purl = buildPurl(name, version);
    const hashes = parseSriIntegrity(entry.integrity);
    const scope = entry.dev ? "optional" : "required";

    const existing = seen.get(dedupKey);
    if (existing) {
      // Promote dev-marked packages to runtime-required if any production path includes the same version (F-25)
      if (scope === "required" && existing.scope !== "required") {
        existing.scope = "required";
      }
      if (!existing.licenses && licenseStr) {
        existing.licenses = [
          isPermissiveOrDualAllowed(licenseStr)
            ? { expression: licenseStr }
            : { license: { name: licenseStr } },
        ];
      }
      if (!existing.hashes && hashes.length > 0) {
        existing.hashes = hashes;
      }
      continue;
    }

    const component = {
      type: "library",
      "bom-ref": purl,
      name,
      version,
      purl,
      scope,
      ...(licenseStr
        ? {
            licenses: [
              isPermissiveOrDualAllowed(licenseStr)
                ? { expression: licenseStr }
                : { license: { name: licenseStr } },
            ],
          }
        : {}),
      ...(hashes.length > 0 ? { hashes } : {}),
    };
    seen.set(dedupKey, component);
  }

  const components = Array.from(seen.values()).sort((a, b) =>
    a.purl.localeCompare(b.purl),
  );

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: {
        components: [
          {
            type: "application",
            name: "ai-office-suite-sbom-generator",
            version: "1.0.0",
          },
        ],
      },
      component: {
        type: "application",
        "bom-ref": `pkg:npm/${rootPkg.name}@${rootPkg.version}`,
        name: rootPkg.name,
        version: rootPkg.version,
        description: rootPkg.description ?? "AI Office Suite",
      },
      properties: [
        { name: "aios:lockfile-sha256", value: lockSha256 },
        { name: "aios:component-count", value: String(components.length) },
        {
          name: "aios:runtime-component-count",
          value: String(components.filter((c) => c.scope === "required").length),
        },
      ],
    },
    components,
  };

  return bom;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const stdoutFlag = args.includes("--stdout");
  const outIdx = args.indexOf("--out");
  const outPath =
    outIdx >= 0 && args[outIdx + 1]
      ? path.resolve(rootDir, args[outIdx + 1])
      : path.join(rootDir, "coverage", "sbom.cdx.json");

  const bom = generateCycloneDxSbom(rootDir);
  const json = `${JSON.stringify(bom, null, 2)}\n`;

  if (stdoutFlag) {
    process.stdout.write(json);
  } else {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, json, "utf8");
    const runtimeCount = bom.components.filter((c) => c.scope === "required").length;
    console.log(
      `PASS: Generated CycloneDX ${bom.specVersion} SBOM at ${path.relative(rootDir, outPath)} (${bom.components.length} total components, ${runtimeCount} runtime required).`,
    );
  }
}
