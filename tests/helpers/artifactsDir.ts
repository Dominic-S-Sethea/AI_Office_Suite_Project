import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TestArtifactsDirHandle {
  dir: string;
  cleanup: () => void;
}

/**
 * Resolves test evidence output directory (L3 / M19):
 * - Defaults to an ephemeral `os.tmpdir()` directory cleaned up after tests,
 *   ensuring `npm test` never mutates tracked files or dirties `git status`.
 * - Opt-in `WRITE_EVIDENCE_ARTIFACTS=1` writes into `tests/artifacts/` for manual visual inspection.
 */
export function createTestArtifactsDir(prefix = "aios-test-artifacts-"): TestArtifactsDirHandle {
  if (process.env.WRITE_EVIDENCE_ARTIFACTS === "1") {
    const dir = path.resolve(process.cwd(), "tests", "artifacts");
    mkdirSync(dir, { recursive: true });
    return { dir, cleanup: () => undefined };
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
