import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_PATTERNS = [
  { name: "GitHub PAT", re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/ },
  { name: "GitHub Fine-Grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "OpenAI API Key", re: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "Anthropic API Key", re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/ },
  { name: "Slack Token", re: /\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9-]{10,}\b/ },
  { name: "Stripe Live Key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  {
    name: "Hardcoded Remote PostgreSQL Credential URL",
    re: /\bpostgres(?:ql)?:\/\/[^:\s'"`]+:[^@\s'"`<>{}$]{10,}@(?!127\.0\.0\.1|localhost|postgres(?::|\/)|example\.com)[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_-]+/,
  },
];

const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\s]{32,}/;

export function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

export function scanTextForSecrets(content, filePath = "<input>") {
  const hits = [];
  for (const sp of SECRET_PATTERNS) {
    if (sp.re.test(content)) {
      hits.push(`Potential ${sp.name} secret detected in ${filePath}`);
    }
  }
  if (PEM_PRIVATE_KEY_RE.test(content)) {
    hits.push(`Private key PEM block detected in ${filePath}`);
  }
  return hits;
}

export function verifySpeechGateSource(source) {
  const codeOnly = stripJsComments(source);
  const hasMockFlag = /\breadonly\s+isMock\s*=\s*true\b/.test(codeOnly);
  const hasFailClosed423 = /\bnew\s+SpeechProviderError\(\s*423\b/.test(codeOnly);
  return hasMockFlag && hasFailClosed423;
}

export function runHygieneAudit(root = process.cwd()) {
  const failures = [];

  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const file of tracked) {
    if (/(^|\/)\.env($|\.(?!example$))/i.test(file)) {
      failures.push(`Forbidden tracked env file: ${file}`);
    }
    if (/(^|\/)\.local-data\//i.test(file)) {
      failures.push(`Forbidden tracked .local-data file: ${file}`);
    }
    if (/\.(wav|mp3|ogg|flac|m4a|pcm)$/i.test(file)) {
      failures.push(`Forbidden tracked audio file: ${file}`);
    }
    if (/^tests\/artifacts\/(?!\.gitkeep$).+/i.test(file)) {
      failures.push(`Forbidden tracked mutable test artifact: ${file}`);
    }
  }

  for (const file of tracked) {
    if (/\.(png|jpg|jpeg|pdf|docx|pptx|xlsx|woff2?|ico|zip)$/i.test(file)) continue;
    let content = "";
    try {
      content = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    failures.push(...scanTextForSecrets(content, file));
  }

  // Verify honest gate boundaries on non-comment code (H31)
  const speechIndex = readFileSync(path.join(root, "engines/speech/src/index.ts"), "utf8");
  if (!verifySpeechGateSource(speechIndex)) {
    failures.push(
      "Speech gate boundary regression: MockSpeechAdapter must retain `readonly isMock = true` and cloud adapters must throw `SpeechProviderError(423, ...)` in active code.",
    );
  }

  return { trackedCount: tracked.length, failures };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { trackedCount, failures } = runHygieneAudit(process.cwd());
  if (failures.length > 0) {
    console.error("FAIL: Repository hygiene checks failed:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `PASS: Repository hygiene verified across ${trackedCount} tracked files (0 forbidden files, 0 secrets, gate boundaries intact).`,
  );
}
