import {
  DEFAULT_AUGMENTOR_SYSTEM_PROMPT,
  readPersonalizationSettings,
  writePersonalizationSettings,
} from "../personalization-settings.js";
import { metricCard, noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";

const AUGMENTOR_SKILLS = [
  {
    name: "Browser control",
    detail: "Read, click, type, scroll, and verify web pages through the governed browser control layer."
  },
  {
    name: "Living Archive intake",
    detail: "Save pages, selections, messages, and artifacts into memory intake for review and promotion."
  },
  {
    name: "Agent delegation",
    detail: "Create governed delegation packets for add-on agents such as Hermes and OpenCode."
  },
  {
    name: "Provider routing",
    detail: "Use the Provider Fabric to route chat, planning, recovery, and archive work without exposing credentials."
  },
  {
    name: "Conversation operations",
    detail: "Fork, delete, copy, regenerate, attach files, and manage context usage across chat workspaces."
  }
];

function field({ label, input }) {
  const wrapper = document.createElement("label");
  wrapper.className = "settings-provider-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  wrapper.append(caption, input);
  return wrapper;
}

function textInput({ ariaLabel, placeholder = "", value = "" }) {
  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("aria-label", ariaLabel);
  input.placeholder = placeholder;
  input.value = value;
  return input;
}

function promptInput(value) {
  const input = document.createElement("textarea");
  input.rows = 9;
  input.setAttribute("aria-label", "Augmentor system prompt");
  input.placeholder = DEFAULT_AUGMENTOR_SYSTEM_PROMPT;
  input.value = value;
  return input;
}

function activeMemoryLabel(activeMemoryAddon, memoryAddons) {
  const active = memoryAddons.find((addon) => addon.id === activeMemoryAddon || addon.id === `addon.${activeMemoryAddon}`);
  return active?.name || activeMemoryAddon || "Living Archive";
}

function pluginTone(addon) {
  return addon?.available || addon?.enabled ? "success" : "warning";
}

function pluginCard(addon) {
  const card = document.createElement("article");
  card.className = "settings-addon-card settings-augmentor-plugin-card";
  card.dataset.tone = pluginTone(addon);
  const header = document.createElement("div");
  header.className = "settings-provider-heading";
  const copy = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = addon.name || addon.id || "Unnamed plugin";
  const meta = document.createElement("p");
  meta.textContent = `${addon.mode || "plugin"} · ${addon.trust || addon.provenance || "explicit grants required"}`;
  copy.append(name, meta);
  const badge = document.createElement("span");
  badge.className = "settings-status-pill";
  badge.dataset.tone = pluginTone(addon);
  badge.textContent = addon.available || addon.enabled ? "Available" : "Missing";
  header.append(copy, badge);

  const capabilities = document.createElement("small");
  const granted = Array.isArray(addon.grantedCapabilities) ? addon.grantedCapabilities : [];
  capabilities.textContent = granted.length ? `Granted: ${granted.join(", ")}` : "No grants active.";
  card.append(header, capabilities);
  return card;
}

function skillCard(skill) {
  return noteCard({ title: skill.name, body: skill.detail });
}

export function renderPersonalizationSection(container, { bridgeRequest, getBridgeRequest, storage,
  storageKeys = {},
  onOpenWorkspace = null,
  onProfileUpdated = null,
  onSelectSection = null
}) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const status = document.createElement("p");
  status.className = "settings-status";
  status.textContent = "Loading identity settings...";

  const form = document.createElement("form");
  form.className = "settings-provider-account-form settings-personalization-form";

  const displayName = textInput({
    ariaLabel: "User display name",
    placeholder: "Your name",
  });
  const subtitle = textInput({
    ariaLabel: "User profile subtitle",
    placeholder: "Local sovereign profile",
  });
  const email = textInput({
    ariaLabel: "User email or contact",
    placeholder: "Optional contact or account email",
  });
  const augmentorName = textInput({
    ariaLabel: "Augmentor display name",
    placeholder: "Augmentor",
  });
  const systemPrompt = promptInput("");

  const grid = document.createElement("div");
  grid.className = "settings-provider-account-grid";
  grid.append(
    field({ label: "User name", input: displayName }),
    field({ label: "Profile label", input: subtitle }),
    field({ label: "Contact", input: email }),
    field({ label: "AI name", input: augmentorName }),
    field({ label: "Augmentor system prompt", input: systemPrompt }),
  );

  const actions = document.createElement("div");
  actions.className = "settings-overview-action-buttons";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "settings-primary-action";
  save.textContent = "Save Identity";
  const resetPrompt = document.createElement("button");
  resetPrompt.type = "button";
  resetPrompt.textContent = "Reset Prompt";
  actions.append(save, resetPrompt);
  form.append(grid, actions);

  const memoryPanel = document.createElement("section");
  memoryPanel.className = "settings-personalization-panel";
  const memoryStatus = document.createElement("p");
  memoryStatus.className = "settings-status";
  memoryStatus.textContent = "Loading memory system...";
  const memoryMetrics = document.createElement("div");
  memoryMetrics.className = "settings-health-grid settings-profile-memory-grid";
  const memoryActions = document.createElement("div");
  memoryActions.className = "settings-overview-action-buttons";
  const openMemorySettings = document.createElement("button");
  openMemorySettings.type = "button";
  openMemorySettings.className = "settings-primary-action";
  openMemorySettings.textContent = "Open Memory Settings";
  openMemorySettings.addEventListener("click", () => onSelectSection?.("memory"));
  const openMemoryWorkspace = document.createElement("button");
  openMemoryWorkspace.type = "button";
  openMemoryWorkspace.textContent = "Open Memory Workspace";
  openMemoryWorkspace.addEventListener("click", () => onOpenWorkspace?.("memory"));
  memoryActions.append(openMemorySettings, openMemoryWorkspace);

  const memoryHeader = settingsHeader({
    eyebrow: "AI memory",
    title: "Memory System",
    body: "Augmentor uses the active memory-system add-on for durable AI memory. This installation defaults to Living Archive, but the add-on can be replaced when another memory provider is installed and granted."
  });
  memoryPanel.append(memoryHeader, memoryStatus, memoryMetrics, memoryActions);

  const skillsPanel = document.createElement("section");
  skillsPanel.className = "settings-personalization-panel";
  const skillsHeader = settingsHeader({
    eyebrow: "Augmentor capabilities",
    title: "Skills & Plugins",
    body: "Skills are internal Augmentor capabilities. Plugins are installed add-ons exposed through scoped grants, similar to how Codex surfaces skills and plugins."
  });
  const skillsGrid = document.createElement("div");
  skillsGrid.className = "settings-addon-grid settings-augmentor-skill-grid";
  skillsGrid.replaceChildren(...AUGMENTOR_SKILLS.map(skillCard));
  const pluginStatus = document.createElement("p");
  pluginStatus.className = "settings-status";
  pluginStatus.textContent = "Loading plugins...";
  const pluginGrid = document.createElement("div");
  pluginGrid.className = "settings-addon-grid";
  skillsPanel.append(skillsHeader, noteCard({
    title: "Available skills",
    body: "These are the built-in action surfaces Augmentor can use when the provider route and capability boundary allow it."
  }), skillsGrid, noteCard({
    title: "Available plugins",
    body: "Plugins remain replaceable add-ons. Augmentor can request work from them, but ResonantOS mediates capabilities and credentials."
  }), pluginStatus, pluginGrid);

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Personal settings",
      title: "User & Augmentor",
      body: "Set the human profile shown in ResonantOS and tune the additional Augmentor system prompt used by chat calls. Safety boundaries remain enforced by the host.",
    }),
    status,
    form,
    memoryPanel,
    skillsPanel,
  );

  const hydrate = async () => {
    const settings = await readPersonalizationSettings(storage, storageKeys);
    displayName.value = settings.profile.displayName;
    subtitle.value = settings.profile.subtitle;
    email.value = settings.profile.email;
    augmentorName.value = settings.augmentor.displayName;
    systemPrompt.value = settings.augmentor.systemPrompt;
    setStatus(status, "Identity settings loaded.", "success");
  };

  const hydrateMemory = async () => {
    if (!bridgeRequest) {
      setStatus(memoryStatus, "Memory bridge is unavailable in this runtime.", "warning");
      return;
    }
    try {
      const result = await bridge()("/memory/settings", { method: "GET" });
      const settings = result.settings ?? {};
      const memoryStatusResult = result.status ?? {};
      const memoryAddons = Array.isArray(result.memoryAddons) ? result.memoryAddons : [];
      const activeLabel = activeMemoryLabel(settings.activeMemoryAddon, memoryAddons);
      memoryMetrics.replaceChildren(
        metricCard({
          label: "Active memory",
          value: activeLabel,
          detail: `${memoryAddons.length} memory add-on${memoryAddons.length === 1 ? "" : "s"} registered`,
          tone: memoryAddons.length ? "success" : "warning"
        }),
        metricCard({
          label: "Wiki pages",
          value: String(memoryStatusResult.wiki?.pages ?? 0),
          detail: "curated AI memory pages"
        }),
        metricCard({
          label: "Intake",
          value: String(memoryStatusResult.intake?.artifacts ?? 0),
          detail: "raw/source artifacts"
        }),
        metricCard({
          label: "Sources",
          value: String(settings.sources?.length ?? 0),
          detail: settings.autoSync ? "auto-sync enabled" : settings.syncMode ?? "manual-review"
        })
      );
      setStatus(memoryStatus, `${activeLabel} is the active AI memory system.`, "success");
    } catch (error) {
      setStatus(memoryStatus, `Memory status unavailable: ${safeErrorMessage(error)}`, "error");
      memoryMetrics.replaceChildren();
    }
  };

  const hydratePlugins = async () => {
    if (!bridgeRequest) {
      setStatus(pluginStatus, "Plugin bridge is unavailable in this runtime.", "warning");
      return;
    }
    try {
      const result = await bridge()("/addons/status", { method: "GET" });
      const addons = Array.isArray(result.addons) ? result.addons : [];
      pluginGrid.replaceChildren(...addons.map(pluginCard));
      setStatus(pluginStatus, addons.length
        ? `${addons.filter((addon) => addon.available || addon.enabled).length}/${addons.length} plugins available.`
        : "No plugins registered.",
      addons.length ? "success" : "warning");
    } catch (error) {
      setStatus(pluginStatus, `Plugin status unavailable: ${safeErrorMessage(error)}`, "error");
      pluginGrid.replaceChildren();
    }
  };

  resetPrompt.addEventListener("click", () => {
    systemPrompt.value = DEFAULT_AUGMENTOR_SYSTEM_PROMPT;
    setStatus(status, "Augmentor prompt reset locally. Save to apply it.", "warning");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    setStatus(status, "Saving identity settings...");
    try {
      const next = await writePersonalizationSettings(storage, storageKeys, {
        profile: {
          displayName: displayName.value,
          subtitle: subtitle.value,
          email: email.value,
        },
        augmentor: {
          displayName: augmentorName.value,
          systemPrompt: systemPrompt.value,
        },
      });
      onProfileUpdated?.(next);
      setStatus(status, "Identity settings saved.", "success");
    } catch (error) {
      setStatus(status, `Save failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      save.disabled = false;
    }
  });

  void hydrate().catch((error) => {
    setStatus(status, `Identity settings unavailable: ${safeErrorMessage(error)}`, "error");
  });
  void hydrateMemory();
  void hydratePlugins();
}
