import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureLivingArchiveSchema } from "./memory-schema.mjs";
import {
  appendMemorySourceMoveHistory as appendSourceMoveHistory,
  appendMemorySourceRepairHistory as appendSourceRepairHistory,
  appendMemorySourceSyncHistory as appendSourceSyncHistory,
  readMemorySourceMoveHistory as readSourceMoveHistory,
  readMemorySourceRepairHistory as readSourceRepairHistory,
  readMemorySourceSyncHistory as readSourceSyncHistory,
} from "./memory-source-history.mjs";
import {
  buildMoveImportPreflight,
  executeMoveImport,
  rollbackMoveImport,
  shouldDeregisterMovedSourceAfterRollback,
} from "./memory-source-move.mjs";
import { assertMemorySettingsSourceCanSave } from "./memory-settings-policy.mjs";
import {
  resolveWindowsSystemRoot,
  windowsPowerShellDiagnostics as defaultWindowsPowerShellDiagnostics,
} from "./browser-first-host-utils.mjs";

const defaultMemorySettings = {
  activeMemoryAddon: "living-archive",
  autoSync: false,
  costPosture: "use-archive-ingest-routing-strategy",
  syncMode: "manual-review",
  sources: [],
};

const folderPickerPrompt = "Select a folder or Obsidian vault for Living Archive";
const linuxPickerSearchPath = ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter);

