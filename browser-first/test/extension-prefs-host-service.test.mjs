import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createExtensionPrefsHostService } from "../host/extension-prefs-host-service.mjs";

test("extension prefs write route is capability gated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-extension-prefs-"));
  try {
    const { extensionPrefsRoutes, flushPendingWrites } = createExtensionPrefsHostService({
      userRoot: () => root,
    });
    const routes = new Map(extensionPrefsRoutes.map((route) => [`${route.method} ${route.path}`, route]));

    assert.equal(typeof routes.get("GET /settings/extension-prefs")?.handler, "function");
    assert.equal(typeof routes.get("POST /settings/extension-prefs")?.handler, "function");
    assert.equal(routes.get("GET /settings/extension-prefs")?.requiredCapability, undefined);
    assert.equal(routes.get("POST /settings/extension-prefs")?.requiredCapability, "extension-prefs-write");

    await flushPendingWrites();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
