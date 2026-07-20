import { noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";
import { capabilityReviewElement, capabilityReviewState } from "../addon-capability-review.js";

function addonTone(addon) {
  if (addon.available || addon.enabled) return "success";
  return "warning";
}

function addonBoundary(addon) {
  if (addon.boundary) return addon.boundary;
  if (/draft-only/i.test(addon.mode ?? "")) {
    return "Draft-only add-ons can prepare packets, but sending and scheduling stay human-approval gated.";
  }
  if (addon.mode === "memory-system") {
    return "Memory add-ons use scoped archive APIs. Direct trusted wiki writes remain blocked.";
  }
  if (/coding/i.test(addon.mode ?? "")) {
    return "Coding add-ons receive bounded delegation packets and return artifacts through ResonantOS.";
  }
  return "Add-ons are replaceable capabilities. They are not trusted core agents unless explicitly granted scoped authority.";
}

function addonCapabilitySummary(addon) {
  const state = capabilityReviewState(addon);
  const parts = [];
  if (state.granted.length) parts.push(`${state.granted.length} granted`);
  if (state.pending.length) parts.push(`${state.pending.length} needs review`);
  if (state.denied.length) parts.push(`${state.denied.length} denied`);
  return parts.length ? parts.join(" · ") : "Explicit grants required";
}

function addonDisclosure(title, body, children = []) {
  const details = document.createElement("details");
  details.className = "settings-addon-disclosure";
  const summary = document.createElement("summary");
  summary.textContent = title;
  const panel = document.createElement("div");
  panel.className = "settings-addon-disclosure-body";
  if (body) {
    const copy = document.createElement("p");
    copy.textContent = body;
    panel.append(copy);
  }
  panel.append(...children);
  details.append(summary, panel);
  return details;
}

function addonCard(addon, actions = {}) {
  const card = document.createElement("article");
  card.className = "settings-addon-card";
  card.dataset.tone = addonTone(addon);

  const header = document.createElement("div");
  header.className = "settings-provider-heading";
  const title = document.createElement("div");
  const label = document.createElement("strong");
  label.textContent = addon.name || addon.id || "Unnamed add-on";
  const role = document.createElement("p");
  role.textContent = `${addon.mode || "unknown mode"} · ${addon.trust || addon.provenance || "explicit grants required"}`;
  title.append(label, role);
  const badge = document.createElement("span");
  badge.textContent = addon.available || addon.enabled ? "Available" : "Missing";
  header.append(title, badge);

  const boundary = document.createElement("p");
  boundary.textContent = addonBoundary(addon);

  const summary = document.createElement("small");
  summary.className = "settings-addon-summary";
  summary.textContent = addonCapabilitySummary(addon);

  const executionPanel = document.createElement("div");
  executionPanel.className = "settings-addon-execution";
  const executionState = Boolean(addon.execution?.localCliExecution);
  if (["addon.hermes", "addon.opencode"].includes(addon.id)) {
    const text = document.createElement("small");
    text.textContent = executionState
      ? "Local CLI execution enabled. Tasks still run through governed packets and reviewable artifacts."
      : "Local CLI execution disabled. Delegations create packets and deterministic/lifecycle artifacts only.";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = executionState ? "Disable local execution" : "Enable local execution";
    toggle.addEventListener("click", () => actions.onToggleExecution?.(addon, !executionState));
    executionPanel.append(text, toggle);
  }

  const capabilities = addonDisclosure(
    "Capabilities and grants",
    "Review exactly what this add-on can request, what is granted, and what remains denied or pending.",
    [capabilityReviewElement(addon)]
  );

  card.append(header, boundary, summary, capabilities);
  if (executionPanel.childNodes.length) {
    card.append(addonDisclosure(
      "Runtime controls",
      "Local execution is optional and remains governed by ResonantOS packets and artifacts.",
      [executionPanel]
    ));
  }
  return card;
}

export function renderAddonsSection(container, { bridgeRequest, getBridgeRequest }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const statusNode = document.createElement("p");
  statusNode.className = "settings-status";
  statusNode.textContent = "Loading add-on registry...";
  const grid = document.createElement("div");
  grid.className = "settings-addon-grid";

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Add-ons and permissions",
      title: "Add-on Control",
      body: "Enable replaceable capabilities without lock-in. Start by checking availability and trust posture; open details only when you need grants or runtime controls."
    }),
    statusNode,
    noteCard({
      title: "Permission rule",
      body: "Add-ons declare requirements. ResonantOS mediates provider, memory, browser, filesystem, and future wallet access through scoped capability grants."
    }),
    grid
  );

  const load = async () => {
    const result = await bridge()("/addons/status", { method: "GET" });
    const addons = Array.isArray(result.addons) ? result.addons : [];
    grid.replaceChildren(...addons.map((addon) => addonCard(addon, {
      onToggleExecution: async (selected, enabled) => {
        const addon = selected.id === "addon.hermes" ? "hermes" : "opencode";
        setStatus(statusNode, `${enabled ? "Enabling" : "Disabling"} ${selected.name} local execution...`);
        await bridge()("/addons/execution-settings", {
          method: "POST",
          capability: "addon-execution-settings-write",
          body: { addon, localCliExecution: enabled }
        });
        await load();
      }
    })));
    setStatus(statusNode, addons.length
      ? `${addons.filter((addon) => addon.available || addon.enabled).length}/${addons.length} add-ons available. Missing add-ons stay disabled until installed or configured.`
      : "No add-ons are visible to this browser-first host yet.",
      addons.some((addon) => addon.available || addon.enabled) ? "success" : "warning"
    );
  };

  void load().catch((error) => {
    setStatus(statusNode, `Add-on registry unavailable: ${safeErrorMessage(error)}`, "error");
  });
}
