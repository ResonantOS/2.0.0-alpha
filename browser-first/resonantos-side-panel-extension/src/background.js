// bridge-config.generated.js is auto-written by the bridge at startup.
// It's gitignored and may not exist in a fresh checkout / shipped zip.
// The static import would throw "Failed to fetch" and kill the service
// worker, so we load it dynamically and fall back to a stub config.
// To bake a real config: run the bridge once, or set chrome.storage
// overrides via Settings > Bridge Target.
let __bridgeConfigPromise;
async function loadBridgeConfig() {
  if (!__bridgeConfigPromise) {
    __bridgeConfigPromise = (async () => {
      try {
        await import("./bridge-config.generated.js");
      } catch (err) {
        console.warn(
          "[ResonantOS] bridge-config.generated.js missing — falling back to defaults. " +
            "Run the bridge once or set chrome.storage overrides via Settings > Bridge Target.",
          err
        );
      }
      return globalThis.__RESONANTOS_BRIDGE_CONFIG__ || {
        bridgeUrl: "http://127.0.0.1:47773",
        bridgeToken: "",
        bridgeCapabilityTokens: {},
      };
    })();
  }
  return __bridgeConfigPromise;
}
import { createBridgeClient, createRawBridgeFetch, detectLoopbackBridge, resolveBridgeConfig, initCapabilityTokens, isUnauthorizedBridgeError } from "./lib/bridge-client.js";
import { isTopFrameSender, sanitizeInlineAssistantBody, sanitizeResonantContextSnapshot } from "./lib/background-message-policy.js";
import { createPrefsSync } from "./lib/prefs-sync.js";

const APPROVAL_REQUIRED_ACTIONS = new Set([
  "wallet_connect",
  "wallet_sign",
  "wallet_switch_network",
  "public_submit",
  "sensitive_type",
  "credential_autofill",
]);

const MAIN_WORKSPACE_PATH = "/src/main-workspace.html";

// `bridgeRequest` is `let` (not `const`) because the rebind chain below
// replaces it once loopback detection has settled. Anything that holds
// a reference to bridgeRequest directly (e.g. the prefsSync getter) will
// see the updated client on the next call. We never reassign inside
// message handlers — those always go through the most recent binding.
let bridgeRequest = null;
let rawFetch = null;
const resonantContextSnapshots = new Map();

// `rebindAndHydrate` runs the full re-initialization chain in the
// right order:
//
//   1. resolveBridgeConfig() reads the user override from
//      chrome.storage.local (if any) and falls back to the generated
//      config baked into the extension.
//   2. detectLoopbackBridge() probes 127.0.0.1:19443 / 47773 and
//      rewrites the config's bridgeUrl to the loopback address when
//      the extension is running on the bridge host itself. This is
//      what makes the same zip work both on the Pi5 (loopback) and
//      on a Mac/Windows box (LAN). On a remote host, the probe
//      times out and the original LAN URL is kept.
//   3. createBridgeClient() / createRawBridgeFetch() build the
//      final request functions from the resolved config.
//   4. initCapabilityTokens() asks the resolved bridge target for only
//      the scoped route capabilities the extension needs.
//   5. prefsSync.hydrate() pulls cross-machine preferences — but
//      only AFTER the rebind has settled, so the hydrate uses the
//      loopback-resolved client. (If we hydrate first with the LAN
//      URL on a Pi5 host, the first pull fails until the rebind
//      kicks in a moment later. Visible regression on first launch.)
//
// We deliberately use .then() chains (not top-level await) because
// some Chromium/Edge builds throw "Service worker registration
// failed" if the SW's top-level evaluation awaits a fetch. The
// promise itself still resolves before the SW is considered ready,
// so message handlers that fire during the bootstrap window simply
// retry on the next event.
const prefsSync = createPrefsSync({
  getBridgeRequest: () => bridgeRequest,
});
prefsSync.install();

