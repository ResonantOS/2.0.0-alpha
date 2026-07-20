// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md
// Intent citation: docs/architecture/ADR-023-addon-repository-registry-model.md

import type {
  AddOnArtifactReference,
  AddOnInstallation,
  AddOnManifest,
  AddOnProvenanceTier,
  AddOnRegistryEntry,
  AddOnRegistryReviewState,
  AddOnRegistrySource,
  InstallationStatus,
  ManifestVerificationState,
} from "../../core/contracts";

export interface AddOnRegistryEntryOptions {
  registrySource: AddOnRegistrySource;
  installation?: AddOnInstallation;
  manifestRef?: Partial<AddOnArtifactReference>;
  releaseArtifact?: AddOnArtifactReference;
  sourceRepositoryUrl?: string;
  reviewState?: AddOnRegistryReviewState;
  notes?: string[];
}

export interface AddOnRegistryBuildInput {
  bundled: AddOnManifest[];
  sideloaded: AddOnManifest[];
  installations: Record<string, AddOnInstallation>;
}

export interface AddOnRegistrySnapshot {
  entries: AddOnRegistryEntry[];
  byId: Record<string, AddOnRegistryEntry>;
}

const sourceDefaults = (
  manifest: AddOnManifest,
  registrySource: AddOnRegistrySource,
): {
  provenanceTier: AddOnProvenanceTier;
  verificationState: ManifestVerificationState;
  reviewState: AddOnRegistryReviewState;
} => {
  if (registrySource === "sideloaded-local" || registrySource === "developer-local") {
    return {
      provenanceTier: "sideloaded-unverified",
      verificationState: "unverified",
      reviewState: "unreviewed",
    };
  }

  // P1-e: a bundled-catalog manifest with NO provenance must NOT be trusted by
  // omission. Previously an absent provenance silently defaulted to
  // curated-signed/verified/reviewed. Instead, mark a manifest lacking any
  // provenance metadata as dev/internal/unreviewed (sideloaded-unverified /
  // unverified / unreviewed) so missing provenance is visible, never crashing.
  if (!manifest.provenance) {
    return {
      provenanceTier: "sideloaded-unverified",
      verificationState: "unverified",
      reviewState: "unreviewed",
    };
  }

  return {
    provenanceTier: manifest.provenance.tier ?? "curated-signed",
    verificationState: manifest.provenance.verificationState ?? "verified",
    reviewState: "reviewed",
  };
};

const defaultManifestRef = (manifest: AddOnManifest, registrySource: AddOnRegistrySource): AddOnArtifactReference => ({
  type: "manifest",
  label: `${manifest.name} manifest`,
  path: registrySource === "bundled-catalog" ? "/addons/index.json" : undefined,
  signatureRef: manifest.provenance?.signatureRef,
});

const installStateFromInstallation = (installation: AddOnInstallation | undefined): {
  installState: InstallationStatus;
  installed: boolean;
  enabled: boolean;
} => ({
  installState: installation?.status ?? "available",
  installed: installation?.installed ?? false,
  enabled: installation?.enabled ?? false,
});

export const createAddOnRegistryEntry = (
  manifest: AddOnManifest,
  options: AddOnRegistryEntryOptions,
): AddOnRegistryEntry => {
  const defaults = sourceDefaults(manifest, options.registrySource);
  const installState = installStateFromInstallation(options.installation);
  const manifestRef = {
    ...defaultManifestRef(manifest, options.registrySource),
    ...options.manifestRef,
    type: "manifest" as const,
  };

  return {
    addonId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    category: manifest.category,
    description: manifest.description,
    runtimeType: manifest.runtimeType,
    registrySource: options.registrySource,
    provenanceTier: options.installation?.provenanceTier ?? defaults.provenanceTier,
    verificationState: options.installation?.verificationState ?? defaults.verificationState,
    reviewState: options.reviewState ?? defaults.reviewState,
    manifestRef,
    releaseArtifact: options.releaseArtifact,
    sourceRepositoryUrl: options.sourceRepositoryUrl,
    compatibility: manifest.compatibility,
    requestedCapabilities: manifest.requestedCapabilities.map((capability) => ({ ...capability })),
    recommendedGrantPresetIds:
      options.installation?.recommendedGrantPresetIds ?? (manifest.grantPresets ?? []).map((preset) => preset.id),
    ...installState,
    notes: options.notes ?? options.installation?.notes ?? ["Catalog entry is not installed yet."],
  };
};

export const createAddOnRegistrySnapshot = ({
  bundled,
  sideloaded,
  installations,
}: AddOnRegistryBuildInput): AddOnRegistrySnapshot => {
  const entries = [
    ...bundled.map((manifest) =>
      createAddOnRegistryEntry(manifest, {
        registrySource: "bundled-catalog",
        installation: installations[manifest.id],
      }),
    ),
    ...sideloaded.map((manifest) =>
      createAddOnRegistryEntry(manifest, {
        registrySource: "sideloaded-local",
        installation: installations[manifest.id],
      }),
    ),
  ];

  return {
    entries,
    byId: Object.fromEntries(entries.map((entry) => [entry.addonId, entry])),
  };
};
