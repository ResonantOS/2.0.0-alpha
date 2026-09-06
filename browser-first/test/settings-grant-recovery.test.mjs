import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderBrowserControlSection } from "../resonantos-side-panel-extension/src/lib/settings/browser-control-section.js";

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Settings did not settle");
}

function setup(t, options) {
  const dom = new JSDOM("<main></main>", { url: "https://example.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const container = document.querySelector("main");
  renderBrowserControlSection(container, {
    chromeApi: { tabs: { query: async () => [] } },
    ...options
  });
  return {
    container,
    status: container.querySelector(".settings-status"),
    button: (label) => [...container.querySelectorAll("button")].find((node) => node.textContent === label)
  };
}

test("a concurrent history refresh cannot expose a second pending revocation", async (t) => {
  let calls = 0;
  let release;
  let granted = true;
  const ui = setup(t, {
    storageKeys: { browserJobs: "jobs" },
    storage: { get: async () => ({ jobs: [] }), set: async () => {} },
    taskConsentStore: {
      taskConsents: async () => granted ? { fixture: { siteKey: "example.test", taskClass: "read" } } : {},
      revokeTaskConsent: async () => {
        calls += 1;
        await new Promise((resolve) => { release = resolve; });
        granted = false;
      }
    }
  });
  await until(() => ui.status.dataset.tone === "success");
  const original = ui.button("Revoke");
  original.click();
  ui.button("Clear Completed Browser Jobs").click();
  await until(() => ui.button("Revoke") !== original);
  ui.button("Revoke").click();
  assert.equal(calls, 1);
  release();
  await until(() => !ui.button("Revoke"));
});

for (const label of ["Reset", "Revoke"]) {
  function stores(action, reads = async () => ({})) {
    let granted = true;
    const consent = { siteKey: "example.test", taskClass: "read", mode: "allow-safe", expiresAt: 2000000000000 };
    return {
      options: {
        sitePermissionStore: {
          sitePermissions: async () => { await reads(); return label === "Reset" && granted ? { "example.test": "allow-safe" } : {}; },
          resetSitePermission: label === "Reset" ? async () => { await action(); granted = false; } : undefined
        },
        taskConsentStore: {
          taskConsents: async () => label === "Revoke" && granted ? { consent } : {},
          revokeTaskConsent: label === "Revoke" ? async () => { await action(); granted = false; } : undefined
        }
      },
      granted: () => granted
    };
  }

  test(`${label} catches failure, blocks pending duplicates and supports retry`, async (t) => {
    let reject;
    let calls = 0;
    let fail = true;
    const store = stores(async () => {
      calls += 1;
      if (fail) await new Promise((resolve, rejectPromise) => { reject = rejectPromise; });
    });
    const ui = setup(t, store.options);
    await until(() => ui.status.dataset.tone === "success");
    const button = ui.button(label);
    button.click();
    button.dispatchEvent(new button.ownerDocument.defaultView.Event("click"));
    assert.equal(calls, 1);
    assert.equal(button.disabled, true);
    reject(new Error("Permission write unavailable"));
    await until(() => !button.disabled);
    assert.equal(ui.status.dataset.tone, "error");
    assert.match(ui.status.textContent, /could not be confirmed/i);
    assert.equal(store.granted(), true);
    fail = false;
    button.click();
    await until(() => !ui.button(label));
    assert.equal(calls, 2);
    assert.equal(store.granted(), false);
    assert.match(ui.status.textContent, /0 stored grants/);
  });

  test(`${label} refresh failure retries reads without replaying the mutation`, async (t) => {
    let calls = 0;
    let failRead = false;
    const store = stores(async () => { calls += 1; failRead = true; }, async () => {
      if (failRead) throw new Error("Grant read unavailable");
    });
    const ui = setup(t, store.options);
    await until(() => ui.status.dataset.tone === "success");
    ui.button(label).click();
    await until(() => ui.status.dataset.tone === "error");
    assert.match(ui.status.textContent, /updated.*refresh failed/i);
    assert.equal(store.granted(), false);
    failRead = false;
    ui.button("Refresh").click();
    await until(() => ui.status.dataset.tone === "success");
    assert.equal(calls, 1);
    assert.match(ui.status.textContent, /0 stored grants/);
  });

  test(`${label} reports an unavailable mutation method`, async (t) => {
    const store = stores(async () => {});
    if (label === "Reset") delete store.options.sitePermissionStore.resetSitePermission;
    else delete store.options.taskConsentStore.revokeTaskConsent;
    const ui = setup(t, store.options);
    await until(() => ui.status.dataset.tone === "success");
    ui.button(label).click();
    await until(() => !ui.button(label).disabled);
    assert.equal(ui.status.dataset.tone, "error");
    assert.equal(store.granted(), true);
  });
}
