import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAddonDelegationService } from "../host/addon-delegation-service.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("Agent Handoff Kit Hot Rod Rig test validates real package evidence", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "agent-handoff-hrr-"));
  try {
    const service = createAddonDelegationService({
      browserFirstRoot: () => path.join(tmp, "BrowserFirst"),
      bridgePublicUrl: () => "http://127.0.0.1:47773",
      dashboardTarget: () => ({ host: "127.0.0.1", port: 9119, url: "http://127.0.0.1:9119" }),
      execFileStdout: async () => "",
      expandUserPath: (value) => value,
      firstExistingExecutable: () => null,
      hermesCommand: () => null,
      hermesHome: () => path.join(tmp, "Hermes"),
      listFilesRecursive: async () => [],
      memoryRoot: () => path.join(tmp, "Memory"),
      opencodeCommand: () => null,
      redactPathForDiagnostics: (value) => value,
      repoRoot,
      safeFileSlug: (value) => String(value ?? "item").replace(/[^a-z0-9-]+/gi, "-").toLowerCase(),
      socketOpen: async () => false,
      uniqueRuntimeId: (prefix) => `${prefix}-test`,
      userRoot: () => tmp,
    });

    const result = await service.executeAgentHandoffHotRodRigTest();

    assert.equal(result.status, "passed");
    assert.equal(result.passed, true);
    assert.ok(result.checks.length >= 8);
    assert.ok(result.checks.every((check) => check.passed), JSON.stringify(result.checks, null, 2));
    assert.ok(result.checks.some((check) => check.id === "channel-evidence"));
    assert.ok(result.checks.some((check) => check.id === "workspace-test-surface"));
    assert.match(result.summary, /passed the host-backed Hot Rod Rig package test/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
