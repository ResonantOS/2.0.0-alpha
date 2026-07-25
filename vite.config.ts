import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const WORKER_RUNTIME_DEPS = ["parakeet.js", "onnxruntime-web", "@huggingface/transformers"];

function externalWorkerRuntimeDeps() {
  return {
    name: "external-worker-runtime-deps",
    resolveId(id: string) {
      if (WORKER_RUNTIME_DEPS.some((dep) => id === dep || id.startsWith(`${dep}/`))) {
        return { id, external: true };
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [react(), externalWorkerRuntimeDeps()],
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
  worker: {
    format: "es",
    plugins: () => [externalWorkerRuntimeDeps()],
  },
  server: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
    // Cross-Origin Isolation headers. The parakeet.js + onnxruntime-web
    // backend needs `SharedArrayBuffer` (and therefore `crossOriginIsolated`)
    // to enable multithreaded WASM, which is 3-6× faster than single-thread
    // on a multi-core machine. The Chrome extension is loaded under its own
    // origin and ignores these, so the dev server is the only place that
    // matters. Production hosts must replicate the same headers — see
    // docs/architecture/ADR-001-platform-stack.md for the deployment note.
    //
    // `credentialless` (rather than `require-corp`) is the right value
    // here: it permits the HuggingFace CDN (which sends `Access-Control-
    // Allow-Origin` but no `Cross-Origin-Resource-Policy`) to be loaded
    // cross-origin without credentials. `require-corp` would block the
    // model download entirely.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    watch: {
      ignored: [
        "**/dist/**",
        "**/node_modules/**",
      ],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  optimizeDeps: {
    // onnxruntime-web ships a large ESM bundle that doesn't benefit from
    // Vite's pre-bundling and can confuse the dep optimizer when it tries
    // to scan the worker entry. Excluding it forces a clean import resolution
    // through the worker bundler.
    exclude: ["onnxruntime-web"],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/*.test.js",
      "src/**/*.test.mjs",
    ],
  },
});
