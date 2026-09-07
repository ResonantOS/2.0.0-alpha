import { noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";
import {
  createModeStatusSection,
  describeAugmentorModeStatus,
  formatModeStatusLine,
  permissionLabel
} from "./mode-status-section.js";

const terminalJobStatuses = new Set(["completed", "blocked", "denied", "cancelled", "failed"]);

function readableTab(tab) {
  return typeof tab?.url === "string" && /^https?:\/\//i.test(tab.url);
}

function activeDelegatedConsentForSite(consents, siteKey) {
  return Object.values(consents)
    .filter((consent) => consent?.siteKey === siteKey && ["allow-safe", "allow-once"].includes(consent?.mode))
    .sort((left, right) => Number(right.grantedAt ?? 0) - Number(left.grantedAt ?? 0))[0] ?? null;
}

function row({ title, meta, actionLabel = "", onAction = null, actions = [] }) {
  const item = document.createElement("li");
  item.className = "settings-control-row";
  const copy = document.createElement("span");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const detail = document.createElement("small");
  detail.textContent = meta;
  copy.append(heading, detail);
  item.append(copy);
  const rowActions = Array.isArray(actions) && actions.length
    ? actions
    : actionLabel && onAction
      ? [{ label: actionLabel, onAction }]
      : [];
  if (rowActions.length) {
    const actionGroup = document.createElement("span");
    actionGroup.className = "settings-row-actions";
    rowActions.forEach((itemAction) => {
      if (!itemAction?.label || !itemAction?.onAction) {
        return;
      }
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = itemAction.label;
      action.addEventListener("click", () => void itemAction.onAction(action));
      actionGroup.append(action);
    });
    item.append(actionGroup);
  }
  return item;
}

async function runDownloadAction(bridgeRequest, statusNode, action, payload = {}) {
  if (!bridgeRequest) {
    throw new Error("Browser bridge is unavailable.");
  }
  const bridge = () => (typeof bridgeRequest === "function" ? bridgeRequest : null);
  const result = await bridge()("/browser/downloads/action", {
    method: "POST",
    capability: "browser-download-action",
    body: { action, ...payload }
  });
  if (result?.message) {
    setStatus(statusNode, result.message, "success");
  }
  return result;
}

function clearButton(label) {
  const action = document.createElement("button");
  action.type = "button";
  action.className = "settings-secondary-action";
  action.textContent = label;
  return action;
}

function controlDisclosure(title, body, children = []) {
  const details = document.createElement("details");
  details.className = "settings-control-advanced";
  const summary = document.createElement("summary");
  summary.textContent = title;
  const panel = document.createElement("div");
  panel.className = "settings-control-advanced-body";
  const copy = document.createElement("p");
  copy.textContent = body;
  panel.append(copy, ...children);
  details.append(summary, panel);
  return details;
}

function openBrowserTab(chromeApi, url) {
  return chromeApi?.tabs?.create?.({ url, active: true }).catch(() => undefined);
}

async function activeTab(chromeApi) {
  const tabs = await chromeApi?.tabs?.query?.({ active: true, currentWindow: true }).catch(() => []);
  return tabs?.[0] ?? null;
}

async function readStored(storage, key, fallback) {
  if (!storage || !key) return fallback;
  const result = await storage?.get?.(key).catch(() => ({}));
  return result?.[key] ?? fallback;
}

export function renderBrowserControlSection(container, { bridgeRequest, getBridgeRequest, chromeApi,
  sitePermissionStore,
  taskConsentStore,
  storage,
  storageKeys = {}
}) {
  const statusNode = document.createElement("p");
  statusNode.className = "settings-status";
  statusNode.textContent = "Loading browser control settings...";
  const currentCard = noteCard({
    title: "Current site",
    body: "Checking the active browser tab and permission mode."
  });
  const modeStatusHost = document.createElement("div");
  modeStatusHost.className = "settings-mode-status-host";
  const permissionsList = document.createElement("ol");
  permissionsList.className = "settings-control-list";
  const jobsList = document.createElement("ol");
  jobsList.className = "settings-control-list";
  const downloadsList = document.createElement("ol");
  downloadsList.className = "settings-control-list";
  const clearJobs = document.createElement("button");
  clearJobs.type = "button";
  clearJobs.className = "settings-primary-action";
  clearJobs.textContent = "Clear Completed Browser Jobs";
  const clearDownloads = clearButton("Clear Download History");

  const browserActions = document.createElement("div");
  browserActions.className = "settings-inline-actions";
  const downloadsButton = document.createElement("button");
  downloadsButton.type = "button";
  downloadsButton.textContent = "Open Downloads";
  downloadsButton.addEventListener("click", () => void openBrowserTab(chromeApi, "chrome://downloads"));
  const historyButton = document.createElement("button");
  historyButton.type = "button";
  historyButton.textContent = "Open History";
  historyButton.addEventListener("click", () => void openBrowserTab(chromeApi, "chrome://history"));
  const bookmarksButton = document.createElement("button");
  bookmarksButton.type = "button";
  bookmarksButton.textContent = "Open Bookmarks";
  bookmarksButton.addEventListener("click", () => void openBrowserTab(chromeApi, "chrome://bookmarks"));
  const extensionsButton = document.createElement("button");
  extensionsButton.type = "button";
  extensionsButton.textContent = "Manage Extensions";
  extensionsButton.addEventListener("click", () => void openBrowserTab(chromeApi, "chrome://extensions"));
  const passwordsButton = document.createElement("button");
  passwordsButton.type = "button";
  passwordsButton.textContent = "Password Manager";
  passwordsButton.addEventListener("click", () => void openBrowserTab(chromeApi, "chrome://password-manager/passwords"));
  const permissionsButton = document.createElement("button");
  permissionsButton.type = "button";
  permissionsButton.textContent = "Site Settings";
  permissionsButton.addEventListener("click", () => void openBrowserTab(chromeApi, "chrome://settings/content"));
  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.textContent = "Browser Settings";
  settingsButton.addEventListener("click", () => void openBrowserTab(chromeApi, "chrome://settings"));
  browserActions.append(downloadsButton, historyButton, bookmarksButton, extensionsButton, passwordsButton, permissionsButton, settingsButton);

  const grantsSection = document.createElement("section");
  grantsSection.className = "settings-control-primary";
  const grantsHeading = document.createElement("div");
  grantsHeading.className = "settings-memory-section-heading";
  const grantsTitle = document.createElement("strong");
  grantsTitle.textContent = "Agent permissions";
  const grantsCopy = document.createElement("p");
  grantsCopy.textContent = "Review the sites and task types where Augmentor has scoped permission beyond the default ask-before-action mode.";
  grantsHeading.append(grantsTitle, grantsCopy);
  grantsSection.append(grantsHeading, permissionsList);

  const browserDisclosure = controlDisclosure(
    "Browser management pages",
    "Open Chromium management pages when you need browser-level settings. These are separate from Augmentor's agent-control grants.",
    [browserActions]
  );
  const downloadsDisclosure = controlDisclosure(
    "Recent downloads",
    "Review files saved through the browser download path. Clearing history hides old entries here but does not delete files.",
    [clearDownloads, downloadsList]
  );
  const jobsDisclosure = controlDisclosure(
    "Browser job history",
    "Review recent browser-control jobs. Clearing browser jobs removes completed, blocked, cancelled, and failed history from the local monitor only.",
    [jobsList, clearJobs]
  );

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Browser and Agent Control",
      title: "Agent Control Permissions",
      body: "Set how Augmentor may read, click, type, and run browser jobs. The default is ask-before-action. Wallet, login, payment, credential, signing, and public-submit boundaries remain approval-gated."
    }),
    statusNode,
    currentCard,
    modeStatusHost,
    grantsSection,
    browserDisclosure,
    downloadsDisclosure,
    jobsDisclosure
  );

  let grantPending = false;
  const grantAction = (label, mutate) => {
    let updated = false;
    return async (button) => {
      if (button.disabled || grantPending) return;
      grantPending = true;
      button.disabled = true;
      setStatus(statusNode, updated ? "Refreshing permissions..." : `${label} in progress...`);
      try {
        if (!updated) {
          await mutate();
          updated = true;
        }
        await load();
      } catch (error) {
        setStatus(statusNode, updated
          ? `Permission updated, but settings refresh failed: ${safeErrorMessage(error)}. Use Refresh to check current grants.`
          : `${label} could not be confirmed: ${safeErrorMessage(error)}. Refresh Settings to check current grants before retrying.`, "error");
      } finally {
        grantPending = false;
        button.textContent = updated ? "Refresh" : label;
        button.disabled = false;
      }
    };
  };

  const load = async () => {
    const tab = await activeTab(chromeApi);
    const siteKey = readableTab(tab) && sitePermissionStore
      ? sitePermissionStore.siteKeyForUrl(tab.url)
      : "";
    const mode = readableTab(tab) && sitePermissionStore
      ? await sitePermissionStore.permissionForUrl(tab.url)
      : "unavailable";
    const [sitePermissions, taskConsents, jobs, activeJobId, downloads] = await Promise.all([
      sitePermissionStore?.sitePermissions?.() ?? {},
      taskConsentStore?.taskConsents?.() ?? {},
      readStored(storage, storageKeys.browserJobs, []),
      readStored(storage, storageKeys.activeBrowserJob, ""),
      bridgeRequest?.("/browser/downloads", { method: "GET" }).catch(() => ({ entries: [], total: 0, root: "" })) ?? { entries: [], total: 0, root: "" }
    ]);
    const permissionEntries = Object.entries(sitePermissions)
      .filter(([key, value]) => key && value && value !== "ask-before-action")
      .sort(([left], [right]) => left.localeCompare(right));
    const consentEntries = Object.values(taskConsents)
      .filter((consent) => consent?.siteKey && consent?.taskClass)
      .sort((left, right) => `${left.siteKey}::${left.taskClass}`.localeCompare(`${right.siteKey}::${right.taskClass}`));
    if (readableTab(tab)) {
      const activeConsent = activeDelegatedConsentForSite(taskConsents, siteKey);
      const modeStatus = describeAugmentorModeStatus({ permissionMode: mode, siteKey, consent: activeConsent });
      currentCard.querySelector("p").textContent = `${siteKey} · ${formatModeStatusLine({ permissionMode: mode, siteKey, consent: activeConsent })}`;
      modeStatusHost.replaceChildren(createModeStatusSection({ document, status: modeStatus }));
    } else {
      currentCard.querySelector("p").textContent = "No readable http/https tab is currently active.";
      modeStatusHost.replaceChildren();
    }

    permissionsList.replaceChildren();
    for (const [key, value] of permissionEntries) {
      permissionsList.append(row({
        title: key,
        meta: `site permission · ${permissionLabel(value)}`,
        actionLabel: "Reset",
        onAction: grantAction("Reset", async () => {
          if (typeof sitePermissionStore?.resetSitePermission !== "function") {
            throw new Error("Site permission reset is unavailable.");
          }
          await sitePermissionStore.resetSitePermission(key, { reason: "Reset from Settings Browser Control", source: "settings" });
        })
      }));
    }
    for (const consent of consentEntries) {
      permissionsList.append(row({
        title: `${consent.siteKey} · ${consent.taskClass}`,
        meta: `task consent · ${consent.mode} · expires ${new Date(consent.expiresAt).toLocaleDateString()}`,
        actionLabel: "Revoke",
        onAction: grantAction("Revoke", async () => {
          if (typeof taskConsentStore?.revokeTaskConsent !== "function") {
            throw new Error("Task consent revocation is unavailable.");
          }
          await taskConsentStore.revokeTaskConsent({
            siteKey: consent.siteKey,
            taskClass: consent.taskClass,
            reason: "Revoked from Settings Browser Control",
            source: "settings"
          });
        })
      }));
    }
    if (!permissionEntries.length && !consentEntries.length) {
      permissionsList.append(row({ title: "No stored grants", meta: "Agent Control is using ask-before-action defaults." }));
    }

    const recentDownloads = Array.isArray(downloads?.entries) ? downloads.entries : [];
    downloadsList.replaceChildren();
    recentDownloads.slice(0, 8).forEach((entry) => {
      downloadsList.append(row({
        title: entry.name || "Downloaded file",
        meta: `${entry.path || downloads.root || "download path unavailable"} · ${entry.size ?? 0} bytes · ${entry.modifiedAt || "no timestamp"}`,
        actions: [
          {
            label: "Open",
            onAction: async () => runDownloadAction(bridgeRequest, statusNode, "open", { name: entry.name })
          },
          {
            label: "Reveal",
            onAction: async () => runDownloadAction(bridgeRequest, statusNode, "reveal", { name: entry.name })
          }
        ]
      }));
    });
    if (!recentDownloads.length) {
      downloadsList.append(row({
        title: "No recent downloads found",
        meta: downloads?.root ? `Checked ${downloads.root}` : "Downloads endpoint unavailable."
      }));
    }

    const normalizedJobs = Array.isArray(jobs) ? jobs : [];
    jobsList.replaceChildren();
    normalizedJobs.slice(0, 8).forEach((job) => {
      jobsList.append(row({
        title: job.goal || job.id || "Browser job",
        meta: `${job.status || "unknown"}${job.id === activeJobId ? " · focused" : ""} · ${job.updatedAt || job.createdAt || "no timestamp"}`
      }));
    });
    if (!normalizedJobs.length) {
      jobsList.append(row({ title: "No browser jobs", meta: "Agent Control has no persisted job history yet." }));
    }
    setStatus(statusNode, `${permissionEntries.length + consentEntries.length} stored grant${permissionEntries.length + consentEntries.length === 1 ? "" : "s"} · ${normalizedJobs.length} browser job${normalizedJobs.length === 1 ? "" : "s"} · ${downloads?.total ?? 0} download${downloads?.total === 1 ? "" : "s"}.`, "success");
  };

  clearJobs.addEventListener("click", async () => {
    if (clearJobs.disabled) return;
    clearJobs.disabled = true;
    try {
      const key = storageKeys.browserJobs;
      if (!key || typeof storage?.get !== "function" || typeof storage?.set !== "function") {
        throw new Error("Browser job storage is unavailable.");
      }
      // A display fallback is unsafe for a read-modify-write operation.
      const stored = await storage.get(key);
      const jobs = stored?.[key];
      if (!stored || (jobs !== undefined && !Array.isArray(jobs))) {
        throw new Error("Browser job history could not be read safely.");
      }
      const kept = (jobs ?? []).filter((job) => !terminalJobStatuses.has(job?.status));
      await storage.set({ [key]: kept });
      await load();
    } catch (error) {
      setStatus(statusNode, `Clear failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      clearJobs.disabled = false;
    }
  });

  clearDownloads.addEventListener("click", async () => {
    clearDownloads.disabled = true;
    try {
      await runDownloadAction(bridgeRequest, statusNode, "clear-history");
      await load();
    } catch (error) {
      setStatus(statusNode, `Clear downloads failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      clearDownloads.disabled = false;
    }
  });

  void load().catch((error) => {
    setStatus(statusNode, `Browser control settings unavailable: ${safeErrorMessage(error)}`, "error");
  });
}
