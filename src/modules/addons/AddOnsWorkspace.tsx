// Intent citation: docs/architecture/ADR-002-modular-codebase.md

import { useEffect, useState } from "react";
import type {
  AddOnInstallation,
  AddOnHookDefinition,
  AddOnManifest,
  AddOnRegistryEntry,
  AddOnScriptDefinition,
  BrowserEngineStatus,
  CapabilityGrant,
  LogicianExecutionArtifact,
  VerifyAgentReport,
  ShellSectionId,
} from "../../core/contracts";
import { Panel } from "../../components/Panel";
import { assessLogicianHookActivation } from "../../core/logician";
import { requestBrowserEngineStatus, requestBrowserInstallEngine } from "../../core/runtime";
import { createAddOnRegistryEntry } from "../../sdk/addons";
import { HermesAddonPanel } from "./HermesAddonPanel";
import { ObsidianAddonPanel } from "./ObsidianAddonPanel";
import { TelegramAddonPanel } from "./TelegramAddonPanel";

type AddOnsWorkspaceProps = {
  search: string;
  sideloadPath: string;
  filteredManifests: AddOnManifest[];
  installations: Record<string, AddOnInstallation>;
  selectedManifest: AddOnManifest | null;
  selectedInstallation: AddOnInstallation | null;
  onSearchChange: (value: string) => void;
  onSideloadPathChange: (value: string) => void;
  onSideload: () => void;
  onSelectManifest: (manifestId: string) => void;
  onToggleAddonInstall: (manifest: AddOnManifest) => void;
  onToggleGrant: (manifestId: string, capability: CapabilityGrant["capability"]) => void;
  onGrantCapabilities: (
    manifestId: string,
    capabilities: CapabilityGrant["capability"][],
    requestedCapabilities: CapabilityGrant[],
  ) => void;
  onUpdateAddonConfig: (manifestId: string, config: Record<string, unknown>) => void;
  onRunLogicianScript: (
    manifest: AddOnManifest,
    installation: AddOnInstallation,
    script: AddOnScriptDefinition,
  ) => Promise<LogicianExecutionArtifact>;
  onRunLogicianHook: (
    manifest: AddOnManifest,
    installation: AddOnInstallation,
    hook: AddOnHookDefinition,
  ) => Promise<LogicianExecutionArtifact>;
  onAskAugmentor: (message: string) => Promise<void>;
  onOpenArchiveReview: () => void;
  onOpenSurface: (sectionId: ShellSectionId) => void;
};

const prettyCapability = (grant: CapabilityGrant): string => grant.capability.replaceAll("-", " ");
const registrySourceForInstallation = (installation: AddOnInstallation | null): AddOnRegistryEntry["registrySource"] =>
  installation?.source === "sideload" ? "sideloaded-local" : "bundled-catalog";
const registryEntryFor = (
  manifest: AddOnManifest,
  installation: AddOnInstallation | null,
): AddOnRegistryEntry =>
  createAddOnRegistryEntry(manifest, {
    registrySource: registrySourceForInstallation(installation),
    installation: installation ?? undefined,
  });
const hasGrant = (installation: AddOnInstallation | null, capability: CapabilityGrant["capability"]): boolean =>
  Boolean(installation?.grantedCapabilities.some((grant) => grant.capability === capability && grant.granted));
const isBrowserVisibleReady = (installation: AddOnInstallation | null): boolean =>
  Boolean(
    installation?.enabled &&
      hasGrant(installation, "network") &&
      hasGrant(installation, "ui-embedding") &&
      hasGrant(installation, "browser-control") &&
      hasGrant(installation, "filesystem"),
  );
const isHermesBridgeReady = (installation: AddOnInstallation | null): boolean =>
  Boolean(installation?.enabled && hasGrant(installation, "shell") && hasGrant(installation, "ui-embedding"));
