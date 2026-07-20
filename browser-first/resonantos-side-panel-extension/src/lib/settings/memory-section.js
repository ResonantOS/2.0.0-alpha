import { metricCard, noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";

function sourceLabel(source) {
  const kind = source.kind === "obsidian-vault" ? "Obsidian vault" : "Folder";
  const ownership = String(source.ownership ?? "mixed-library").replace(/-/g, " ");
  const mode = String(source.importMode ?? "copy-on-import").replace(/-/g, " ");
  const state = source.disabledAt ? "disabled" : (source.exists ? "found" : "missing");
  return `${kind} · ${ownership} · ${mode} · ${state}`;
}

function sourceRow(source, actions = {}) {
  const row = document.createElement("li");
  row.className = "settings-control-row";
  if (source.disabledAt) {
    row.dataset.disabled = "true";
  }
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = source.path || "Unnamed source";
  const meta = document.createElement("small");
  meta.textContent = sourceLabel(source);
  copy.append(title, meta);
  if (source.id && !source.placeholder) {
    const controls = document.createElement("span");
    controls.className = "settings-inline-actions";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = source.disabledAt ? "Enable" : "Disable";
    toggle.setAttribute("aria-label", `${source.disabledAt ? "Enable" : "Disable"} memory source ${source.path}`);
    toggle.addEventListener("click", () => source.disabledAt ? actions.onEnable?.(source) : actions.onDisable?.(source));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove memory source ${source.path}`);
    remove.addEventListener("click", () => actions.onRemove?.(source));
    controls.append(toggle);
    if (source.importMode === "move-on-import" && source.ledgerPath) {
      const rollback = document.createElement("button");
      rollback.type = "button";
      rollback.textContent = "Rollback";
      rollback.setAttribute("aria-label", `Rollback moved memory source ${source.path}`);
      rollback.addEventListener("click", () => actions.onRollback?.(source));
      controls.append(rollback);
    }
    controls.append(remove);
    row.append(copy, controls);
    return row;
  }
  row.append(copy);
  return row;
}

function scanSummaryCard(summary) {
  const card = document.createElement("section");
  card.className = "settings-note settings-source-scan";
  const title = document.createElement("strong");
  title.textContent = summary.path || "Source scan";
  const categories = summary.categories ?? {};
  const body = document.createElement("p");
  body.textContent = [
    `${summary.totalScanned ?? 0} file(s) scanned${summary.limitReached ? " · limit reached" : ""}`,
    `${categories.compatible ?? 0} compatible`,
    `${categories.processed ?? 0} processed`,
    `${categories["raw-audio"] ?? 0} raw audio`,
    `${categories.media ?? 0} media`,
    `${categories.unsupported ?? 0} unsupported`,
    `${categories.hidden ?? 0} hidden`
  ].join(" · ");
  const recommendation = document.createElement("p");
  recommendation.textContent = summary.recommendation ?? "Review this source before registering it.";
  card.append(title, body, recommendation);
  return card;
}

function syncHistoryCard(entry) {
  const card = document.createElement("section");
  card.className = "settings-note settings-source-sync-history";
  const title = document.createElement("strong");
  title.textContent = "Last source sync";
  if (!entry) {
    const empty = document.createElement("p");
    empty.textContent = "No source sync has run yet.";
    card.append(title, empty);
    return card;
  }
  const summary = document.createElement("p");
  summary.textContent = [
    entry.finishedAt ? `finished ${entry.finishedAt}` : `started ${entry.startedAt ?? "unknown time"}`,
    entry.status ?? "unknown",
    `${entry.reviewedSources ?? 0} source(s) reviewed`,
    `${entry.eligibleFiles ?? 0} new/changed`,
    `${entry.createdArtifacts ?? 0} intake artifact(s)`,
    `${entry.reviewRequests ?? 0} review request(s)`,
    `${entry.skippedSources?.length ?? 0} skipped`
  ].join(" · ");
  const mode = document.createElement("small");
  mode.textContent = entry.autoIntake
    ? "Auto intake + review created raw intake artifacts only; trusted AI Memory still requires review, draft, verification, and promotion."
    : "Review-only sync found candidates but did not create intake artifacts.";
  card.append(title, summary, mode);
  if (entry.sources?.length) {
    const details = document.createElement("details");
    details.className = "settings-source-sync-details";
    const detailSummary = document.createElement("summary");
    detailSummary.textContent = "Inspect source outcome";
    const list = document.createElement("ol");
    for (const source of entry.sources.slice(0, 5)) {
      const item = document.createElement("li");
      const heading = document.createElement("strong");
      heading.textContent = `${source.sourceId || "source"} · ${source.status || "reviewed"}`;
      const counts = document.createElement("p");
      counts.textContent = [
        `${source.candidates ?? 0} candidate(s)`,
        `${source.eligibleFiles ?? 0} new/changed`,
        `${source.createdArtifacts ?? 0} intake artifact(s)`,
        `${source.reviewRequests ?? 0} review request(s)`,
        `${source.rejectedFiles ?? 0} rejected`
      ].join(" · ");
      item.append(heading, counts);
      if (source.eligibleFileSamples?.length) {
        const files = document.createElement("small");
        files.textContent = `Files: ${source.eligibleFileSamples.slice(0, 5).join(", ")}`;
        item.append(files);
      }
      if (source.createdArtifactSamples?.length) {
        const artifacts = document.createElement("small");
        artifacts.textContent = `Intake: ${source.createdArtifactSamples.slice(0, 3).map((artifact) => `${artifact.sourceFile || "file"} → ${artifact.path || "artifact"}`).join(" · ")}`;
        item.append(artifacts);
      }
      list.append(item);
    }
    details.append(detailSummary, list);
    card.append(details);
  }
  if (entry.skippedSources?.length) {
    const skipped = document.createElement("ol");
    skipped.className = "settings-source-sync-skipped";
    for (const source of entry.skippedSources.slice(0, 3)) {
      const item = document.createElement("li");
      item.textContent = `${source.path || source.sourceId}: ${source.reason || "skipped"}`;
      skipped.append(item);
    }
    card.append(skipped);
  }
  return card;
}

function repairHistoryCard(entry) {
  const card = document.createElement("section");
  card.className = "settings-note settings-source-repair-history";
  const title = document.createElement("strong");
  title.textContent = "Last source repair";
  if (!entry) {
    const empty = document.createElement("p");
    empty.textContent = "No source-version repair has run yet.";
    card.append(title, empty);
    return card;
  }
  const summary = document.createElement("p");
  summary.textContent = [
    entry.repairedAt ? `repaired ${entry.repairedAt}` : "unknown time",
    entry.status ?? "unknown",
    entry.sourceId ?? "source",
    entry.sourcePath ? `source ${entry.sourcePath}` : "",
    entry.backupPath ? `backup ${entry.backupPath}` : ""
  ].filter(Boolean).join(" · ");
  const mode = document.createElement("small");
  mode.textContent = entry.message || "A source-version manifest repair was recorded. Review the source again before intake.";
  card.append(title, summary, mode);
  return card;
}

function moveHistoryCard(entry) {
  const card = document.createElement("section");
  card.className = "settings-note settings-source-move-history";
  const title = document.createElement("strong");
  title.textContent = "Last source move";
  if (!entry) {
    const empty = document.createElement("p");
    empty.textContent = "No move-on-import operation has run yet.";
    card.append(title, empty);
    return card;
  }
  const summary = document.createElement("p");
  summary.textContent = [
    entry.at ?? "unknown time",
    entry.action ?? "move",
    entry.status ?? "unknown",
    entry.sourceId ?? "",
    entry.originalPath ? `from ${entry.originalPath}` : "",
    entry.managedPath ? `to ${entry.managedPath}` : "",
    entry.ledgerPath ? `ledger ${entry.ledgerPath}` : ""
  ].filter(Boolean).join(" · ");
  const mode = document.createElement("small");
  mode.textContent = entry.message || "Move-on-import history records managed source relocation and rollback evidence.";
  card.append(title, summary, mode);
  return card;
}

function movePreflightCard(preflight, onExecute) {
  const card = document.createElement("section");
  card.className = "settings-note settings-source-scan";
  card.dataset.tone = preflight.okToMove ? "warning" : "error";
  const title = document.createElement("strong");
  title.textContent = preflight.okToMove ? "Move preflight ready" : "Move preflight blocked";
  const body = document.createElement("p");
  body.textContent = [
    `${preflight.fileCount ?? 0} file(s)`,
    `${preflight.directoryCount ?? 0} folder(s)`,
    `${preflight.hiddenFiles ?? 0} hidden file(s)`,
    `${Math.ceil((preflight.totalBytes ?? 0) / 1024)} KB`,
  ].join(" · ");
  const paths = document.createElement("p");
  paths.textContent = `From ${preflight.sourcePath} → ${preflight.destinationRoot}`;
  card.append(title, body, paths);
  if (!preflight.okToMove) {
    const blocked = document.createElement("p");
    blocked.textContent = `Blocked: ${(preflight.blocked ?? []).map((entry) => entry.reason).join(", ") || "unknown"}`;
    card.append(blocked);
    return card;
  }
  const warning = document.createElement("p");
  warning.textContent = `This moves the folder into ResonantOS Memory and makes that managed copy canonical. The engine verifies file hashes and writes a rollback ledger before registration. To execute, type exactly: ${preflight.confirmationPhrase}`;
  const confirm = document.createElement("input");
  confirm.type = "text";
  confirm.placeholder = preflight.confirmationPhrase;
  confirm.setAttribute("aria-label", "Move import confirmation phrase");
  const execute = document.createElement("button");
  execute.type = "button";
  execute.textContent = "Execute Move Import";
  execute.disabled = true;
  confirm.addEventListener("input", () => {
    execute.disabled = confirm.value !== preflight.confirmationPhrase;
  });
  execute.addEventListener("click", () => onExecute?.(preflight, confirm.value, execute));
  card.append(warning, confirm, execute);
  return card;
}

function option(value, text, selected) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  node.selected = selected;
  return node;
}

export function renderMemorySection(container, { bridgeRequest, getBridgeRequest, onOpenWorkspace = null }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const statusNode = document.createElement("p");
  statusNode.className = "settings-status";
  statusNode.textContent = "Loading memory settings...";
  const metrics = document.createElement("div");
  metrics.className = "settings-health-grid";
  const sourceList = document.createElement("ol");
  sourceList.className = "settings-control-list";
  const syncHistoryPanel = document.createElement("div");
  syncHistoryPanel.className = "settings-source-sync-panel";
  const repairHistoryPanel = document.createElement("div");
  repairHistoryPanel.className = "settings-source-repair-panel";
  const moveHistoryPanel = document.createElement("div");
  moveHistoryPanel.className = "settings-source-move-panel";
  const scanPanel = document.createElement("div");
  scanPanel.className = "settings-source-scan-panel";
  const form = document.createElement("form");
  form.className = "settings-routing-form";
  const pathGroup = document.createElement("div");
  pathGroup.className = "settings-path-picker";

  const pathInput = document.createElement("input");
  pathInput.name = "path";
  pathInput.placeholder = "Folder or Obsidian vault path";
  pathInput.setAttribute("aria-label", "Memory source path");
  const browse = document.createElement("button");
  browse.type = "button";
  browse.textContent = "Browse";
  browse.setAttribute("aria-label", "Browse for memory source folder");
  const scan = document.createElement("button");
  scan.type = "button";
  scan.textContent = "Scan";
  scan.setAttribute("aria-label", "Scan selected memory source folder");
  pathGroup.append(pathInput, browse, scan);
  const kind = document.createElement("select");
  kind.name = "kind";
  kind.setAttribute("aria-label", "Memory source kind");
  kind.append(option("folder", "Folder", true), option("obsidian-vault", "Obsidian vault", false));
  const ownership = document.createElement("select");
  ownership.name = "ownership";
  ownership.setAttribute("aria-label", "Memory source ownership");
  ownership.append(
    option("mixed-library", "Mixed library", true),
    option("human-knowledge", "Human knowledge", false),
    option("external-knowledge", "External knowledge", false)
  );
  const importMode = document.createElement("select");
  importMode.name = "importMode";
  importMode.setAttribute("aria-label", "Memory source import mode");
  importMode.append(
    option("copy-on-import", "Copy on import", true),
    option("move-on-import", "Move on import", false),
    option("linked-readonly", "Linked read-only", false)
  );
  const syncMode = document.createElement("select");
  syncMode.name = "syncMode";
  syncMode.setAttribute("aria-label", "Memory sync mode");
  syncMode.append(
    option("manual-review", "Manual review", true),
    option("auto-intake-review", "Auto intake + review", false),
    option("paused", "Paused", false)
  );
  const autoSync = document.createElement("label");
  autoSync.className = "settings-routing-check";
  const autoSyncInput = document.createElement("input");
  autoSyncInput.type = "checkbox";
  autoSyncInput.name = "autoSync";
  autoSync.append(autoSyncInput, document.createTextNode(" Auto-sync"));
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Connect Source";

  const advancedSettings = document.createElement("details");
  advancedSettings.className = "settings-memory-advanced";
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = "Advanced source options";
  const advancedBody = document.createElement("div");
  advancedBody.className = "settings-memory-advanced-body";
  advancedBody.append(importMode, syncMode, autoSync);
  advancedSettings.append(advancedSummary, advancedBody);
  form.append(pathGroup, kind, ownership, advancedSettings, save);

  const sourceSection = document.createElement("section");
  sourceSection.className = "settings-memory-source-section";
  const sourceHeading = document.createElement("div");
  sourceHeading.className = "settings-memory-section-heading";
  const sourceTitle = document.createElement("strong");
  sourceTitle.textContent = "Connected sources";
  const sourceHelp = document.createElement("p");
  sourceHelp.textContent = "These are the folders or vaults ResonantOS can preserve as source evidence before AI Memory is updated.";
  const runSync = document.createElement("button");
  runSync.type = "button";
  runSync.textContent = "Run Sync Now";
  runSync.setAttribute("aria-label", "Run governed memory source sync now");
  sourceHeading.append(sourceTitle, sourceHelp, runSync);
  sourceSection.append(sourceHeading, syncHistoryPanel, repairHistoryPanel, moveHistoryPanel, sourceList);

  const addSourceCard = document.createElement("section");
  addSourceCard.className = "settings-note settings-memory-add-source";
  const addTitle = document.createElement("strong");
  addTitle.textContent = "Add a source";
  const addBody = document.createElement("p");
  addBody.textContent = "Choose a folder or Obsidian vault, tell ResonantOS what kind of knowledge it contains, then connect it. Copy-on-import is the default safe mode.";
  addSourceCard.append(addTitle, addBody, scanPanel, form);

  const advancedBoundary = document.createElement("details");
  advancedBoundary.className = "settings-memory-advanced";
  const boundarySummary = document.createElement("summary");
  boundarySummary.textContent = "Source boundary and move-on-import";
  const boundaryBody = document.createElement("div");
  boundaryBody.className = "settings-memory-advanced-body";
  boundaryBody.append(noteCard({
    title: "Source boundary",
    body: "Copy-on-import makes the ResonantOS memory copy the active knowledge base. Linked sources stay read-only. Move-on-import relocates the selected folder into ResonantOS Memory, verifies moved bytes, and keeps a rollback ledger; use it only when you want ResonantOS Memory to become the source location."
  }));
  advancedBoundary.append(boundarySummary, boundaryBody);

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Memory system",
      title: "Living Archive Settings",
      body: "Connect the folders or vaults Augmentor can learn from. ResonantOS preserves source evidence first, then updates AI Memory through the governed archive pipeline."
    }),
    statusNode,
    metrics,
    sourceSection,
    addSourceCard,
    advancedBoundary
  );

  const load = async () => {
    const result = await bridge()("/memory/settings", { method: "GET" });
    const settings = result.settings ?? {};
    const memoryStatus = result.status ?? {};
    const addons = result.memoryAddons ?? [];
    const syncHistory = result.syncHistory ?? [];
    const sourceRepairHistory = result.sourceRepairHistory ?? [];
    const sourceMoveHistory = result.sourceMoveHistory ?? [];
    autoSyncInput.checked = Boolean(settings.autoSync);
    syncMode.value = settings.syncMode ?? "manual-review";
    metrics.replaceChildren(
      metricCard({ label: "Active add-on", value: settings.activeMemoryAddon ?? "living-archive", detail: `${addons.length} memory add-on${addons.length === 1 ? "" : "s"} registered` }),
      metricCard({ label: "Wiki pages", value: String(memoryStatus.wiki?.pages ?? 0), detail: "AI_MEMORY/wiki" }),
      metricCard({ label: "Intake", value: String(memoryStatus.intake?.artifacts ?? 0), detail: "raw/source artifacts" }),
      metricCard({ label: "Sources", value: String(settings.sources?.length ?? 0), detail: settings.autoSync ? "auto-sync enabled" : "manual sync" })
    );
    syncHistoryPanel.replaceChildren(syncHistoryCard(syncHistory[0]));
    repairHistoryPanel.replaceChildren(repairHistoryCard(sourceRepairHistory[0]));
    moveHistoryPanel.replaceChildren(moveHistoryCard(sourceMoveHistory[0]));
    sourceList.replaceChildren();
    for (const source of settings.sources ?? []) {
      sourceList.append(sourceRow(source, {
        onDisable: (entry) => manageSource(entry, "disable"),
        onEnable: (entry) => manageSource(entry, "enable"),
        onRemove: (entry) => manageSource(entry, "remove"),
        onRollback: rollbackMovedSource
      }));
    }
    if (!settings.sources?.length) {
      sourceList.append(sourceRow({
        path: "No connected sources yet",
        kind: "folder",
        ownership: "mixed-library",
        importMode: "copy-on-import",
        exists: false,
        placeholder: true
      }));
    }
    setStatus(statusNode, `${settings.sources?.length ?? 0} source${settings.sources?.length === 1 ? "" : "s"} connected · ${settings.syncMode ?? "manual-review"}.`, "success");
  };

  const manageSource = async (source, action) => {
    const label = action === "remove" ? "remove" : "disable";
    if (action === "remove" && typeof window !== "undefined" && typeof window.confirm === "function") {
      const confirmed = window.confirm(`Remove this source from Living Archive settings?\n\n${source.path}`);
      if (!confirmed) {
        setStatus(statusNode, "Source removal cancelled.", "warning");
        return;
      }
    }
    setStatus(statusNode, `${action === "remove" ? "Removing" : action === "enable" ? "Enabling" : "Disabling"} memory source...`);
    try {
      await bridge()("/memory/source/action", {
        method: "POST",
        capability: "memory-source-manage",
        body: {
          action,
          sourceId: source.id,
          reason: `User requested ${label} from Memory Settings`
        }
      });
      await load();
      setStatus(statusNode, `Memory source ${action === "enable" ? "enabled" : `${label}d`}.`, "success");
    } catch (error) {
      setStatus(statusNode, `Source ${label} failed: ${safeErrorMessage(error)}`, "error");
    }
  };

  runSync.addEventListener("click", async () => {
    runSync.disabled = true;
    setStatus(statusNode, "Running governed memory source sync...");
    try {
      const result = await bridge()("/memory/source/sync", {
        method: "POST",
        capability: "memory-source-file-intake",
        body: { limit: 2_000 }
      });
      await load();
      if (result.status === "paused") {
        setStatus(statusNode, "Memory sync is paused. Change sync mode before running sync.", "warning");
      } else if (result.autoIntake) {
        setStatus(
          statusNode,
          `Sync reviewed ${result.reviewedSources ?? 0} source(s), created ${result.createdArtifacts ?? 0} intake artifact(s), and queued ${result.reviewRequests ?? 0} review request(s).`,
          "success"
        );
      } else {
        setStatus(
          statusNode,
          `Sync reviewed ${result.reviewedSources ?? 0} source(s) and found ${result.eligibleFiles ?? 0} new/changed file(s). Switch to auto intake + review to create intake automatically.`,
          "success"
        );
      }
    } catch (error) {
      setStatus(statusNode, `Sync failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      runSync.disabled = false;
    }
  });

  const rollbackMovedSource = async (source) => {
    const confirmation = typeof window !== "undefined" && typeof window.prompt === "function"
      ? window.prompt(`Rollback this moved source?\n\n${source.path}\n\nThis restores files from ResonantOS Memory back to the original source path using the audited move ledger. Type ROLLBACK MOVE to continue.`)
      : "";
    if (confirmation !== "ROLLBACK MOVE") {
      setStatus(statusNode, "Move rollback cancelled.", "warning");
      return;
    }
    setStatus(statusNode, "Rolling back moved source...");
    try {
      const result = await bridge()("/memory/source/move-rollback", {
        method: "POST",
        capability: "memory-source-move",
        body: {
          ledgerPath: source.ledgerPath,
          confirmation
        }
      });
      await load();
      const skipped = result.skippedCount ?? 0;
      setStatus(statusNode, `Move rollback restored ${result.restoredCount ?? 0} file(s); ${skipped} skipped.`, skipped ? "warning" : "success");
    } catch (error) {
      setStatus(statusNode, `Move rollback failed: ${safeErrorMessage(error)}`, "error");
    }
  };

  const executeMovePreflight = async () => {
    const selectedPath = pathInput.value.trim();
    if (!selectedPath) {
      setStatus(statusNode, "Select or paste a folder path before move preflight.", "warning");
      return;
    }
    scanPanel.replaceChildren();
    setStatus(statusNode, "Running move import preflight...");
    const preflight = await bridge()("/memory/source/move-preflight", {
      method: "POST",
      capability: "memory-source-move",
      body: {
        path: selectedPath,
        kind: kind.value,
        ownership: ownership.value
      }
    });
    scanPanel.replaceChildren(movePreflightCard(preflight, executeMoveImport));
    setStatus(statusNode, preflight.okToMove
      ? "Move preflight complete. Review destination and type the confirmation phrase to execute."
      : "Move preflight blocked. Review the listed reason before continuing.",
    preflight.okToMove ? "warning" : "error");
  };

  const executeMoveImport = async (preflight, confirmation, executeButton) => {
    executeButton.disabled = true;
    setStatus(statusNode, "Executing move import...");
    try {
      const result = await bridge()("/memory/source/move-execute", {
        method: "POST",
        capability: "memory-source-move",
        body: {
          path: preflight.sourcePath,
          kind: kind.value,
          ownership: ownership.value,
          confirmation,
          preflightFingerprint: preflight.preflightFingerprint
        }
      });
      pathInput.value = "";
      const preservedSource = result.sourceCleanupStatus === "preserved-new-content";
      const completeCard = noteCard({
        title: "Move import complete",
        body: `Moved ${result.movedCount ?? 0} file(s) into managed memory. This managed Memory copy is now the canonical knowledge source. Ledger: ${result.ledgerPath}${
          preservedSource
            ? " The original source folder was kept because new files appeared during cleanup; review it before deleting anything."
            : ""
        } Next: open Living Archive to review this source and start AI Memory build.`
      });
      if (typeof onOpenWorkspace === "function") {
        const openMemory = document.createElement("button");
        openMemory.type = "button";
        openMemory.textContent = "Open Living Archive";
        openMemory.addEventListener("click", () => onOpenWorkspace("memory"));
        completeCard.append(openMemory);
      }
      scanPanel.replaceChildren(completeCard);
      await load();
      setStatus(statusNode, preservedSource
        ? "Move import completed and source registered. Original source folder preserved because new files appeared during cleanup."
        : "Move import completed and source registered.",
      preservedSource ? "warning" : "success");
    } catch (error) {
      setStatus(statusNode, `Move import failed: ${safeErrorMessage(error)}`, "error");
      executeButton.disabled = false;
    }
  };

  browse.addEventListener("click", async () => {
    browse.disabled = true;
    setStatus(statusNode, "Opening folder picker...");
    try {
      const result = await bridge()("/memory/source/browse", {
        method: "POST",
        capability: "memory-source-browse",
        body: {
          kind: kind.value,
          prompt: "Select a folder or Obsidian vault for Living Archive"
        }
      });
      if (result.cancelled) {
        setStatus(statusNode, "Folder selection cancelled.", "warning");
        return;
      }
      pathInput.value = result.path ?? "";
      if (result.kind === "obsidian-vault") {
        kind.value = "obsidian-vault";
      }
      setStatus(statusNode, "Folder selected. Review ownership/import mode, then save.", "success");
    } catch (error) {
      setStatus(statusNode, `Browse failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      browse.disabled = false;
    }
  });

  scan.addEventListener("click", async () => {
    const selectedPath = pathInput.value.trim();
    if (!selectedPath) {
      setStatus(statusNode, "Select or paste a folder path before scanning.", "warning");
      return;
    }
    scan.disabled = true;
    scanPanel.replaceChildren();
    setStatus(statusNode, "Scanning source folder...");
    try {
      const result = await bridge()("/memory/source/scan", {
        method: "POST",
        capability: "memory-source-scan",
        body: {
          path: selectedPath,
          limit: 2_000
        }
      });
      if (result.kind === "obsidian-vault") {
        kind.value = "obsidian-vault";
      }
      scanPanel.replaceChildren(scanSummaryCard(result));
      setStatus(statusNode, "Source scan complete. Review summary before saving.", "success");
    } catch (error) {
      setStatus(statusNode, `Scan failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      scan.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (importMode.value === "move-on-import" && pathInput.value.trim()) {
      try {
        await executeMovePreflight();
      } catch (error) {
        setStatus(statusNode, `Move preflight failed: ${safeErrorMessage(error)}`, "error");
      }
      return;
    }
    save.disabled = true;
    setStatus(statusNode, "Saving memory settings...");
    try {
      await bridge()("/memory/settings", {
        method: "POST",
        capability: "memory-settings-write",
        body: {
          autoSync: autoSyncInput.checked,
          syncMode: syncMode.value,
          source: pathInput.value.trim()
            ? {
                path: pathInput.value.trim(),
                kind: kind.value,
                ownership: ownership.value,
                importMode: importMode.value
              }
            : null
        }
      });
      pathInput.value = "";
      await load();
      setStatus(statusNode, "Memory settings saved.", "success");
    } catch (error) {
      setStatus(statusNode, `Save failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      save.disabled = false;
    }
  });

  void load().catch((error) => {
    setStatus(statusNode, `Memory settings unavailable: ${safeErrorMessage(error)}`, "error");
  });
}
