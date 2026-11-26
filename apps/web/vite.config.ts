import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ai-office-suite/shared-contracts": path.resolve(__dirname, "../../packages/shared-contracts/src/index.ts"),
      "@ai-office-suite/document-engine/tiptap-codec": path.resolve(__dirname, "../../engines/document/src/tiptapCodec.ts"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom") || id.includes("node_modules/scheduler")) {
            return "react-vendor";
          }
          if (id.includes("node_modules/prosemirror-") || id.includes("node_modules/@tiptap/pm")) {
            return "prosemirror-vendor";
          }
          if (id.includes("node_modules/@tiptap/")) {
            return "tiptap-vendor";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5174,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4100",
        changeOrigin: false,
      },
    },
  },
});