export function createMemorySourceSettingsService({
  memoryRoot,
  userRoot,
  memorySettingsPath,
  memorySourceAuditPath,
  countFiles,
  pathSummary,
  listFilesRecursive,
  expandUserPath,
  stableMemorySourceId,
  redactPathForDiagnostics,
  redactDiagnosticText,
  execFileStdout,
  firstExistingExecutable,
  isInsidePath,
  executeAddonsStatus,
  environment = process.env,
  platform = process.platform,
  windowsPowerShellDiagnostics = defaultWindowsPowerShellDiagnostics,
} = {}) {
  function assertDependency(name, value) {
    if (!value) {
      throw new Error(`Memory source service missing dependency: ${name}`);
    }
  }
  for (const [name, value] of Object.entries({
    memoryRoot,
    userRoot,
    memorySettingsPath,
    memorySourceAuditPath,
    countFiles,
    pathSummary,
    listFilesRecursive,
    expandUserPath,
    stableMemorySourceId,
    redactPathForDiagnostics,
    redactDiagnosticText,
    execFileStdout,
    firstExistingExecutable,
    isInsidePath,
    executeAddonsStatus,
    windowsPowerShellDiagnostics,
  })) {
    assertDependency(name, value);
  }

  function pickerEnvironment() {
    const keys = platform === "win32"
      ? ["USERPROFILE", "TEMP", "TMP"]
      : platform === "darwin"
        ? ["HOME", "LANG", "LC_ALL", "TMPDIR"]
        : [
          "HOME",
          "LANG",
          "LC_ALL",
          "TMPDIR",
          "DISPLAY",
          "WAYLAND_DISPLAY",
          "XAUTHORITY",
          "DBUS_SESSION_BUS_ADDRESS",
          "XDG_RUNTIME_DIR",
        ];
    const scopedEnvironment = Object.fromEntries(
      keys.map((key) => [key, environment[key]]).filter(([, value]) => value !== undefined),
    );
    return platform === "win32"
      ? {
        SystemRoot: resolveWindowsSystemRoot(environment),
        WINDIR: resolveWindowsSystemRoot(environment),
        ...scopedEnvironment,
      }
      : scopedEnvironment;
  }

  async function executeMemoryStatus() {
    const root = memoryRoot();
    const schema = await ensureLivingArchiveSchema({ memoryRoot: root });
    const wikiRoot = path.join(root, "AI_MEMORY", "wiki");
    const intakeRoot = path.join(root, "INTAKE");
    const reviewRoot = path.join(root, "REVIEW");
    const indexPath = path.join(root, "AI_MEMORY", "wiki", "index.md");
    const logPath = path.join(root, "AI_MEMORY", "wiki", "log.md");
    const markdownPredicate = (filePath) => /\.(md|markdown)$/i.test(filePath);
    return {
      root,
      exists: existsSync(root),
      schema,
      wiki: {
        root: wikiRoot,
        pages: await countFiles(wikiRoot, markdownPredicate),
        index: await pathSummary(indexPath),
        log: await pathSummary(logPath),
      },
      intake: {
        root: intakeRoot,
        artifacts: await countFiles(intakeRoot, () => true),
      },
      review: {
        root: reviewRoot,
        requests: await countFiles(path.join(reviewRoot, "requests"), () => true),
        artifacts: await countFiles(path.join(reviewRoot, "artifacts"), () => true),
      },
    };
  }

  async function readMemorySettings() {
    const filePath = memorySettingsPath();
    if (!existsSync(filePath)) {
      return defaultMemorySettings;
    }
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return {
      ...defaultMemorySettings,
      ...parsed,
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    };
  }

  function normalizeMemorySource(source, existingSources = []) {
    const expandedPath = expandUserPath(source?.path);
    if (!expandedPath) {
      throw new Error("Memory source path is required.");
    }
    const kind = ["folder", "obsidian-vault"].includes(source?.kind) ? source.kind : "folder";
    const ownership = ["human-knowledge", "external-knowledge", "mixed-library"].includes(source?.ownership)
      ? source.ownership
      : "mixed-library";
    const importMode = ["copy-on-import", "move-on-import", "linked-readonly"].includes(source?.importMode)
      ? source.importMode
      : "copy-on-import";
    const existingById = existingSources.find((entry) =>
      entry?.id &&
      source?.id === entry.id &&
      expandUserPath(entry.path) === expandedPath
    );
    const existingByPath = existingSources.find((entry) =>
      entry?.id &&
      expandUserPath(entry.path) === expandedPath &&
      (["folder", "obsidian-vault"].includes(entry.kind) ? entry.kind : "folder") === kind
    );
    return {
      id: existingById?.id ?? existingByPath?.id ?? stableMemorySourceId(kind, expandedPath),
      path: expandedPath,
      kind,
      ownership,
      importMode,
      exists: existsSync(expandedPath),
      lastSeenAt: new Date().toISOString(),
    };
  }

  function resolveMemorySettings(settings) {
    return {
      ...defaultMemorySettings,
      ...settings,
      root: memoryRoot(),
      sources: (settings.sources ?? []).map((source) => ({
        ...source,
        exists: existsSync(expandUserPath(source.path)),
      })),
    };
  }

  async function appendMemorySourceAudit(action, source, extra = {}) {
    const now = new Date().toISOString();
    const filePath = memorySourceAuditPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    const entry = [
      `## [${now}] source_${action}`,
      `- source: ${redactPathForDiagnostics(source?.path ?? extra.sourceId ?? "unknown")}`,
      `- kind: ${source?.kind ?? "unknown"}`,
      `- ownership: ${source?.ownership ?? "unknown"}`,
      `- importMode: ${source?.importMode ?? "unknown"}`,
      extra.reason ? `- reason: ${redactDiagnosticText(extra.reason)}` : "",
      "",
    ].filter(Boolean).join("\n");
    await appendFile(filePath, entry);
    await chmod(filePath, 0o600).catch(() => undefined);
  }

  async function readMemorySourceSyncHistory(limit = 10) {
    return readSourceSyncHistory({ memoryRoot: memoryRoot(), limit });
  }

  async function appendMemorySourceSyncHistory(entry) {
    return appendSourceSyncHistory({
      memoryRoot: memoryRoot(),
      userRoot: userRoot(),
      entry,
      redactDiagnosticText,
    });
  }

  async function readMemorySourceRepairHistory(limit = 10) {
    return readSourceRepairHistory({ memoryRoot: memoryRoot(), limit });
  }

  async function appendMemorySourceRepairHistory(entry) {
    return appendSourceRepairHistory({
      memoryRoot: memoryRoot(),
      userRoot: userRoot(),
      entry,
      redactDiagnosticText,
    });
  }

  async function readMemorySourceMoveHistory(limit = 10) {
    return readSourceMoveHistory({ memoryRoot: memoryRoot(), limit });
  }

  async function appendMemorySourceMoveHistory(entry) {
    return appendSourceMoveHistory({
      memoryRoot: memoryRoot(),
      userRoot: userRoot(),
      entry,
      redactDiagnosticText,
    });
  }

  async function executeMemorySettings() {
    const [settings, status, addons, syncHistory, sourceRepairHistory, sourceMoveHistory] = await Promise.all([
      readMemorySettings(),
      executeMemoryStatus(),
      executeAddonsStatus(),
      readMemorySourceSyncHistory(5),
      readMemorySourceRepairHistory(5),
      readMemorySourceMoveHistory(5),
    ]);
    return {
      settings: resolveMemorySettings(settings),
      status,
      memoryAddons: addons.addons.filter((addon) => addon.mode === "memory-system"),
      syncHistory,
      sourceRepairHistory,
      sourceMoveHistory,
    };
  }

  async function executeMemorySettingsSave(payload = {}) {
    const current = await readMemorySettings();
    const next = {
      ...current,
      autoSync: typeof payload.autoSync === "boolean" ? payload.autoSync : current.autoSync,
      costPosture: String(payload.costPosture ?? current.costPosture).trim().slice(0, 100) || current.costPosture,
      syncMode: ["manual-review", "auto-intake-review", "paused"].includes(payload.syncMode) ? payload.syncMode : current.syncMode,
    };
    if (payload.activeMemoryAddon) {
      next.activeMemoryAddon = String(payload.activeMemoryAddon).trim().slice(0, 100) || current.activeMemoryAddon;
    }
    if (payload.source) {
      assertMemorySettingsSourceCanSave(payload.source);
      const normalized = normalizeMemorySource(payload.source, current.sources);
      const existing = next.sources.filter((source) => source.id !== normalized.id && expandUserPath(source.path) !== normalized.path);
      next.sources = [...existing, normalized];
    }
    const filePath = memorySettingsPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    return {
      savedAt: new Date().toISOString(),
      settings: resolveMemorySettings(next),
    };
  }

  async function executeMemorySourceAction(payload = {}) {
    const sourceId = String(payload.sourceId ?? "").trim();
    const action = String(payload.action ?? "").trim();
    if (!sourceId) {
      throw new Error("Memory source action requires a source id.");
    }
    if (!["disable", "enable", "remove"].includes(action)) {
      throw new Error("Unsupported memory source action.");
    }
    const current = await readMemorySettings();
    const source = current.sources.find((entry) => entry.id === sourceId);
    if (!source) {
      throw new Error("Memory source was not found.");
    }
    const now = new Date().toISOString();
    const nextSources = action === "remove"
      ? current.sources.filter((entry) => entry.id !== sourceId)
      : current.sources.map((entry) => entry.id === sourceId
          ? action === "enable"
            ? { ...entry, disabledAt: undefined, enabledAt: now, lastSeenAt: now }
            : { ...entry, disabledAt: now, lastSeenAt: now }
          : entry);
    const next = { ...current, sources: nextSources };
    const filePath = memorySettingsPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    await appendMemorySourceAudit(action, source, { reason: payload.reason, sourceId });
    return {
      action,
      sourceId,
      savedAt: now,
      settings: resolveMemorySettings(next),
    };
  }

  async function executeMemorySourceMovePreflight(payload = {}) {
    const sourcePath = expandUserPath(payload.path);
    if (!sourcePath) {
      throw new Error("Move import preflight requires a source folder path.");
    }
    return buildMoveImportPreflight({
      sourcePath,
      memoryRoot: memoryRoot(),
      kind: ["folder", "obsidian-vault"].includes(payload.kind) ? payload.kind : "folder",
      ownership: ["human-knowledge", "external-knowledge", "mixed-library"].includes(payload.ownership)
        ? payload.ownership
        : "mixed-library",
    });
  }

  async function executeMemorySourceMoveExecute(payload = {}) {
    const sourcePath = expandUserPath(payload.path);
    if (!sourcePath) {
      throw new Error("Move import execution requires a source folder path.");
    }
    const result = await executeMoveImport({
      sourcePath,
      memoryRoot: memoryRoot(),
      kind: ["folder", "obsidian-vault"].includes(payload.kind) ? payload.kind : "folder",
      ownership: ["human-knowledge", "external-knowledge", "mixed-library"].includes(payload.ownership)
        ? payload.ownership
        : "mixed-library",
      confirmation: payload.confirmation,
      expectedPreflightFingerprint: payload.preflightFingerprint,
    });
    if (result.status !== "moved") {
      throw new Error(
        `Move import failed and automatic rollback restored ${result.rollbackRestoredCount ?? 0} file(s), ` +
        `${result.rollbackRestoredDirectoryCount ?? 0} folder(s), source root restored: ${result.rollbackSourceRootRestored === true ? "yes" : "no"}; ` +
        `${result.rollbackSkippedCount ?? 0} file(s), ${result.rollbackSkippedDirectoryCount ?? 0} folder(s), ` +
        `${result.rollbackSkippedRootCleanupCount ?? 0} root cleanup issue(s) skipped.`
      );
    }
    const current = await readMemorySettings();
    const normalized = normalizeMemorySource(result.source, current.sources);
    const nextSource = {
      ...normalized,
      originalPath: result.source.originalPath,
      moveId: result.source.moveId,
      manifestPath: result.source.manifestPath,
      ledgerPath: result.source.ledgerPath,
    };
    const existing = current.sources.filter((source) =>
      source.id !== nextSource.id &&
      expandUserPath(source.path) !== nextSource.path &&
      expandUserPath(source.originalPath ?? "") !== result.source.originalPath
    );
    const next = { ...current, sources: [...existing, nextSource] };
    const filePath = memorySettingsPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    await appendMemorySourceAudit("move_execute", nextSource, {
      reason: `Moved source from ${redactPathForDiagnostics(result.source.originalPath)} to managed memory.`,
    });
    await appendMemorySourceMoveHistory({
      id: `move-execute-${randomUUID()}`,
      action: "move-execute",
      sourceId: nextSource.id,
      moveId: nextSource.moveId,
      status: result.status,
      at: result.finishedAt,
      originalPath: result.source.originalPath,
      managedPath: result.source.path,
      ledgerPath: result.source.ledgerPath,
      manifestPath: result.source.manifestPath,
      movedCount: result.movedCount,
      message: "Source moved into managed Memory and registered as the canonical source.",
    });
    return {
      ...result,
      source: nextSource,
      settings: resolveMemorySettings(next),
    };
  }

  async function executeMemorySourceMoveRollback(payload = {}) {
    const ledgerPath = expandUserPath(payload.ledgerPath);
    if (!ledgerPath) {
      throw new Error("Move import rollback requires a ledger path.");
    }
    const moveLedgerRoot = path.join(memoryRoot(), "CONFIG", "move-imports");
    if (!isInsidePath(ledgerPath, moveLedgerRoot)) {
      throw new Error("Move import rollback ledger must stay inside Memory/CONFIG/move-imports.");
    }
    const report = await rollbackMoveImport({
      ledgerPath,
      confirmation: payload.confirmation,
    });
    const current = await readMemorySettings();
    const movedSource = current.sources.find((source) =>
      path.resolve(expandUserPath(source.ledgerPath ?? "")) === path.resolve(ledgerPath)
    );
    const nextSources = shouldDeregisterMovedSourceAfterRollback(report)
      ? current.sources.filter((source) => expandUserPath(source.ledgerPath ?? "") !== path.resolve(ledgerPath))
      : current.sources;
    const next = { ...current, sources: nextSources };
    const filePath = memorySettingsPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    await appendMemorySourceAudit("move_rollback", { path: ledgerPath, kind: "folder", ownership: "unknown", importMode: "move-on-import" }, {
      reason: `Rollback restored ${report.restoredCount} file(s); ${report.skippedCount} skipped.`,
    });
    await appendMemorySourceMoveHistory({
      id: `move-rollback-${randomUUID()}`,
      action: "move-rollback",
      sourceId: movedSource?.id ?? "",
      moveId: movedSource?.moveId ?? "",
      status: shouldDeregisterMovedSourceAfterRollback(report) ? "restored" : "partial",
      at: report.rolledBackAt,
      originalPath: movedSource?.originalPath ?? "",
      managedPath: movedSource?.path ?? "",
      ledgerPath,
      manifestPath: movedSource?.manifestPath ?? "",
      restoredCount: report.restoredCount,
      skippedCount: report.skippedCount,
      message: shouldDeregisterMovedSourceAfterRollback(report)
        ? "Moved source rollback restored all tracked content and deregistered the source."
        : "Moved source rollback was partial; source remains registered for inspection.",
    });
    return {
      ...report,
      settings: resolveMemorySettings(next),
    };
  }

  async function executeMemorySourceBrowse(payload = {}) {
    const override = String(environment.RESONANTOS_BROWSER_FIRST_PICK_FOLDER_RESULT ?? "").trim();
    let selectedPath = override;
    if (!selectedPath) {
      const prompt = folderPickerPrompt;
      const options = { env: pickerEnvironment() };
      if (platform === "darwin") {
        selectedPath = await execFileStdout("/usr/bin/osascript", [
          "-e",
          `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`,
        ], options).catch((error) => {
          if (/user canceled/i.test(error.message)) return "";
          throw error;
        });
      } else if (platform === "win32") {
        const powerShellRuntime = windowsPowerShellDiagnostics();
        if (!powerShellRuntime?.installed) {
          throw new Error("Windows PowerShell was not found in the fixed system directory. Paste the path manually.");
        }
        selectedPath = await execFileStdout(powerShellRuntime.command, [
          "-NoProfile",
          "-STA",
          "-Command",
          [
            "Add-Type -AssemblyName System.Windows.Forms",
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
            `$dialog.Description = ${JSON.stringify(prompt)}`,
            "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }",
          ].join("; "),
        ], { ...options, shell: false });
      } else {
        const lookupOptions = { searchPath: linuxPickerSearchPath };
        const picker = firstExistingExecutable("zenity", lookupOptions) ??
          firstExistingExecutable("kdialog", lookupOptions);
        if (!picker) {
          throw new Error("No supported native folder picker was found. Install zenity/kdialog or paste the path manually.");
        }
        selectedPath = picker.endsWith("kdialog")
          ? await execFileStdout(picker, ["--getexistingdirectory", environment.HOME ?? os.homedir(), "--title", prompt], options)
          : await execFileStdout(picker, ["--file-selection", "--directory", "--title", prompt], options);
      }
    }
    selectedPath = expandUserPath(selectedPath);
    if (!selectedPath) {
      return { cancelled: true, path: "" };
    }
    if (!existsSync(selectedPath)) {
      throw new Error("Selected folder does not exist.");
    }
    const details = await stat(selectedPath);
    if (!details.isDirectory()) {
      throw new Error("Selected path is not a folder.");
    }
    return {
      cancelled: false,
      path: selectedPath,
      kind: existsSync(path.join(selectedPath, ".obsidian")) ? "obsidian-vault" : (payload.kind || "folder"),
    };
  }

  function classifyMemorySourceFile(filePath, rootPath) {
    const relative = path.relative(rootPath, filePath).replace(/\\/g, "/");
    const extension = path.extname(filePath).toLowerCase();
    if (relative.split("/").some((part) => part.startsWith("."))) {
      return "hidden";
    }
    if ([".md", ".markdown", ".txt", ".csv", ".json", ".pdf", ".docx"].includes(extension)) {
      return "compatible";
    }
    if ([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"].includes(extension)) {
      return "raw-audio";
    }
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(extension)) {
      return "media";
    }
    if ([".html", ".htm", ".xml", ".yaml", ".yml"].includes(extension)) {
      return "processed";
    }
    return "unsupported";
  }

  async function executeMemorySourceScan(payload = {}) {
    const sourcePath = expandUserPath(payload.path);
    if (!sourcePath) {
      throw new Error("Memory source scan requires a folder path.");
    }
    if (!existsSync(sourcePath)) {
      throw new Error("Memory source path does not exist.");
    }
    const details = await stat(sourcePath);
    if (!details.isDirectory()) {
      throw new Error("Memory source path must be a folder.");
    }
    const limit = Math.max(10, Math.min(5_000, Number(payload.limit ?? 2_000)));
    const files = await listFilesRecursive(sourcePath, () => true, limit + 1);
    const visibleFiles = files.slice(0, limit);
    const categories = {
      compatible: 0,
      "raw-audio": 0,
      processed: 0,
      media: 0,
      hidden: 0,
      unsupported: 0,
    };
    const samples = {};
    for (const filePath of visibleFiles) {
      const kind = classifyMemorySourceFile(filePath, sourcePath);
      categories[kind] += 1;
      samples[kind] = samples[kind] ?? [];
      if (samples[kind].length < 5) {
        samples[kind].push(path.relative(sourcePath, filePath).replace(/\\/g, "/"));
      }
    }
    return {
      path: sourcePath,
      kind: existsSync(path.join(sourcePath, ".obsidian")) ? "obsidian-vault" : "folder",
      totalScanned: visibleFiles.length,
      limitReached: files.length > limit,
      categories,
      samples,
      recommendation: categories.compatible || categories.processed
        ? "This source has compatible knowledge files and can be registered for governed intake."
        : categories["raw-audio"]
          ? "This source appears to contain raw audio. Register it only if an audio/TOL add-on will process it into intake bundles."
          : "This source has little directly compatible knowledge content. Review before registering.",
    };
  }

  return {
    appendMemorySourceAudit,
    appendMemorySourceRepairHistory,
    appendMemorySourceSyncHistory,
    classifyMemorySourceFile,
    executeMemorySettings,
    executeMemorySettingsSave,
    executeMemorySourceAction,
    executeMemorySourceBrowse,
    executeMemorySourceMoveExecute,
    executeMemorySourceMovePreflight,
    executeMemorySourceMoveRollback,
    executeMemorySourceScan,
    executeMemoryStatus,
    normalizeMemorySource,
    readMemorySettings,
    readMemorySourceMoveHistory,
    readMemorySourceRepairHistory,
    readMemorySourceSyncHistory,
    resolveMemorySettings,
  };
}
