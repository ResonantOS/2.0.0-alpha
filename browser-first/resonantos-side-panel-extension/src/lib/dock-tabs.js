// Top-of-sidecar tabs (Site / Agent Control / Jobs) that pop their panel out as
// a full-size overlay over the chat. Each panel is otherwise hidden. A per-tab
// dot lights when the panel gains new content while its popout is closed, and
// clears when the human opens it. Content changes are detected by comparing a
// text signature, so a re-render with identical content doesn't false-flag.

// A panel is "blocking" when it holds something that needs the human: a visible
// approval card, or a blocked/failed/awaiting job or control step. Its tab dot
// then goes red + blinking (see dock-tab-dot[data-blocking] in CSS) instead of
// the normal green activity dot.
export const DOCK_BLOCKING_SELECTOR = [
  '[data-state="blocked"]',
  '[data-state="approval"]',
  '[data-status="blocked"]',
  '[data-status="failed"]',
  '[data-status="denied"]',
  '[data-attention="stale"]',
  '.approval-card:not([hidden])',
  '.job-approval-card'
].join(", ");

function defaultIsBlocking(panel) {
  return Boolean(panel && typeof panel.querySelector === "function" && panel.querySelector(DOCK_BLOCKING_SELECTOR));
}

export function createDockTabs({
  tabs = [],            // [{ name, button, dot, panel }]
  popout = null,        // the overlay section
  popoutTitle = null,   // heading shown in the overlay
  closeButton = null,
  titles = {},          // { name: "Human label" }
  onOpen = () => {},    // called with the tab name whenever a panel is opened
  isBlocking = defaultIsBlocking, // (panel) -> does it hold a needs-human message?
  observe = true        // wire MutationObservers (off in unit tests)
} = {}) {
  let openName = null;
  const signatures = new Map();
  const observers = [];

  const tabFor = (name) => tabs.find((tab) => tab.name === name) ?? null;
  const signatureOf = (tab) => (tab?.panel ? tab.panel.textContent ?? "" : "");

  function render() {
    if (popout) {
      popout.hidden = openName === null;
      popout.dataset.open = openName ?? "none";
    }
    if (popoutTitle && openName) {
      popoutTitle.textContent = titles[openName] ?? openName;
    }
    for (const tab of tabs) {
      const active = tab.name === openName;
      tab.button?.setAttribute?.("aria-expanded", active ? "true" : "false");
      tab.button?.classList?.toggle?.("active", active);
    }
  }

  function clearActivity(name) {
    const tab = tabFor(name);
    if (tab?.dot) {
      tab.dot.hidden = true;
      tab.dot.dataset.active = "false";
      tab.dot.dataset.blocking = "false";
    }
    signatures.set(name, signatureOf(tab)); // baseline so we don't re-flag
  }

  function markActivity(name) {
    if (name === openName) return; // a visible panel needs no badge
    const tab = tabFor(name);
    if (tab?.dot) {
      tab.dot.hidden = false;
      tab.dot.dataset.active = "true";
      tab.dot.dataset.blocking = isBlocking(tab.panel) ? "true" : "false";
    }
  }

  // Explicit, state-driven activity flag. Panels rendered lazily (e.g. the main
  // workspace's Site/Control/Permissions) can't rely on a DOM MutationObserver,
  // so both surfaces call this from the SAME shared-store change with the SAME
  // computed blocking — keeping their dots in sync. blocking=true turns the dot
  // red (see dock-tab-dot[data-blocking]); the open-panel rule still applies.
  function signalActivity(name, { blocking = false } = {}) {
    if (name === openName) return;
    const tab = tabFor(name);
    if (tab?.dot) {
      tab.dot.hidden = false;
      tab.dot.dataset.active = "true";
      tab.dot.dataset.blocking = blocking ? "true" : "false";
    }
  }

  function open(name) {
    if (!tabFor(name)) return;
    openName = name;
    render();
    clearActivity(name);
    onOpen(name);
  }

  function close() {
    openName = null;
    render();
  }

  function toggle(name) {
    if (openName === name) close();
    else open(name);
  }

  // Flag activity when a panel's content actually changed since we last looked.
  function notePanelActivity(name) {
    const tab = tabFor(name);
    if (!tab) return;
    const sig = signatureOf(tab);
    if (sig === signatures.get(name)) return;
    signatures.set(name, sig);
    markActivity(name);
  }

  function bind() {
    for (const tab of tabs) {
      tab.button?.addEventListener?.("click", () => toggle(tab.name));
      signatures.set(tab.name, signatureOf(tab));
      if (observe && tab.panel && typeof MutationObserver !== "undefined") {
        const observer = new MutationObserver(() => notePanelActivity(tab.name));
        observer.observe(tab.panel, { childList: true, subtree: true, characterData: true });
        observers.push(observer);
      }
    }
    closeButton?.addEventListener?.("click", () => close());
    render();
  }

  return {
    bind,
    open,
    close,
    toggle,
    notePanelActivity,
    signalActivity,
    render,
    isOpen: () => openName,
    disconnect: () => observers.splice(0).forEach((observer) => observer.disconnect())
  };
}
