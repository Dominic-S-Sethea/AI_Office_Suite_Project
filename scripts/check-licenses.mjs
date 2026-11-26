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
// - nodejs-polars-*@0.26.2: MIT (parent nodejs-polars@0.26.2 LICENSE verified MIT;
//   platform native packages declare "SEE LICENSE IN LICENSE")
const VERIFIED_LEGACY_TRANSITIVE = new Set([
  "buffers@0.1.1",
  "nodejs-polars-win32-x64-msvc@0.26.2",
  "nodejs-polars-linux-x64-gnu@0.26.2",
  "nodejs-polars-linux-x64-musl@0.26.2",
  "nodejs-polars-linux-arm64-gnu@0.26.2",
  "nodejs-polars-linux-arm64-musl@0.26.2",
  "nodejs-polars-darwin-x64@0.26.2",
  "nodejs-polars-darwin-arm64@0.26.2",
  "nodejs-polars-android-arm64@0.26.2",
]);

const DISALLOWED_IDENTIFIERS = [
  /^AGPL/i,
  /^SSPL/i,
  /^BUSL/i,
  /^BSL-1\.1/i,
  /^UNLICENSED$/i,
];

function tokenizeSpdx(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: ch, value: ch });
      i++;
      continue;
    }
    let j = i;
    while (j < expr.length && !/[\s()]/.test(expr[j])) j++;
    const word = expr.slice(i, j);
    const upper = word.toUpperCase();
    if (upper === "AND" || upper === "OR" || upper === "WITH") {
      tokens.push({ type: upper, value: upper });
    } else {
      tokens.push({ type: "ID", value: word });
    }
    i = j;
  }
  return tokens;
}

/**
 * Recursive-descent SPDX license expression evaluator (H31):
 * Properly respects parentheses and SPDX operator precedence (`WITH` > `AND` > `OR`).
 * Returns true iff the expression can be satisfied using exclusively approved permissive licenses.
 */
export function isPermissiveOrDualAllowed(licenseStr) {
  if (!licenseStr || typeof licenseStr !== "string") return false;
  const trimmed = licenseStr.trim();
  if (!trimmed) return false;
  if (ALLOWED_EXACT.has(trimmed)) return true;

  const tokens = tokenizeSpdx(trimmed);
  if (tokens.length === 0) return false;

  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseOr() {
    let left = parseAnd();
    while (peek()?.type === "OR") {
      consume();
      const right = parseAnd();
      left = left || right;
    }
    return left;
  }

  function parseAnd() {
    let left = parsePrimary();
    while (peek()?.type === "AND") {
      consume();
      const right = parsePrimary();
      left = left && right;
    }
    return left;
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error("Unexpected end of SPDX expression");
    if (tok.type === "(") {
      consume();
      const inner = parseOr();
      if (peek()?.type !== ")") {
        throw new Error("Unbalanced parenthesis in SPDX expression");
      }
      consume();
      return inner;
    }
    if (tok.type === "ID") {
      consume();
      const baseId = tok.value.replace(/\+$/, "");
      // Consume optional `WITH <exception>` clause (exception must not be disallowed)
      if (peek()?.type === "WITH") {
        consume();
        const exc = consume();
        if (!exc || exc.type !== "ID") {
          throw new Error("Expected exception identifier after WITH");
        }
      }
      if (DISALLOWED_IDENTIFIERS.some((re) => re.test(baseId))) return false;
      return ALLOWED_EXACT.has(baseId);
    }
    throw new Error(`Unexpected token '${tok.value}' in SPDX expression`);
  }

  try {
    const result = parseOr();
    if (pos !== tokens.length) return false;
    return result;
  } catch {
    return false;
  }
}

function listWorkspacePackageDirs(baseDir) {
  const dirs = [baseDir];
  for (const group of ["packages", "platform", "engines", "modules", "apps"]) {
    const groupDir = path.join(baseDir, group);
    try {
      for (const entry of readdirSync(groupDir)) {
        const candidateDir = path.join(groupDir, entry);
        try {
          if (statSync(path.join(candidateDir, "package.json")).isFile()) {
            dirs.push(candidateDir);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return dirs;
}

function collectDirectDependencies(workspaceDirs) {
  const direct = new Set();
  for (const dir of workspaceDirs) {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const workspaceDirs = listWorkspacePackageDirs(rootDir);
  const directDeps = collectDirectDependencies(workspaceDirs);
  const allPackages = [];
  // Walk root AND every workspace's node_modules (H31)
  for (const wsDir of workspaceDirs) {
    walkNodeModules(path.join(wsDir, "node_modules"), allPackages);
  }

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

  console.log(
    `License audit scanned ${seen.size} installed third-party package versions across ${workspaceDirs.length} workspaces (${directDeps.size} direct dependencies).`,
  );

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
}
