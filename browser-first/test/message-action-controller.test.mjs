import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  createMessageActionController,
  fileLooksTextLike
} from "../resonantos-side-panel-extension/src/lib/message-action-controller.js";

function createHarness(overrides = {}) {
  const events = [];
  const messages = [
    { id: "u1", role: "user", content: "hello", createdAt: "2026-05-26T10:00:00.000Z" },
    { id: "a1", role: "assistant", content: "answer", usage: { tokens: 3 }, createdAt: "2026-05-26T10:01:00.000Z" }
  ];
  let attachments = [];
  const chatSessionStore = {
    addAttachments: async (items) => {
      attachments = [...attachments, ...items];
      events.push(["addAttachments", items]);
    },
    clearAttachments: async () => {
      attachments = [];
      events.push(["clearAttachments"]);
    },
    deleteMessage: async (id) => events.push(["delete", id]),
    findMessage: (id) => messages.find((message) => message.id === id) ?? null,
    forkFromMessage: async (id) => {
      events.push(["fork", id]);
      return { id: "fork-a" };
    },
    prepareRegenerationFromMessage: async (id, options) => {
      events.push(["prepareRegeneration", id, options?.mode]);
      return overrides.noPreviousUser
        ? null
        : { mode: options?.mode, userMessage: messages[0] };
    },
    trimToPreviousUserMessage: async (id) => {
      events.push(["trim", id]);
      return overrides.noPreviousUser ? null : messages[0];
    }
  };
  const commandInput = {
    focused: false,
    value: "",
    focus() {
      this.focused = true;
    }
  };
  const fileInput = { value: "selected" };
  const controller = createMessageActionController({
    addMessage: async (role, content) => events.push(["message", role, content]),
    bridgeRequest: async (path, request) => {
      events.push(["bridge", path, request.body]);
      if (overrides.archiveFail) throw new Error("archive down");
      return { path: "/archive/intake/message.md" };
    },
    chatSessionStore,
    commandInput,
    composerController: {
      resetUndoStack: (value) => events.push(["resetUndo", value])
    },
    fileInput,
    flashCopied: (id) => events.push(["flash", id]),
    getLastSnapshot: () => ({ url: "https://example.com/" }),
    getRegenerationMode: () => overrides.regenerationMode ?? "branch",
    getRespondToCommand: () => async (value) => events.push(["respond", value]),
    navigator: {
      clipboard: {
        writeText: async (text) => events.push(["clipboard", text])
      }
    },
    renderAttachments: () => events.push(["renderAttachments"]),
    renderMessages: () => events.push(["renderMessages"]),
    setStatus: (status) => events.push(["status", status])
  });
  return { commandInput, controller, events, fileInput, getAttachments: () => attachments };
}

function createCopyFallbackHarness() {
  const dom = new JSDOM("<main></main>");
  const events = [];
  const commandInput = dom.window.document.createElement("textarea");
  dom.window.document.body.append(commandInput);
  dom.window.document.execCommand = (command) => {
    const scratch = [...dom.window.document.querySelectorAll("textarea")].at(-1);
    events.push(["execCommand", command, scratch?.value]);
    return true;
  };
  const controller = createMessageActionController({
    addMessage: async () => undefined,
    bridgeRequest: async () => ({}),
    chatSessionStore: {
      findMessage: () => ({ id: "a1", role: "assistant", content: "fallback copy", createdAt: "2026-05-26T10:01:00.000Z" })
    },
    commandInput,
    composerController: { resetUndoStack: () => undefined },
    fileInput: null,
    flashCopied: (id) => events.push(["flash", id]),
    getLastSnapshot: () => null,
    getRespondToCommand: () => async () => undefined,
    navigator: {
      clipboard: {
        writeText: async () => {
          throw new Error("clipboard unavailable");
        }
      }
    },
    renderAttachments: () => undefined,
    renderMessages: () => undefined,
    setStatus: (status) => events.push(["status", status])
  });
  return { controller, events };
}

