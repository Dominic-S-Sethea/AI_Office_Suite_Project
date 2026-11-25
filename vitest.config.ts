import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@ai-office-suite/shared-contracts": path.resolve(__dirname, "packages/shared-contracts/src/index.ts"),
      "@ai-office-suite/validation": path.resolve(__dirname, "packages/validation/src/index.ts"),
      "@ai-office-suite/authorization": path.resolve(__dirname, "platform/authorization/src/index.ts"),
      "@ai-office-suite/database": path.resolve(__dirname, "platform/database/src/index.ts"),
      "@ai-office-suite/identity": path.resolve(__dirname, "platform/identity/src/index.ts"),
      "@ai-office-suite/storage": path.resolve(__dirname, "platform/storage/src/index.ts"),
      "@ai-office-suite/audit": path.resolve(__dirname, "platform/audit/src/index.ts"),
      "@ai-office-suite/analytics-engine": path.resolve(__dirname, "engines/analytics/src/index.ts"),
      "@ai-office-suite/presentation-engine": path.resolve(__dirname, "engines/presentation/src/index.ts"),
      "@ai-office-suite/intelligence-engine": path.resolve(__dirname, "engines/intelligence/src/index.ts"),
      "@ai-office-suite/document-engine": path.resolve(__dirname, "engines/document/src/index.ts"),
      "@ai-office-suite/calculation-engine": path.resolve(__dirname, "engines/calculation/src/index.ts"),
      "@ai-office-suite/data-processing": path.resolve(__dirname, "engines/data-processing/src/index.ts"),
      "@ai-office-suite/file-conversion": path.resolve(__dirname, "engines/file-conversion/src/index.ts"),
      "@ai-office-suite/speech-engine": path.resolve(__dirname, "engines/speech/src/index.ts"),
      "@ai-office-suite/documents-module": path.resolve(__dirname, "modules/documents/src/index.ts"),
      "@ai-office-suite/ai-module": path.resolve(__dirname, "modules/ai/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
