// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md
// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

import { useEffect, useState } from "react";
import type {
  AddOnInstallation,
  AddOnManifest,
  CapabilityGrant,
  HermesDashboardStatus,
  HermesWorkspaceSnapshot,
} from "../../core/contracts";
import {
  requestHermesDashboardStart,
  requestHermesDashboardStop,
  requestHermesWorkspaceSnapshot,
} from "../../core/runtime";
import "./hermes-workspace.css";

type HermesWorkspaceProps = {
  active: boolean;
  manifest?: AddOnManifest;
  installation?: AddOnInstallation;
  onConfigureAddon: () => void;
  onGrantWorkspaceAccess: () => void;
  onProfileHomeChange: (profileHome: string) => void;
  onModelMetadataChange: (model: string, availableModels: string[]) => void;
  onAskAugmentor: (message: string) => Promise<void>;
};

const hasGrant = (installation: AddOnInstallation | undefined, capability: CapabilityGrant["capability"]): boolean =>
  Boolean(installation?.enabled && installation.grantedCapabilities.some((grant) => grant.capability === capability && grant.granted));

const configuredProfileHome = (installation: AddOnInstallation | undefined): string =>
  typeof installation?.config?.profileHome === "string" ? installation.config.profileHome : "";

const configuredDashboardUrl = (installation: AddOnInstallation | undefined): string =>
  typeof installation?.config?.dashboardUrl === "string" ? installation.config.dashboardUrl : "";

const configuredHermesModels = (installation: AddOnInstallation | undefined): string[] =>
  Array.isArray(installation?.config?.hermesAvailableModels)
    ? installation.config.hermesAvailableModels.filter((item): item is string => typeof item === "string")
    : [];

