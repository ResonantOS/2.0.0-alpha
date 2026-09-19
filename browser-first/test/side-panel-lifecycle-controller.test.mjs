import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelLifecycleController } from "../resonantos-side-panel-extension/src/lib/side-panel-lifecycle-controller.js";

function createEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event = {}) {
      return listeners.get(type)?.(event);
    }
  };
}

function createHarness({ pendingPrompt = "", pendingRecord, storedState, turnBusy = false, statusLabel = "Ready" } = {}) {
  const events = [];
  const storageState = storedState ?? (pendingRecord || pendingPrompt ? {
    augmentorPendingSidebarPrompt: pendingRecord ?? { prompt: pendingPrompt }
  } : {});
  let busy = turnBusy;
  const storageChanged = {
    handler: null,
    addListener(handler) {
      this.handler = handler;
    }
  };
  const commandInput = {
    value: "",
    dispatchEvent: (event) => events.push(["input-event", event.type]),
    focus: () => events.push(["focus"])
  };
  const sendButton = createEventTarget();
  const commandForm = {
    querySelector: () => sendButton,
    ...createEventTarget()
  };
  const controller = createSidePanelLifecycleController({
    addMessage: async (role, content) => events.push(["message", role, content]),
    browserJobStore: {
      async toggleMonitorCollapsed() {
        events.push(["toggle-jobs"]);
      }
    },
    clearActivitySoon: (...args) => events.push(["clear-activity", ...args]),
    commandForm,
    commandInput,
    composerController: {
      bind: () => events.push(["composer-bind"]),
      resetUndoStack: (value) => events.push(["reset-undo", value])
    },
    getStatusLabel: () => statusLabel,
    getTurnBusy: () => busy,
    messageActions: {
      attachFiles: async () => events.push(["attach-files"])
    },
    respondToCommand: async (prompt) => events.push(["respond", prompt]),
    setTurnBusy: (value) => {
      busy = value;
      events.push(["busy", value]);
    },
    storage: {
      async get(key) {
        return { [key]: storageState[key] };
      },
      async remove(key) {
        delete storageState[key];
        events.push(["remove", key]);
      }
    },
    storageOnChanged: storageChanged,
    storageKeys: {
      pendingSidebarPrompt: "augmentorPendingSidebarPrompt"
    },
    windowRef: {
      Event: class {
        constructor(type) {
          this.type = type;
        }
      }
    }
  });
  return {
    commandForm,
    commandInput,
    controller,
    events,
    getBusy: () => busy,
    setBusy: (value) => { busy = value; },
    sendButton,
    storageChanged,
    storageState
  };
}

test("side panel lifecycle controller consumes pending sidebar prompt once", async () => {
  const harness = createHarness({ pendingPrompt: "  /browser read  " });

  const consumed = await harness.controller.consumePendingSidebarPrompt();

  assert.equal(consumed, true);
  assert.equal(harness.getBusy(), false);
  assert.equal(harness.storageState.augmentorPendingSidebarPrompt, undefined);
  assert.deepEqual(harness.events, [
    ["remove", "augmentorPendingSidebarPrompt"],
    ["busy", true],
    ["message", "user", "/browser read"],
    ["respond", "/browser read"],
    ["busy", false]
  ]);
});

test("side panel lifecycle controller leaves pending prompt untouched while busy", async () => {
  const harness = createHarness({ pendingPrompt: "/control work", turnBusy: true });

  const consumed = await harness.controller.consumePendingSidebarPrompt();

  assert.equal(consumed, false);
  assert.equal(harness.storageState.augmentorPendingSidebarPrompt.prompt, "/control work");
  assert.deepEqual(harness.events, []);
});