function rebindAndHydrate({ refreshGenerated = false } = {}) {
  return resolveBridgeConfig({ refreshGenerated })
    .then((cfg) => detectLoopbackBridge(cfg))
    .then((cfg) => {
      bridgeRequest = createBridgeClient(cfg);
      rawFetch = createRawBridgeFetch(cfg);
      return initCapabilityTokens(cfg)
        .catch((error) => {
          // Surface capability-token bootstrap failures so operators get a
          // DevTools breadcrumb. A 500 here — commonly the bridge launcher's
          // mint map missing a requested capability (#200) — otherwise leaves
          // every capability-scoped route silently 403ing with no clue why.
          console.error(
            "[resonantos] capability-token bootstrap failed; capability-scoped bridge routes will be rejected until this is resolved.",
            error,
          );
          return undefined;
        })
        .then(() => ({ cfg, bridgeRequest, rawFetch }));
    })
    .then(({ cfg, bridgeRequest: req, rawFetch: raw }) => {
      // Prefs hydrate is fire-and-forget — the hydration state is
      // visible to the user via the Bridge Target settings card and
      // doesn't need to gate any other startup work.
      void prefsSync.hydrate().catch(() => undefined);
      return { cfg, bridgeRequest: req, rawFetch: raw };
    })
    .catch(() => undefined);
}

void rebindAndHydrate();

async function currentBridgeRequest(route, options = {}) {
  const req = typeof bridgeRequest === "function"
    ? bridgeRequest
    : (await rebindAndHydrate())?.bridgeRequest;
  if (typeof req !== "function") {
    throw new Error("Browser bridge is unavailable.");
  }
  try {
    return await req(route, options);
  } catch (error) {
    if (!isUnauthorizedBridgeError(error)) throw error;
    const rebound = await rebindAndHydrate({ refreshGenerated: true });
    if (typeof rebound?.bridgeRequest !== "function") throw error;
    return rebound.bridgeRequest(route, options);
  }
}

// Re-bind the client if the user changes the bridge target override
// from the settings page. The service worker can be woken by the storage
// change event after a settings update.
chrome?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== "local") return;
  if (!changes?.bridgeTargetOverride) return;
  void rebindAndHydrate();
});

const isMainWorkspaceUrl = (url = "") => {
  try {
    return new URL(url).pathname === MAIN_WORKSPACE_PATH;
  } catch {
    return false;
  }
};

const activeTabForWindow = async (windowId) => {
  const query = windowId === undefined
    ? { active: true, currentWindow: true }
    : { active: true, windowId };
  const [tab] = await chrome.tabs.query(query).catch(() => []);
  return tab ?? null;
};

const setSidePanelEnabledForTab = async (tabId, enabled) => {
  if (typeof chrome.sidePanel?.setOptions !== "function") {
    return;
  }
  if (tabId === undefined) {
    return;
  }
  await chrome.sidePanel.setOptions({ tabId, path: "src/side-panel.html", enabled }).catch(() => undefined);
};

const setSidePanelEnabledForActiveTab = async (windowId, enabled) => {
  const tab = await activeTabForWindow(windowId);
  await setSidePanelEnabledForTab(tab?.id, enabled);
};

const syncSidePanelForTab = async (tab) => {
  if (tab?.id === undefined || typeof tab.url !== "string") {
    return;
  }
  // Intent citation: docs/architecture/ADR-037-browser-first-chromium-resonantos.md
  // Augmentor is the browser-contained ResonantOS side surface. It must stay
  // available on the main workspace and normal webpages; humans hide it by
  // closing the browser side panel and reopen it from the topbar/extension.
  await setSidePanelEnabledForTab(tab.id, true);
};

const syncSidePanelForActiveTab = async (windowId) => {
  await syncSidePanelForTab(await activeTabForWindow(windowId));
};

const openResonantSidePanel = async (windowId, { force = false } = {}) => {
  if (typeof chrome.sidePanel?.open !== "function" || windowId === undefined) {
    return false;
  }
  const tab = await activeTabForWindow(windowId);
  if (tab?.id === undefined) {
    return false;
  }
  await setSidePanelEnabledForTab(tab.id, true);
  await chrome.sidePanel.open({ windowId }).catch(() => undefined);
  return true;
};

const handoffToResonantSidePanel = async ({ senderTab, targetUrl = "" } = {}) => {
  const tab = senderTab?.id === undefined
    ? await activeTabForWindow(senderTab?.windowId)
    : senderTab;
  if (tab?.id === undefined || tab.windowId === undefined) {
    return { ok: false, opened: false, navigated: false, error: "No active tab available for browser-control handoff." };
  }
  // Intent citation: docs/architecture/ADR-037-browser-first-chromium-resonantos.md
  // Browser-control handoff must keep the human on the target webpage while
  // Augmentor moves into the side panel. Enabling/opening the panel before
  // navigation avoids losing the sender page during tab URL changes.
  await setSidePanelEnabledForTab(tab.id, true);
  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  if (targetUrl) {
    await chrome.tabs.update(tab.id, { url: targetUrl }).catch(() => undefined);
  }
  return { ok: true, opened: true, navigated: Boolean(targetUrl), tabId: tab.id };
};

