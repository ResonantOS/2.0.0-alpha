import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

// Content scripts declared in manifest.json are injected as CLASSIC scripts (no
// `type: "module"` support for manifest content_scripts). Any ES-module syntax
// (`export`, top-level `import`) makes Chrome abort parsing of the WHOLE file, so
// nothing in it runs on the page — silently disabling whatever it guards (#219 gate).
const root = new URL("../resonantos-side-panel-extension/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));

test("manifest declares at least one classic content script", () => {
  const scripts = (manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []);
  assert.ok(scripts.length > 0);
});

for (const cs of manifest.content_scripts ?? []) {
  for (const file of cs.js ?? []) {
    test(`content script parses as a classic script: ${file}`, () => {
      const source = readFileSync(new URL(file, root), "utf8");
      assert.doesNotThrow(() => new Script(source, { filename: file }), `${file} must not use ES-module syntax (export/import) — it is injected as a classic content script`);
    });
  }
}
