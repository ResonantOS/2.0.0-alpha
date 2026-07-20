// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md
// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

import { useEffect, useState } from "react";
import type { AddOnInstallation, AddOnManifest, CapabilityGrant, OpenCodeServiceResult, OpenCodeStatus, TaskWorkspacePayload } from "../../core/contracts";
import {
  requestOpenCodeInjectPrompt,
  requestListTaskWorkspaces,
  requestOpenCodeStartService,
  requestOpenCodeStatus,
  requestOpenCodeStopService,
  requestOpenCodeWorkspaceFolderSelection,
  requestReadTaskWorkspace,
} from "../../core/runtime";
import "./opencode-workspace.css";

type OpenCodeWorkspaceProps = {
  active: boolean;
  manifest?: AddOnManifest;
  installation?: AddOnInstallation;
  onConfigureAddon: () => void;
  onGrantWorkspaceAccess: () => void;
  onWorkspacePathChange: (workspacePath: string) => void;
  onOpenDelegationMonitor: () => void;
  pendingTaskWorkspaceId?: string | null;
  onPendingTaskConsumed?: () => void;
};

const hasGrant = (installation: AddOnInstallation | undefined, capability: CapabilityGrant["capability"]): boolean =>
  Boolean(installation?.enabled && installation.grantedCapabilities.some((grant) => grant.capability === capability && grant.granted));

const configuredWorkspacePath = (installation: AddOnInstallation | undefined): string =>
  typeof installation?.config?.workspacePath === "string" ? installation.config.workspacePath : "";

const openCodeRuntimeGuidance = (status: OpenCodeStatus | null): string => {
  const lines = [
    status?.installHint || "Install OpenCode with `curl -fsSL https://opencode.ai/install | bash` or `npm install -g opencode-ai`.",
  ];
  if (status?.installCommand) {
    lines.push(`Primary command: ${status.installCommand}`);
  }
  if (status?.alternativeInstallCommands?.length) {
    lines.push(`Alternatives: ${status.alternativeInstallCommands.join(" | ")}`);
  }
  if (status?.configureCommand) {
    lines.push(`Existing install override: ${status.configureCommand}`);
  }
  if (status?.overrideConfigured && !status.overrideFound) {
    lines.push(`Configured override was not found: ${status.overridePath || "OPENCODE_COMMAND"}`);
  }
  if (status?.searchedCommands?.length) {
    lines.push(`Command names checked: ${status.searchedCommands.join(", ")}`);
  }
  if (status?.searchedPaths?.length) {
    const suffix = status.searchedPathOmitted ? ` (+${status.searchedPathOmitted} more)` : "";
    lines.push(`Searched paths${suffix}:`);
    lines.push(...status.searchedPaths.slice(0, 12).map((candidate) => `- ${candidate}`));
  }
  return lines.join("\n");
};

