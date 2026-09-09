import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDevExternalAgentRuntimesPanelService } from "../host/dev-external-agent-runtimes-panel.mjs";

// Manifest fixtures shaped like the real examples/addons/*.json the panel
// enumerates. Only the fields the panel reads are set.
const deepseekManifest = {
  id: "addon.deepseek-harness",
  name: "DeepSeek Harness",
  version: "0.1.0",
  runtimeType: "agent-addon",
  service: { entrypoint: "http://127.0.0.1:3080" },
  requestedCapabilities: [
    { capability: "providers" },
    { capability: "agent-delegation" },
  ],
  tools: [{ name: "deepseek_harness.status" }, { name: "deepseek_harness.run_task" }],
};
const memoryManifest = {
  id: "reference-memory",
  name: "Reference Memory",
  version: "0.1.0",
  runtimeType: "local-service",
  service: { entrypoint: "http://127.0.0.1:4888" },
  requestedCapabilities: [{ capability: "memory-provider" }, { capability: "network" }],
  tools: [{ name: "memory.search" }],
};

async function withAddonsDir(files, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-dev-panel-"));
  try {
    const addonsDir = path.join(root, "examples", "addons");
    await mkdir(addonsDir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(addonsDir, name), contents);
    }
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("constructor requires a repoRoot", () => {
  assert.throws(() => createDevExternalAgentRuntimesPanelService({}), /repoRoot/);
  assert.throws(() => createDevExternalAgentRuntimesPanelService({ repoRoot: "" }), /repoRoot/);
});

test("dev panel routes are exact, gated, and development-only in shape", () => {
  const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: "/anywhere" });
  const byPath = new Map(devPanelRoutes.map((route) => [route.path, route]));

  // Exactly two routes, exact distinct pathnames (trailing slash matters),
  // no prefix matching: any suffix falls through to default-deny unknown-route.
  assert.deepEqual([...byPath.keys()].sort(), [
    "/dev/external-agent-runtimes",
    "/dev/external-agent-runtimes/",
  ]);
  for (const route of devPanelRoutes) {
    assert.equal(route.method, "GET", route.path);
    assert.equal(route.requiredCapability, "addon-runtime-read", `${route.path} must declare addon-runtime-read`);
    assert.equal(typeof route.handler, "function", route.path);
  }
});

test("JSON route enumerates addon manifests with the §3 trigger flag", async () => {
  await withAddonsDir(
    {
      "addon.deepseek-harness.json": JSON.stringify(deepseekManifest),
      "reference-memory.json": JSON.stringify(memoryManifest),
      "notes.txt": "not a manifest",
    },
    async (root) => {
      const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
      const jsonRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes");
      const result = await jsonRoute.handler({}, {});

      assert.equal(result.panelPath, "/dev/external-agent-runtimes/");
      assert.equal(typeof result.generatedAt, "string");
      assert.equal(result.error, null);
      // Sorted, only *.json enumerated.
      assert.deepEqual(
        result.addons.map((addon) => addon.fileName),
        ["addon.deepseek-harness.json", "reference-memory.json"],
      );

      const deepseek = result.addons.find((addon) => addon.fileName === "addon.deepseek-harness.json");
      assert.equal(deepseek.id, "addon.deepseek-harness");
      assert.equal(deepseek.runtimeType, "agent-addon");
      assert.equal(deepseek.serviceEntrypoint, "http://127.0.0.1:3080");
      assert.deepEqual(deepseek.tools, ["deepseek_harness.status", "deepseek_harness.run_task"]);
      // §3 trigger: providers + agent-delegation.
      assert.equal(deepseek.hasTrigger, true);

      const memory = result.addons.find((addon) => addon.fileName === "reference-memory.json");
      assert.equal(memory.hasTrigger, false);
    },
  );
});

test("JSON route reports a malformed manifest inline without aborting the listing", async () => {
  await withAddonsDir(
    {
      "a-good.json": JSON.stringify(memoryManifest),
      "b-bad.json": "{ not json",
    },
    async (root) => {
      const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
      const jsonRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes");
      const result = await jsonRoute.handler({}, {});
      assert.equal(result.error, null);
      const bad = result.addons.find((addon) => addon.fileName === "b-bad.json");
      assert.match(bad.error, /parse failed/);
      const good = result.addons.find((addon) => addon.fileName === "a-good.json");
      assert.equal(good.id, "reference-memory");
    },
  );
});

test("JSON route returns an honest error when the addons directory is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-dev-panel-empty-"));
  try {
    // No examples/addons directory at all.
    const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
    const jsonRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes");
    const result = await jsonRoute.handler({}, {});
    assert.deepEqual(result.addons, []);
    assert.match(result.error, /unable to read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTML route serves the panel with server-injected data and no external fetch", async () => {
  await withAddonsDir(
    {
      "addon.deepseek-harness.json": JSON.stringify(deepseekManifest),
    },
    async (root) => {
      const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
      const htmlRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes/");
      const result = await htmlRoute.handler({}, {});

      assert.equal(result.contentType, "text/html; charset=utf-8");
      assert.equal(typeof result.__html, "string");
      // The manifests are injected server-side (no client-side fetch required)
      // into an inert application/json data block.
      assert.match(result.__html, /addon\.deepseek-harness/);
      assert.match(result.__html, /<script type="application\/json" id="panel-data">/);
      // The injection token is fully replaced (no leftover sentinel).
      assert.doesNotMatch(result.__html, /__EXTERNAL_AGENT_RUNTIMES_DATA__/);
    },
  );
});

test("HTML route neutralises markup-breakout sequences in manifest fields", async () => {
  await withAddonsDir(
    {
      "evil.json": JSON.stringify({ id: "x</script><script>alert(1)</script>", name: "evil" }),
    },
    async (root) => {
      const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
      const htmlRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes/");
      const result = await htmlRoute.handler({}, {});
      // No raw `</script>` may appear inside the injected payload.
      assert.ok(!result.__html.includes("x</script><script>"), "injected payload must escape <");
    },
  );
});
