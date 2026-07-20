#!/usr/bin/env node

// Compatibility entrypoint for older browser-first scripts. The 2.0.0 alpha
// ships the Chrome extension and local Node bridge only.
await import("./run-bridge-minimal.mjs");
