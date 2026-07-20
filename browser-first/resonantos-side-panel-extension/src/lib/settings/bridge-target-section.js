// Bridge Target settings section.
//
// Lets the user view and override the bridge target that the extension is
// currently talking to. The override is persisted in chrome.storage.local,
// keyed by BRIDGE_STORAGE_OVERRIDE_KEY. When set, the bridge client resolves
// to this target on next startup (and live, via the storage.onChanged
// listener wired in the entry-point files).
//
// The UI also:
//   - shows the currently active bridge URL + token source (override,
//     generated, or default)
//   - shows the bridge /status health if reachable
//   - lets the user copy the generated config values (for when they want
//     to install the extension on another machine and need the token)

import { bridgeAuthMessage } from "../runtime-error-messages.js";
import { metricCard, noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";
import { BRIDGE_STORAGE_OVERRIDE_KEY, detectLoopbackBridge, resolveBridgeConfig } from "../bridge-client.js";

const STATUS_KEYS = [BRIDGE_STORAGE_OVERRIDE_KEY];

function parseOverrideFromForm(form) {
  const url = String(form.elements["bridge-url"]?.value ?? "").trim();
  const token = String(form.elements["bridge-token"]?.value ?? "").trim();
  const capabilityBootstrapToken = String(form.elements["bridge-capability-bootstrap-token"]?.value ?? "").trim();
  if (!url) return { ok: false, error: "Bridge URL is required." };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "Bridge URL must start with http:// or https://" };
  }
  return { ok: true, override: { bridgeUrl: url, bridgeToken: token, capabilityBootstrapToken } };
}

function setOverridePayload(override) {
  if (!override || !override.bridgeUrl) {
    return { [BRIDGE_STORAGE_OVERRIDE_KEY]: null };
  }
  return {
    [BRIDGE_STORAGE_OVERRIDE_KEY]: {
      bridgeUrl: override.bridgeUrl,
      bridgeToken: override.bridgeToken ?? "",
      capabilityBootstrapToken: override.capabilityBootstrapToken ?? "",
    },
  };
}

async function clearOverride() {
  if (typeof chrome === "undefined" || !chrome?.storage?.local?.remove) return;
  await chrome.storage.local.remove([BRIDGE_STORAGE_OVERRIDE_KEY]);
}

async function saveOverride(override) {
  if (typeof chrome === "undefined" || !chrome?.storage?.local?.set) return;
  await chrome.storage.local.set(setOverridePayload(override));
}

async function loadStoredOverride() {
  if (typeof chrome === "undefined" || !chrome?.storage?.local?.get) return null;
  const result = await chrome.storage.local.get([BRIDGE_STORAGE_OVERRIDE_KEY]).catch(() => ({}));
  const value = result?.[BRIDGE_STORAGE_OVERRIDE_KEY];
  if (!value || typeof value !== "object" || !value.bridgeUrl) return null;
  return value;
}

async function probeBridge(url, token) {
  const headers = token ? { "X-ResonantOS-Bridge-Token": token } : {};
  const response = await fetch(`${url.replace(/\/$/, "")}/status`, { headers });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { ok: response.ok && body?.ok === true, status: response.status, body };
}

function buildField({ id, label, value, type = "text", placeholder = "", monospace = true, textarea = false, autocomplete = "off" }) {
  const wrapper = document.createElement("label");
  wrapper.className = "settings-provider-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement(textarea ? "textarea" : "input");
  if (textarea) {
    input.rows = 4;
  } else {
    input.type = type;
  }
  input.id = id;
  input.name = id;
  input.placeholder = placeholder;
  input.autocomplete = autocomplete;
  input.spellcheck = false;
  input.value = value ?? "";
  if (monospace) input.classList.add("settings-mono");
  wrapper.append(caption, input);
  return { wrapper, input };
}

function actionRow({ buttons }) {
  const row = document.createElement("div");
  row.className = "settings-provider-account-actions";
  for (const { label, onClick, tone = "" } of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (tone) button.dataset.tone = tone;
    button.addEventListener("click", onClick);
    row.append(button);
  }
  return row;
}

function healthCard({ label, value, detail, tone }) {
  return metricCard({ label, value, detail, tone });
}