const hasScaffoldContract = (manifest: AddOnManifest): boolean =>
  Boolean(
    manifest.workflowBoundaries?.length ||
      manifest.skills?.length ||
      manifest.connectors?.length ||
      manifest.scripts?.length ||
      manifest.hooks?.length ||
      manifest.tools?.length,
  );
const shellNavigationSectionFor = (manifest: AddOnManifest): ShellSectionId | null =>
  manifest.surfaces.find((surface) => surface.shellNavigation)?.shellNavigation?.sectionId ?? null;

const addonPrimaryActionLabel = (manifest: AddOnManifest, installation: AddOnInstallation | null): string => {
  if (manifest.id === "addon.browser" && !isBrowserVisibleReady(installation)) {
    return "Install and grant browser access";
  }
  if (manifest.id === "addon.hermes" && !isHermesBridgeReady(installation)) {
    return "Install and grant Hermes workspace access";
  }
  if (!installation?.installed) {
    return "Install";
  }
  return installation.enabled ? "Disable" : "Enable";
};

export function AddOnsWorkspace(props: AddOnsWorkspaceProps) {
  return (
    <>
      <Panel
        title="Add-on Workspace"
        subtitle="Curated manifests plus local sideloading, with capability grants instead of blanket trust."
        actions={
          <div className="toolbar">
            <input
              className="search-input"
              value={props.search}
              onChange={(event) => props.onSearchChange(event.target.value)}
              placeholder="Search add-ons"
            />
          </div>
        }
      >
        <div className="sideload-strip">
          <input
            value={props.sideloadPath}
            onChange={(event) => props.onSideloadPathChange(event.target.value)}
            placeholder="/absolute/path/to/addon-manifest.json"
          />
          <button type="button" className="button-primary" onClick={props.onSideload}>
            Sideload manifest
          </button>
        </div>

        <div className="addon-grid">
          {props.filteredManifests.map((manifest) => {
            const effectiveInstallation = props.installations[manifest.id] ?? null;
            const registryEntry = registryEntryFor(manifest, effectiveInstallation);
            const shellNavigationSection = shellNavigationSectionFor(manifest);
            const canOpenSurface = Boolean(
              shellNavigationSection && effectiveInstallation?.installed && effectiveInstallation.enabled,
            );
            return (
              <article
                key={manifest.id}
                className={`addon-card ${props.selectedManifest?.id === manifest.id ? "selected" : ""}`}
                onClick={() => props.onSelectManifest(manifest.id)}
              >
                <div className="addon-headline">
                  <div>
                    <strong>{manifest.name}</strong>
                    <p>
                      {manifest.category} · {manifest.runtimeType}
                    </p>
                  </div>
                  <span className={`tone tone-${effectiveInstallation?.enabled ? "active" : "neutral"}`}>
                    {registryEntry.installState}
                  </span>
                </div>
                <p>{manifest.description}</p>
                <div className="addon-registry-strip" aria-label={`${manifest.name} registry status`}>
                  <span>{registryEntry.registrySource.replaceAll("-", " ")}</span>
                  <span>{registryEntry.reviewState}</span>
                  <span>{registryEntry.verificationState}</span>
                </div>
                {canOpenSurface && shellNavigationSection ? (
                  <button
                    type="button"
                    className="button-primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onOpenSurface(shellNavigationSection);
                    }}
                  >
                    Open {manifest.name}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button-secondary"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (manifest.id === "addon.browser" && !isBrowserVisibleReady(effectiveInstallation)) {
                      props.onSelectManifest(manifest.id);
                      props.onGrantCapabilities(
                        manifest.id,
                        ["network", "ui-embedding", "browser-control", "filesystem"],
                        manifest.requestedCapabilities,
                      );
                      return;
                    }
                    if (manifest.id === "addon.hermes" && !isHermesBridgeReady(effectiveInstallation)) {
                      props.onSelectManifest(manifest.id);
                      props.onGrantCapabilities(
                        manifest.id,
                        ["shell", "ui-embedding"],
                        manifest.requestedCapabilities,
                      );
                      return;
                    }
                    props.onToggleAddonInstall(manifest);
                  }}
                >
                  {addonPrimaryActionLabel(manifest, effectiveInstallation)}
                </button>
              </article>
            );
          })}
        </div>
      </Panel>

      {props.selectedManifest && props.selectedInstallation && (
        <AddOnDetailPanel
          selectedManifest={props.selectedManifest}
          selectedInstallation={props.selectedInstallation}
          registryEntry={registryEntryFor(props.selectedManifest, props.selectedInstallation)}
          onToggleGrant={props.onToggleGrant}
          onGrantCapabilities={props.onGrantCapabilities}
          onUpdateAddonConfig={props.onUpdateAddonConfig}
          onRunLogicianScript={props.onRunLogicianScript}
          onRunLogicianHook={props.onRunLogicianHook}
          onAskAugmentor={props.onAskAugmentor}
          onOpenArchiveReview={props.onOpenArchiveReview}
        />
      )}
    </>
  );
}