test("side panel lifecycle controller binds storage wakeup and form submit", async () => {
  const harness = createHarness({ statusLabel: "Ready" });
  harness.commandInput.value = "hello Augmentor";

  harness.controller.bindListeners();
  await harness.commandForm.dispatch("submit", {
    preventDefault: () => harness.events.push(["prevent"])
  });

  assert.ok(harness.events.some((event) => event[0] === "composer-bind"));
  assert.deepEqual(harness.events.filter((event) => event[0] !== "composer-bind"), [
    ["prevent"],
    ["busy", true],
    ["message", "user", "hello Augmentor"],
    ["reset-undo", ""],
    ["respond", "hello Augmentor"],
    ["busy", false],
    ["clear-activity"]
  ]);
  assert.equal(harness.commandInput.value, "");
  assert.equal(typeof harness.storageChanged.handler, "function");
});

test("side panel lifecycle controller turns send button into stop while busy", () => {
  const harness = createHarness({ turnBusy: true });
  const stopEvents = [];
  const controller = createSidePanelLifecycleController({
    browserJobStore: {},
    commandForm: {
      querySelector: () => harness.sendButton,
      addEventListener: () => undefined
    },
    commandInput: harness.commandInput,
    composerController: { bind: () => undefined },
    getTurnBusy: () => true,
    messageActions: { attachFiles: async () => undefined },
    stopChatTurn: () => stopEvents.push("stop")
  });

  controller.bindListeners();
  harness.sendButton.dispatch("click", {
    preventDefault: () => stopEvents.push("prevent")
  });

  assert.deepEqual(stopEvents, ["prevent", "stop"]);
});

const reentryNotice = "Sensitive text was removed from this handoff. Enter the command directly in the sidebar to continue.";

for (const prompt of ["/control go to https://example.test/?token=REDACTED", ""]) {
  test(`marked sidebar handoff is removed without execution or prefill, including reload (${prompt ? "preview" : "empty preview"})`, async () => {
    const record = { prompt, createdAt: "2026-09-19T12:00:00.000Z", requiresReentry: true };
    // A newly constructed controller with a serialized record models a panel reload.
    const harness = createHarness({ pendingRecord: JSON.parse(JSON.stringify(record)) });
    harness.commandInput.value = "unfinished draft";
    assert.equal(await harness.controller.consumePendingSidebarPrompt(), true);
    assert.deepEqual(harness.events.filter(([type]) => type === "respond"), []);
    assert.deepEqual(harness.events, [
      ["remove", "augmentorPendingSidebarPrompt"],
      ["message", "system", reentryNotice]
    ]);
    assert.equal(harness.commandInput.value, "unfinished draft");
    assert.equal(harness.getBusy(), false);
    assert.deepEqual(harness.storageState, {});

    const reloaded = createHarness({ storedState: JSON.parse(JSON.stringify(harness.storageState)) });
    assert.equal(await reloaded.controller.consumePendingSidebarPrompt(), false);
    assert.deepEqual(reloaded.events, []);
  });
}

test("marked sidebar handoff stays deferred while busy and never executes when idle", async () => {
  const record = { prompt: "/control token=REDACTED", requiresReentry: true };
  const harness = createHarness({ pendingRecord: record, turnBusy: true });
  assert.equal(await harness.controller.consumePendingSidebarPrompt(), false);
  assert.deepEqual(harness.storageState, { augmentorPendingSidebarPrompt: record });
  assert.deepEqual(harness.events, []);
  harness.setBusy(false);
  assert.equal(await harness.controller.consumePendingSidebarPrompt(), true);
  assert.deepEqual(harness.events, [
    ["remove", "augmentorPendingSidebarPrompt"],
    ["message", "system", reentryNotice]
  ]);
});

for (const prompt of ["/jobs", "/jobs focus job-1", "/control go to https://example.test/docs"]) {
  test(`unmarked sidebar handoff still executes once: ${prompt}`, async () => {
    const harness = createHarness({ pendingPrompt: prompt });
    assert.equal(await harness.controller.consumePendingSidebarPrompt(), true);
    assert.deepEqual(harness.events, [
      ["remove", "augmentorPendingSidebarPrompt"],
      ["busy", true],
      ["message", "user", prompt],
      ["respond", prompt],
      ["busy", false]
    ]);
    assert.equal(await harness.controller.consumePendingSidebarPrompt(), false);
    assert.equal(harness.events.filter(([type]) => type === "respond").length, 1);
  });
}
