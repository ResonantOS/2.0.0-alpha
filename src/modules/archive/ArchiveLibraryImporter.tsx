// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-013-living-archive-memory-domains.md

import { useState } from "react";
import type {
  ArchiveLibraryImportMode,
  ArchiveLibraryImportResult,
  ArchiveLibraryPreflightResult,
  ArchiveMemoryDomain,
} from "../../core/contracts";
import { Panel } from "../../components/Panel";

type ArchiveLibraryImporterProps = {
  archiveSourceScanBusy: boolean;
  archiveLibraryImportResult: ArchiveLibraryImportResult | null;
  archiveLibraryPreflightResult: ArchiveLibraryPreflightResult | null;
  onPickLibraryFolder: () => Promise<string | null>;
  onPreflightLibrary: (sourcePath: string) => void;
  onAskAugmentorAboutPreflight: (report: ArchiveLibraryPreflightResult) => void;
  onImportLibrary: (input: {
    sourcePath: string;
    domain: ArchiveMemoryDomain;
    importMode: ArchiveLibraryImportMode;
    libraryName?: string;
    excludedTopFolders?: string[];
  }) => void;
};

export function ArchiveLibraryImporter({
  archiveSourceScanBusy,
  archiveLibraryImportResult,
  archiveLibraryPreflightResult,
  onPickLibraryFolder,
  onPreflightLibrary,
  onAskAugmentorAboutPreflight,
  onImportLibrary,
}: ArchiveLibraryImporterProps) {
  const [libraryPath, setLibraryPath] = useState("");
  const [libraryName, setLibraryName] = useState("");
  const [libraryDomain, setLibraryDomain] = useState<ArchiveMemoryDomain>("mixed-library");
  const [libraryImportMode, setLibraryImportMode] = useState<ArchiveLibraryImportMode>("copy");
  const chooseLibraryFolder = async () => {
    const selected = await onPickLibraryFolder();
    if (selected) {
      setLibraryPath(selected);
      onPreflightLibrary(selected);
    }
  };
  const preflightMatchesPath = archiveLibraryPreflightResult?.sourcePath === libraryPath.trim();
  const canImport =
    Boolean(libraryPath.trim()) &&
    preflightMatchesPath &&
    archiveLibraryPreflightResult?.exists &&
    archiveLibraryPreflightResult.supportedFiles > 0;

  return (
    <Panel
      className="library-importer-panel"
      title="Add Knowledge"
      subtitle="Choose any folder. Obsidian-compatible vaults are optional."
    >
      <form
        className="library-import-form"
        onSubmit={(event) => {
          event.preventDefault();
          onImportLibrary({
            sourcePath: libraryPath,
            domain: libraryDomain,
            importMode: libraryImportMode,
            libraryName,
            excludedTopFolders: archiveLibraryPreflightResult?.recommendedPlan.autoExcludedTopFolders ?? [],
          });
        }}
      >
        <section className="library-step-card">
          <div className="library-step-head">
            <span>1</span>
            <div>
              <strong>Choose the folder or vault</strong>
              <p>This is the only required choice. Analysis starts automatically after selection.</p>
            </div>
          </div>
          <button
            type="button"
            className={`library-folder-button ${libraryPath ? "selected" : ""}`}
            aria-label="Choose folder or vault path"
            onClick={() => void chooseLibraryFolder()}
          >
            <span>{libraryPath || "Click to choose a knowledge folder"}</span>
            <strong>Browse...</strong>
          </button>
          {libraryPath ? (
            <div className="library-preflight-actions">
              <button
                type="button"
                className="button-secondary touch-action"
                disabled={archiveSourceScanBusy || !libraryPath.trim()}
                onClick={() => onPreflightLibrary(libraryPath)}
              >
                {archiveSourceScanBusy ? "Analyzing..." : "Analyze Again"}
              </button>
              <p>
                {archiveSourceScanBusy
                  ? "The Living Archive Agent is checking what can be imported."
                  : preflightMatchesPath
                    ? "Analysis complete. If the summary looks right, let the AI import it."
                    : "Run analysis again if this path changed."}
              </p>
            </div>
          ) : null}
          <details className="library-manual-path">
            <summary>Advanced: type path manually</summary>
            <input
              aria-label="Manual folder or vault path"
              value={libraryPath}
              onChange={(event) => setLibraryPath(event.target.value)}
              placeholder="~/Documents/My Knowledge Folder"
            />
          </details>
          {archiveLibraryPreflightResult ? (
            <LibraryPreflightReport
              report={archiveLibraryPreflightResult}
              isStale={!preflightMatchesPath}
              onAskAugmentor={onAskAugmentorAboutPreflight}
            />
          ) : null}
        </section>

        <details className="library-advanced-options">
          <summary>Advanced import options</summary>
          <section className="library-step-card">
            <div className="library-step-head">
              <span>2</span>
              <div>
                <strong>Optional handling</strong>
                <p>The recommended default is Mixed Library + Copy. Change this only if you know the source type.</p>
              </div>
            </div>
            <div className="library-field-grid">
              <label>
                <span>Library name</span>
                <input
                  value={libraryName}
                  onChange={(event) => setLibraryName(event.target.value)}
                  placeholder="Optional, inferred from folder"
                />
              </label>
              <label>
                <span>Memory domain</span>
                <select value={libraryDomain} onChange={(event) => setLibraryDomain(event.target.value as ArchiveMemoryDomain)}>
                  <option value="mixed-library">Mixed Library - let AI classify</option>
                  <option value="human-knowledge">Human Knowledge</option>
                  <option value="external-knowledge">External Knowledge</option>
                </select>
              </label>
              <label>
                <span>Import mode</span>
                <select value={libraryImportMode} onChange={(event) => setLibraryImportMode(event.target.value as ArchiveLibraryImportMode)}>
                  <option value="copy">Copy into Living Archive (recommended)</option>
                  <option value="move" disabled>
                    Move into Living Archive (disabled until audited execution)
                  </option>
                  <option value="reference">Reference in place (advanced)</option>
                </select>
              </label>
            </div>
            <div className={`inline-notice ${libraryImportMode === "move" ? "warning" : ""}`}>
              {libraryImportMode === "copy"
                ? "Copy mode preserves the original and makes the managed ResonantOS copy the active knowledge base."
                : libraryImportMode === "move"
                  ? "Move mode is disabled until explicit confirmation, audit, and rollback execution exist."
                  : "Reference mode leaves files where they are. Use only when you cannot copy the source yet."}
            </div>
          </section>
        </details>

        <section className="library-step-card library-import-action-card">
          <div className="library-step-head">
            <span>2</span>
            <div>
              <strong>Let the AI import it</strong>
              <p>The agent will use safe defaults, preserve the original, and continue curation after import.</p>
            </div>
          </div>
          <button type="submit" className="button-primary touch-action" disabled={archiveSourceScanBusy || !canImport}>
            {archiveSourceScanBusy ? "Working..." : "Let AI Import This"}
          </button>
          {!archiveLibraryPreflightResult ? (
            <div className="inline-notice">Choose a folder first. The agent will analyze it before import.</div>
          ) : !preflightMatchesPath ? (
            <div className="inline-notice warning">The folder path changed after preflight. Analyze again before importing.</div>
          ) : !canImport ? (
            <div className="inline-notice warning">This source has no supported files to import.</div>
          ) : null}
        </section>
      </form>
      {archiveLibraryImportResult ? (
        <article className="archive-import-result">
          <div className="archive-import-result-head">
            <div>
              <span className="eyebrow">Latest imported library</span>
              <strong>{archiveLibraryImportResult.libraryName}</strong>
              <p className="path-chip">{archiveLibraryImportResult.canonicalRoot}</p>
            </div>
            <span className="tone tone-active">{archiveLibraryImportResult.domain}</span>
          </div>
          <div className="archive-result-metrics">
            <span>{archiveLibraryImportResult.filesImported} imported</span>
            <span>{archiveLibraryImportResult.skippedFiles} skipped</span>
            <span>{archiveLibraryImportResult.importMode} mode</span>
            <span>{archiveLibraryImportResult.classificationStatus}</span>
            <span>{archiveLibraryImportResult.metadataStandard}</span>
            {archiveLibraryImportResult.recommendedAddon ? <span>Resonant Notes add-on optional</span> : null}
          </div>
          {archiveLibraryImportResult.classificationManifestPath ? (
            <div className="inline-notice">
              The import is ready for AI memory building. The agent can continue from the main Living Archive panel.
            </div>
          ) : null}
        </article>
      ) : null}
    </Panel>
  );
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
};

