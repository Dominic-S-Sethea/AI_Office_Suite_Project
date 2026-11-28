import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@ai-office-suite/shared-contracts": path.resolve(__dirname, "packages/shared-contracts/src/index.ts"),
      "@ai-office-suite/validation": path.resolve(__dirname, "packages/validation/src/index.ts"),
      "@ai-office-suite/authorization": path.resolve(__dirname, "platform/authorization/src/index.ts"),
      "@ai-office-suite/database": path.resolve(__dirname, "platform/database/src/index.ts"),
      "@ai-office-suite/identity/express": path.resolve(__dirname, "platform/identity/src/express.ts"),
      "@ai-office-suite/identity": path.resolve(__dirname, "platform/identity/src/index.ts"),
      "@ai-office-suite/storage": path.resolve(__dirname, "platform/storage/src/index.ts"),
      "@ai-office-suite/audit": path.resolve(__dirname, "platform/audit/src/index.ts"),
      "@ai-office-suite/analytics-engine": path.resolve(__dirname, "engines/analytics/src/index.ts"),
      "@ai-office-suite/presentation-engine": path.resolve(__dirname, "engines/presentation/src/index.ts"),
      "@ai-office-suite/intelligence-engine": path.resolve(__dirname, "engines/intelligence/src/index.ts"),
      "@ai-office-suite/integration-engine/pg-persistence": path.resolve(__dirname, "engines/integration/src/pgPersistence.ts"),
      "@ai-office-suite/integration-engine": path.resolve(__dirname, "engines/integration/src/index.ts"),
      "@ai-office-suite/document-engine/tiptap-codec": path.resolve(__dirname, "engines/document/src/tiptapCodec.ts"),
      "@ai-office-suite/document-engine": path.resolve(__dirname, "engines/document/src/index.ts"),
      "@ai-office-suite/calculation-engine": path.resolve(__dirname, "engines/calculation/src/index.ts"),
      "@ai-office-suite/data-processing": path.resolve(__dirname, "engines/data-processing/src/index.ts"),
      "@ai-office-suite/file-conversion": path.resolve(__dirname, "engines/file-conversion/src/index.ts"),
      "@ai-office-suite/speech-engine": path.resolve(__dirname, "engines/speech/src/index.ts"),
      "@ai-office-suite/documents-module": path.resolve(__dirname, "modules/documents/src/index.ts"),
      "@ai-office-suite/ai-module": path.resolve(__dirname, "modules/ai/src/index.ts"),
      "@ai-office-suite/workers": path.resolve(__dirname, "apps/workers/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    maxWorkers: 4,
    testTimeout: 120000,
    hookTimeout: 60000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "apps/api/src/**/*.ts",
        "apps/workers/src/**/*.ts",
        "apps/web/src/**/*.{ts,tsx}",
        "engines/*/src/**/*.ts",
        "modules/*/src/**/*.ts",
        "packages/*/src/**/*.ts",
        "platform/*/src/**/*.ts",
      ],
      exclude: ["**/*.d.ts"],
    },
  },
});