test("message action controller detects text-like files", () => {
  assert.equal(fileLooksTextLike({ name: "notes.md", type: "" }), true);
  assert.equal(fileLooksTextLike({ name: "data.bin", type: "application/octet-stream" }), false);
  assert.equal(fileLooksTextLike({ name: "payload", type: "application/json" }), true);
});

test("message action controller copies, forks, deletes, and edits messages", async () => {
  const harness = createHarness();

  await harness.controller.copyMessage("a1");
  await harness.controller.forkFromMessage("a1");
  await harness.controller.deleteMessage("a1");
  harness.controller.editMessage("u1");

  assert.ok(harness.events.some((event) => event[0] === "clipboard" && event[1] === "answer"));
  assert.ok(harness.events.some((event) => event[0] === "flash" && event[1] === "a1"));
  assert.ok(harness.events.some((event) => event[0] === "fork" && event[1] === "a1"));
  assert.ok(harness.events.some((event) => event[0] === "delete" && event[1] === "a1"));
  assert.equal(harness.commandInput.value, "hello");
  assert.equal(harness.commandInput.focused, true);
});

test("message action controller falls back to native copy when clipboard API fails", async () => {
  const harness = createCopyFallbackHarness();

  await harness.controller.copyMessage("a1");

  assert.ok(harness.events.some((event) => event[0] === "execCommand" && event[1] === "copy" && event[2] === "fallback copy"));
  assert.ok(harness.events.some((event) => event[0] === "flash" && event[1] === "a1"));
  assert.ok(harness.events.some((event) => event[0] === "status" && event[1] === "Copied"));
});

test("message action controller saves messages to archive and reports stats", async () => {
  const harness = createHarness();

  await harness.controller.saveMessageToArchive("a1");
  await harness.controller.showMessageStats("a1");
  await harness.controller.showMessageStats("u1");

  assert.ok(harness.events.some((event) => event[0] === "bridge" && event[1] === "/archive/intake" && event[2].sourceMessageId === "a1"));
  assert.ok(harness.events.some((event) => event[0] === "message" && /Saved to Living Archive intake/.test(event[2])));
  assert.ok(harness.events.some((event) => event[0] === "message" && /Generation stats/.test(event[2])));
  assert.ok(harness.events.some((event) => event[0] === "message" && /No generation telemetry/.test(event[2])));
});

test("message action controller prepares regenerate with the selected mode", async () => {
  const harness = createHarness({ regenerationMode: "branch" });
  await harness.controller.regenerateFromMessage("a1");
  assert.ok(harness.events.some((event) => event[0] === "prepareRegeneration" && event[1] === "a1" && event[2] === "branch"));
  assert.ok(harness.events.some((event) => event[0] === "respond" && event[1] === "hello"));

  const overwrite = createHarness({ regenerationMode: "overwrite" });
  await overwrite.controller.regenerateFromMessage("a1");
  assert.ok(overwrite.events.some((event) => event[0] === "prepareRegeneration" && event[2] === "overwrite"));
});

test("message action controller handles missing regeneration history", async () => {
  const missing = createHarness({ noPreviousUser: true });
  await missing.controller.regenerateFromMessage("a1");
  assert.ok(missing.events.some((event) => event[0] === "message" && /No previous user message/.test(event[2])));
});

test("message action controller attaches text files and clears attachments", async () => {
  const harness = createHarness();
  const file = {
    name: "notes.md",
    size: 12,
    text: async () => "hello from file",
    type: "text/markdown"
  };

  await harness.controller.attachFiles([file]);
  assert.equal(harness.getAttachments().length, 1);
  assert.equal(harness.getAttachments()[0].content, "hello from file");
  assert.equal(harness.fileInput.value, "");
  assert.ok(harness.events.some((event) => event[0] === "renderAttachments"));

  await harness.controller.clearAttachments();
  assert.equal(harness.getAttachments().length, 0);
});
