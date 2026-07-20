import { isReadableSubframeTab, rankedReadableBrowserTabs } from "./readable-tab-ranking.js";
import { parseQuotedText } from "./browser-command-parser.js";
import {
  daoAffordances,
  daoControlLines,
  daoFieldLines,
  walletDaoAuditMarkdown
} from "./wallet-dao-audit-markdown.js";
import { normalizeWalletProviderState, walletStateMarkdown } from "./wallet-state.js";

const readOnlyAllowedContentActions = new Set([
  "control_overlay",
  "detect_forms",
  "get_selection",
  "read_page",
  "resonator"
]);

const subframeContentActionTypes = new Set([
  "click_text",
  "detect_forms",
  "get_selection",
  "read_page",
  "scroll_page",
  "type_text"
]);

function safeBrowserUrlForDisplay(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return String(value ?? "").split(/[?#]/)[0].slice(0, 300);
  }
}

function sanitizeBrowserSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const safe = { ...snapshot };
  safe.url = safeBrowserUrlForDisplay(safe.url);
  if (safe.frame && typeof safe.frame === "object") {
    safe.frame = { ...safe.frame, referrer: safeBrowserUrlForDisplay(safe.frame.referrer) };
  }
  if (Array.isArray(safe.iframes)) {
    safe.iframes = safe.iframes.map((frame) => ({ ...frame, src: safeBrowserUrlForDisplay(frame?.src) }));
  }
  if (Array.isArray(safe.links)) {
    safe.links = safe.links.map((link) => ({ ...link, href: safeBrowserUrlForDisplay(link?.href) }));
  }
  if (Array.isArray(safe.forms)) {
    safe.forms = safe.forms.map((form) => ({ ...form, action: safeBrowserUrlForDisplay(form?.action) }));
  }
  if (Array.isArray(safe.controls)) {
    safe.controls = safe.controls.map((control) => ({
      ...control,
      form: control?.form ? { ...control.form, action: safeBrowserUrlForDisplay(control.form.action) } : control?.form
    }));
  }
  if (Array.isArray(safe.fields)) {
    safe.fields = safe.fields.map((field) => ({
      ...field,
      form: field?.form ? { ...field.form, action: safeBrowserUrlForDisplay(field.form.action) } : field?.form
    }));
  }
  if (Array.isArray(safe.frames)) {
    safe.frames = safe.frames.map((frame) => ({ ...frame, url: safeBrowserUrlForDisplay(frame?.url) }));
  }
  return safe;
}

