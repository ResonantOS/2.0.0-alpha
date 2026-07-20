import { describe, expect, it } from "vitest";
import type { AddOnManifest } from "./contracts";
import { buildDefaultState } from "./defaults";
import { applyProviderDiagnostics, canPerformArchiveAction, resolveProviderPath, resolveProviderRoute, strategistDisplayName } from "./policies";
import { rebaseStateOnManifests } from "./runtime";

const testManifest = (id: string): AddOnManifest => ({
  id,
  name: id,
  version: "0.1.0",
  author: "test",
  category: "integration",
  description: "test",
  runtimeType: "local-service",
  surfaces: [],
  requestedCapabilities: [],
  providerRequirements: {
    sharedProfiles: [],
    supportsPrivateCredentials: false,
  },
  archiveIntegration: {
    readScopes: [],
    intakeWriteScopes: [],
    canRequestIngest: false,
    canWriteKnowledgePages: false,
  },
  health: {
    strategy: "none",
  },
  installHooks: {},
  compatibility: {
    shellVersion: "^0.1.0",
    platforms: ["macOS"],
  },
});

describe("archive policy", () => {
  const buildState = () =>
    buildDefaultState([
      testManifest("addon.openclaw"),
      testManifest("addon.obsidian"),
      testManifest("addon.telegram-channel"),
    ]);

  it("blocks add-ons from writing knowledge pages", () => {
    const state = buildState();
    expect(canPerformArchiveAction(state, "addon.openclaw", "archive-knowledge-write")).toBe(false);
  });

  it("allows intake-only writes for approved add-ons", () => {
    const state = buildState();
    expect(canPerformArchiveAction(state, "addon.openclaw", "archive-intake-write", "_LivingArchive/INTAKE/external-agents/session-1")).toBe(true);
  });

  it("keeps knowledge page writes reserved for the ingest service", () => {
    const state = buildState();
    expect(canPerformArchiveAction(state, "archive-ingest.core", "archive-knowledge-write")).toBe(true);
  });
});

describe("strategist identity", () => {
  it("uses the default name until the user renames it", () => {
    const state = buildDefaultState([]);
    expect(strategistDisplayName(state)).toBe("Augmentor");
    state.strategistIdentity.customName = "Manolo's Strategist";
    expect(strategistDisplayName(state)).toBe("Manolo's Strategist");
  });
});

describe("provider routing", () => {
  it("uses the fallback provider when the primary is missing", () => {
    const state = buildDefaultState([]);
    const primary = { ...state.providers[0], status: "missing" as const };
    const fallback = state.providers[1];
    const resolved = resolveProviderPath(primary, fallback);
    expect(resolved.active?.id).toBe(fallback.id);
    expect(resolved.usingFallback).toBe(true);
  });

  it("resolves a primary provider runtime node when a healthy route exists", () => {
    const state = buildDefaultState([]);
    const configuredState = {
      ...state,
      providers: state.providers.map((p) =>
        p.id === "shared-minimax" ? { ...p, credentialStatus: "configured" as const } : p,
      ),
    };
    const resolved = resolveProviderRoute(configuredState, {
      consumerId: "strategist.core",
      primaryProviderProfileId: "shared-minimax",
      fallbackProviderProfileId: "shared-openai",
      preferredModels: ["MiniMax-M3"],
      fallbackPolicyId: "core-default",
    });

    expect(resolved.providerProfileId).toBe("shared-minimax");
    expect(resolved.runtimeNodeId).toBe("node-minimax-cloud");
    expect(resolved.executionAdapterId).toBe("cloud-minimax-compatible");
    expect(resolved.model).toBe("MiniMax-M3");
    expect(resolved.resolutionReason).toBe("primary-healthy");
  });

  it("offers a resurrection path when normal routes are unavailable", () => {
    const state = buildDefaultState([]);
    const unavailableState = {
      ...state,
      providers: state.providers.map((provider) =>
        provider.providerType === "local" ? provider : { ...provider, status: "missing" as const },
      ),
      runtimeNodes: state.runtimeNodes.map((node) =>
        node.id === "node-local-resurrect" ? node : { ...node, healthState: "unavailable" as const },
      ),
    };

    const resolved = resolveProviderRoute(unavailableState, {
      consumerId: "strategist.core",
      primaryProviderProfileId: "shared-minimax",
      fallbackProviderProfileId: "shared-openai",
      fallbackPolicyId: "core-default",
      allowResurrection: true,
    });

    expect(resolved.runtimeNodeId).toBe("node-local-resurrect");
    expect(resolved.executionAdapterId).toBe("local-ollama");
    expect(resolved.recoveryActionId).toBeUndefined();
    expect(resolved.resolutionReason).toBe("fallback-in-policy");
  });
});

