import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { DEV_SERVER_FS_DENY } from "./src/dev-server-policy";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("@codemirror/lang-markdown") || id.includes("@lezer/markdown")) {
            return "codemirror-markdown";
          }
          if (
            id.includes("@codemirror/") ||
            id.includes("@lezer/") ||
            id.includes("style-mod") ||
            id.includes("w3c-keyname") ||
            id.includes("crelt")
          ) {
            return "codemirror-core";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
    fs: {
      strict: true,
      deny: DEV_SERVER_FS_DENY,
    },
    watch: {
      ignored: [
        "**/dist/**",
        "**/node_modules/**",
      ],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