const rememberResonantContextSnapshot = (message, sender) => {
  if (!isTopFrameSender(sender)) {
    return { ok: false, ignored: true, error: "Only top-frame context snapshots can update active-tab context." };
  }
  const tabId = sender.tab?.id ?? null;
  if (tabId === null) {
    return { ok: false, error: "No tab was associated with the context snapshot." };
  }
  const snapshot = sanitizeResonantContextSnapshot(message.payload, {
    tabId,
    title: sender.tab?.title ?? "",
    url: sender.tab?.url ?? "",
  });
  resonantContextSnapshots.set(tabId, snapshot);
  if (resonantContextSnapshots.size > 40) {
    const oldest = resonantContextSnapshots.keys().next().value;
    resonantContextSnapshots.delete(oldest);
  }
  return { ok: true };
};

// Fetch capability tokens from the bridge on service-worker startup.
// Tokens are NOT stored in the generated config; the endpoint requires the
// bridge token plus a separate capability-bootstrap token.
void initCapabilityTokens();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void initCapabilityTokens();
});

chrome.runtime.onStartup.addListener(() => {
  void initCapabilityTokens();
});

chrome.action.onClicked.addListener(async (tab) => {
  await openResonantSidePanel(tab.windowId, { force: true });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-augmentor-side-panel") {
    return;
  }
  chrome.windows.getCurrent((window) => {
    void openResonantSidePanel(window?.id);
  });
});

chrome.tabs.onActivated?.addListener?.((activeInfo) => {
  void syncSidePanelForActiveTab(activeInfo.windowId);
});

chrome.tabs.onUpdated?.addListener?.((_tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    resonantContextSnapshots.delete(tab.id);
  }
  if (changeInfo.url || changeInfo.status === "complete") {
    void syncSidePanelForTab(tab);
  }
});

chrome.tabs.onRemoved?.addListener?.((tabId) => {
  resonantContextSnapshots.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    console.warn("[background] rejected message from unknown sender:", sender.id);
    return;
  }

  if (!message) {
    return false;
  }

  if (message.type === "resonant-context-snapshot") {
    sendResponse(rememberResonantContextSnapshot(message, sender));
    return true;
  }

  if (message.channel !== "resonantos.browser_first") {
    return false;
  }

  if (message.type === "active_tab_context") {
    const pending = sender.tab?.id === undefined
      ? activeTabForWindow(sender.tab?.windowId)
      : Promise.resolve(sender.tab);
    void pending
      .then((tab) => {
        const tabId = tab?.id ?? null;
        sendResponse({
          ok: true,
          tabId,
          title: tab?.title ?? "",
          url: tab?.url ?? "",
          contextSnapshot: tabId === null ? null : resonantContextSnapshots.get(tabId) ?? null,
          receivedAt: new Date().toISOString()
        });
      })
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    return true;
  }

  if (message.type === "inline_assistant_request") {
    void currentBridgeRequest("/augmentor/inline", {
        method: "POST",
        body: sanitizeInlineAssistantBody(message.body)
      })
      .then((payload) => sendResponse({ ok: true, reply: payload.reply ?? "" }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    return true;
  }

  if (message.type === "open_side_panel") {
    const windowId = sender.tab?.windowId;
    if (windowId !== undefined) {
      void openResonantSidePanel(windowId, { force: Boolean(message.force) }).then((opened) => sendResponse({ ok: true, opened }));
      return true;
    }
    chrome.windows.getCurrent((window) => {
      void openResonantSidePanel(window?.id, { force: Boolean(message.force) }).then((opened) => sendResponse({ ok: true, opened }));
    });
    return true;
  }

  if (message.type === "browser_control_handoff") {
    void handoffToResonantSidePanel({
      senderTab: sender.tab,
      targetUrl: typeof message.targetUrl === "string" ? message.targetUrl : ""
    }).then(sendResponse);
    return true;
  }

  if (message.type === "action_request") {
    const action = String(message.action ?? "");
    const approvalRequired = APPROVAL_REQUIRED_ACTIONS.has(action);
    sendResponse({
      ok: !approvalRequired,
      approvalRequired,
      deniedToAutomation: approvalRequired,
      reason: approvalRequired
        ? "Wallet, credential, public-submit, and sensitive actions require explicit human approval."
        : "Safe browser action can be routed through the governed ResonantOS tool bridge."
    });
    return true;
  }

  sendResponse({ ok: false, error: "Unknown ResonantOS browser-first message." });
  return true;
});
