// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/product/PRODUCT_GUIDE.md

import { useState } from "react";
import type { AddOnInstallation, AddOnManifest, InstallationStatus, ResonantShellState } from "../../core/contracts";
import { resolveArchiveIngestRoute, resolveRoutineRoute, routedProviderLabel } from "../../core/provider-service";

type AppRuntimeSurface = "terminal-app" | "embedded-app" | "agent-workspace" | "channel-service" | "system-workspace";

type LauncherApp = {
  id: string;
  name: string;
  description: string;
  category: string;
  status: InstallationStatus | "core" | "planned";
  runtimeSurface: AppRuntimeSurface;
  primaryAction: string;
  manifest?: AddOnManifest;
  installation?: AddOnInstallation;
};

export function OverviewWorkspace({
  state,
  manifests,
  displayedStrategistName,
  providerLabel,
  onOpenArchive,
  onOpenDelegation,
  onOpenAddons,
  onOpenBrowser,
  onOpenOpenCode,
  onGrantBrowserVisibleAccess,
  onOpenSettings,
}: {
  state: ResonantShellState;
  manifests: AddOnManifest[];
  displayedStrategistName: string;
  providerLabel: string;
  onOpenArchive: () => void;
  onOpenDelegation: () => void;
  onOpenAddons: () => void;
  onOpenBrowser: () => void;
  onOpenOpenCode: () => void;
  onGrantBrowserVisibleAccess: () => void;
  onOpenSettings: () => void;
}) {
  const launcherApps = buildLauncherApps(state, manifests);
  const [activeAppId, setActiveAppId] = useState(launcherApps[0]?.id ?? "app.living-archive");
  const activeApp = launcherApps.find((app) => app.id === activeAppId) ?? launcherApps[0];
  const routineRoute = resolveRoutineRoute(state);
  const archiveRoute = resolveArchiveIngestRoute(state);
  const runningApps = launcherApps.filter((app) => app.status === "enabled" || app.status === "core");

  return (
    <div className="home-workspace">
      <section className="home-hero-panel">
        <div className="home-hero-copy">
          <span className="eyebrow">ResonantOS Home</span>
          <h2>Launch your AI tools from one workbench.</h2>
          <p>
            Open agents, embedded apps, memory tools, and channels in the center workspace while Augmentor stays available
            on the right rail.
          </p>
        </div>
        <div className="home-health-strip" aria-label="System health summary">
          <HealthPill label="Strategist" value={displayedStrategistName} meta={providerLabel} />
          <HealthPill label="Routine route" value={routineRoute.model ?? "Missing"} meta={routedProviderLabel(routineRoute)} />
          <HealthPill label="Archive ingest" value={archiveRoute.model ?? "Missing"} meta={routedProviderLabel(archiveRoute)} />
        </div>
      </section>

      <section className="app-workbench-grid">
        <div className="app-launcher-panel">
          <div className="workspace-section-head">
            <div>
              <span className="eyebrow">Apps and add-ons</span>
              <h3>Available workspaces</h3>
            </div>
            <button type="button" className="button-secondary touch-action" onClick={onOpenAddons}>
              Manage Add-ons
            </button>
          </div>
          <div className="app-tile-grid" aria-label="ResonantOS app launcher">
            {launcherApps.map((app) => (
              <button
                key={app.id}
                type="button"
                className={`app-tile ${activeApp?.id === app.id ? "active" : ""}`}
                onClick={() => setActiveAppId(app.id)}
              >
                <span className={`app-orb app-orb-${surfaceTone(app.runtimeSurface)}`} aria-hidden="true">
                  {appIcon(app)}
                </span>
                <span className="app-tile-copy">
                  <strong>{app.name}</strong>
                  <small>{runtimeLabel(app.runtimeSurface)}</small>
                  <span>{app.description}</span>
                </span>
                <span className={`app-status app-status-${statusTone(app.status)}`}>{app.status}</span>
              </button>
            ))}
          </div>
        </div>

        <section className="active-app-panel" aria-label="Active center workspace">
          {activeApp ? (
            <ActiveAppSurface
              app={activeApp}
              onOpenArchive={onOpenArchive}
              onOpenDelegation={onOpenDelegation}
              onOpenAddons={onOpenAddons}
              onOpenBrowser={onOpenBrowser}
              onOpenOpenCode={onOpenOpenCode}
              onGrantBrowserVisibleAccess={onGrantBrowserVisibleAccess}
              onOpenSettings={onOpenSettings}
            />
          ) : null}
        </section>
      </section>

      <section className="running-workspaces-panel">
        <div className="workspace-section-head">
          <div>
            <span className="eyebrow">Running now</span>
            <h3>Active shell surfaces</h3>
          </div>
        </div>
        <div className="running-app-strip">
          {runningApps.map((app) => (
            <button key={app.id} type="button" className="running-app-card" onClick={() => setActiveAppId(app.id)}>
              <strong>{app.name}</strong>
              <span>{runtimeLabel(app.runtimeSurface)}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ActiveAppSurface({
  app,
  onOpenArchive,
  onOpenDelegation,
  onOpenAddons,
  onOpenBrowser,
  onOpenOpenCode,
  onGrantBrowserVisibleAccess,
  onOpenSettings,
}: {
  app: LauncherApp;
  onOpenArchive: () => void;
  onOpenDelegation: () => void;
  onOpenAddons: () => void;
  onOpenBrowser: () => void;
  onOpenOpenCode: () => void;
  onGrantBrowserVisibleAccess: () => void;
  onOpenSettings: () => void;
}) {
  const isTerminal = app.runtimeSurface === "terminal-app";
  const isEmbedded = app.runtimeSurface === "embedded-app";
  const primaryHandler =
    app.id === "addon.living-archive" && (app.status === "enabled" || app.status === "installed")
      ? onOpenArchive
      : app.id === "core.delegation"
        ? onOpenDelegation
      : app.id === "core.settings"
        ? onOpenSettings
        : app.id === "addon.browser" && (app.status === "enabled" || app.status === "installed")
          ? onOpenBrowser
        : app.id === "addon.opencode" && (app.status === "enabled" || app.status === "installed")
          ? onOpenOpenCode
        : app.status === "available" || app.status === "planned"
          ? onOpenAddons
          : undefined;

  return (
    <>
      <div className="active-app-head">
        <div>
          <span className="eyebrow">Center workspace</span>
          <h3>{app.name}</h3>
          <p>{app.description}</p>
        </div>
        <span className={`app-status app-status-${statusTone(app.status)}`}>{app.status}</span>
      </div>

      <div className={`workspace-preview ${isTerminal ? "terminal" : isEmbedded ? "embedded" : "system"}`}>
        {app.id === "addon.browser" ? (
          <BrowserPreview app={app} onGrantVisibleAccess={onGrantBrowserVisibleAccess} />
        ) : isTerminal ? (
          <TerminalPreview app={app} />
        ) : isEmbedded ? (
          <EmbeddedPreview app={app} />
        ) : (
          <SystemPreview app={app} />
        )}
      </div>

      <div className="active-app-actions">
        <button type="button" className="button-secondary touch-action" onClick={primaryHandler}>
          {app.primaryAction}
        </button>
        <button type="button" className="button-secondary touch-action" disabled>
          Full Screen Soon
        </button>
      </div>
    </>
  );
}

function BrowserPreview({ app, onGrantVisibleAccess }: { app: LauncherApp; onGrantVisibleAccess: () => void }) {
  const ready = app.status === "enabled" || app.status === "installed";
  return (
    <div className="embedded-preview-body browser-preview-body">
      <strong>Live browser workspace</strong>
      <p>Open the workspace to load https://resonantos.com in the center column.</p>
      {!ready ? (
        <button type="button" className="button-secondary touch-action" onClick={onGrantVisibleAccess}>
          Install and grant browser access
        </button>
      ) : null}
    </div>
  );
}

function TerminalPreview({ app }: { app: LauncherApp }) {
  return (
    <div className="terminal-preview-body">
      <span>$ resonantos open {app.name.toLowerCase()}</span>
      <strong>{app.name} terminal workspace</strong>
      <p>PTY runtime will mount here once the add-on service boundary is implemented.</p>
    </div>
  );
}

function EmbeddedPreview({ app }: { app: LauncherApp }) {
  return (
    <div className="embedded-preview-body">
      <div className="embedded-preview-toolbar">
        <span />
        <span />
        <span />
      </div>
      <strong>{app.name} embedded workspace</strong>
      <p>Embedded app canvas placeholder. The side rails stay available until full-screen mode is enabled.</p>
    </div>
  );
}

function SystemPreview({ app }: { app: LauncherApp }) {
  return (
    <div className="system-preview-body">
      <strong>{app.name}</strong>
      <p>{app.description}</p>
    </div>
  );
}

function HealthPill({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="home-health-pill">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{meta}</p>
    </div>
  );
}

function buildLauncherApps(state: ResonantShellState, manifests: AddOnManifest[]): LauncherApp[] {
  const manifestApps = manifests.map((manifest) => {
    const installation = state.installations[manifest.id];
    const installedStatus = installation?.enabled
      ? "enabled"
      : installation?.installed
        ? installation.status
        : "available";

    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      category: manifest.category,
      status: installedStatus,
      runtimeSurface: runtimeSurfaceForManifest(manifest),
      primaryAction: installedStatus === "enabled" || installedStatus === "installed" ? "Open Workspace" : "Install / Configure",
      manifest,
      installation,
    } satisfies LauncherApp;
  });

  const plannedApps: LauncherApp[] = [
    {
      id: "addon.hermes",
      name: "Hermes",
      description: "Messenger and automation agent workspace planned as a terminal-capable add-on.",
      category: "agent",
      status: "planned",
      runtimeSurface: "terminal-app",
      primaryAction: "View Add-on Plan",
    },
    {
      id: "addon.opencode",
      name: "OpenCode",
      description: "Open-source coding IDE workspace planned as an embedded add-on.",
      category: "tool",
      status: "planned",
      runtimeSurface: "embedded-app",
      primaryAction: "View Add-on Plan",
    },
    {
      id: "addon.browser",
      name: "Browser",
      description: "Embedded browser workspace for research and web tasks.",
      category: "tool",
      status: "planned",
      runtimeSurface: "embedded-app",
      primaryAction: "View Add-on Plan",
    },
  ];

  const plannedManifestIds = new Set(manifestApps.map((app) => app.id));
  const visiblePlannedApps = plannedApps.filter((app) => !plannedManifestIds.has(app.id));

  return [
    {
      id: "core.delegation",
      name: "Delegation Monitor",
      description: "Supervise task workspaces Augmentor creates for the Engineer and future add-on agents.",
      category: "core",
      status: "core",
      runtimeSurface: "system-workspace",
      primaryAction: "Open Delegation",
    },
    ...manifestApps,
    ...visiblePlannedApps,
    {
      id: "core.settings",
      name: "Settings",
      description: "Provider profiles, credentials, model strategy, permissions, and diagnostics.",
      category: "core",
      status: "core",
      runtimeSurface: "system-workspace",
      primaryAction: "Open Settings",
    },
  ];
}

function runtimeSurfaceForManifest(manifest: AddOnManifest): AppRuntimeSurface {
  if (manifest.id === "addon.openclaw") {
    return "terminal-app";
  }

  if (manifest.runtimeType === "embedded-module" || manifest.surfaces.some((surface) => surface.type === "embedded-pane")) {
    return "embedded-app";
  }

  if (manifest.runtimeType === "agent-addon") {
    return "agent-workspace";
  }

  if (manifest.runtimeType === "channel-addon") {
    return "channel-service";
  }

  return "system-workspace";
}

function runtimeLabel(runtimeSurface: AppRuntimeSurface) {
  const labels: Record<AppRuntimeSurface, string> = {
    "terminal-app": "Terminal / TUI",
    "embedded-app": "Embedded app",
    "agent-workspace": "Agent workspace",
    "channel-service": "Channel service",
    "system-workspace": "System workspace",
  };
  return labels[runtimeSurface];
}

function surfaceTone(runtimeSurface: AppRuntimeSurface) {
  if (runtimeSurface === "terminal-app") {
    return "terminal";
  }
  if (runtimeSurface === "embedded-app") {
    return "embedded";
  }
  if (runtimeSurface === "agent-workspace") {
    return "agent";
  }
  return "system";
}

function statusTone(status: LauncherApp["status"]) {
  if (status === "enabled" || status === "core") {
    return "active";
  }
  if (status === "installed" || status === "available") {
    return "idle";
  }
  if (status === "planned" || status === "degraded") {
    return "warning";
  }
  return "idle";
}

function appIcon(app: LauncherApp) {
  if (app.runtimeSurface === "terminal-app") {
    return ">";
  }
  if (app.runtimeSurface === "embedded-app") {
    return "[]";
  }
  if (app.runtimeSurface === "agent-workspace") {
    return "A";
  }
  if (app.runtimeSurface === "channel-service") {
    return "CH";
  }
  return app.category.slice(0, 1).toUpperCase();
}
