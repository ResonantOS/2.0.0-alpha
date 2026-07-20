#!/usr/bin/env node
/**
 * Disclosure-baseline presence test (PR-A01).
 * Uses only node:test and node:assert. Run with: node --test
 *
 * Asserts the promoted disclosure baseline is present and correctly shaped:
 *   - SECURITY.md declares the disclosure-owner contact line.
 *   - .github/workflows/security.yml declares `permissions: contents: read`
 *     and references the security-pipeline registry runner.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/security-pipeline/ -> repo root is two levels up.
const REPO_ROOT = join(__dirname, "..", "..");

test("SECURITY.md declares the disclosure-owner contact line", () => {
  const security = readFileSync(join(REPO_ROOT, "SECURITY.md"), "utf8");
  assert.match(
    security,
    /\*\*Disclosure contact:\*\*\s*Vladimir Rondelli/,
    "SECURITY.md must name the disclosure owner Vladimir Rondelli"
  );
  assert.match(
    security,
    /rondellivladimir@gmail\.com/,
    "SECURITY.md must include the disclosure-owner contact email"
  );
});

test("security.yml declares least-privilege permissions and runs the registry", () => {
  const workflow = readFileSync(
    join(REPO_ROOT, ".github", "workflows", "security.yml"),
    "utf8"
  );

  // permissions: contents: read (top-level, with read as the value of contents)
  assert.match(
    workflow,
    /permissions:\s*\n\s*contents:\s*read/,
    "security.yml must declare permissions: contents: read"
  );

  // references the registry runner script + the checks registry config
  assert.match(
    workflow,
    /scripts\/security-pipeline\/run-check\.mjs/,
    "security.yml must reference the registry runner run-check.mjs"
  );
  assert.match(
    workflow,
    /--config\s+\.github\/security-pipeline\/checks\.yml/,
    "security.yml must point the runner at the checks registry"
  );

  // every uses: ref must be SHA-pinned to a full 40-char commit SHA
  const usesRefs = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(usesRefs.length > 0, "security.yml should reference at least one action");
  for (const ref of usesRefs) {
    assert.match(
      ref,
      /@[0-9a-f]{40}$/,
      `action ref must be pinned to a full 40-char commit SHA: ${ref}`
    );
  }
});