export function renderBridgeTargetSection(container, { bridgeRequest, onBridgeConfigChanged, prefsSync = null } = {}) {
  container.innerHTML = "";
  container.append(
    settingsHeader({
      eyebrow: "Bridge Target",
      title: "Bridge Target",
      body: "Choose which ResonantOS bridge the extension talks to. The override is stored locally in this browser profile and beats the generated config that ships with the extension. Use it to point a Mac/Windows/Linux install at the bridge on the Pi5.",
    })
  );

  const statusNode = document.createElement("p");
  statusNode.className = "settings-status";
  setStatus(statusNode, "Loading bridge target...");
  container.append(statusNode);

  const healthGrid = document.createElement("div");
  healthGrid.className = "settings-health-grid";
  healthGrid.append(
    healthCard({ label: "Active URL", value: "—", detail: "resolving..." }),
    healthCard({ label: "Source", value: "—", detail: "override / generated / default" }),
    healthCard({ label: "Bridge health", value: "—", detail: "probing /status" })
  );
  container.append(healthGrid);

  const syncCard = document.createElement("section");
  syncCard.className = "settings-provider-card";
  const syncHeading = document.createElement("strong");
  syncHeading.className = "settings-provider-heading";
  syncHeading.textContent = "Cross-machine preference sync";
  const syncHint = document.createElement("p");
  syncHint.className = "settings-provider-help";
  syncHint.textContent =
    "Settings like model defaults, augmentor persona, and theme are stored on the bridge and re-pulled when this extension starts on another machine. Local session data (chats, projects) is not synced.";
  const syncStatus = document.createElement("p");
  syncStatus.className = "settings-status";
  syncStatus.textContent = "Sync status: unknown";
  const syncGrid = document.createElement("div");
  syncGrid.className = "settings-health-grid";
  syncGrid.append(
    healthCard({ label: "Last pull", value: "—", detail: "GET /settings/extension-prefs" }),
    healthCard({ label: "Last push", value: "—", detail: "POST /settings/extension-prefs" }),
    healthCard({ label: "Source", value: "—", detail: "stored / missing" })
  );
  syncCard.append(syncHeading, syncHint, syncGrid);
  if (prefsSync) {
    const syncActions = actionRow({
      buttons: [
        {
          label: "Pull from bridge now",
          onClick: async () => {
            setStatus(syncStatus, "Pulling from bridge...", "");
            try {
              const result = await prefsSync.hydrate();
              if (result.ok) {
                setStatus(syncStatus, `Pulled from bridge. Source: ${result.source}${result.wroteAny ? ", updated local values" : ""}.`, "success");
              } else {
                setStatus(syncStatus, `Pull failed: ${result.reason}`, "error");
              }
            } catch (error) {
              setStatus(syncStatus, safeErrorMessage(error), "error");
            } finally {
              refreshSyncStatus();
            }
          },
        },
        {
          label: "Push to bridge now",
          onClick: async () => {
            setStatus(syncStatus, "Pushing to bridge...", "");
            try {
              await prefsSync.flush();
              refreshSyncStatus();
            } catch (error) {
              setStatus(syncStatus, safeErrorMessage(error), "error");
            }
          },
        },
      ],
    });
    syncCard.append(syncActions);
  } else {
    const note = document.createElement("p");
    note.className = "settings-provider-help";
    note.textContent = "Sync is not active in this context (no prefsSync handle). Open the main new-tab workspace to see live sync controls.";
    syncCard.append(note);
  }
  syncCard.append(syncStatus);
  container.append(syncCard);

  function refreshSyncStatus() {
    if (!prefsSync) return;
    const state = prefsSync.getState();
    const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : "never");
    const errorMessage = state.lastError ? safeErrorMessage(state.lastError) : "";
    const [pullCard, pushCard, sourceCard] = syncGrid.children;
    pullCard.querySelector("strong").textContent = state.lastPullAt ? fmt(state.lastPullAt) : "—";
    pullCard.querySelector("p").textContent = errorMessage ? `last error: ${errorMessage}` : "no error";
    pushCard.querySelector("strong").textContent = state.lastPushAt ? fmt(state.lastPushAt) : "—";
    pushCard.querySelector("p").textContent = errorMessage ? `last error: ${errorMessage}` : "no error";
    sourceCard.querySelector("strong").textContent = state.lastSource ?? "—";
    sourceCard.querySelector("p").textContent = state.pending ? "change pending, will push..." : "idle";
  }

  const formCard = document.createElement("section");
  formCard.className = "settings-provider-card";
  const formHeading = document.createElement("strong");
  formHeading.className = "settings-provider-heading";
  formHeading.textContent = "Override";
  const formHint = document.createElement("p");
  formHint.className = "settings-provider-help";
  formHint.textContent =
    "Set a different bridge URL, bridge token, and capability-bootstrap token to point this browser at a different host. Leave token fields blank only when the generated config still targets that bridge.";
  const form = document.createElement("form");
  form.className = "settings-provider-form";
  form.addEventListener("submit", (event) => event.preventDefault());
  const urlField = buildField({
    id: "bridge-url",
    label: "Bridge URL",
    placeholder: "http://192.168.1.100:47773",
    monospace: true,
  });
  const tokenField = buildField({
    id: "bridge-token",
    label: "Bridge token (optional override)",
    placeholder: "leave blank to use the generated token",
    monospace: true,
  });
  const bootstrapField = buildField({
    id: "bridge-capability-bootstrap-token",
    label: "Capability-bootstrap token (optional override)",
    placeholder: "required for privileged bridge actions on a manual target",
    monospace: true,
  });
  form.append(urlField.wrapper, tokenField.wrapper, bootstrapField.wrapper);
  formCard.append(formHeading, formHint, form, actionRow({
    buttons: [
      {
        label: "Save override",
        tone: "primary",
        onClick: async () => {
          const parsed = parseOverrideFromForm(form);
          if (!parsed.ok) {
            setStatus(statusNode, parsed.error, "error");
            return;
          }
          try {
            await saveOverride(parsed.override);
            setStatus(statusNode, "Override saved. Reconnecting to new bridge target...", "");
            await refresh();
            onBridgeConfigChanged?.(await resolveBridgeConfig());
          } catch (error) {
            setStatus(statusNode, safeErrorMessage(error), "error");
          }
        },
      },
      {
        label: "Test connection",
        onClick: async () => {
          const parsed = parseOverrideFromForm(form);
          if (!parsed.ok) {
            setStatus(statusNode, parsed.error, "error");
            return;
          }
          await runProbe(parsed.override.bridgeUrl, parsed.override.bridgeToken);
        },
      },
      {
        label: "Use generated",
        onClick: async () => {
          try {
            await clearOverride();
            setStatus(statusNode, "Override cleared. Falling back to the generated config.", "");
            await refresh();
            onBridgeConfigChanged?.(await resolveBridgeConfig());
          } catch (error) {
            setStatus(statusNode, safeErrorMessage(error), "error");
          }
        },
      },
    ],
  }));
  container.append(formCard);

  container.append(
    noteCard({
      title: "Cross-machine workflow",
      body: "The same extension zip installs unchanged on Linux, macOS, and Windows. A clean install uses the generated config automatically. For a manual remote target, enter the bridge's LAN or Tailscale URL plus the bridge and capability-bootstrap tokens from that bridge host.",
    })
  );

  const generatedCard = document.createElement("section");
  generatedCard.className = "settings-provider-card";
  const generatedHeading = document.createElement("strong");
  generatedHeading.className = "settings-provider-heading";
  generatedHeading.textContent = "Generated config (from extension package)";
  const generatedHint = document.createElement("p");
  generatedHint.className = "settings-provider-help";
  generatedHint.textContent =
    "These values are baked into the extension at build time. They let a fresh install on the Pi5 itself work without any extra setup. To override them, use the form above.";
  const generatedUrl = document.createElement("code");
  generatedUrl.className = "settings-mono settings-provider-pill";
  generatedUrl.textContent = "—";
  const generatedToken = document.createElement("code");
  generatedToken.className = "settings-mono settings-provider-pill";
  generatedToken.textContent = "—";
  const generatedBootstrapToken = document.createElement("code");
  generatedBootstrapToken.className = "settings-mono settings-provider-pill";
  generatedBootstrapToken.textContent = "—";
  generatedCard.append(generatedHeading, generatedHint, generatedUrl, generatedToken, generatedBootstrapToken);
  container.append(generatedCard);

  let activeConfig = null;

  async function refresh() {
    const resolvedConfig = await resolveBridgeConfig();
    activeConfig = await detectLoopbackBridge(resolvedConfig).catch(() => resolvedConfig);
    const [storedOverride] = await Promise.all([loadStoredOverride()]);
    const generated = globalThis.__RESONANTOS_BRIDGE_CONFIG__ ?? {};
    if (storedOverride) {
      urlField.input.value = storedOverride.bridgeUrl ?? "";
      tokenField.input.value = storedOverride.bridgeToken ?? "";
      bootstrapField.input.value = storedOverride.capabilityBootstrapToken ?? "";
    } else {
      urlField.input.value = activeConfig.bridgeUrl;
      tokenField.input.value = "";
      bootstrapField.input.value = "";
    }
    generatedUrl.textContent = generated.bridgeUrl ?? "(none — extension is missing the generated config)";
    generatedToken.textContent = generated.bridgeToken
      ? `${generated.bridgeToken.slice(0, 6)}…${generated.bridgeToken.slice(-4)} (${generated.bridgeToken.length} chars)`
      : "(none)";
    generatedBootstrapToken.textContent = generated.capabilityBootstrapToken
      ? `bootstrap: ${generated.capabilityBootstrapToken.slice(0, 6)}…${generated.capabilityBootstrapToken.slice(-4)} (${generated.capabilityBootstrapToken.length} chars)`
      : "bootstrap: (none)";

    const sourceValue = activeConfig.source?.startsWith("loopback:")
      ? "Loopback"
      : activeConfig.source === "override"
        ? "Override"
        : activeConfig.source === "generated"
          ? "Generated"
          : "Default";
    const sourceDetail = activeConfig.source?.startsWith("loopback:")
      ? `local loopback bridge detected from ${activeConfig.source.replace("loopback:", "")} config`
      : activeConfig.source === "override"
        ? "local chrome.storage override is winning"
        : activeConfig.source === "generated"
          ? "extension package config is in use"
          : "loopback default — bridge is on 127.0.0.1 only";
    const [urlCard, sourceCard, healthCardEl] = healthGrid.children;
    urlCard.querySelector("strong").textContent = activeConfig.bridgeUrl;
    urlCard.querySelector("p").textContent =
      `token: ${activeConfig.bridgeToken ? `${activeConfig.bridgeToken.slice(0, 6)}…` : "(none)"} · bootstrap: ${activeConfig.capabilityBootstrapToken ? "configured" : "missing"}`;
    sourceCard.querySelector("strong").textContent = sourceValue;
    sourceCard.querySelector("p").textContent = sourceDetail;
    healthCardEl.querySelector("strong").textContent = "Probing...";
    healthCardEl.querySelector("p").textContent = "checking /status";
    setStatus(statusNode, `Resolved: ${activeConfig.source}`, "");
    refreshSyncStatus();
    await runProbe(activeConfig.bridgeUrl, activeConfig.bridgeToken);
  }

  async function runProbe(url, token) {
    const [, , healthCardEl] = healthGrid.children;
    try {
      const result = await probeBridge(url, token);
      if (result.ok) {
        healthCardEl.querySelector("strong").textContent = "Online";
        const providerCount = Object.keys(result.body?.providers ?? {}).length || 0;
        healthCardEl.querySelector("p").textContent = `200 OK · ${providerCount} providers`;
        healthCardEl.dataset.tone = "success";
        setStatus(statusNode, `Bridge ${url} responded OK.`, "success");
      } else if (result.status === 401) {
        healthCardEl.querySelector("strong").textContent = "401";
        healthCardEl.querySelector("p").textContent = "unauthorized - token mismatch";
        healthCardEl.dataset.tone = "error";
        setStatus(statusNode, `Bridge ${url} replied 401. ${bridgeAuthMessage()}`, "error");
      } else if (result.status === 403) {
        healthCardEl.querySelector("strong").textContent = "403";
        healthCardEl.querySelector("p").textContent = "forbidden — IP not allowlisted";
        healthCardEl.dataset.tone = "error";
        setStatus(statusNode, `Bridge ${url} replied 403. Your IP is not in RESONANTOS_BRIDGE_ALLOWED_IPS on the bridge host.`, "error");
      } else {
        healthCardEl.querySelector("strong").textContent = `${result.status}`;
        healthCardEl.querySelector("p").textContent = "unhealthy response";
        healthCardEl.dataset.tone = "error";
        setStatus(statusNode, `Bridge ${url} replied ${result.status}.`, "error");
      }
    } catch (error) {
      healthCardEl.querySelector("strong").textContent = "Unreachable";
      healthCardEl.querySelector("p").textContent = safeErrorMessage(error);
      healthCardEl.dataset.tone = "error";
      setStatus(statusNode, `Could not reach ${url}: ${safeErrorMessage(error)}`, "error");
    }
  }

  void refresh();
}
