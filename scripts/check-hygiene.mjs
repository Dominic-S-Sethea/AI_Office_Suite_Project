import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

// 1. Check tracked files for forbidden secrets, local storage, env files, and audio binaries
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
}

// 2. Scan tracked text files for high-confidence leaked credentials
const secretPatterns = [
  { name: "GitHub PAT", re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

for (const file of tracked) {
  if (/\.(png|jpg|jpeg|pdf|docx|pptx|xlsx|woff2?|ico|zip)$/i.test(file)) continue;
  let content = "";
  try {
    content = readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  for (const sp of secretPatterns) {
    if (sp.re.test(content)) {
      failures.push(`Potential ${sp.name} secret detected in ${file}`);
    }
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\s]{32,}/.test(content)) {
    failures.push(`Private key PEM block detected in ${file}`);
  }
}

// 3. Verify honest gate boundaries: cloud STT stays fail-closed (423) & MockSpeechAdapter stays isMock = true
const speechIndex = readFileSync(path.join(root, "engines/speech/src/index.ts"), "utf8");
if (!/readonly isMock = true/.test(speechIndex) || !/\b423\b/.test(speechIndex)) {
  failures.push("Speech gate boundary regression: MockSpeechAdapter must retain isMock = true and cloud adapters must fail closed with 423.");
}

if (failures.length > 0) {
  console.error("FAIL: Repository hygiene checks failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`PASS: Repository hygiene verified across ${tracked.length} tracked files (0 forbidden files, 0 secrets, gate boundaries intact).`);