type AddOnDetailPanelProps = Pick<
  AddOnsWorkspaceProps,
  | "onAskAugmentor"
  | "onGrantCapabilities"
  | "onOpenArchiveReview"
  | "onRunLogicianHook"
  | "onRunLogicianScript"
  | "onToggleGrant"
  | "onUpdateAddonConfig"
> & {
  selectedManifest: AddOnManifest;
  selectedInstallation: AddOnInstallation;
  registryEntry: AddOnRegistryEntry;
};

function AddOnDetailPanel(props: AddOnDetailPanelProps) {
  const [logicianBusyId, setLogicianBusyId] = useState<string | null>(null);
  const [logicianNotice, setLogicianNotice] = useState("");
  const runScript = async (script: AddOnScriptDefinition) => {
    setLogicianBusyId(script.id);
    setLogicianNotice("");
    try {
      const artifact = await props.onRunLogicianScript(props.selectedManifest, props.selectedInstallation, script);
      setLogicianNotice(`${artifact.status}: ${artifact.summary}`);
    } catch (error) {
      setLogicianNotice(error instanceof Error ? error.message : "Logician script failed.");
    } finally {
      setLogicianBusyId(null);
    }
  };
  const runHook = async (hook: AddOnHookDefinition) => {
    setLogicianBusyId(hook.id);
    setLogicianNotice("");
    try {
      const artifact = await props.onRunLogicianHook(props.selectedManifest, props.selectedInstallation, hook);
      setLogicianNotice(`${artifact.status}: ${artifact.summary}`);
    } catch (error) {
      setLogicianNotice(error instanceof Error ? error.message : "Logician hook failed.");
    } finally {
      setLogicianBusyId(null);
    }
  };

  return (
    <Panel
      title={props.selectedManifest.name}
      subtitle="Catalog provenance, install state, capability grants, and shell integration."
      actions={
        <span className={`tone tone-${props.registryEntry.enabled ? "active" : "neutral"}`}>
          {props.registryEntry.registrySource} · {props.registryEntry.provenanceTier}
        </span>
      }
    >
      <div className="addon-registry-summary">
        <div>
          <span className="eyebrow">Registry state</span>
          <strong>{props.registryEntry.reviewState}</strong>
          <p>
            This is a discovery record. Installation, enablement, and grants are controlled separately by
            ResonantOS.
          </p>
        </div>
        <div className="addon-registry-strip">
          <span>{props.registryEntry.installState}</span>
          <span>{props.registryEntry.verificationState}</span>
          <span>{props.registryEntry.manifestRef.label}</span>
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-card">
          <span className="eyebrow">Provenance</span>
          <ul>
            <li>Tier: {props.registryEntry.provenanceTier}</li>
            <li>Source: {props.registryEntry.registrySource}</li>
            <li>Review: {props.registryEntry.reviewState}</li>
            <li>Verification: {props.registryEntry.verificationState}</li>
            <li>
              Recommended grants:{" "}
              {props.registryEntry.recommendedGrantPresetIds.length
                ? props.registryEntry.recommendedGrantPresetIds.join(", ")
                : "none"}
            </li>
          </ul>
        </div>
        <div className="detail-card">
          <span className="eyebrow">Surfaces</span>
          <ul>
            {props.selectedManifest.surfaces.map((surface) => (
              <li key={surface.id}>
                <strong>{surface.label}</strong> · {surface.type}
              </li>
            ))}
          </ul>
        </div>
        <div className="detail-card">
          <span className="eyebrow">Capabilities</span>
          <div className="grant-list">
            {props.selectedInstallation.grantedCapabilities.map((grant) => (
              <button
                key={grant.capability}
                type="button"
                className={`grant-chip ${grant.granted ? "granted" : ""}`}
                onClick={() => props.onToggleGrant(props.selectedManifest.id, grant.capability)}
              >
                {prettyCapability(grant)} · {grant.scope}
              </button>
            ))}
          </div>
        </div>
        <div className="detail-card">
          <span className="eyebrow">Archive contract</span>
          <ul>
            <li>Read scopes: {props.selectedManifest.archiveIntegration.readScopes.join(", ") || "none"}</li>
            <li>Intake writes: {props.selectedManifest.archiveIntegration.intakeWriteScopes.join(", ") || "none"}</li>
            <li>Request ingest: {props.selectedManifest.archiveIntegration.canRequestIngest ? "yes" : "no"}</li>
            <li>Knowledge writes: {props.selectedManifest.archiveIntegration.canWriteKnowledgePages ? "yes" : "no"}</li>
          </ul>
        </div>
        {hasScaffoldContract(props.selectedManifest) && (
          <div className="detail-card">
            <span className="eyebrow">Workflow scaffold</span>
            <ul>
              <li>Boundaries: {props.selectedManifest.workflowBoundaries?.length ?? 0}</li>
              <li>Skills: {(props.selectedManifest.skills?.length ?? 0) + (props.selectedManifest.augmentorSkills?.length ?? 0)}</li>
              <li>Connectors: {props.selectedManifest.connectors?.length ?? 0}</li>
              <li>Tools: {props.selectedManifest.tools?.length ?? 0}</li>
              <li>Scripts: {props.selectedManifest.scripts?.length ?? 0}</li>
              <li>Hooks: {props.selectedManifest.hooks?.length ?? 0}</li>
            </ul>
          </div>
        )}
      </div>

      {hasScaffoldContract(props.selectedManifest) && (
        <AddOnScaffoldPanel
          manifest={props.selectedManifest}
          installation={props.selectedInstallation}
          busyId={logicianBusyId}
          notice={logicianNotice}
          onRunHook={runHook}
          onRunScript={runScript}
        />
      )}

      {props.selectedManifest.id === "addon.obsidian" && (
        <ObsidianAddonPanel
          installation={props.selectedInstallation}
          onConfigChange={(config) => props.onUpdateAddonConfig(props.selectedManifest.id, config)}
          onAskAugmentor={props.onAskAugmentor}
          onGrantArchiveIntake={() =>
            props.onGrantCapabilities(
              props.selectedManifest.id,
              ["archive-intake-write"],
              props.selectedManifest.requestedCapabilities,
            )
          }
          onOpenArchiveReview={props.onOpenArchiveReview}
        />
      )}

      {props.selectedManifest.id === "addon.browser" && (
        <BrowserAddonSetupPanel
          installation={props.selectedInstallation}
          onGrantVisibleAccess={() =>
            props.onGrantCapabilities(
              props.selectedManifest.id,
              ["network", "ui-embedding", "browser-control", "filesystem"],
              props.selectedManifest.requestedCapabilities,
            )
          }
        />
      )}

      {props.selectedManifest.id === "addon.hermes" && (
        <HermesAddonPanel
          installation={props.selectedInstallation}
          requestedCapabilities={props.selectedManifest.requestedCapabilities}
          onGrantCapabilities={(capabilities, requestedCapabilities) =>
            props.onGrantCapabilities(props.selectedManifest.id, capabilities, requestedCapabilities)
          }
          onConfigChange={(config) => props.onUpdateAddonConfig(props.selectedManifest.id, config)}
        />
      )}

      {props.selectedManifest.id === "addon.telegram-channel" && (
        <TelegramAddonPanel
          installation={props.selectedInstallation}
          requestedCapabilities={props.selectedManifest.requestedCapabilities}
          onGrantCapabilities={(capabilities, requestedCapabilities) =>
            props.onGrantCapabilities(props.selectedManifest.id, capabilities, requestedCapabilities)
          }
          onConfigChange={(config) => props.onUpdateAddonConfig(props.selectedManifest.id, config)}
        />
      )}

    </Panel>
  );
}