function parseResonatorTarget(body) {
  const raw = String(body ?? "").trim();
  const quoted = parseQuotedText(raw);
  if (quoted) {
    return { text: quoted };
  }
  if (!raw) return null;
  const [first, ...rest] = raw.split(/\s+/);
  const selectorLike = /^(#|\.|\[|[a-z][\w-]*(?:[#.[>~:]|$))/i.test(first);
  if (selectorLike) {
    return { selector: first, label: rest.join(" ").trim() };
  }
  return { text: raw };
}

function parseResonatorCommandPayload(action, body) {
  if (action === "clear") return {};
  if (action === "step") {
    const steps = String(body ?? "")
      .split(";")
      .map((part) => parseResonatorTarget(part))
      .filter(Boolean)
      .map((step, index) => ({ ...step, label: step.label || step.text || `Step ${index + 1}` }));
    return steps.length ? { steps } : null;
  }
  return parseResonatorTarget(body);
}

export function createBrowserPageActions(deps) {
  const {
    addMessage,
    bridgeRequest,
    // Optional getter for the late-bound bridge client. The rebind
    // chain sets the module-level `bridgeRequest` *after* this
    // controller is constructed, so passing a value here captures a
    // stale `null`. When a getter is provided, it wins.
    getBridgeRequest,
    chrome,
    getModel = () => "MiniMax-M3",
    getThinkingDepth = () => "minimal",
    isReadableBrowserTab,
    normalizeBrowserUrl,
    permissionForUrl,
    renderSitePermissionPanel,
    setActivity,
    setContextMeter,
    setControlledTabId,
    getLastSnapshot = () => null,
    setLastSnapshot,
    setStatus,
    siteKeyForUrl,
    sleep
  } = deps;
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);

  const reviewQueueGuidance = "Next: open Living Archive > Review Queue to inspect, draft, verify, and promote it if it should become trusted AI Memory.";

  async function activeTab() {
    const controlledTabId = deps.getControlledTabId();
    if (controlledTabId) {
      const controlled = await chrome.tabs.get(controlledTabId).catch(() => null);
      if (isReadableBrowserTab(controlled)) {
        if (!chrome.webNavigation?.getAllFrames) {
          return controlled;
        }
        const tabs = await chrome.tabs.query({ currentWindow: true }).catch(() => []);
        if (!await isReadableSubframeTab(chrome, controlled, tabs, isReadableBrowserTab)) {
          return controlled;
        }
      }
      setControlledTabId(null);
    }
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const readableTabs = await rankedReadableBrowserTabs(chrome, tabs, isReadableBrowserTab);
    if (readableTabs.length) {
      const tab = readableTabs.at(0);
      setControlledTabId(tab.id);
      return tab;
    }
    const allTabs = await chrome.tabs.query({});
    const fallback = (await rankedReadableBrowserTabs(chrome, allTabs, isReadableBrowserTab)).at(0) ??
      tabs.find((tab) => tab.active);
    if (isReadableBrowserTab(fallback)) {
      setControlledTabId(fallback.id);
    }
    return fallback;
  }

  async function openBrowserUrl(target) {
    const url = normalizeBrowserUrl(target);
    const targetTab = await activeTab();
    setActivity("tool-running", "Navigating browser", url);
    setStatus("Navigating");
    if (targetTab?.id && isReadableBrowserTab(targetTab)) {
      await chrome.tabs.update(targetTab.id, { url, active: true });
      setControlledTabId(targetTab.id);
    } else {
      const tab = await chrome.tabs.create({ url, active: true });
      setControlledTabId(tab.id);
    }
    setLastSnapshot(null);
    setContextMeter(null);
    await addMessage("system", `Opened ${url}`);
    setStatus("Ready");
    return { ok: true, action: "open", url };
  }

  async function searchBrowser({ query, action }) {
    const url = action === "news"
      ? `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&setlang=en-US`
      : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    setActivity("tool-running", action === "news" ? "Searching news" : "Searching web", query);
    setStatus(action === "news" ? "Searching news" : "Searching web");
    const targetTab = await activeTab();
    if (targetTab?.id && isReadableBrowserTab(targetTab)) {
      await chrome.tabs.update(targetTab.id, { url, active: true });
      setControlledTabId(targetTab.id);
    } else {
      const tab = await chrome.tabs.create({ url, active: true });
      setControlledTabId(tab.id);
    }
    setLastSnapshot(null);
    setContextMeter(null);
    if (action === "news") {
      const news = await bridge()("/web/news", {
        method: "POST",
        body: { query, limit: 5 }
      }).catch((error) => ({ error: error instanceof Error ? error.message : String(error), items: [] }));
      const headlines = news.items?.length
        ? `\n\nTop headlines:\n${news.items.map((item, index) => `${index + 1}. ${item.title}${item.source ? ` — ${item.source}` : ""}`).join("\n")}`
        : `\n\nI opened the news search, but headline extraction failed${news.error ? `: ${news.error}` : "."}`;
      await addMessage("system", `Opened news search for "${query}".${headlines}`);
    } else {
      await addMessage("system", `Opened web search for "${query}".`);
    }
    setActivity("completed", action === "news" ? "News search opened" : "Web search opened", query);
    setStatus("Ready");
    return { ok: true, action, query, url };
  }

  function mergeFrameSnapshots(responses) {
    const snapshots = responses
      .filter((response) => response?.ok && response.snapshot)
      .map((response) => sanitizeBrowserSnapshot(response.snapshot));
    if (!snapshots.length) {
      return null;
    }
    const topSnapshot = snapshots.find((snapshot) => snapshot.frame?.isTop) ?? snapshots[0];
    return {
      ...topSnapshot,
      text: snapshots.map((snapshot) => snapshot.text).filter(Boolean).join("\n\n--- frame ---\n\n").slice(0, 24000),
      links: snapshots.flatMap((snapshot) => snapshot.links ?? []).slice(0, 140),
      controls: snapshots.flatMap((snapshot) => snapshot.controls ?? []).slice(0, 140),
      fields: snapshots.flatMap((snapshot) => snapshot.fields ?? []).slice(0, 140),
      frames: snapshots.map((snapshot) => ({
        title: snapshot.title,
        url: snapshot.url,
        isTop: Boolean(snapshot.frame?.isTop),
        words: String(snapshot.text ?? "").split(/\s+/).filter(Boolean).length,
        controls: snapshot.controls?.length ?? 0,
        fields: snapshot.fields?.length ?? 0
      }))
    };
  }

  async function sendContentActionToFrames(tabId, message) {
    const frames = await chrome.webNavigation?.getAllFrames?.({ tabId }).catch(() => null);
    const frameIds = subframeContentActionTypes.has(message.type) && Array.isArray(frames) && frames.length
      ? frames.map((frame) => frame.frameId)
      : [0];
    const responses = [];
    for (const frameId of frameIds) {
      const response = await chrome.tabs.sendMessage(tabId, message, { frameId }).catch((error) => ({
        ok: false,
        frameId,
        error: String(error)
      }));
      responses.push({ ...response, frameId });
    }
    if (message.type === "read_page") {
      const snapshot = mergeFrameSnapshots(responses);
      return snapshot ? { ok: true, snapshot, frameResponses: responses.length } : { ok: false, error: "No readable frame returned page context." };
    }
    const success = responses.find((response) => response?.ok);
    if (success) return success;
    const approval = responses.find((response) => response?.approvalRequired);
    if (approval) return approval;
    return responses.find((response) => response?.error) ?? { ok: false, error: "No frame handled this browser action." };
  }

  async function readSpecificTabPage(tab, { includeBlocked = false } = {}) {
    if (!tab?.id || !isReadableBrowserTab(tab)) {
      return { ok: false, tab, error: "Tab is not a readable web page." };
    }
    const siteMode = await permissionForUrl(tab.url);
    if (siteMode === "blocked" && !includeBlocked) {
      return { ok: false, tab, error: `Assistant is blocked on ${siteKeyForUrl(tab.url)}.` };
    }
    const response = await sendContentActionToFrames(tab.id, {
      channel: "resonantos.browser_first.content",
      type: "read_page"
    });
    return response?.ok
      ? { ok: true, tab, snapshot: response.snapshot }
      : { ok: false, tab, error: response?.error ?? "No readable page context returned." };
  }

  async function sendContentAction(payload) {
    const tab = await activeTab();
    if (!tab?.id || !isReadableBrowserTab(tab)) {
      return { ok: false, error: "No normal web page is active for this browser action." };
    }
    const siteMode = await permissionForUrl(tab.url);
    if (siteMode === "blocked") {
      return { ok: false, error: `Assistant is blocked on ${siteKeyForUrl(tab.url)}.` };
    }
    if (siteMode === "read-only" && !readOnlyAllowedContentActions.has(payload.type)) {
      return { ok: false, error: `Assistant actions are read-only on ${siteKeyForUrl(tab.url)}.` };
    }
    const message = {
      channel: "resonantos.browser_first.content",
      ...payload
    };
    const firstAttempt = await sendContentActionToFrames(tab.id, message);
    const shouldInjectContentScript = !firstAttempt?.ok &&
      /receiving end|connection|No readable frame returned page context/i.test(firstAttempt?.error ?? "");
    if (firstAttempt?.ok || !shouldInjectContentScript) {
      return firstAttempt;
    }
    if (chrome.scripting?.executeScript) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          "src/lib/resonant-context.js",
          "src/lib/context-plugins.js",
          "src/lib/resonator.js",
          "src/lib/control-overlay.js",
          "src/lib/content-field-safety.js",
          "src/lib/content-inline-actions.js",
          "src/lib/content-control-refs.js",
          "src/content.js"
        ]
      }).catch(() => undefined);
    } else {
      await chrome.tabs.reload(tab.id);
      await sleep(1200);
    }
    return sendContentActionToFrames(tab.id, message);
  }

  function sameContextTab(snapshot, tab) {
    if (!snapshot || !tab?.id) return false;
    const snapshotTabId = Number(snapshot.tabId ?? snapshot.tab?.id);
    if (Number.isFinite(snapshotTabId) && snapshotTabId !== tab.id) return false;
    if (Number.isFinite(snapshotTabId)) return true;
    return Boolean(snapshot.url && tab.url && snapshot.url === tab.url);
  }

  async function hydrateCachedTabSnapshot(tab) {
    if (!tab?.id) {
      setLastSnapshot(null);
      setContextMeter(null);
      return null;
    }
    const currentSnapshot = getLastSnapshot();
    if (sameContextTab(currentSnapshot, tab)) {
      setContextMeter(currentSnapshot);
      return currentSnapshot;
    }
    const response = await chrome.runtime?.sendMessage?.({
      channel: "resonantos.browser_first",
      type: "active_tab_context",
      tabId: tab.id
    }).catch(() => null);
    const snapshot = response?.snapshot ?? null;
    if (sameContextTab(snapshot, tab)) {
      setLastSnapshot(snapshot);
      setContextMeter(snapshot);
      return snapshot;
    }
    setLastSnapshot(null);
    setContextMeter(null);
    return null;
  }

  const setPageControlOverlay = async (active, label = "", phase = "") => sendContentAction({
    type: "control_overlay",
    active,
    label: label || (active ? "Augmentor is operating this page" : ""),
    phase
  });

  async function runResonatorCommand(action, body = "") {
    const normalizedAction = String(action ?? "").toLowerCase();
    const allowedActions = new Set(["arrow", "clear", "highlight", "spotlight", "step"]);
    if (!allowedActions.has(normalizedAction)) {
      await addMessage("system", `Unknown Resonator command: ${normalizedAction || "empty"}.`);
      return { ok: false, error: "Unknown Resonator command." };
    }
    const payload = parseResonatorCommandPayload(normalizedAction, body);
    if (payload === null) {
      await addMessage("system", `Resonator ${normalizedAction} needs a selector or quoted visible text target.`);
      setStatus("Resonator target needed");
      setActivity("failed", "Resonator target needed", normalizedAction);
      return { ok: false, error: "Resonator target required." };
    }
    setActivity("browser-control", `Showing Resonator ${normalizedAction}`, String(body || normalizedAction).slice(0, 160));
    setStatus("Guiding page");
    const response = await sendContentAction({
      type: "resonator",
      action: normalizedAction,
      payload
    });
    if (response?.ok) {
      await addMessage("system", `Resonator ${normalizedAction} displayed on the active page.`);
      setStatus("Ready");
      setActivity("completed", `Resonator ${normalizedAction} displayed`, normalizedAction);
      return response;
    }
    await addMessage("system", `Resonator ${normalizedAction} failed: ${response?.error ?? "unknown error"}`);
    setStatus("Resonator failed");
    setActivity("failed", `Resonator ${normalizedAction} failed`, response?.error ?? "unknown error");
    return response;
  }

  async function typeIntoActivePage({ text, field = "", ref = "", submit, userApproved = false }) {
    setActivity("tool-running", "Typing into page", text);
    setStatus("Typing");
    const response = await sendContentAction({ type: "type_text", text, field, ref, submit, userApproved });
    if (response?.ok) {
      await addMessage(
        "system",
        `Typed into the active page${response.submitted ? " and submitted it" : ""}: "${response.typedText}"`
      );
      setStatus("Ready");
      setActivity("completed", "Typed into page", response.fieldName || response.tagName || "active field");
      return response;
    }
    await addMessage("system", `I could not type into the page: ${response?.error ?? "unknown error"}`);
    setStatus("Page action failed");
    setActivity("failed", "Typing failed", response?.error ?? "unknown error");
    return response;
  }

  async function clickActivePageText({ text, ref = "", userApproved = false }) {
    setActivity("tool-running", "Clicking page element", text || ref);
    setStatus("Clicking");
    const response = await sendContentAction({ type: "click_text", text, ref, userApproved });
    if (response?.ok) {
      await addMessage("system", `Clicked "${response.clickedText || text || ref}" on the active page.`);
      setStatus("Ready");
      setActivity("completed", "Clicked page element", response.clickedText || text || ref);
      return response;
    }
    await addMessage("system", `I could not click "${text || ref}": ${response?.error ?? "unknown error"}`);
    setStatus("Page action failed");
    setActivity("failed", "Click failed", response?.error ?? "unknown error");
    return response;
  }

  async function scrollActivePage({ direction = "down", amount = 720 } = {}) {
    setActivity("tool-running", "Scrolling page", direction);
    setStatus("Scrolling");
    const response = await sendContentAction({ type: "scroll_page", direction, amount });
    if (response?.ok) {
      await addMessage("system", `Scrolled ${response.direction}. Position: ${response.scrollY}/${response.maxScrollY}.`);
      setStatus("Ready");
      setActivity("completed", "Scrolled page", response.direction);
      return response;
    }
    await addMessage("system", `I could not scroll the page: ${response?.error ?? "unknown error"}`);
    setStatus("Page action failed");
    setActivity("failed", "Scroll failed", response?.error ?? "unknown error");
    return response;
  }

  async function detectActivePageForms() {
    setActivity("retrieving", "Inspecting page forms", "Looking for editable fields and forms");
    setStatus("Inspecting forms");
    const response = await sendContentAction({ type: "detect_forms" });
    if (!response?.ok) {
      await addMessage("system", `I could not inspect forms: ${response?.error ?? "unknown error"}`);
      setStatus("Page action failed");
      setActivity("failed", "Form inspection failed", response?.error ?? "unknown error");
      return response;
    }
    const formLines = (response.forms ?? []).map((form) => {
      const fields = (form.fields ?? []).map((field) => field.label || field.name || field.id || field.type || field.tagName).filter(Boolean).join(", ");
      return `- form ${form.index}${form.id ? ` #${form.id}` : ""}: ${fields || "no labelled fields"}`;
    });
    const looseLines = (response.looseFields ?? []).map((field) => `- ${field.label || field.name || field.id || field.type || field.tagName}`);
    await addMessage(
      "system",
      [
        `Detected ${(response.forms ?? []).length} form(s) and ${(response.looseFields ?? []).length} loose editable field(s).`,
        formLines.length ? "\nForms:\n" + formLines.join("\n") : "",
        looseLines.length ? "\nLoose fields:\n" + looseLines.slice(0, 12).join("\n") : "",
        "\nPublic submit, wallet, payment, login, and credential actions remain human-approval gated."
      ].filter(Boolean).join("\n")
    );
    setStatus("Ready");
    setActivity("completed", "Inspected page forms", `${(response.forms ?? []).length} forms`);
    return response;
  }

  async function refreshTabContext() {
    setStatus("Reading");
    const tab = await activeTab();
    const label = tab?.title || safeBrowserUrlForDisplay(tab?.url) || "No page context";
    deps.setReadButtonTitle(`Attach/read current page: ${label}`);
    await renderSitePermissionPanel(tab);
    await hydrateCachedTabSnapshot(tab);
    setStatus("Ready");
    return tab;
  }

  async function readActivePage({ announce = true } = {}) {
    const tab = await refreshTabContext();
    if (!tab?.id || !isReadableBrowserTab(tab)) {
      if (announce) {
        await addMessage("system", "I cannot read this tab yet. Open a normal web page and try again.");
      }
      return null;
    }

    setActivity("reading", "Reading browser page", tab.title || safeBrowserUrlForDisplay(tab.url));
    setStatus("Reading page");
    const rawResponse = await sendContentAction({
      channel: "resonantos.browser_first.content",
      type: "read_page"
    });
    const response = rawResponse?.ok
      ? { ...rawResponse, snapshot: sanitizeBrowserSnapshot(rawResponse.snapshot) }
      : rawResponse;

    setLastSnapshot(response?.snapshot ?? null);
    setContextMeter(response?.snapshot ?? null);
    setStatus(response?.ok ? "Ready" : "Read failed");
    if (announce) {
      await addMessage(
        "system",
        response?.ok
          ? `Page context attached: ${response.snapshot.title || "Untitled"}\n${response.snapshot.url}`
          : `I could not read the page: ${response?.error ?? "unknown error"}`
      );
    }
    return response;
  }

  async function detectWalletState({ announce = true } = {}) {
    const tab = await activeTab();
    if (!tab?.id || !isReadableBrowserTab(tab)) {
      const error = "No normal web page is active for wallet detection.";
      if (announce) await addMessage("system", error);
      return { ok: false, error };
    }
    const siteMode = await permissionForUrl(tab.url);
    if (siteMode === "blocked") {
      const error = `Assistant is blocked on ${siteKeyForUrl(tab.url)}.`;
      if (announce) await addMessage("system", error);
      return { ok: false, error };
    }
    setActivity("retrieving", "Checking wallet provider", tab.title || tab.url);
    setStatus("Checking wallet");
    const probeResults = await (chrome.scripting?.executeScript?.({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const preview = (value) => {
          const text = String(value ?? "");
          return text.length > 12 ? `${text.slice(0, 4)}...${text.slice(-4)}` : text;
        };
        const solana = globalThis.phantom?.solana || globalThis.solana || null;
        const ethereum = globalThis.phantom?.ethereum || (globalThis.ethereum?.isPhantom ? globalThis.ethereum : null);
        return {
          phantomEthereum: {
            detected: Boolean(ethereum),
            isConnected: Boolean(ethereum?.isConnected?.()),
            isPhantom: Boolean(ethereum?.isPhantom),
            publicKeyPreview: preview(Array.isArray(ethereum?.selectedAddress) ? ethereum.selectedAddress[0] : ethereum?.selectedAddress)
          },
          phantomSolana: {
            detected: Boolean(solana),
            isConnected: Boolean(solana?.isConnected),
            isPhantom: Boolean(solana?.isPhantom),
            publicKeyPreview: preview(solana?.publicKey?.toString?.())
          },
          source: "main-world-probe"
        };
      }
    }).catch(() => []) ?? Promise.resolve([]));
    const [probe] = probeResults;
    let state = normalizeWalletProviderState(probe?.result ?? {}, tab);
    if (!probe?.result) {
      const response = await sendContentAction({
        channel: "resonantos.browser_first.content",
        type: "read_page"
      });
      state = normalizeWalletProviderState({
        phantomSolana: {
          detected: Boolean(response?.snapshot?.walletProviders?.phantomSolana),
          isPhantom: Boolean(response?.snapshot?.walletProviders?.phantomSolana)
        },
        source: "isolated-content-fallback"
      }, tab);
    }
    setStatus("Ready");
    setActivity("completed", "Wallet provider checked", state.detected ? "provider detected" : "none detected");
    if (announce) {
      await addMessage("system", walletStateMarkdown(state));
    }
    return { ok: true, state };
  }

  async function summarizeSnapshot() {
    const response = deps.getLastSnapshot() ? { ok: true, snapshot: deps.getLastSnapshot() } : await readActivePage({ announce: false });
    const snapshot = response?.snapshot;
    if (!snapshot) {
      await addMessage("system", "I cannot read this page yet. Open a normal web page, then ask me again.");
      return;
    }

    const text = snapshot.text || "";
    setActivity("reading", "Summarising page context", snapshot.title || snapshot.url);
    const words = text.split(/\s+/).filter(Boolean);
    const excerpt = words.slice(0, 80).join(" ");
    await addMessage(
      "system",
      [
        `I can read this page: **${snapshot.title || "Untitled"}**`,
        "",
        excerpt ? `What is visible now: ${excerpt}${words.length > 80 ? "..." : ""}` : "There is very little readable text visible on the page.",
        "",
        "If you want me to act on it, use a direct instruction like: `/control click \"Add to cart\"` or `/control find the next available booking slot`."
      ].join("\n")
    );
    return { ok: true, snapshot };
  }

  async function prepareDaoWorkflowGuidance(goal = "") {
    const cachedSnapshotBeforeRead = deps.getLastSnapshot();
    const response = await readActivePage({ announce: false }).catch(() => null) ??
      (cachedSnapshotBeforeRead ? { ok: true, snapshot: cachedSnapshotBeforeRead } : null);
    let snapshot = response?.snapshot;
    if (!snapshot) {
      await addMessage("system", "I cannot prepare a DAO workflow yet. Open the DAO page first, then run `/dao <what you want to do>`.");
      return { ok: false, error: "No readable DAO page context available." };
    }
    let { fields, visibleControls } = daoAffordances(snapshot, { controlLimit: 12, fieldLimit: 8 });
    if (!fields.length && !visibleControls.length) {
      const cachedSnapshot = cachedSnapshotBeforeRead;
      const cachedAffordances = daoAffordances(cachedSnapshot, { controlLimit: 12, fieldLimit: 8 });
      if (cachedAffordances.fields.length || cachedAffordances.visibleControls.length) {
        snapshot = cachedSnapshot;
        fields = cachedAffordances.fields;
        visibleControls = cachedAffordances.visibleControls;
      }
    }
    if (!fields.length && !visibleControls.length) {
      const tabs = await chrome.tabs.query({ currentWindow: true }).catch(() => []);
      for (const tab of tabs.filter(isReadableBrowserTab)) {
        if (tab.id === response?.tab?.id) continue;
        const candidate = await readSpecificTabPage(tab, { includeBlocked: true }).catch(() => null);
        const candidateSnapshot = candidate?.snapshot;
        if (!candidateSnapshot) continue;
        const candidateAffordances = daoAffordances(candidateSnapshot, { controlLimit: 12, fieldLimit: 8 });
        if (candidateAffordances.fields.length || candidateAffordances.visibleControls.length) {
          snapshot = candidateSnapshot;
          fields = candidateAffordances.fields;
          visibleControls = candidateAffordances.visibleControls;
          setLastSnapshot(snapshot);
          break;
        }
      }
    }
    await addMessage(
      "system",
      [
        "DAO workflow helper",
        goal ? `Goal: ${goal}` : "Goal: inspect this DAO page safely.",
        "",
        `Page: ${snapshot.title || "Untitled"}`,
        snapshot.url || "",
        "",
        "Visible wallet/governance controls:",
        ...daoControlLines(visibleControls),
        "",
        "Relevant fields:",
        ...daoFieldLines(fields),
        "",
        "Safe sequence:",
        "1. Read the page/proposal details and verify the domain.",
        "2. Use `/wallet status` to check whether Phantom is present before any wallet step.",
        "3. Let Augmentor prepare instructions, compare visible values, and identify risk points.",
        "4. Human completes wallet connect, signature, vote, transaction, or public submission manually.",
        "",
        "Risk checklist:",
        "- Confirm the domain, proposal id/title, voting choice, quorum/threshold, treasury or token amounts, and transaction destination before acting.",
        "- Treat Execute, Queue, Sign, Confirm, Vote, Transfer, Claim, Stake, Unstake, and Submit as human-only controls.",
        "",
        "Stop rule: ResonantOS will not click wallet connect, sign, vote, submit, transfer, or transaction confirmation controls for you."
      ].join("\n")
    );
    return { ok: true, controls: visibleControls.length, fields: fields.length, snapshot };
  }

  async function saveWalletDaoAuditToArchive(goal = "") {
    const response = deps.getLastSnapshot() ? { ok: true, snapshot: deps.getLastSnapshot() } : await readActivePage({ announce: false });
    const snapshot = response?.snapshot;
    if (!snapshot) {
      await addMessage("system", "There is no readable page for a wallet/DAO audit. Open the DAO or dApp page first, then run `/wallet audit` or `/dao audit <goal>`.");
      setStatus("Wallet audit unavailable");
      return { ok: false, error: "No browser page context available." };
    }
    setActivity("retrieving", "Saving wallet/DAO audit", snapshot.title || snapshot.url);
    setStatus("Saving wallet audit");
    const walletResult = await detectWalletState({ announce: false });
    if (!walletResult?.ok) {
      await addMessage("system", `Wallet/DAO audit failed before save: ${walletResult?.error ?? "wallet detection unavailable"}`);
      setStatus("Wallet audit unavailable");
      return { ok: false, error: walletResult?.error ?? "Wallet detection unavailable." };
    }
    const { fields, visibleControls } = daoAffordances(snapshot);
    const result = await bridge()("/archive/intake", {
      method: "POST",
      body: {
        title: `Wallet / DAO Audit: ${snapshot.title || snapshot.url || "Active page"}`,
        url: snapshot.url,
        origin: "browser-wallet-dao-audit",
        content: walletDaoAuditMarkdown({ goal, snapshot, walletState: walletResult.state }),
        metadata: {
          controls: visibleControls.length,
          fields: fields.length,
          goal: String(goal ?? ""),
          walletDetected: Boolean(walletResult.state?.detected),
          walletProviders: Object.entries(walletResult.state?.providers ?? {})
            .filter(([, provider]) => provider?.detected)
            .map(([name]) => name)
        }
      }
    });
    const review = await bridge()("/archive/review/request", {
      method: "POST",
      body: {
        path: result.path,
        reason: "Review this wallet/DAO browser evidence for domain safety, visible governance values, wallet provider state, and human-only action boundaries before any Living Archive wiki update."
      }
    });
    await addMessage(
      "system",
      "Saved a wallet/DAO audit to Living Archive intake and queued it for review.\n\nThis is read-only evidence. Wallet connect, signing, voting, transfer, transaction confirmation, and public submission remain human-only."
    );
    setStatus("Wallet audit saved");
    setActivity("completed", "Saved wallet/DAO audit", result.path);
    return { ok: true, ...result, reviewRequestPath: review.path, controls: visibleControls.length, fields: fields.length };
  }

  function pageIntakeMarkdown(snapshot) {
    const text = String(snapshot.text ?? "").trim();
    const links = (snapshot.links ?? [])
      .slice(0, 24)
      .map((link) => `- [${link.text || link.href}](${link.href})`)
      .join("\n");
    return [
      `Captured from: ${snapshot.url}`,
      "",
      "## Page Context",
      `- title: ${snapshot.title || "Untitled"}`,
      `- url: ${snapshot.url}`,
      `- links captured: ${snapshot.links?.length ?? 0}`,
      `- controls captured: ${snapshot.controls?.length ?? 0}`,
      `- fields captured: ${snapshot.fields?.length ?? 0}`,
      "",
      "## Visible Text",
      text || "_No visible text captured._",
      "",
      links ? "## Links\n" + links : "",
    ].filter(Boolean).join("\n");
  }

  function deterministicPageSummary(snapshot) {
    const text = String(snapshot.text ?? "").replace(/\s+/g, " ").trim();
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 6);
    return sentences.length
      ? sentences.join(" ")
      : text.split(/\s+/).filter(Boolean).slice(0, 120).join(" ");
  }

  function pageSummaryIntakeMarkdown(snapshot, summary, { model = "", fallback = false } = {}) {
    const text = String(snapshot.text ?? "").trim();
    const links = (snapshot.links ?? [])
      .slice(0, 16)
      .map((link) => `- [${link.text || link.href}](${link.href})`)
      .join("\n");
    return [
      `Captured from: ${snapshot.url}`,
      "",
      "## AI Summary",
      summary || "_No summary was generated._",
      "",
      "## Provenance",
      `- title: ${snapshot.title || "Untitled"}`,
      `- url: ${snapshot.url}`,
      `- model: ${model || "deterministic-fallback"}`,
      `- fallback summary: ${fallback ? "yes" : "no"}`,
      `- visible words captured: ${text.split(/\s+/).filter(Boolean).length}`,
      "",
      links ? "## Source Links\n" + links : "",
      "",
      "## Source Excerpt",
      text.slice(0, 12000) || "_No visible text captured._"
    ].filter(Boolean).join("\n");
  }

  function researchTrailIntakeMarkdown({ title, snapshots, skipped }) {
    const collectedAt = new Date().toISOString();
    const pages = snapshots.map((snapshot, index) => {
      const text = String(snapshot.text ?? "").trim();
      const links = (snapshot.links ?? [])
        .slice(0, 8)
        .map((link) => `  - [${link.text || link.href}](${link.href})`)
        .join("\n");
      return [
        `## Page ${index + 1}: ${snapshot.title || "Untitled"}`,
        "",
        `- url: ${snapshot.url}`,
        `- visible words: ${text.split(/\s+/).filter(Boolean).length}`,
        `- controls captured: ${snapshot.controls?.length ?? 0}`,
        `- fields captured: ${snapshot.fields?.length ?? 0}`,
        "",
        "### Visible Text",
        text.slice(0, 6000) || "_No visible text captured._",
        "",
        links ? "### Source Links\n" + links : ""
      ].filter(Boolean).join("\n");
    });
    const skippedLines = skipped.length
      ? [
        "## Skipped Tabs",
        "",
        ...skipped.map((item) => `- ${item.tab?.title || item.tab?.url || "unknown"}: ${item.error}`)
      ]
      : [];
    return [
      `# Research Trail: ${title}`,
      "",
      `- collectedAt: ${collectedAt}`,
      `- pages captured: ${snapshots.length}`,
      `- tabs skipped: ${skipped.length}`,
      "",
      "This is a browser research trail intake bundle. It remains source material until the Living Archive review, verification, and promotion pipeline accepts it as trusted AI Memory.",
      "",
      ...pages,
      "",
      ...skippedLines
    ].join("\n").trim();
  }

  async function summarizeCurrentPageToArchive() {
    const response = deps.getLastSnapshot() ? { ok: true, snapshot: deps.getLastSnapshot() } : await readActivePage({ announce: false });
    const snapshot = response?.snapshot;
    if (!snapshot) {
      await addMessage("system", "There is no browser page context to summarize. Open a normal web page and read it first.");
      setStatus("Summary unavailable");
      return { ok: false, error: "No browser page context available." };
    }
    setActivity("thinking", "Summarising page for Living Archive intake", snapshot.title || snapshot.url);
    setStatus("Summarising page");
    let summary = "";
    let model = "";
    let fallback = false;
    try {
      const result = await bridge()("/augmentor/chat", {
        method: "POST",
        body: {
          model: getModel(),
          surface: "archive-intake",
          thinkingDepth: getThinkingDepth(),
          pageContext: pageIntakeMarkdown(snapshot).slice(0, 12000),
          runtimeContext: "Create a source-grounded Living Archive intake summary. Do not claim trusted wiki promotion. Preserve uncertainty and cite visible source facts only.",
          messages: [{
            role: "user",
            content: [
              "Summarize this browser page for Living Archive intake.",
              "Return concise markdown with:",
              "- What this page is",
              "- Key facts visible in the page",
              "- Why it may matter",
              "- Questions or uncertainties for review",
              "- Suggested wiki entities/concepts to consider"
            ].join("\n")
          }]
        }
      });
      summary = String(result.reply ?? "").trim();
      model = result.model || getModel();
    } catch (error) {
      fallback = true;
      model = "deterministic-fallback";
      summary = [
        "Provider summary failed, so ResonantOS created a deterministic source excerpt for review.",
        "",
        deterministicPageSummary(snapshot) || "No readable text was available for deterministic summarisation.",
        "",
        `Provider error: ${error instanceof Error ? error.message : String(error)}`
      ].join("\n");
    }
    const result = await bridge()("/archive/intake", {
      method: "POST",
      body: {
        title: `Summary: ${snapshot.title || snapshot.url || "Untitled"}`,
        url: snapshot.url,
        origin: "browser-page-summary",
        content: pageSummaryIntakeMarkdown(snapshot, summary, { model, fallback })
      }
    });
    const review = await bridge()("/archive/review/request", {
      method: "POST",
      body: {
        path: result.path,
        reason: "Verify this browser page summary against the source excerpt before any Living Archive wiki update is proposed."
      }
    });
    await addMessage(
      "system",
      `Summarized this page into Living Archive intake and queued it for review.\n\nThis is a review artifact, not trusted AI Memory yet.\n\n${reviewQueueGuidance}`
    );
    setStatus("Page summary saved");
    setActivity("completed", "Saved page summary intake", result.path);
    return { ok: true, ...result, reviewRequestPath: review.path, fallback };
  }

  async function saveResearchTrailToArchive(rawTitle = "") {
    const title = String(rawTitle ?? "").replace(/^(trail|research|research trail)\b/i, "").trim() || "Browser research trail";
    setActivity("retrieving", "Collecting browser research trail", title);
    setStatus("Collecting trail");
    const tabs = (await chrome.tabs.query({ currentWindow: true }).catch(() => []))
      .filter(isReadableBrowserTab)
      .slice(0, 8);
    if (!tabs.length) {
      await addMessage("system", "No readable browser tabs are available for a research trail. Open one or more normal web pages first.");
      setStatus("Trail unavailable");
      setActivity("failed", "No readable tabs", "Research trail");
      return { ok: false, error: "No readable browser tabs available." };
    }
    const reads = [];
    for (const tab of tabs) {
      reads.push(await readSpecificTabPage(tab));
    }
    const snapshots = reads.filter((item) => item.ok && item.snapshot).map((item) => item.snapshot);
    const skipped = reads.filter((item) => !item.ok);
    if (!snapshots.length) {
      await addMessage("system", "I could not read any open web tabs for the research trail. Check site permissions or open readable pages.");
      setStatus("Trail unavailable");
      setActivity("failed", "No readable tab content", "Research trail");
      return { ok: false, error: "No readable tab content available.", skipped };
    }
    const result = await bridge()("/archive/intake", {
      method: "POST",
      body: {
        title: `Research Trail: ${title}`,
        url: snapshots[0]?.url ?? null,
        origin: "browser-research-trail",
        content: researchTrailIntakeMarkdown({ title, snapshots, skipped })
      }
    });
    const review = await bridge()("/archive/review/request", {
      method: "POST",
      body: {
        path: result.path,
        reason: "Evaluate this multi-page browser research trail for Living Archive ingestion, source provenance, entity extraction, contradictions, and durable wiki synthesis."
      }
    });
    await addMessage(
      "system",
      `Saved a ${snapshots.length}-page browser research trail to Living Archive intake and queued it for review.\n\nIt remains raw source material until review, verification, and promotion accept it.\n\n${reviewQueueGuidance}`
    );
    setStatus("Research trail saved");
    setActivity("completed", "Saved research trail intake", result.path);
    return { ok: true, ...result, reviewRequestPath: review.path, pages: snapshots.length, skipped: skipped.length };
  }

  async function saveCurrentPageToArchive() {
    const response = deps.getLastSnapshot() ? { ok: true, snapshot: deps.getLastSnapshot() } : await readActivePage({ announce: false });
    const snapshot = response?.snapshot;
    if (!snapshot) {
      await addMessage("system", "There is no browser page context to save yet. Open a normal web page and read it first.");
      setStatus("Intake unavailable");
      return { ok: false, error: "No browser page context available." };
    }
    setActivity("tool-running", "Saving page to Living Archive intake", snapshot.title || snapshot.url);
    const result = await bridge()("/archive/intake", {
      method: "POST",
      body: {
        title: `Page: ${snapshot.title || snapshot.url || "Untitled"}`,
        url: snapshot.url,
        origin: "browser-current-page",
        content: pageIntakeMarkdown(snapshot)
      }
    });
    const review = await bridge()("/archive/review/request", {
      method: "POST",
      body: {
        path: result.path,
        reason: "Evaluate this saved browser page for Living Archive ingestion, entities, contradictions, durable wiki updates, and source-backed synthesis."
      }
    });
    await addMessage(
      "system",
      `Saved this page to Living Archive intake and queued it for review.\n\nIt remains raw source material until the archive review, verification, and promotion pipeline accepts it.\n\n${reviewQueueGuidance}`
    );
    setStatus("Page saved to intake");
    setActivity("completed", "Saved page intake", result.path);
    return { ok: true, ...result, reviewRequestPath: review.path };
  }

  async function saveSelectionToArchive() {
    setActivity("tool-running", "Saving selection to Living Archive intake", "Reading selected page text");
    const response = await sendContentAction({ type: "get_selection" });
    const selection = response?.selection;
    const text = String(selection?.text ?? "").trim();
    if (!response?.ok || !text) {
      await addMessage("system", "No selected text is available to save. Select text on the active web page and try again.");
      setStatus("No selection");
      setActivity("failed", "No selection available", response?.error ?? "");
      return { ok: false, error: response?.error ?? "No selected text available." };
    }
    const title = response.title || selection.title || "Selected browser text";
    const url = response.url || selection.url || "";
    const result = await bridge()("/archive/intake", {
      method: "POST",
      body: {
        title: `Selection: ${title}`,
        url,
        origin: "browser-selection",
        content: [
          `Captured from: ${url || "unknown URL"}`,
          "",
          "## Selection",
          text,
        ].join("\n")
      }
    });
    const review = await bridge()("/archive/review/request", {
      method: "POST",
      body: {
        path: result.path,
        reason: "Evaluate this selected browser text for Living Archive ingestion, entities, contradictions, durable wiki updates, and source-backed synthesis."
      }
    });
    await addMessage(
      "system",
      `Saved the selected text to Living Archive intake and queued it for review.\n\nIt remains raw source material until the archive review, verification, and promotion pipeline accepts it.\n\n${reviewQueueGuidance}`
    );
    setStatus("Selection saved to intake");
    setActivity("completed", "Saved selection intake", result.path);
    return { ok: true, ...result, reviewRequestPath: review.path };
  }

  return {
    activeTab,
    clickActivePageText,
    detectActivePageForms,
    detectWalletState,
    mergeFrameSnapshots,
    openBrowserUrl,
    prepareDaoWorkflowGuidance,
    readActivePage,
    refreshTabContext,
    runResonatorCommand,
    scrollActivePage,
    searchBrowser,
    sendContentAction,
    sendContentActionToFrames,
    setPageControlOverlay,
    saveCurrentPageToArchive,
    saveResearchTrailToArchive,
    saveWalletDaoAuditToArchive,
    saveSelectionToArchive,
    summarizeCurrentPageToArchive,
    summarizeSnapshot,
    typeIntoActivePage
  };
}
