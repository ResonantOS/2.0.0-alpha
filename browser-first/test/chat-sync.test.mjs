import assert from "node:assert/strict";
import test from "node:test";

import { shouldSyncChatChange } from "../resonantos-side-panel-extension/src/lib/chat-sync.js";

const options = { keys: ["sessions", "folders", "projects", "activeSessionId"], writerKey: "writer", instanceId: "me" };

test("chat sync ignores the surface's own writes", () => {
  const changes = { sessions: { newValue: [] }, writer: { newValue: "me:7" } };
  assert.equal(shouldSyncChatChange(changes, options), false);
});

test("chat sync re-syncs on another surface's chat write", () => {
  const changes = { folders: { newValue: [] }, writer: { newValue: "them:3" } };
  assert.equal(shouldSyncChatChange(changes, options), true);
});

test("chat sync ignores changes that touch no chat keys", () => {
  const changes = { augmentorBrowserJobs: { newValue: [] } };
  assert.equal(shouldSyncChatChange(changes, options), false);
});

test("chat sync handles a foreign write even without a writer token", () => {
  const changes = { activeSessionId: { newValue: "s2" } };
  assert.equal(shouldSyncChatChange(changes, options), true);
});

test("chat sync is safe on empty or malformed input", () => {
  assert.equal(shouldSyncChatChange(null, options), false);
  assert.equal(shouldSyncChatChange({}, options), false);
});