function CountList({ title, counts }: { title: string; counts: ArchiveLibraryPreflightResult["supportedByExtension"] }) {
  return (
    <div className="library-preflight-list">
      <strong>{title}</strong>
      {counts.length ? (
        <ul>
          {counts.slice(0, 8).map((item) => (
            <li key={item.label}>
              <span>{item.label}</span>
              <small>
                {item.count} · {formatBytes(item.sizeBytes)}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p>No entries.</p>
      )}
    </div>
  );
}

function LibraryPreflightReport({
  report,
  isStale,
  onAskAugmentor,
}: {
  report: ArchiveLibraryPreflightResult;
  isStale: boolean;
  onAskAugmentor: (report: ArchiveLibraryPreflightResult) => void;
}) {
  return (
    <article className="library-preflight-report">
      {isStale ? <div className="inline-notice warning">This preflight belongs to a previous path. Analyze again.</div> : null}
      <div className="library-preflight-simple">
        <strong>{report.supportedFiles.toLocaleString()} files can be imported</strong>
        <p>
          {report.skippedFiles.toLocaleString()} unsupported or technical file(s) will be skipped. Managed copy estimate:{" "}
          {formatBytes(report.estimatedManagedStorageBytes)}.
        </p>
        {report.obsidianVaultDetected ? <span className="tone tone-active">Obsidian vault detected</span> : null}
      </div>
      {report.warnings.length ? (
        <div className="library-preflight-warnings">
          {report.warnings.map((warning) => (
            <div className={`inline-notice ${warning.severity === "error" ? "warning" : ""}`} key={`${warning.title}:${warning.detail}`}>
              <strong>{warning.title}</strong>
              <p>{warning.detail}</p>
            </div>
          ))}
        </div>
      ) : null}
      <div className="library-recommended-plan">
        <div>
          <span className="eyebrow">AI recommendation</span>
          <strong>{report.recommendedPlan.summary}</strong>
          <p>{report.recommendedPlan.approvalNote}</p>
        </div>
        <button type="button" className="button-secondary touch-action" disabled={isStale} onClick={() => onAskAugmentor(report)}>
          Ask Augmentor
        </button>
      </div>
      <details className="library-preflight-details">
        <summary>Technical details</summary>
        <div className="archive-result-metrics">
          <span>{report.recommendedPlan.includedTopFolders.length} top folder(s) included</span>
          <span>{report.recommendedPlan.autoExcludedTopFolders.length} technical folder(s) auto-excluded</span>
          <span>{report.recommendedPlan.ambiguousTopFolders.length} ambiguous folder(s) flagged</span>
          <span>{formatBytes(report.estimatedImportBytes)} source size</span>
        </div>
        <div className="library-preflight-grid">
          <CountList title="Will import by folder" counts={report.supportedByTopFolder} />
          <CountList title="Will skip by folder" counts={report.skippedByTopFolder} />
          <CountList title="Will import by type" counts={report.supportedByExtension} />
          <CountList title="Will skip by type" counts={report.skippedByExtension} />
        </div>
      </details>
      {report.samples.length ? (
        <details className="library-manual-path">
          <summary>Skipped examples</summary>
          <ul className="mono-list">
            {report.samples.slice(0, 12).map((sample) => (
              <li key={`${sample.reason}:${sample.path}`}>
                {sample.reason} · {sample.path}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}
