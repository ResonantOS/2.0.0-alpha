import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("side panel wires natural delegation into the command router", async () => {
  const source = await readFile(new URL("../resonantos-side-panel-extension/src/side-panel.js", import.meta.url), "utf8");
  const routerSetup = /const commandRouter = createSidePanelCommandRouter\(\{(?<body>[\s\S]*?)\n\}\);/.exec(source);

  assert.ok(routerSetup?.groups?.body, "side panel command router setup was not found");
  assert.match(source, /const\s+\{[\s\S]*runNaturalDelegationCommand[\s\S]*\}\s*=\s*createAppCommandHandlers\(/);
  assert.match(routerSetup.groups.body, /\brunNaturalDelegationCommand\b/);
});
