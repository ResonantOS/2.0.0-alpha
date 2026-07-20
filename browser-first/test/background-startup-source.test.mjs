import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backgroundPath = path.resolve(__dirname, "../resonantos-side-panel-extension/src/background.js");

test("background service worker imports the raw bridge fetch helper used during rebind", async () => {
  const source = await readFile(backgroundPath, "utf8");

  assert.match(source, /import\s+\{[^}]*createRawBridgeFetch[^}]*\}\s+from\s+"\.\/lib\/bridge-client\.js"/s);
  assert.match(source, /createRawBridgeFetch\(cfg\)/);
});