export function OpenCodeWorkspace({
  active,
  manifest,
  installation,
  onConfigureAddon,
  onGrantWorkspaceAccess,
  onWorkspacePathChange,
  onOpenDelegationMonitor,
  pendingTaskWorkspaceId,
  onPendingTaskConsumed,
}: OpenCodeWorkspaceProps) {
  const [status, setStatus] = useState<OpenCodeStatus | null>(null);
  const [service, setService] = useState<OpenCodeServiceResult | null>(null);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [latestDelegation, setLatestDelegation] = useState<TaskWorkspacePayload | null>(null);
  const [injectedWorkspaceId, setInjectedWorkspaceId] = useState("");
  const [injectionNotice, setInjectionNotice] = useState("");
  const [delegationWebUrl, setDelegationWebUrl] = useState("");
  const [stoppedByUser, setStoppedByUser] = useState(false);
  const [autoLaunchAttemptedFor, setAutoLaunchAttemptedFor] = useState("");
  const workspacePath = configuredWorkspacePath(installation);
  const filesystemGranted = hasGrant(installation, "filesystem");
  const shellGranted = hasGrant(installation, "shell");
  const embeddingGranted = hasGrant(installation, "ui-embedding");
  const grantsReady = Boolean(installation?.enabled && filesystemGranted && shellGranted && embeddingGranted);
  const ready = Boolean(grantsReady && workspacePath && status?.installed);

  useEffect(() => {
    if (!active || status) {
      return undefined;
    }
    let cancelled = false;
    setBusyLabel("Checking OpenCode");
    requestOpenCodeStatus()
      .then((nextStatus) => {
        if (!cancelled) {
          setStatus(nextStatus);
        }
      })
      .catch((statusError) => {
        if (!cancelled) {
          setError(statusError instanceof Error ? statusError.message : "Failed to check OpenCode runtime.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusyLabel("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, status]);

  const loadDelegationPayload = async (workspaceId?: string | null): Promise<TaskWorkspacePayload | null> => {
    if (workspaceId) {
      return requestReadTaskWorkspace(workspaceId);
    }
    const workspaces = await requestListTaskWorkspaces();
    const latestOpenCodeWorkspace = [...workspaces]
      .filter((workspace) => workspace.id.includes("opencode"))
      .sort((left, right) => right.id.localeCompare(left.id))[0];
    if (!latestOpenCodeWorkspace) {
      return null;
    }
    return requestReadTaskWorkspace(latestOpenCodeWorkspace.id);
  };

  const refreshLatestDelegation = async () => {
    setLatestDelegation(await loadDelegationPayload(pendingTaskWorkspaceId));
  };

  const promptFromDelegation = (payload: TaskWorkspacePayload): string =>
    [
      "ResonantOS delegated this task to OpenCode. Review the scope before acting.",
      "",
      payload.taskMarkdown,
      "",
      "Return changed files, commands run, deterministic verification, and residual risks before marking complete.",
    ].join("\n");

  const injectLatestDelegationPrompt = async (options: { automatic?: boolean } = {}) => {
    if (!service || !latestDelegation) {
      return;
    }
    setInjectionNotice(options.automatic ? "Starting delegated task in OpenCode..." : "Starting task in OpenCode session...");
    try {
      const result = await requestOpenCodeInjectPrompt({
        sessionId: service.sessionId,
        prompt: promptFromDelegation(latestDelegation),
        clearExisting: true,
        submit: true,
      });
      setInjectedWorkspaceId(latestDelegation.workspace.id);
      if (result.webUrl) {
        setDelegationWebUrl(result.webUrl);
      }
      setInjectionNotice(
        `Task started in an OpenCode session (${result.promptLength} chars). You can watch, interrupt, or continue directly inside OpenCode.`,
      );
      onPendingTaskConsumed?.();
    } catch (injectionError) {
      setInjectionNotice(injectionError instanceof Error ? injectionError.message : "Failed to inject delegated task into OpenCode.");
    }
  };

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    let cancelled = false;
    loadDelegationPayload(pendingTaskWorkspaceId)
      .then((payload) => {
        if (!cancelled && payload) {
          setLatestDelegation(payload);
          if (pendingTaskWorkspaceId && injectedWorkspaceId !== payload.workspace.id) {
            setInjectionNotice("Delegated task received. Launching OpenCode will open it in a visible session.");
          }
        }
        if (!cancelled && !payload) {
          setLatestDelegation(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLatestDelegation(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, pendingTaskWorkspaceId]);

  const chooseWorkspace = async () => {
    setError("");
    setBusyLabel("Choosing workspace");
    try {
      const selected = await requestOpenCodeWorkspaceFolderSelection();
      if (selected) {
        onWorkspacePathChange(selected);
      }
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "Failed to choose OpenCode workspace.");
    } finally {
      setBusyLabel("");
    }
  };

  const refreshStatus = async () => {
    setError("");
    setBusyLabel("Checking OpenCode");
    try {
      setStatus(await requestOpenCodeStatus());
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Failed to check OpenCode runtime.");
    } finally {
      setBusyLabel("");
    }
  };

  const startService = async (targetWorkspacePath = workspacePath, options: { automatic?: boolean } = {}) => {
    if (!targetWorkspacePath) {
      setError("Choose a scoped workspace before launching OpenCode.");
      return;
    }
    setError("");
    setBusyLabel(options.automatic ? "Reattaching OpenCode" : "Starting OpenCode");
    if (options.automatic) {
      setAutoLaunchAttemptedFor(targetWorkspacePath);
    }
    try {
      setService(
        await requestOpenCodeStartService({
          workspacePath: targetWorkspacePath,
          mode: "serve",
          sessionId: "opencode-main",
        }),
      );
      setStoppedByUser(false);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Failed to start OpenCode service.");
    } finally {
      setBusyLabel("");
    }
  };

  const setupAndLaunch = async () => {
    if (!grantsReady) {
      onGrantWorkspaceAccess();
    }
    let launchWorkspacePath = workspacePath;
    if (!launchWorkspacePath) {
      setError("");
      setBusyLabel("Choosing workspace");
      try {
        const selected = await requestOpenCodeWorkspaceFolderSelection();
        if (!selected) {
          setBusyLabel("");
          return;
        }
        launchWorkspacePath = selected;
        onWorkspacePathChange(selected);
      } catch (selectionError) {
        setError(selectionError instanceof Error ? selectionError.message : "Failed to choose OpenCode workspace.");
        setBusyLabel("");
        return;
      }
    }

    setError("");
    setBusyLabel("Checking OpenCode");
    let nextStatus: OpenCodeStatus;
    try {
      nextStatus = await requestOpenCodeStatus();
      setStatus(nextStatus);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Failed to check OpenCode runtime.");
      setBusyLabel("");
      return;
    }

    if (!nextStatus.installed) {
      setError(`OpenCode is not installed or not detectable.\n${openCodeRuntimeGuidance(nextStatus)}`);
      setBusyLabel("");
      return;
    }

    await startService(launchWorkspacePath);
  };

  const stopService = async () => {
    setError("");
    setBusyLabel("Stopping OpenCode");
    try {
      await requestOpenCodeStopService(service?.sessionId ?? "opencode-main");
      setService(null);
      setStoppedByUser(true);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Failed to stop OpenCode service.");
    } finally {
      setBusyLabel("");
    }
  };

  useEffect(() => {
    if (!active || !ready || service || busyLabel || stoppedByUser || autoLaunchAttemptedFor === workspacePath) {
      return;
    }
    void startService(workspacePath, { automatic: true });
  }, [active, autoLaunchAttemptedFor, busyLabel, ready, service, stoppedByUser, workspacePath]);

  useEffect(() => {
    if (!active || !service || !latestDelegation || injectedWorkspaceId === latestDelegation.workspace.id) {
      return;
    }
    void injectLatestDelegationPrompt({ automatic: true });
  }, [active, injectedWorkspaceId, latestDelegation?.workspace.id, service?.sessionId]);

  const missingRequirements = [
    !installation?.enabled ? "enable the add-on" : "",
    !filesystemGranted ? "grant scoped filesystem access" : "",
    !shellGranted ? "grant host-mediated shell access" : "",
    !embeddingGranted ? "grant UI embedding" : "",
    !workspacePath ? "choose a workspace folder" : "",
    status && !status.installed ? "install OpenCode runtime" : "",
  ].filter(Boolean);

  return (
    <section className={`opencode-workspace ${active ? "" : "is-hidden"}`} data-testid="opencode-workspace" aria-hidden={!active}>
      <header className="opencode-toolbar">
        <div className="opencode-toolbar-main">
          <strong>{manifest?.name ?? "OpenCode"}</strong>
          <span className={`opencode-runtime-pill ${service ? "ready" : ready ? "ready" : "attention"}`}>
            {service ? "Running" : ready ? "Ready" : "Setup needed"}
          </span>
          {workspacePath ? <span className="opencode-workspace-path">{workspacePath}</span> : null}
          {busyLabel ? <span className="opencode-busy">{busyLabel}...</span> : null}
        </div>
        <div className="opencode-toolbar-actions">
          <button type="button" className="button-primary touch-action" onClick={() => void setupAndLaunch()} disabled={Boolean(busyLabel)}>
            {service ? "Restart" : "Launch"}
          </button>
          <button type="button" className="button-secondary touch-action" onClick={() => void stopService()} disabled={!service || Boolean(busyLabel)}>
            Stop
          </button>
          <button
            type="button"
            className="opencode-icon-button"
            aria-label="OpenCode workspace settings"
            title="OpenCode workspace settings"
            onClick={() => setSettingsOpen((current) => !current)}
          >
            ⚙
          </button>
        </div>
      </header>

      {settingsOpen ? (
        <div className="opencode-settings-drawer">
          <section className="opencode-setup-card">
            <span className="eyebrow">Runtime</span>
            <strong>{status?.installed ? `OpenCode ${status.version ?? "detected"}` : "OpenCode not detected"}</strong>
            <p>{status?.binaryPath ?? status?.installHint ?? "Checking OpenCode runtime..."}</p>
            {status && !status.installed ? <pre className="opencode-runtime-guidance">{openCodeRuntimeGuidance(status)}</pre> : null}
            <button type="button" className="button-secondary touch-action" onClick={() => void refreshStatus()} disabled={Boolean(busyLabel)}>
              Check OpenCode
            </button>
          </section>

          <section className="opencode-setup-card">
            <span className="eyebrow">Workspace scope</span>
            <strong>{workspacePath || "No workspace selected"}</strong>
            <p>Use a disposable test vault or task workspace first. Do not point this at a real vault until versioning is active.</p>
            <button type="button" className="button-secondary touch-action" onClick={() => void chooseWorkspace()} disabled={Boolean(busyLabel)}>
              Choose Workspace
            </button>
          </section>

          <section className="opencode-setup-card">
            <span className="eyebrow">Capability gate</span>
            <strong>{grantsReady ? "Required grants active" : "Required grants missing"}</strong>
            <p>Requires filesystem, shell, and UI embedding. Provider and archive grants remain separate.</p>
            <button type="button" className="button-secondary touch-action" onClick={onGrantWorkspaceAccess}>
              Grant OpenCode Access
            </button>
            <button type="button" className="button-secondary touch-action" onClick={onConfigureAddon}>
              Open Add-on Settings
            </button>
          </section>
        </div>
      ) : null}

      {missingRequirements.length ? (
        <div className="opencode-warning">
          <strong>Before launch:</strong> {missingRequirements.join(", ")}.
        </div>
      ) : null}
      {error ? <div className="opencode-error">{error}</div> : null}

      <section className="opencode-embed-shell" aria-label="OpenCode embedded workspace">
        {latestDelegation ? (
          <div className="opencode-delegation-strip">
            <div>
              <strong>Delegated task ready</strong>
              <span>{latestDelegation.packet.mission}</span>
              <small>{injectionNotice || `TASK.md: ${latestDelegation.workspace.taskMarkdownPath}`}</small>
            </div>
            <div className="opencode-delegation-actions">
              <button
                type="button"
                className="button-secondary touch-action"
                onClick={() => void injectLatestDelegationPrompt()}
                disabled={!service}
              >
                Send to OpenCode
              </button>
              <button type="button" className="button-secondary touch-action" onClick={() => void refreshLatestDelegation()}>
                Refresh
              </button>
              <button type="button" className="button-secondary touch-action" onClick={onOpenDelegationMonitor}>
                Monitor
              </button>
            </div>
          </div>
        ) : null}
        {service ? (
          <>
            <div className={`opencode-trust-kernel ${service.trustKernelWarning ? "attention" : "ready"}`}>
              <strong>{service.trustKernelWarning ? "Trust Kernel advisory unavailable" : "Trust Kernel advisory active"}</strong>
              <span>
                {service.trustKernelWarning
                  ? service.trustKernelWarning
                  : service.trustKernelPacketPath
                    ? `Protocol packet: ${service.trustKernelPacketPath}`
                    : "Protocol packet recorded for this OpenCode session."}
              </span>
            </div>
            <iframe
              title="OpenCode workspace"
              src={delegationWebUrl || service.webUrl}
              className="opencode-embed-frame"
              sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            />
          </>
        ) : (
          <div className="opencode-embed-placeholder">
            <strong>OpenCode UI will appear here after launch.</strong>
            <p>
              This spike keeps OpenCode as an optional add-on. ResonantOS will use the SDK/API layer for governance and
              OpenCode's own UI for the coding workspace.
            </p>
          </div>
        )}
      </section>
    </section>
  );
}
