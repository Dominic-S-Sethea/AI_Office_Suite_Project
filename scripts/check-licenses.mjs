import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const ALLOWED_EXACT = new Set([
  "MIT",
  "MIT/X11",
  "ISC",
  "BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "Zlib",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "OFL-1.1",
  "BlueOak-1.0.0",
  "Python-2.0",
]);

// Verified permissive transitive packages with non-SPDX metadata strings:
// - buffers@0.1.1: pre-SPDX MIT/X11 package via exceljs -> unzipper -> binary
// - nodejs-polars-win32-x64-msvc@0.26.2: MIT (parent nodejs-polars LICENSE verified MIT)
const VERIFIED_LEGACY_TRANSITIVE = new Set([
  "buffers@0.1.1",
  "nodejs-polars-win32-x64-msvc@0.26.2",
]);

const DISALLOWED_PATTERNS = [
  /\bAGPL\b/i,
  /\bSSPL\b/i,
  /\bBUSL\b/i,
  /\bBSL-1\.1\b/i,
  /\bUNLICENSED\b/i,
];

function isPermissiveOrDualAllowed(licenseStr) {
  if (!licenseStr || typeof licenseStr !== "string") return false;
  const trimmed = licenseStr.trim();
  if (ALLOWED_EXACT.has(trimmed)) return true;
  if (DISALLOWED_PATTERNS.some((p) => p.test(trimmed))) return false;
  const unwrapped = trimmed.replace(/^\(|\)$/g, "");
  // Allow SPDX OR expressions where at least one branch is permissive (e.g., jszip: MIT OR GPL-3.0-or-later)
  if (/\bOR\b/i.test(unwrapped)) {
    const parts = unwrapped.split(/\s+OR\s+/i);
    return parts.some((part) => isPermissiveOrDualAllowed(part.trim()));
  }
  // Allow SPDX AND expressions where EVERY clause is permissive (e.g., pako: MIT AND Zlib)
  if (/\bAND\b/i.test(unwrapped)) {
    const parts = unwrapped.split(/\s+AND\s+/i);
    return parts.every((part) => isPermissiveOrDualAllowed(part.trim()));
  }
  return false;
}

function collectDirectDependencies() {
  const pkgPaths = [path.join(rootDir, "package.json")];
  for (const group of ["packages", "platform", "engines", "modules", "apps"]) {
    const groupDir = path.join(rootDir, group);
    try {
      for (const entry of readdirSync(groupDir)) {
        const candidate = path.join(groupDir, entry, "package.json");
        try {
          if (statSync(candidate).isFile()) pkgPaths.push(candidate);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  const direct = new Set();
  for (const pkgPath of pkgPaths) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith("@ai-office-suite/")) direct.add(dep);
    }
    for (const dep of Object.keys(pkg.devDependencies ?? {})) {
      if (!dep.startsWith("@ai-office-suite/")) direct.add(dep);
    }
  }
  return direct;
}

function walkNodeModules(dir, results = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry === ".bin" || entry === ".vite") continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (entry.startsWith("@")) {
      walkNodeModules(full, results);
      continue;
    }
    const pkgJsonPath = path.join(full, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (pkg.private === true && typeof pkg.name === "string" && pkg.name.startsWith("@ai-office-suite/")) {
        continue;
      }
      results.push({
        name: pkg.name,
        version: pkg.version,
        license: typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? "UNKNOWN"),
        path: full,
      });
    } catch {
      // ignore folders without package.json
    }
    const nested = path.join(full, "node_modules");
    try {
      if (statSync(nested).isDirectory()) walkNodeModules(nested, results);
    } catch {
      // ignore
    }
  }
  return results;
}

const directDeps = collectDirectDependencies();
const allPackages = [
  ...walkNodeModules(path.join(rootDir, "node_modules")),
  ...walkNodeModules(path.join(rootDir, "apps", "web", "node_modules")),
];

const seen = new Map();
for (const pkg of allPackages) {
  const key = `${pkg.name}@${pkg.version}`;
  if (!seen.has(key)) seen.set(key, pkg);
}

const directViolations = [];
const transitiveWarnings = [];
const transitiveViolations = [];

for (const pkg of seen.values()) {
  const isDirect = directDeps.has(pkg.name);
  const pkgKey = `${pkg.name}@${pkg.version}`;
  const ok = isPermissiveOrDualAllowed(pkg.license) || (!isDirect && VERIFIED_LEGACY_TRANSITIVE.has(pkgKey));
  if (!ok) {
    if (isDirect) directViolations.push(pkg);
    else transitiveViolations.push(pkg);
  } else if (isDirect && /\bGPL\b/i.test(pkg.license)) {
    directViolations.push(pkg);
  } else if (!isDirect && /\bGPL\b/i.test(pkg.license)) {
    transitiveWarnings.push(pkg);
  }
}

console.log(`License audit scanned ${seen.size} installed third-party package versions (${directDeps.size} direct dependencies).`);

if (transitiveWarnings.length > 0) {
  console.log("Transitive dual-licensed packages (permissive branch selected):");
  for (const w of transitiveWarnings) {
    console.log(`  - ${w.name}@${w.version}: ${w.license}`);
  }
}

if (directViolations.length > 0 || transitiveViolations.length > 0) {
  console.error("DISALLOWED LICENSES FOUND:");
  for (const v of [...directViolations, ...transitiveViolations]) {
    console.error(`  - ${v.name}@${v.version}: ${v.license}`);
  }
  process.exit(1);
}

console.log("PASS: Zero disallowed (AGPL/GPL-only/commercial-restricted) licenses detected.");
