#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = join(repoRoot, "docs", "architecture", "MODULE-OWNERSHIP.md");
const contributingPath = join(repoRoot, "CONTRIBUTING.md");
const modulesDir = join(repoRoot, "src", "modules");

const headingSlug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

test("module ownership architecture doc covers every module and boundary", () => {
  assert.equal(existsSync(docPath), true, "docs/architecture/MODULE-OWNERSHIP.md must exist");

  const doc = readFileSync(docPath, "utf8");
  const modules = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const moduleName of modules) {
    assert.match(
      doc,
      new RegExp(`\\| \`src/modules/${moduleName}/\``),
      `MODULE-OWNERSHIP.md must list src/modules/${moduleName}/`,
    );
  }

  for (const heading of [
    "State And Data Flow",
    "Host And IPC Boundary",
    "Pull Request Checklist Hook",
  ]) {
    assert.match(doc, new RegExp(`## ${heading}\\b`), `missing ${heading} section`);
  }

  assert.match(doc, /browser-first\/host\//, "active browser-first host boundary must be documented");
  assert.match(doc, /src-tauri\/src\/.*not present/i, "the current src-tauri/src absence must be explicit");
  assert.match(
    doc,
    /`browser-first\/host\/addon-delegation-host-service\.mjs`, `addon-delegation-service\.mjs`, `hermes-runtime\.mjs`, and `opencode-runtime\.mjs`/,
    "addon delegation ownership must include both runtime resolvers",
  );
  assert.match(
    doc,
    /`browser-first\/host\/browser-diagnostics-host-service\.mjs` and `browser-diagnostics-service\.mjs`/,
    "browser diagnostics ownership must include its process-launch implementation",
  );
  assert.match(
    doc,
    /\| `browser-first\/host\/bridge-tls\.mjs` \|/,
    "bridge TLS ownership must be explicit",
  );
});

test("contributor checklist points module changes at the ownership map", () => {
  const contributing = readFileSync(contributingPath, "utf8");

  assert.match(
    contributing,
    new RegExp(`docs/architecture/MODULE-OWNERSHIP\\.md#${headingSlug("Pull Request Checklist Hook")}`),
    "CONTRIBUTING.md must link PR authors to the module ownership checklist",
  );
});
