import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_WORKSPACE_PATH = new URL(
  "../resonantos-side-panel-extension/src/main-workspace.js",
  import.meta.url,
);

test("main workspace disposes the previous OpenCode renderer before replacing its DOM", async () => {
  const source = await readFile(MAIN_WORKSPACE_PATH, "utf8");
  const renderStart = source.indexOf("function renderMessages()");
  const renderEnd = source.indexOf("\nfunction ", renderStart + 1);
  const renderMessages = source.slice(
    renderStart,
    renderEnd > renderStart ? renderEnd : undefined,
  );

  const disposeIndex = renderMessages.indexOf("activeWorkspaceCleanup");
  const replaceIndex = renderMessages.indexOf("transcript.replaceChildren()");
  assert.ok(disposeIndex >= 0, "renderMessages must invoke the active workspace cleanup");
  assert.ok(replaceIndex > disposeIndex, "workspace cleanup must begin before DOM replacement");
  assert.match(
    renderMessages,
    /activeWorkspaceCleanup\s*=\s*renderOpenCodeWorkspace\(/,
  );
});
