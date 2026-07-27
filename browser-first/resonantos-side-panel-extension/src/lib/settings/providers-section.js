import { metricCard, noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";
import {
  formatLabel,
  modelLabel,
  modelValue,
  parseModelsText,
  providerModelsText,
  providerSort,
  providerTypeLabel,
  providerTypePresets
} from "./provider-catalog.js";

function labeledField({ label, input }) {
  const wrapper = document.createElement("label");
  wrapper.className = "settings-provider-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  wrapper.append(caption, input);
  return wrapper;
}

function providerAccountPayload(form, provider = {}) {
  const FormDataCtor = form.ownerDocument?.defaultView?.FormData ?? FormData;
  const data = new FormDataCtor(form);
  const templateId = String(data.get("templateId") ?? provider.templateId ?? provider.providerType ?? "minimax").trim();
  const preset = providerTypePresets[templateId] ?? providerTypePresets.minimax;
  return {
    id: provider.id,
    mode: provider.id ? "update" : "create",
    templateId,
    label: String(data.get("label") ?? "").trim(),
    providerType: preset.providerType,
    authType: "api-key",
    apiBaseUrl: String(data.get("apiBaseUrl") ?? "").trim(),
    role: String(data.get("role") ?? "").trim(),
    models: parseModelsText(data.get("models")),
    credential: String(data.get("credential") ?? "").trim(),
  };
}

function providerAccountForm(provider = {}) {
  const form = document.createElement("form");
  form.className = "settings-provider-account-form";

  const name = document.createElement("input");
  name.name = "label";
  name.required = true;
  name.placeholder = "MiniMax fast account";
  name.value = provider.label ?? "";

  const template = document.createElement("select");
  template.name = "templateId";
  let currentCategory = "";
  for (const [value, preset] of Object.entries(providerTypePresets)) {
    if (preset.category !== currentCategory) {
      currentCategory = preset.category;
      const group = document.createElement("option");
      group.disabled = true;
      group.textContent = `-- ${currentCategory} --`;
      template.append(group);
    }
    const option = document.createElement("option");
    option.value = value;
    option.textContent = preset.label;
    template.append(option);
  }
  template.value = provider.templateId ?? provider.providerType ?? "minimax";

  const apiBaseUrl = document.createElement("input");
  apiBaseUrl.name = "apiBaseUrl";
  apiBaseUrl.placeholder = "https://api.provider.com/v1";
  apiBaseUrl.value = provider.apiBaseUrl ?? providerTypePresets[template.value]?.apiBaseUrl ?? "";

  const role = document.createElement("input");
  role.name = "role";
  role.placeholder = "Fast Augmentor account, routine account, archive account...";
  role.value = provider.role ?? "";

  const models = document.createElement("textarea");
  models.name = "models";
  models.rows = 4;
  models.placeholder = "One model per line";
  models.value = providerModelsText(provider) || providerTypePresets[template.value]?.models.join("\n") || "";

  const credential = document.createElement("input");
  credential.name = "credential";
  credential.type = "password";
  credential.autocomplete = "off";
  credential.placeholder = provider.id ? "Leave blank to keep current credential" : "Paste account API key";

  template.addEventListener("change", () => {
    const preset = providerTypePresets[template.value] ?? providerTypePresets.minimax;
    name.placeholder = `${preset.label} account`;
    apiBaseUrl.value = preset.apiBaseUrl;
    models.value = preset.models.join("\n");
  });

  const grid = document.createElement("div");
  grid.className = "settings-provider-account-grid";
  grid.append(
    labeledField({ label: "Account name", input: name }),
    labeledField({ label: "Provider template", input: template }),
    labeledField({ label: "API base URL", input: apiBaseUrl }),
    labeledField({ label: "Role / cost note", input: role }),
    labeledField({ label: "Models enabled for this account", input: models }),
    labeledField({ label: provider.id ? "Replace credential" : "Credential", input: credential }),
  );
  form.append(grid);
  return form;
}

export function openProviderAccountModal({ bridgeRequest, getBridgeRequest, statusNode, reload }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const overlay = document.createElement("div");
  overlay.className = "settings-provider-modal";
  const panel = document.createElement("section");
  panel.className = "settings-provider-modal-panel";
  const heading = document.createElement("div");
  heading.className = "settings-provider-modal-heading";
  const title = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = "Add provider account";
  const body = document.createElement("p");
  body.textContent = "Create a separate account block for every subscription, API key, or local runtime. Multiple accounts can share the same provider type.";
  title.append(strong, body);
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  heading.append(title, close);
  const form = providerAccountForm();
  const actions = document.createElement("div");
  actions.className = "settings-provider-modal-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save account";
  actions.append(save);
  form.append(actions);
  // Status lives INSIDE the modal so save progress and — critically — save
  // failures are shown to the user while the dialog is still open. Writing them
  // to the settings page behind the modal (the old behavior) hid the error and
  // left the dialog stuck with no signal (#271).
  const modalStatus = document.createElement("p");
  modalStatus.className = "settings-provider-modal-status";
  modalStatus.setAttribute("role", "status");
  modalStatus.setAttribute("aria-live", "polite");
  panel.append(heading, form, modalStatus);
  overlay.append(panel);
  document.body.append(overlay);
  close.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    setStatus(modalStatus, "Saving provider account…");
    try {
      await bridge()("/providers/accounts", {
        method: "POST",
        capability: "provider-credential-write",
        body: providerAccountPayload(form),
      });
      // Success: close the dialog, then surface confirmation on the settings page.
      overlay.remove();
      setStatus(statusNode, "Provider account saved.", "success");
      await reload();
    } catch (error) {
      // Failure: keep the dialog open and show the reason in the dialog so the
      // user can correct the input and retry — do not write it behind the modal.
      setStatus(modalStatus, `Save failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      save.disabled = false;
    }
  });
}

function modelBadges(provider) {
  const chain = document.createElement("div");
  chain.className = "settings-route-chain";
  const models = provider.models ?? [];
  if (!models.length) {
    const empty = document.createElement("span");
    empty.className = "settings-route-badge";
    empty.dataset.state = "unavailable";
    empty.textContent = "No models declared";
    chain.append(empty);
    return chain;
  }
  for (const model of models) {
    const badge = document.createElement("span");
    badge.className = "settings-route-badge";
    badge.dataset.state = model.allowed === false ? "disabled" : provider.configured ? "available" : "unavailable";
    badge.textContent = `${modelLabel(model)} · ${formatLabel(model.costTier)} · ${formatLabel(model.qualityTier)}${model.allowed === false ? " · disabled" : ""}`;
    chain.append(badge);
  }
  return chain;
}

function routeConsumerList(provider) {
  const list = document.createElement("ul");
  list.className = "settings-provider-consumers";
  const consumers = provider.routeConsumers ?? [];
  if (!consumers.length) {
    const item = document.createElement("li");
    item.textContent = "No routing strategies currently depend on this provider.";
    list.append(item);
    return list;
  }
  for (const consumer of consumers) {
    const item = document.createElement("li");
    const labelNode = document.createElement("strong");
    labelNode.textContent = consumer.label;
    const detail = document.createElement("span");
    detail.textContent = `${formatLabel(consumer.workload)} · ${consumer.hardStop ? "hard-stop" : "fallback allowed"} · ${consumer.routeState}`;
    item.append(labelNode, detail);
    list.append(item);
  }
  return list;
}

export function diagnosticRecoverySuggestions(entries = []) {
  const byProvider = new Map();
  for (const entry of entries.slice(0, 12)) {
    const key = entry.providerId || entry.label || "unknown";
    if (!byProvider.has(key)) byProvider.set(key, []);
    byProvider.get(key).push(entry);
  }
  const suggestions = [];
  for (const providerEntries of byProvider.values()) {
    const latest = providerEntries[0] ?? {};
    const label = latest.label || latest.providerId || "Provider";
    const authFailures = providerEntries.filter((entry) => entry.state === "auth-failed").length;
    const networkFailures = providerEntries.filter((entry) => ["network-failed", "unreachable"].includes(entry.state)).length;
    if (latest.state === "missing-credential") {
      suggestions.push({
        providerId: latest.providerId,
        state: "missing-credential",
        title: `${label}: save a credential`,
        body: "Add or restore the provider credential for this host session, then run Test connection again."
      });
      continue;
    }
    if (authFailures >= 2) {
      suggestions.push({
        providerId: latest.providerId,
        state: "auth-failed",
        title: `${label}: credential recovery needed`,
        body: "Update or replace the stored credential, confirm the account/subscription is active, then run Test connection again."
      });
      continue;
    }
    if (networkFailures >= 2) {
      suggestions.push({
        providerId: latest.providerId,
        state: "network-failed",
        title: `${label}: network route unstable`,
        body: "Check internet, VPN, firewall, provider status, or local runtime availability. If this is urgent, switch Routing to an available fallback."
      });
      continue;
    }
    if (latest.state === "reachable") {
      suggestions.push({
        providerId: latest.providerId,
        state: "reachable",
        title: `${label}: no recovery action needed`,
        body: "The provider endpoint was reachable during the latest bounded connectivity test."
      });
    }
  }
  return suggestions;
}

function diagnosticsHistoryPanel() {
  const section = document.createElement("section");
  section.className = "settings-note settings-provider-diagnostics";
  const heading = document.createElement("strong");
  heading.textContent = "Recent provider diagnostics";
  const body = document.createElement("p");
  body.textContent = "Recent connection checks are saved locally with redacted details so repeated failures can be compared without rerunning diagnostics.";
  const recovery = document.createElement("div");
  recovery.className = "settings-provider-recovery";
  const recoveryTitle = document.createElement("small");
  recoveryTitle.textContent = "Suggested recovery";
  const recoveryList = document.createElement("ul");
  recoveryList.className = "settings-provider-recovery-list";
  recovery.append(recoveryTitle, recoveryList);
  const list = document.createElement("ol");
  list.className = "settings-provider-history-list";
  section.append(heading, body, recovery, list);
  return {
    section,
    render(entries = []) {
      recoveryList.replaceChildren();
      for (const suggestion of diagnosticRecoverySuggestions(entries)) {
        const item = document.createElement("li");
        item.className = "settings-provider-recovery-row";
        item.dataset.state = suggestion.state;
        const title = document.createElement("strong");
        title.textContent = suggestion.title;
        const detail = document.createElement("span");
        detail.textContent = suggestion.body;
        item.append(title, detail);
        recoveryList.append(item);
      }
      recovery.hidden = recoveryList.children.length === 0;
      list.replaceChildren();
      const visible = entries.slice(0, 6);
      if (!visible.length) {
        const empty = document.createElement("li");
        empty.className = "settings-work-empty";
        empty.textContent = "No provider diagnostics have been recorded yet.";
        list.append(empty);
        return;
      }
      for (const entry of visible) {
        const item = document.createElement("li");
        item.className = "settings-provider-history-row";
        item.dataset.state = entry.state ?? "unknown";
        const title = document.createElement("strong");
        title.textContent = `${entry.label || entry.providerId || "Provider"} · ${formatLabel(entry.state)}`;
        const meta = document.createElement("small");
        const latency = typeof entry.latencyMs === "number" ? ` · ${entry.latencyMs}ms` : "";
        const status = typeof entry.status === "number" ? ` · HTTP ${entry.status}` : "";
        meta.textContent = `${entry.testedAt || "recently"}${status}${latency}`;
        const detail = document.createElement("span");
        detail.textContent = entry.detail || "No detail recorded.";
        item.append(title, meta, detail);
        list.append(item);
      }
    }
  };
}

function providerCard({ provider, bridgeRequest, getBridgeRequest, statusNode, reload, onSelectSection }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const card = document.createElement("article");
  card.className = "settings-provider-card";
  card.dataset.configured = String(Boolean(provider.configured));

  const heading = document.createElement("div");
  heading.className = "settings-provider-heading";
  const title = document.createElement("div");
  const label = document.createElement("strong");
  label.textContent = provider.label;
  const role = document.createElement("p");
  role.textContent = provider.role;
  title.append(label, role);

  const summary = document.createElement("div");
  summary.className = "settings-provider-summary";
  const type = document.createElement("span");
  type.textContent = providerTypeLabel(provider);
  const modelsCount = document.createElement("span");
  modelsCount.textContent = `${(provider.models ?? []).length} model${(provider.models ?? []).length === 1 ? "" : "s"}`;
  const badge = document.createElement("span");
  badge.textContent = provider.configured ? "Ready" : "Missing";
  badge.dataset.state = provider.configured ? "ready" : "missing";
  summary.append(type, modelsCount, badge);
  heading.append(title, summary);

  const meta = document.createElement("p");
  meta.className = "settings-model-list";
  meta.textContent = `Provider type: ${providerTypeLabel(provider)} · Account ID: ${provider.id} · ${provider.source === "user" ? "user account" : "built-in account"}`;

  const auth = document.createElement("p");
  auth.className = "settings-model-list";
  const credentialState = provider.credentialPreview === "session"
    ? "session-only in host memory"
    : provider.credentialPreview === "stored"
      ? "configured in host credential store"
      : "missing";
  auth.textContent = `Auth: ${formatLabel(provider.authType)} · Credential: ${credentialState}`;

  const form = document.createElement("form");
  form.className = "settings-provider-form";
  const input = document.createElement("input");
  input.type = "password";
  input.name = "credential";
  input.autocomplete = "off";
  input.placeholder = provider.configured ? "Replace key" : "Paste key";
  input.setAttribute("aria-label", `${provider.label} credential`);
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = provider.configured ? "Update" : "Save";
  form.append(input, save);
  if (provider.source === "user") {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "settings-provider-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${provider.label} provider`);
    remove.addEventListener("click", async () => {
      const confirmRemoval = typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(`Remove the ${provider.label} provider? Routing strategies that use its models will revert to defaults.`)
        : true;
      if (!confirmRemoval) {
        return;
      }
      remove.disabled = true;
      setStatus(statusNode, `Removing ${provider.label}...`);
      try {
        await bridge()("/providers/accounts/remove", {
          method: "POST",
          capability: "provider-credential-write",
          body: { providerId: provider.id }
        });
        setStatus(statusNode, `${provider.label} removed.`, "success");
        await reload();
      } catch (error) {
        setStatus(statusNode, `Remove failed: ${safeErrorMessage(error)}`, "error");
        remove.disabled = false;
      }
    });
    form.append(remove);
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const credential = input.value.trim();
    if (!credential) {
      setStatus(statusNode, `Add a ${provider.label} credential before saving.`, "warning");
      return;
    }
    save.disabled = true;
    setStatus(statusNode, `Saving ${provider.label} credential...`);
    try {
      await bridge()("/providers/credentials", {
        method: "POST",
        capability: "provider-credential-write",
        body: { providerId: provider.id, credential }
      });
      input.value = "";
      setStatus(statusNode, `${provider.label} credential saved for this host session.`, "success");
      await reload();
    } catch (error) {
      setStatus(statusNode, `Save failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      save.disabled = false;
    }
  });

  const detailsPanel = document.createElement("div");
  detailsPanel.className = "settings-provider-panel";
  detailsPanel.hidden = true;
  const consumersTitle = document.createElement("small");
  consumersTitle.className = "settings-provider-subtitle";
  consumersTitle.textContent = "Used by routing strategies";
  detailsPanel.append(meta, auth, modelBadges(provider), consumersTitle, routeConsumerList(provider));

  const modelPolicy = document.createElement("form");
  modelPolicy.className = "settings-provider-model-policy";
  const policyTitle = document.createElement("small");
  policyTitle.className = "settings-provider-subtitle";
  policyTitle.textContent = "Allowed models";
  const modelOptions = document.createElement("div");
  modelOptions.className = "settings-provider-model-options";
  for (const model of provider.models ?? []) {
    const labelNode = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "allowedModel";
    checkbox.value = modelValue(model);
    checkbox.checked = model.allowed !== false;
    const text = document.createElement("span");
    text.textContent = modelLabel(model);
    labelNode.append(checkbox, text);
    modelOptions.append(labelNode);
  }
  const savePolicy = document.createElement("button");
  savePolicy.type = "submit";
  savePolicy.textContent = "Save allowed models";
  modelPolicy.append(policyTitle, modelOptions, savePolicy);
  modelPolicy.addEventListener("submit", async (event) => {
    event.preventDefault();
    const allowedModels = [...modelPolicy.querySelectorAll("input[name='allowedModel']:checked")]
      .map((input) => input.value);
    if (!allowedModels.length) {
      setStatus(statusNode, "At least one model must remain allowed for a provider.", "warning");
      return;
    }
    savePolicy.disabled = true;
    setStatus(statusNode, `Saving ${provider.label} allowed-model policy...`);
    try {
      await bridge()("/providers/model-preferences", {
        method: "POST",
        capability: "provider-routing-write",
        body: { providerId: provider.id, allowedModels }
      });
      setStatus(statusNode, `${provider.label} allowed-model policy saved.`, "success");
      await reload();
    } catch (error) {
      setStatus(statusNode, `Allowed-model save failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      savePolicy.disabled = false;
    }
  });

  const editPanel = document.createElement("div");
  editPanel.className = "settings-provider-panel settings-provider-panel-edit";
  editPanel.hidden = true;
  const editForm = providerAccountForm(provider);
  const editActions = document.createElement("div");
  editActions.className = "settings-provider-actions";
  const editSave = document.createElement("button");
  editSave.type = "submit";
  editSave.textContent = "Save account settings";
  editActions.append(editSave);
  editForm.append(editActions);
  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    editSave.disabled = true;
    setStatus(statusNode, `Saving ${provider.label} account settings...`);
    try {
      await bridge()("/providers/accounts", {
        method: "POST",
        capability: "provider-credential-write",
        body: providerAccountPayload(editForm, provider)
      });
      setStatus(statusNode, `${provider.label} account settings saved.`, "success");
      await reload();
    } catch (error) {
      setStatus(statusNode, `Account settings save failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      editSave.disabled = false;
    }
  });
  editPanel.append(editForm, modelPolicy, form);

  const actions = document.createElement("div");
  actions.className = "settings-provider-actions settings-provider-row-actions";
  const show = document.createElement("button");
  show.type = "button";
  show.textContent = "Details";
  show.dataset.action = "show-provider";
  show.addEventListener("click", () => {
    detailsPanel.hidden = !detailsPanel.hidden;
    show.textContent = detailsPanel.hidden ? "Details" : "Hide details";
  });
  actions.append(show);
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "Edit";
  edit.dataset.action = "edit-provider";
  edit.addEventListener("click", () => {
    editPanel.hidden = !editPanel.hidden;
    edit.textContent = editPanel.hidden ? "Edit" : "Close edit";
  });
  actions.append(edit);

  const moreTools = document.createElement("details");
  moreTools.className = "settings-provider-more";
  const moreSummary = document.createElement("summary");
  moreSummary.textContent = "More";
  const morePanel = document.createElement("div");
  morePanel.className = "settings-provider-more-panel";

  const health = document.createElement("button");
  health.type = "button";
  health.textContent = "Check readiness";
  health.addEventListener("click", async () => {
    health.disabled = true;
    setStatus(statusNode, `Checking ${provider.label} readiness...`);
    try {
      const result = await bridge()("/providers/health", {
        method: "POST",
        body: { providerId: provider.id }
      });
      const tone = result.state === "ready" ? "success" : result.state === "degraded" ? "warning" : "error";
      setStatus(statusNode, `${result.label}: ${result.detail}`, tone);
    } catch (error) {
      setStatus(statusNode, `Health check failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      health.disabled = false;
    }
  });
  morePanel.append(health);
  const connectivity = document.createElement("button");
  connectivity.type = "button";
  connectivity.textContent = "Test connection";
  connectivity.addEventListener("click", async () => {
    connectivity.disabled = true;
    setStatus(statusNode, `Testing ${provider.label} endpoint reachability...`);
    try {
      const result = await bridge()("/providers/connectivity-test", {
        method: "POST",
        body: { providerId: provider.id }
      });
      const tone = result.state === "reachable" ? "success" : result.state === "missing-credential" ? "warning" : "error";
      const latency = typeof result.latencyMs === "number" ? ` · ${result.latencyMs}ms` : "";
      await reload();
      setStatus(statusNode, `${result.label}: ${result.detail}${latency}`, tone);
    } catch (error) {
      setStatus(statusNode, `Connection test failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      connectivity.disabled = false;
    }
  });
  morePanel.append(connectivity);
  const routing = document.createElement("button");
  routing.type = "button";
  routing.textContent = "Open routing";
  routing.addEventListener("click", () => {
    if (typeof onSelectSection === "function") {
      onSelectSection("routing");
    }
  });
  morePanel.append(routing);
  moreTools.append(moreSummary, morePanel);
  actions.append(moreTools);

  card.append(heading, actions, detailsPanel, editPanel);
  return card;
}

export function renderProvidersSection(container, { bridgeRequest, getBridgeRequest, onSelectSection }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const statusNode = document.createElement("p");
  statusNode.className = "settings-status";
  statusNode.textContent = "Loading provider profiles...";

  const grid = document.createElement("div");
  grid.className = "settings-provider-grid";
  const vaultGrid = document.createElement("div");
  vaultGrid.className = "settings-health-grid";
  const history = diagnosticsHistoryPanel();
  const advanced = document.createElement("details");
  advanced.className = "settings-provider-advanced";
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = "Advanced provider diagnostics";
  const advancedBody = document.createElement("div");
  advancedBody.className = "settings-provider-advanced-body";
  const securityNote = noteCard({
    title: "Security boundary",
    body: "Add-ons can request model access, but they do not receive raw provider credentials. The host resolves approved requests through scoped provider grants."
  });
  advancedBody.append(history.section, securityNote);
  advanced.append(advancedSummary, advancedBody);
  const toolbar = document.createElement("div");
  toolbar.className = "settings-provider-toolbar";
  const addProvider = document.createElement("button");
  addProvider.type = "button";
  addProvider.className = "settings-primary-action";
  addProvider.textContent = "Add provider account";
  toolbar.append(addProvider);

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Providers and models",
      title: "Provider Profiles",
      body: "Configure model accounts for Augmentor, Agent Control, and approved add-ons. Alpha credentials stay in session-only host memory or environment configuration; raw keys are not persisted by the extension host."
    }),
    toolbar,
    statusNode,
    vaultGrid,
    grid,
    advanced
  );

  addProvider.addEventListener("click", () => openProviderAccountModal({
    bridgeRequest,
    getBridgeRequest: () => bridgeRequest,
    statusNode,
    reload: load,
  }));

  const load = async () => {
    const [result, historyResult] = await Promise.all([
      bridge()("/providers/status", { method: "GET" }),
      bridge()("/providers/diagnostics-history", { method: "GET" }).catch(() => ({ entries: [] }))
    ]);
    const providers = [...(result.providers ?? [])].sort(providerSort);
    const configuredCount = providers.filter((provider) => provider.configured).length;
    const consumerCount = providers.reduce((total, provider) => total + (provider.routeConsumers?.length ?? 0), 0);
    vaultGrid.replaceChildren(
      metricCard({
        label: "Credential store",
        value: result.vault?.persistence === "session-only"
          ? "Session-only"
          : result.vault?.configured ? "Created" : "Missing",
        detail: result.vault?.location ?? "session-only host credential store",
        tone: result.vault?.configured ? "success" : "warning"
      }),
      metricCard({
        label: "Configured",
        value: `${configuredCount}/${providers.length}`,
        detail: "provider profiles with active session/env credentials",
        tone: configuredCount ? "success" : "warning"
      }),
      metricCard({
        label: "Model routes",
        value: String(consumerCount),
        detail: "routing strategy dependencies shown below"
      })
    );
    grid.replaceChildren(...providers.map((provider) => providerCard({
      provider,
      bridgeRequest,
      getBridgeRequest: () => bridgeRequest,
      statusNode,
      reload: load,
      onSelectSection
    })));
    history.render(historyResult.entries ?? []);
    setStatus(statusNode, providers.length
      ? `${configuredCount}/${providers.length} provider profiles configured.`
      : "No provider profiles are registered.",
      providers.length && providers.every((provider) => provider.configured) ? "success" : "warning"
    );
  };

  void load().catch((error) => {
    setStatus(statusNode, `Provider status unavailable: ${safeErrorMessage(error)}`, "error");
  });
}