function latestArtifactFor(
  installation: AddOnInstallation,
  kind: LogicianExecutionArtifact["kind"],
  targetId: string,
): LogicianExecutionArtifact | undefined {
  return installation.verificationArtifacts?.find((artifact) => artifact.kind === kind && artifact.targetId === targetId);
}

function AddOnScaffoldPanel({
  manifest,
  installation,
  busyId,
  notice,
  onRunHook,
  onRunScript,
}: {
  manifest: AddOnManifest;
  installation: AddOnInstallation;
  busyId: string | null;
  notice: string;
  onRunHook: (hook: AddOnHookDefinition) => void;
  onRunScript: (script: AddOnScriptDefinition) => void;
}) {
  return (
    <div className="bundle-card">
      <span className="eyebrow">Packaged workflow</span>
      <p className="muted-copy">
        This section explains the add-on scaffold: the repeatable work it packages, the skills it teaches, the
        systems it connects to, and the deterministic checks it can run through Logician-style tooling.
      </p>
      <div className="detail-grid">
        {manifest.workflowBoundaries?.map((boundary) => (
          <div className="detail-card" key={boundary.id}>
            <span className="eyebrow">{boundary.repeatability}</span>
            <strong>{boundary.label}</strong>
            <p>{boundary.jobToBeDone}</p>
            <p className="muted-copy">{boundary.userValue}</p>
          </div>
        ))}
        {manifest.skills?.map((skill) => (
          <div className="detail-card" key={skill.id}>
            <span className="eyebrow">Skill · {skill.invocation}</span>
            <strong>{skill.name}</strong>
            <p>{skill.description}</p>
            <p className="muted-copy">{skill.documentPath}</p>
          </div>
        ))}
        {manifest.augmentorSkills?.map((skill) => (
          <div className="detail-card" key={skill.documentPath}>
            <span className="eyebrow">Augmentor skill</span>
            <strong>{skill.objective}</strong>
            <p className="muted-copy">{skill.documentPath}</p>
            <p className="muted-copy">
              {skill.workflowPhases.length} phases · {skill.approvalGates.length} approval gates
            </p>
          </div>
        ))}
        {manifest.connectors?.map((connector) => (
          <div className="detail-card" key={connector.id}>
            <span className="eyebrow">Connector · {connector.type}</span>
            <strong>{connector.name}</strong>
            <p>{connector.description}</p>
            <p className="muted-copy">Config: {connector.configScope}</p>
          </div>
        ))}
        {manifest.scripts?.map((script) => (
          <div className="detail-card" key={script.id}>
            <span className="eyebrow">Script · {script.runPolicy}</span>
            <strong>{script.name}</strong>
            <p>{script.description}</p>
            <p className="muted-copy">
              {script.deterministic ? "Deterministic" : "Non-deterministic"} ·{" "}
              {script.requiresHumanApproval ? "approval required" : "host-gated"}
            </p>
            {latestArtifactFor(installation, "script", script.id) ? (
              <LogicianArtifactInspector artifact={latestArtifactFor(installation, "script", script.id)} />
            ) : null}
            <button
              type="button"
              className="button-secondary touch-action"
              disabled={busyId === script.id}
              onClick={() => onRunScript(script)}
            >
              {busyId === script.id ? "Running check..." : "Run Logician check"}
            </button>
          </div>
        ))}
        {manifest.hooks?.map((hook) => (
          <AddOnHookCard
            key={hook.id}
            manifest={manifest}
            installation={installation}
            hook={hook}
            busy={busyId === hook.id}
            onRunHook={onRunHook}
          />
        ))}
      </div>
      {notice ? <p className="muted-copy">{notice}</p> : null}
    </div>
  );
}

