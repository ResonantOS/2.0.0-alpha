import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
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
    assert.match(result.error, /ENOENT/, "a stable reason code keeps the failure actionable");
    // The error must not leak the absolute repository path (the developer's
    // workstation path) into the JSON or HTML response.
    assert.ok(!result.error.includes(root), `error must not contain the absolute path: ${result.error}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON route fails honestly on structurally invalid manifests without aborting", async () => {
  await withAddonsDir(
    {
      "a-good.json": JSON.stringify(memoryManifest),
      "b-null.json": "null",
      "c-array.json": "[]",
      "d-string.json": JSON.stringify("just a string"),
      "e-bad-caps.json": JSON.stringify({ id: "x", requestedCapabilities: "providers" }),
      "f-bad-tools.json": JSON.stringify({ id: "y", tools: { name: "nope" } }),
    },
    async (root) => {
      const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
      const jsonRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes");
      // Must resolve, not throw: one bad manifest never 500s the whole listing.
      const result = await jsonRoute.handler({}, {});
      assert.equal(result.error, null);
      assert.equal(result.addons.length, 6);
      const good = result.addons.find((addon) => addon.fileName === "a-good.json");
      assert.equal(good.id, "reference-memory", "the valid manifest is still listed");
      const expectations = [
        ["b-null.json", /^invalid manifest: manifest root/],
        ["c-array.json", /^invalid manifest: manifest root/],
        ["d-string.json", /^invalid manifest: manifest root/],
        ["e-bad-caps.json", /^invalid manifest: requestedCapabilities/],
        ["f-bad-tools.json", /^invalid manifest: tools/],
      ];
      for (const [fileName, pattern] of expectations) {
        const entry = result.addons.find((addon) => addon.fileName === fileName);
        assert.ok(entry, `${fileName} is enumerated`);
        assert.match(entry.error, pattern, fileName);
      }
    },
  );
});

test("JSON route tolerates nullish entries in capability and tool arrays", async () => {
  // Partially-formed arrays (valid JSON, nullish members) must neither crash
  // the listing nor leak into the card fields.
  const ragged = {
    id: "addon.ragged",
    name: "Ragged",
    requestedCapabilities: [null, { capability: "providers" }, {}],
    tools: [null, { name: "ragged.tool" }, {}],
  };
  await withAddonsDir({ "ragged.json": JSON.stringify(ragged) }, async (root) => {
    const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
    const jsonRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes");
    const result = await jsonRoute.handler({}, {});
    const entry = result.addons.find((addon) => addon.fileName === "ragged.json");
    assert.equal(entry.error, undefined, "ragged arrays are valid manifests, not errors");
    assert.deepEqual(entry.tools, ["ragged.tool"], "nullish tool entries are filtered");
    assert.equal(entry.hasTrigger, false, "nullish capability entries grant nothing");
  });
});

test("panel omits unknown and sensitive manifest fields (data minimization)", async () => {
  // Token-shaped value assembled at runtime from individually harmless
  // fragments so no committed line carries a scanner-matching credential
  // literal (repo convention: syntheticLeakedBearerToken in addon-sdk-testing).
  const syntheticToken = ["sk", "panel", "0000111122223333"].join("-");
  const hostileFields = {
    email: "developer@example.com",
    systemPrompt: "You are a helpful assistant with full access",
    absolutePath: "/Users/someone/private/secrets.json",
    apiKey: syntheticToken,
    onmouseover: "alert(1)",
    nestedConfig: { home: "/Users/someone", env: "DEEPSEEK_API_KEY" },
  };
  // Computed key: an own "__proto__" property that JSON.parse would also
  // produce as an own property — it must neither pollute nor pass through.
  const manifest = {
    id: "addon.hostile",
    name: "Hostile",
    version: "1.0.0",
    runtimeType: "agent-addon",
    ...hostileFields,
    ["__" + "proto__"]: { polluted: true },
  };
  const sensitiveValues = [
    "developer@example.com",
    "helpful assistant",
    "/Users/someone",
    syntheticToken,
    "onmouseover",
    "DEEPSEEK_API_KEY",
    "polluted",
    "__proto__",
  ];
  await withAddonsDir({ "hostile.json": JSON.stringify(manifest) }, async (root) => {
    const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
    const jsonRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes");
    const result = await jsonRoute.handler({}, {});
    const entry = result.addons.find((addon) => addon.fileName === "hostile.json");

    // Exactly the whitelisted card fields — unknown fields are omitted, not
    // merely escaped.
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["fileName", "hasTrigger", "id", "name", "runtimeType", "serviceEntrypoint", "tools", "version"],
    );

    const serialized = JSON.stringify(result);
    for (const leaked of sensitiveValues) {
      assert.ok(!serialized.includes(leaked), `JSON payload must not contain ${leaked}`);
    }

    // The __proto__ fixture key polluted nothing.
    assert.equal({}.polluted, undefined);

    // The HTML path serves the same minimized payload.
    const htmlRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes/");
    const html = (await htmlRoute.handler({}, {})).__html;
    for (const leaked of sensitiveValues) {
      assert.ok(!html.includes(leaked), `HTML must not contain ${leaked}`);
    }
  });
});

test("panel handlers are observational: no writes and no created directories", async () => {
  const snapshotTree = async (dir) => {
    const listing = [];
    for (const rel of (await readdir(dir, { recursive: true })).sort()) {
      const fullPath = path.join(dir, rel);
      const info = await stat(fullPath);
      listing.push([rel, info.isDirectory() ? "dir" : await readFile(fullPath, "utf8")]);
    }
    return listing;
  };

  await withAddonsDir(
    { "addon.deepseek-harness.json": JSON.stringify(deepseekManifest) },
    async (root) => {
      const before = await snapshotTree(root);
      const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
      for (const route of devPanelRoutes) {
        await route.handler({}, {});
      }
      assert.deepEqual(await snapshotTree(root), before, "handlers must not write, create, or modify any file");
    },
  );

  // The missing-directory error path must not create examples/addons either.
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-dev-panel-ro-"));
  try {
    const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
    for (const route of devPanelRoutes) {
      await route.handler({}, {});
    }
    assert.deepEqual(await readdir(root), [], "the error path must not create directories");
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

test("panel module surface is read-only by construction (import pin)", async () => {
  // The module's import list is the complete statement of its capabilities:
  // no subprocess, no network, no environment, no credential/grants surface.
  // Combined with the no-writes snapshot test above, this pins the panel as
  // observational: if a future change needs any new capability, this fails first.
  const source = await readFile(new URL("../host/dev-external-agent-runtimes-panel.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ["node:fs", "node:fs/promises", "node:path", "node:url"]);
  assert.ok(!source.includes("process.env"), "the panel must not read the environment");
  assert.ok(!source.includes("child_process"), "the panel must not spawn");
});

test("enumeration reads only <repoRoot>/examples/addons — sibling fixtures are invisible", async () => {
  await withAddonsDir({ "real.json": JSON.stringify(memoryManifest) }, async (root) => {
    // A decoy manifest tree NEXT TO the fixture root: a handler that read
    // outside repoRoot (cwd, home dirs, absolute paths) could see it.
    const sibling = await mkdtemp(path.join(os.tmpdir(), "resonantos-dev-panel-decoy-"));
    try {
      const decoyAddons = path.join(sibling, "examples", "addons");
      await mkdir(decoyAddons, { recursive: true });
      await writeFile(path.join(decoyAddons, "decoy.json"), JSON.stringify(deepseekManifest));
      const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
      const jsonRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes");
      const result = await jsonRoute.handler({}, {});
      assert.deepEqual(
        result.addons.map((addon) => addon.fileName),
        ["real.json"],
        "reads are confined to the supplied repository root",
      );
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });
});