export function HermesWorkspace({
  active,
  manifest,
  installation,
  onConfigureAddon,
  onGrantWorkspaceAccess,
  onProfileHomeChange,
  onModelMetadataChange,
  onAskAugmentor,
}: HermesWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<HermesWorkspaceSnapshot | null>(null);
  const [dashboard, setDashboard] = useState<HermesDashboardStatus | null>(null);
  const [profileHomeDraft, setProfileHomeDraft] = useState(configuredProfileHome(installation));
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoStartAttemptedFor, setAutoStartAttemptedFor] = useState("");
  const profileHome = configuredProfileHome(installation);
  const shellGranted = hasGrant(installation, "shell");
  const embeddingGranted = hasGrant(installation, "ui-embedding");
  const archiveReadGranted = hasGrant(installation, "archive-read");
  const grantsReady = Boolean(installation?.enabled && shellGranted && embeddingGranted);
  const dashboardUrl =
    dashboard?.dashboardProxyUrl ||
    snapshot?.dashboard.dashboardProxyUrl ||
    dashboard?.url ||
    configuredDashboardUrl(installation) ||
    snapshot?.dashboard.url ||
    "http://127.0.0.1:9119";
  const dashboardKey = profileHome || "default";
  const configuredHermesModel = typeof installation?.config?.hermesModel === "string" ? installation.config.hermesModel : "";
  const installedHermesModels = configuredHermesModels(installation);

  const persistModelMetadata = (nextSnapshot: HermesWorkspaceSnapshot) => {
    const currentModel = nextSnapshot.install.currentModel?.trim();
    const availableModels = nextSnapshot.install.availableModels.map((model) => model.trim()).filter(Boolean);
    const sameModel = currentModel === configuredHermesModel;
    const sameModels =
      availableModels.length === installedHermesModels.length &&
      availableModels.every((model, index) => model === installedHermesModels[index]);
    if (!currentModel || (sameModel && sameModels)) {
      return;
    }
    onModelMetadataChange(currentModel, availableModels);
  };

  useEffect(() => {
    setProfileHomeDraft(profileHome);
  }, [profileHome]);

  const refresh = async () => {
    setError("");
    setBusyLabel("Checking");
    try {
      const nextSnapshot = await requestHermesWorkspaceSnapshot(profileHome || undefined);
      setSnapshot(nextSnapshot);
      setDashboard(nextSnapshot.dashboard);
      persistModelMetadata(nextSnapshot);
    } catch (snapshotError) {
      setError(snapshotError instanceof Error ? snapshotError.message : "Failed to load Hermes workspace state.");
    } finally {
      setBusyLabel("");
    }
  };

  const startDashboard = async (automatic = false) => {
    if (!grantsReady) {
      if (!automatic) {
        onGrantWorkspaceAccess();
      }
      return;
    }
    setError("");
    setBusyLabel(automatic ? "Starting" : "Starting");
    if (automatic) {
      setAutoStartAttemptedFor(dashboardKey);
    }
    try {
      const nextDashboard = await requestHermesDashboardStart({
        profileHome: profileHome || undefined,
        host: "127.0.0.1",
        port: 9119,
        includeTui: true,
      });
      setDashboard(nextDashboard);
      const nextSnapshot = await requestHermesWorkspaceSnapshot(profileHome || undefined);
      setSnapshot(nextSnapshot);
      persistModelMetadata(nextSnapshot);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Failed to start Hermes dashboard.");
    } finally {
      setBusyLabel("");
    }
  };

  const stopDashboard = async () => {
    setError("");
    setBusyLabel("Stopping");
    try {
      setDashboard(await requestHermesDashboardStop(profileHome || undefined));
      await refresh();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Failed to stop Hermes dashboard.");
    } finally {
      setBusyLabel("");
    }
  };

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    let cancelled = false;
    const run = async () => {
      if (!grantsReady) {
        return;
      }
      setError("");
      setBusyLabel("Checking");
      try {
        const nextSnapshot = await requestHermesWorkspaceSnapshot(profileHome || undefined);
        if (cancelled) {
          return;
        }
        setSnapshot(nextSnapshot);
        setDashboard(nextSnapshot.dashboard);
        persistModelMetadata(nextSnapshot);
        if (!nextSnapshot.dashboard.running && autoStartAttemptedFor !== dashboardKey) {
          await startDashboard(true);
        }
      } catch (snapshotError) {
        if (!cancelled) {
          setError(snapshotError instanceof Error ? snapshotError.message : "Failed to load Hermes workspace state.");
        }
      } finally {
        if (!cancelled) {
          setBusyLabel("");
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [active, autoStartAttemptedFor, dashboardKey, grantsReady, profileHome]);

  if (!active) {
    return <section className="hermes-workspace is-hidden" data-testid="hermes-workspace" aria-hidden="true" />;
  }

  return (
    <section className="hermes-workspace" data-testid="hermes-workspace">
      <button
        type="button"
        className={`hermes-settings-trigger ${settingsOpen ? "active" : ""}`}
        aria-label={settingsOpen ? "Hide Hermes settings" : "Show Hermes settings"}
        title={settingsOpen ? "Hide Hermes settings" : "Show Hermes settings"}
        onClick={() => setSettingsOpen((value) => !value)}
      >
        Settings
      </button>

      {error ? (
        <div className="hermes-floating-status" role="alert">
          {error}
        </div>
      ) : busyLabel ? (
        <div className="hermes-floating-status">{busyLabel}</div>
      ) : null}

      {settingsOpen ? (
        <section className="hermes-settings-drawer" aria-label="Hermes workspace settings">
          <div className="hermes-settings-head">
            <strong>{manifest?.name ?? "Hermes"}</strong>
            <span className={`hermes-pill ${dashboard?.running ? "ready" : "attention"}`}>
              {dashboard?.running ? "Dashboard running" : "Dashboard stopped"}
            </span>
            <button type="button" className="button-secondary touch-action" onClick={() => void refresh()} disabled={Boolean(busyLabel)}>
              Refresh
            </button>
            <button type="button" className="button-secondary touch-action" onClick={() => setSettingsOpen(false)}>
              Close
            </button>
          </div>
          <article>
            <span className="eyebrow">Profile</span>
            <strong>{profileHome || "~/.hermes"}</strong>
            <div className="hermes-profile-edit">
              <input
                value={profileHomeDraft}
                onChange={(event) => setProfileHomeDraft(event.target.value)}
                placeholder="Hermes profile path, defaults to ~/.hermes"
              />
              <button
                type="button"
                className="button-secondary touch-action"
                onClick={() => {
                  onProfileHomeChange(profileHomeDraft.trim());
                  setSnapshot(null);
                  setDashboard(null);
                  setAutoStartAttemptedFor("");
                }}
              >
                Save
              </button>
            </div>
          </article>

          <article>
            <span className="eyebrow">Dashboard</span>
            <strong>{dashboard?.url ?? "http://127.0.0.1:9119"}</strong>
            <div className="hermes-action-row">
              <button type="button" className="button-secondary touch-action" onClick={() => void startDashboard()} disabled={Boolean(busyLabel)}>
                Start
              </button>
              <button type="button" className="button-secondary touch-action" onClick={() => void stopDashboard()} disabled={Boolean(busyLabel)}>
                Stop
              </button>
              <button type="button" className="button-secondary touch-action" onClick={onConfigureAddon}>
                Add-on Grants
              </button>
            </div>
          </article>

          <article>
            <span className="eyebrow">Audit</span>
            <strong>{snapshot?.install.compatibility ?? "Not checked"}</strong>
            <p>{snapshot?.install.findings[0]?.title ?? "Open settings after refresh to inspect Hermes compatibility."}</p>
          </article>

          <article>
            <span className="eyebrow">Agent system</span>
            <strong>{snapshot?.install.currentModel ?? (configuredHermesModel || "default profile model")}</strong>
            <p>
              {(snapshot?.install.availableModels.length ?? installedHermesModels.length) || 1} model route
              {((snapshot?.install.availableModels.length ?? installedHermesModels.length) || 1) === 1 ? "" : "s"} · curator{" "}
              {snapshot?.curator.enabled ? "enabled" : "unknown"} · archive read{" "}
              {archiveReadGranted ? "granted" : "gated"}
            </p>
            <div className="hermes-action-row">
              <button
                type="button"
                className="button-secondary touch-action"
                onClick={() =>
                  void onAskAugmentor(
                    "Prepare a safe Hermes Archivist profile setup plan for ResonantOS. Do not change Hermes config, identity, skills, or memory without explicit approval.",
                  )
                }
              >
                Archivist Plan
              </button>
              <button
                type="button"
                className="button-secondary touch-action"
                onClick={() =>
                  void onAskAugmentor(
                    "Create a Hermes /slashgoal mission with scope, success criteria, allowed tools, approval checkpoints, Living Archive read-only boundaries, and an explicit stop condition.",
                  )
                }
              >
                Slashgoal Draft
              </button>
            </div>
          </article>
        </section>
      ) : null}

      <section className="hermes-dashboard-frame" aria-label="Embedded Hermes dashboard">
        {dashboard?.running ? (
          <iframe title="Hermes dashboard" src={dashboardUrl} />
        ) : (
          <div className="hermes-dashboard-placeholder">
            <strong>{grantsReady ? "Starting Hermes dashboard..." : "Hermes workspace access is gated"}</strong>
            <p>
              {grantsReady
                ? "ResonantOS is launching the local Hermes dashboard for this workspace."
                : "Grant shell and workspace embedding access to launch the local Hermes dashboard here."}
            </p>
            {!grantsReady ? (
              <button type="button" className="button-primary touch-action" onClick={onGrantWorkspaceAccess}>
                Grant Hermes Access
              </button>
            ) : (
              <button type="button" className="button-secondary touch-action" onClick={() => void startDashboard()} disabled={Boolean(busyLabel)}>
                Start Dashboard
              </button>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