function AddOnHookCard({
  manifest,
  installation,
  hook,
  busy,
  onRunHook,
}: {
  manifest: AddOnManifest;
  installation: AddOnInstallation;
  hook: AddOnHookDefinition;
  busy: boolean;
  onRunHook: (hook: AddOnHookDefinition) => void;
}) {
  const activation = assessLogicianHookActivation({
    manifest,
    installation,
    hook,
    humanInitiated: false,
  });
  const latest = latestArtifactFor(installation, "hook", hook.id);
  const blocked = activation.status === "blocked";

  return (
    <div className="detail-card">
      <span className="eyebrow">Hook · {hook.event}</span>
      <strong>{hook.handlerRef}</strong>
      <p className="muted-copy">
        {activation.status} · failure policy: {hook.failurePolicy}
      </p>
      {blocked ? <p className="muted-copy">{activation.issues.map((issue) => issue.message).join(" ")}</p> : null}
      {latest ? (
        <LogicianArtifactInspector artifact={latest} />
      ) : null}
      <button
        type="button"
        className="button-secondary touch-action"
        disabled={busy || blocked}
        onClick={() => onRunHook(hook)}
      >
        {busy ? "Running hook..." : blocked ? "Hook blocked" : "Run hook"}
      </button>
    </div>
  );
}