describe("manifest rebase", () => {
  it("adds new sideloaded manifests without dropping saved state", () => {
    const base = buildDefaultState([testManifest("addon.obsidian")]);
    const rebased = rebaseStateOnManifests(base, [testManifest("addon.obsidian"), testManifest("addon.new")], ["addon.new"]);
    expect(rebased.installations["addon.new"]).toBeDefined();
    expect(rebased.installations["addon.new"].source).toBe("sideload");
  });

  it("forces sideloaded manifests into unverified provenance even if they claim curation", () => {
    const claimingCurated = {
      ...testManifest("addon.claimed-curated"),
      provenance: {
        tier: "curated-signed",
        verificationState: "verified",
        signed: true,
        signer: "unknown",
      },
    } satisfies AddOnManifest;

    const rebased = rebaseStateOnManifests(buildDefaultState([]), [claimingCurated], ["addon.claimed-curated"]);

    expect(rebased.installations["addon.claimed-curated"].provenanceTier).toBe("sideloaded-unverified");
    expect(rebased.installations["addon.claimed-curated"].verificationState).toBe("unverified");
  });

  it("does not install, enable, or grant bundled add-ons by default", () => {
    const state = buildDefaultState([
      testManifest("addon.telegram-channel"),
      {
        ...testManifest("addon.browser"),
        requestedCapabilities: [{ capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" }],
      },
    ]);

    expect(Object.values(state.installations).map((installation) => installation.status)).toEqual(["available", "available"]);
    expect(Object.values(state.installations).every((installation) => installation.installed === false)).toBe(true);
    expect(Object.values(state.installations).every((installation) => installation.enabled === false)).toBe(true);
    expect(
      Object.values(state.installations).flatMap((installation) =>
        installation.grantedCapabilities.filter((grant) => grant.granted),
      ),
    ).toEqual([]);
  });
});

describe("provider defaults", () => {
  it("routes the Strategist to MiniMax first and OpenAI second", () => {
    const state = buildDefaultState([]);
    const strategist = state.agents.find((agent) => agent.id === "strategist.core");
    expect(strategist?.providerProfileId).toBe("shared-minimax");
    expect(strategist?.fallbackProviderProfileId).toBe("shared-openai");
    expect(state.providers[0]?.primaryModel).toBe("MiniMax-M3");
  });

  it("maps live provider diagnostics back into routing health", () => {
    const state = buildDefaultState([]);
    const updated = applyProviderDiagnostics(state, [
      {
        providerId: "shared-minimax",
        providerLabel: "Shared MiniMax",
        providerType: "minimax",
        authMethod: "subscription",
        authTier: "experimental",
        executionAdapter: "cloud-minimax-compatible",
        credentialConfigured: false,
        status: "offline",
        summary: "Provider is offline.",
        checkedAt: "unix:1",
        primaryModel: "MiniMax-M3",
        fallbackModel: "MiniMax-M3",
        runtimeDiagnostics: [
          {
            runtimeNodeId: "node-minimax-cloud",
            runtimeNodeLabel: "MiniMax Cloud Runtime",
            runtimeKind: "cloud",
            locality: "cloud",
            probeState: "unavailable",
            detail: "Endpoint probe failed.",
          },
        ],
      },
    ]);

    expect(updated.providers.find((provider) => provider.id === "shared-minimax")?.status).toBe("missing");
    expect(updated.providers.find((provider) => provider.id === "shared-minimax")?.credentialStatus).toBe("missing");
    expect(updated.runtimeNodes.find((node) => node.id === "node-minimax-cloud")?.healthState).toBe("unavailable");
  });

  it("keeps local-runtime OpenAI-compatible providers credential-ready after diagnostics", () => {
    const state = buildDefaultState([]);
    const provider = {
      ...state.providers.find((item) => item.id === "shared-local")!,
      id: "provider-asus-gx10-test",
      label: "ASUS GX10",
      providerType: "openai-compatible" as const,
      authMethod: "local-runtime" as const,
      credentialStatus: "configured" as const,
      status: "ready" as const,
    };
    const updated = applyProviderDiagnostics(
      { ...state, providers: [...state.providers, provider] },
      [
        {
          providerId: provider.id,
          providerLabel: provider.label,
          providerType: provider.providerType,
          authMethod: provider.authMethod,
          authTier: provider.authTier,
          executionAdapter: "cloud-openai-compatible",
          credentialConfigured: false,
          status: "healthy",
          summary: "LAN runtime responded.",
          checkedAt: "unix:1",
          primaryModel: provider.primaryModel,
          runtimeDiagnostics: [],
        },
      ],
    );

    expect(updated.providers.find((item) => item.id === provider.id)?.credentialStatus).toBe("configured");
  });
});
