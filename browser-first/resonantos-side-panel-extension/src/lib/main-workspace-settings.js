import { renderAddonsSection } from "./settings/addons-section.js";
import { renderAboutSection } from "./settings/about-section.js";
import { renderAppearanceSection } from "./settings/appearance-section.js";
import { renderBridgeTargetSection } from "./settings/bridge-target-section.js";
import { renderBrowserControlSection } from "./settings/browser-control-section.js";
import { renderDiagnosticsSection } from "./settings/diagnostics-section.js";
import { renderMemorySection } from "./settings/memory-section.js";
import { renderOverviewSection } from "./settings/overview-section.js";
import { renderPersonalizationSection } from "./settings/personalization-section.js";
import { renderPrivacySection } from "./settings/privacy-section.js";
import { renderProvidersSection } from "./settings/providers-section.js";
import { renderRoutingSection } from "./settings/routing-section.js";
import { renderWorkSection } from "./settings/work-section.js";

const sections = [
  {
    id: "profile",
    label: "Profile",
    hint: "User and Augmentor",
    group: "Start here",
    render: renderPersonalizationSection
  },
  {
    id: "overview",
    label: "Start Here",
    hint: "Setup checklist",
    group: "Start here",
    render: renderOverviewSection
  },
  {
    id: "providers",
    label: "Providers",
    hint: "Models and credentials",
    group: "Start here",
    render: renderProvidersSection
  },
  {
    id: "memory",
    label: "Memory",
    hint: "Sources and sync",
    group: "Start here",
    render: renderMemorySection
  },
  {
    id: "work",
    label: "Chats & Projects",
    hint: "Archive and restore",
    group: "Work",
    render: renderWorkSection
  },
  {
    id: "browser-control",
    label: "Browser Control",
    hint: "AI permissions",
    group: "Work",
    render: renderBrowserControlSection
  },
  {
    id: "addons",
    label: "Add-ons",
    hint: "Permissions",
    group: "Work",
    render: renderAddonsSection
  },
  {
    id: "routing",
    label: "Routing",
    hint: "Cost and fallback",
    group: "Advanced",
    render: renderRoutingSection
  },
  {
    id: "privacy",
    label: "Privacy",
    hint: "Trust boundaries",
    group: "Advanced",
    render: renderPrivacySection
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    hint: "Logs and reports",
    group: "Advanced",
    render: renderDiagnosticsSection
  },
  {
    id: "bridge-target",
    label: "Bridge Target",
    hint: "Cross-machine bridge URL",
    group: "Advanced",
    render: renderBridgeTargetSection
  },
  {
    id: "appearance",
    label: "Appearance",
    hint: "Density and motion",
    group: "Advanced",
    render: renderAppearanceSection
  },
  {
    id: "about",
    label: "About",
    hint: "Version and architecture",
    group: "Advanced",
    render: renderAboutSection
  }
];

function groupedSectionButtons(activeId, onSelect) {
  const nodes = [];
  let currentGroup = "";
  for (const section of sections) {
    if (section.group !== currentGroup) {
      currentGroup = section.group;
      const label = document.createElement("span");
      label.className = "settings-nav-group-label";
      label.textContent = currentGroup;
      nodes.push(label);
    }
    nodes.push(sectionButton(section, activeId, onSelect));
  }
  return nodes;
}

function sectionButton(section, activeId, onSelect) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-nav-item";
  button.dataset.section = section.id;
  button.dataset.active = String(section.id === activeId);
  const label = document.createElement("strong");
  label.textContent = section.label;
  const hint = document.createElement("span");
  hint.textContent = section.hint;
  button.append(label, hint);
  button.addEventListener("click", () => onSelect(section.id));
  return button;
}

export function renderSettingsWorkspace({
  container,
  bridgeRequest,
  getBridgeRequest,
  chatSessionStore = null,
  onOpenSession = null,
  onOpenWorkspace = null,
  onProfileUpdated = null,
  onRestore = null,
  chromeApi = null,
  sitePermissionStore = null,
  taskConsentStore = null,
  storage = null,
  storageKeys = {},
  prefsSync = null,
  initialSection = "overview"
}) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  let activeId = sections.some((section) => section.id === initialSection) ? initialSection : "overview";
  const shell = document.createElement("section");
  shell.className = "settings-workspace";
  const nav = document.createElement("nav");
  nav.className = "settings-subnav";
  nav.setAttribute("aria-label", "Settings sections");
  const panel = document.createElement("div");
  panel.className = "settings-panel";

  const context = {
    bridgeRequest,
    getBridgeRequest: typeof getBridgeRequest === "function" ? getBridgeRequest : () => bridgeRequest,
    chromeApi,
    chatSessionStore,
    onSelectSection: (nextId) => {
      if (!sections.some((section) => section.id === nextId) || nextId === activeId) return;
      activeId = nextId;
      renderActive();
    },
    onOpenSession,
    onOpenWorkspace,
    onProfileUpdated,
    onRestore,
    sitePermissionStore,
    storage,
    storageKeys,
    taskConsentStore,
    prefsSync
  };

  const renderActive = () => {
    const activeSection = sections.find((section) => section.id === activeId) ?? sections[0];
    nav.replaceChildren(...groupedSectionButtons(activeId, (nextId) => {
      if (nextId === activeId) return;
      activeId = nextId;
      renderActive();
    }));
    activeSection.render(panel, { ...context, sectionId: activeSection.id });
  };

  shell.append(nav, panel);
  container.replaceChildren(shell);
  renderActive();
}