function LogicianArtifactInspector({ artifact }: { artifact?: LogicianExecutionArtifact }) {
  if (!artifact) {
    return null;
  }
  const report = artifact.verifyAgentReport ?? trustReportFromEvidence(artifact.evidence);
  return (
    <div className="logician-artifact-inspector">
      <div className="addon-registry-strip">
        <span>Latest: {artifact.status}</span>
        <span>Verify Agent: {report?.status ?? "missing"}</span>
        <span>{artifact.commandRef}</span>
      </div>
      <p className="muted-copy">{artifact.summary}</p>
      {report ? (
        <>
          <p className="muted-copy">
            <strong>Next action:</strong> {report.nextAction}
          </p>
          <div className="addon-registry-strip" aria-label="Evidence trust counts">
            {Object.entries(report.evidenceTrustCounts).map(([tier, count]) => (
              <span key={tier}>
                {tier}: {count}
              </span>
            ))}
          </div>
          {report.findings.length ? (
            <ul className="logician-finding-list" aria-label="Verify Agent findings">
              {report.findings.slice(0, 4).map((finding) => (
                <li key={`${finding.code}-${finding.message}`}>
                  <strong>{finding.code}</strong> · {finding.severity} · {finding.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-copy">No Verify Agent findings.</p>
          )}
        </>
      ) : (
        <p className="muted-copy">No Verify Agent report attached to this artifact.</p>
      )}
    </div>
  );
}

function trustReportFromEvidence(evidence: Record<string, unknown>): VerifyAgentReport | undefined {
  const report = evidence.verifyAgentReport;
  if (typeof report !== "object" || report === null) {
    return undefined;
  }
  return report as VerifyAgentReport;
}

function BrowserAddonSetupPanel({
  installation,
  onGrantVisibleAccess,
}: {
  installation: AddOnInstallation;
  onGrantVisibleAccess: () => void;
}) {
  const [engineStatus, setEngineStatus] = useState<BrowserEngineStatus | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [engineError, setEngineError] = useState("");
  const [engineLog, setEngineLog] = useState("");
  const networkGranted = installation.grantedCapabilities.some((grant) => grant.capability === "network" && grant.granted);
  const embeddingGranted = installation.grantedCapabilities.some((grant) => grant.capability === "ui-embedding" && grant.granted);
  const browserControlGranted = installation.grantedCapabilities.some((grant) => grant.capability === "browser-control" && grant.granted);
  const filesystemGranted = installation.grantedCapabilities.some((grant) => grant.capability === "filesystem" && grant.granted);
  const ready = installation.enabled && networkGranted && embeddingGranted && browserControlGranted && filesystemGranted;
  const installerReady = installation.enabled && networkGranted && browserControlGranted;

  useEffect(() => {
    let cancelled = false;
    requestBrowserEngineStatus()
      .then((status) => {
        if (!cancelled) {
          setEngineStatus(status);
          setEngineError("");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setEngineError(error instanceof Error ? error.message : "Could not inspect Chromium engine.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const installEngine = async () => {
    setEngineBusy(true);
    setEngineError("");
    setEngineLog("");
    try {
      const result = await requestBrowserInstallEngine();
      setEngineLog(result.log);
      setEngineStatus({
        installed: result.installed,
        enginePath: result.enginePath,
        installHint: result.installed ? "Chromium engine is installed." : "Chromium engine installation did not complete.",
      });
      if (!result.installed) {
        setEngineError("Chromium engine installation did not complete.");
      }
    } catch (error) {
      setEngineError(error instanceof Error ? error.message : "Chromium engine install failed.");
    } finally {
      setEngineBusy(false);
    }
  };

  return (
    <div className="browser-addon-panel">
      <div>
        <span className="eyebrow">Browser setup</span>
        <h3>Controlled Chromium access</h3>
        <p>
          Install Browser and grant network, UI embedding, browser control, and reviewed filesystem access to launch
          the native embedded Chromium host with trusted extension flows for Phantom and Bitwarden.
        </p>
      </div>
      <div className="browser-addon-grant-box">
        <span className={`tone tone-${networkGranted ? "active" : "neutral"}`}>network {networkGranted ? "granted" : "needed"}</span>
        <span className={`tone tone-${embeddingGranted ? "active" : "neutral"}`}>
          ui embedding {embeddingGranted ? "granted" : "needed"}
        </span>
        <span className={`tone tone-${browserControlGranted ? "active" : "neutral"}`}>
          browser control {browserControlGranted ? "granted" : "needed"}
        </span>
        <span className={`tone tone-${filesystemGranted ? "active" : "neutral"}`}>
          filesystem {filesystemGranted ? "granted" : "needed"}
        </span>
        <span className={`tone tone-${engineStatus?.installed ? "active" : "neutral"}`}>
          chromium {engineStatus?.installed ? "installed" : "needed"}
        </span>
        <button type="button" className="button-primary touch-action" onClick={onGrantVisibleAccess} disabled={ready}>
          {ready ? "Browser access granted" : "Install and grant controlled browser access"}
        </button>
        <button
          type="button"
          className="button-secondary touch-action"
          onClick={installEngine}
          disabled={engineBusy || Boolean(engineStatus?.installed) || !installerReady}
        >
          {engineBusy
            ? "Installing Chromium..."
            : engineStatus?.installed
              ? "Chromium installed"
              : installerReady
                ? "Install Chromium Engine"
                : "Grant Browser access first"}
        </button>
      </div>
      {engineStatus?.enginePath ? <p className="muted-copy">Engine path: {engineStatus.enginePath}</p> : null}
      {engineError ? (
        <p className="form-error" role="alert">
          {engineError}
        </p>
      ) : null}
      {engineLog ? <pre className="browser-addon-install-log">{engineLog.slice(-1600)}</pre> : null}
    </div>
  );
}
