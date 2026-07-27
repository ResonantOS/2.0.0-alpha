// Show/hide the full-screen Augmentor workspace from the side panel.
//
// The workspace (`main-workspace.html`) is a full extension page. It used to be
// forced onto every new tab via `chrome_url_overrides.newtab`; now the browser
// keeps its own default page and the human opens/closes the workspace on demand
// from a toggle in the composer toolbar. This module holds the decision logic
// (pure, unit-tested) and a thin performer that drives `chrome.tabs`.

export const MAIN_WORKSPACE_FILE = "src/main-workspace.html";
export const MAIN_WORKSPACE_PATH = `/${MAIN_WORKSPACE_FILE}`;

export function isMainWorkspaceUrl(url = "", { workspacePath = MAIN_WORKSPACE_PATH } = {}) {
  try {
    return new URL(url).pathname === workspacePath;
  } catch {
    return false;
  }
}

// The workspace counts as "visible" when it is the active tab of the window the
// side panel belongs to — that is what the toggle's pressed state reflects.
export function mainWorkspaceVisible(tabs = [], { workspacePath = MAIN_WORKSPACE_PATH } = {}) {
  return tabs.some((tab) => tab?.active && isMainWorkspaceUrl(tab?.url, { workspacePath }));
}

// Decide what a toggle click should do against the current-window tabs:
//   - viewing the workspace        -> close it (hide)
//   - workspace open in background  -> focus it (show)
//   - not open at all               -> open it (show)
// `visible` is the resulting state so the caller can update aria-pressed.
export function resolveMainWorkspaceToggle(tabs = [], { workspacePath = MAIN_WORKSPACE_PATH } = {}) {
  const workspaceTabs = tabs.filter((tab) => isMainWorkspaceUrl(tab?.url, { workspacePath }));
  const activeWorkspace = workspaceTabs.find((tab) => tab?.active);
  if (activeWorkspace) {
    return { action: "close", tabId: activeWorkspace.id, visible: false };
  }
  if (workspaceTabs.length > 0) {
    const target = workspaceTabs[0];
    return { action: "focus", tabId: target.id, windowId: target.windowId, visible: true };
  }
  return { action: "open", visible: true };
}

export function createMainWorkspaceToggle({
  tabsApi = typeof chrome !== "undefined" ? chrome.tabs : null,
  windowsApi = typeof chrome !== "undefined" ? chrome.windows : null,
  getWorkspaceUrl = () => chrome.runtime.getURL(MAIN_WORKSPACE_FILE),
  workspacePath = MAIN_WORKSPACE_PATH
} = {}) {
  async function currentWindowTabs() {
    return (await tabsApi?.query?.({ currentWindow: true }).catch(() => [])) ?? [];
  }

  async function isVisible() {
    return mainWorkspaceVisible(await currentWindowTabs(), { workspacePath });
  }

  async function toggle() {
    const tabs = await currentWindowTabs();
    const decision = resolveMainWorkspaceToggle(tabs, { workspacePath });
    if (decision.action === "close") {
      // Closing the last tab would take the whole window down — land the human
      // on the browser's default page first, then drop the workspace tab.
      if (tabs.length <= 1) {
        await tabsApi?.create?.({}).catch(() => undefined);
      }
      await tabsApi?.remove?.(decision.tabId).catch(() => undefined);
    } else if (decision.action === "focus") {
      await tabsApi?.update?.(decision.tabId, { active: true }).catch(() => undefined);
      if (decision.windowId !== undefined) {
        await windowsApi?.update?.(decision.windowId, { focused: true }).catch(() => undefined);
      }
    } else {
      await tabsApi?.create?.({ url: getWorkspaceUrl(), active: true }).catch(() => undefined);
    }
    return decision.visible;
  }

  return { toggle, isVisible };
}
