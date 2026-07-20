// Intent citation: docs/architecture/ADR-026-minimal-kernel-replaceable-default-addons.md
// Intent citation: docs/architecture/ADR-011-living-archive-host-service.md

import type {
  AddOnInstallation,
  AddOnManifest,
  ArchiveBackgroundCycleResult,
  ArchiveDocumentPayload,
  ArchiveIngestRequestResult,
  ArchiveIntakeWriteResult,
  ArchiveLintResult,
  ArchiveMaintenanceCycleResult,
  ArchiveProcessIngestResult,
  ArchivePromoteReviewArtifactResult,
  ArchiveQueuedIngestRequest,
  ArchiveReviewArtifact,
  ArchiveReviewDecisionResult,
  ArchiveRuntimeStatus,
  ArchiveSearchResult,
  ArchiveSemanticLintResult,
  ProviderProfile,
  ResonantShellState,
} from "./contracts";
import {
  requestArchiveDocument,
  requestArchiveBackgroundCycle,
  requestArchiveIngestRequest,
  requestArchiveIntakeWrite,
  requestArchiveLint,
  requestArchiveMaintenanceCycle,
  requestArchiveProcessIngestRequest,
  requestArchivePromoteReviewArtifact,
  requestArchiveReviewArtifacts,
  requestArchiveReviewDecision,
  requestArchiveReviewQueue,
  requestArchiveRuntimeStatus,
  requestArchiveSearch,
  requestArchiveSemanticLint,
} from "./runtime";

export type MemoryProviderKind = "living-archive" | "http-json" | "unsupported";

export type MemoryProviderBroker = {
  providerId: string;
  label: string;
  kind: MemoryProviderKind;
  supports: {
    status: boolean;
    search: boolean;
    read: boolean;
    intakeWrite: boolean;
    ingestRequest: boolean;
    review: boolean;
  };
  status(): Promise<ArchiveRuntimeStatus>;
  search(query: string, limit?: number): Promise<ArchiveSearchResult>;
  read(path: string): Promise<ArchiveDocumentPayload>;
  intakeWrite(input: {
    actorId: string;
    bucket: string;
    fileName: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<ArchiveIntakeWriteResult>;
  ingestRequest(input: {
    actorId: string;
    sourcePath: string;
    sourceType: string;
    sourceRole?: string;
    intent: string;
    provenance?: Record<string, unknown>;
  }): Promise<ArchiveIngestRequestResult>;
  reviewQueue(): Promise<ArchiveQueuedIngestRequest[]>;
  reviewArtifacts(): Promise<ArchiveReviewArtifact[]>;
  processIngestRequest(input: {
    requestFile: string;
    providerId: string;
    providerType: ProviderProfile["providerType"];
    apiBaseUrl?: string;
    runtimeNodeId?: string;
    runtimeNodeKind?: string;
    runtimeNodeEndpoint?: string;
    authTier?: string;
    model: string;
    verifierProviderId?: string;
    verifierProviderType?: ProviderProfile["providerType"];
    verifierApiBaseUrl?: string;
    verifierRuntimeNodeId?: string;
    verifierRuntimeNodeKind?: string;
    verifierRuntimeNodeEndpoint?: string;
    verifierAuthTier?: string;
    verifierModel?: string;
  }): Promise<ArchiveProcessIngestResult>;
  maintenanceCycle?(input: {
    providerId: string;
    providerType: ProviderProfile["providerType"];
    apiBaseUrl?: string;
    runtimeNodeId?: string;
    runtimeNodeKind?: string;
    runtimeNodeEndpoint?: string;
    authTier?: string;
    model: string;
    verifierProviderId?: string;
    verifierProviderType?: ProviderProfile["providerType"];
    verifierApiBaseUrl?: string;
    verifierRuntimeNodeId?: string;
    verifierRuntimeNodeKind?: string;
    verifierRuntimeNodeEndpoint?: string;
    verifierAuthTier?: string;
    verifierModel?: string;
    maxRequests?: number;
    autoPromote?: boolean;
    actorId?: string;
  }): Promise<ArchiveMaintenanceCycleResult>;
  backgroundCycle?(input: {
    providerId: string;
    providerType: ProviderProfile["providerType"];
    apiBaseUrl?: string;
    runtimeNodeId?: string;
    runtimeNodeKind?: string;
    runtimeNodeEndpoint?: string;
    authTier?: string;
    model: string;
    verifierProviderId?: string;
    verifierProviderType?: ProviderProfile["providerType"];
    verifierApiBaseUrl?: string;
    verifierRuntimeNodeId?: string;
    verifierRuntimeNodeKind?: string;
    verifierRuntimeNodeEndpoint?: string;
    verifierAuthTier?: string;
    verifierModel?: string;
    maxRequests?: number;
    autoPromote?: boolean;
    actorId?: string;
    rootPath?: string;
  }): Promise<ArchiveBackgroundCycleResult>;
  lint?(): Promise<ArchiveLintResult>;
  semanticLint?(input: {
    providerId: string;
    providerType: ProviderProfile["providerType"];
    apiBaseUrl?: string;
    runtimeNodeId?: string;
    runtimeNodeKind?: string;
    runtimeNodeEndpoint?: string;
    authTier?: string;
    model: string;
    maxCandidates?: number;
  }): Promise<ArchiveSemanticLintResult>;
  decideReview(input: {
    artifactFile: string;
    actorId: string;
    action: "approve" | "reject" | "escalate";
    notes?: string;
  }): Promise<ArchiveReviewDecisionResult>;
  promoteReviewArtifact(input: {
    artifactFile: string;
    actorId: string;
  }): Promise<ArchivePromoteReviewArtifactResult>;
};

const capabilityGranted = (
  state: ResonantShellState,
  addonId: string,
  capability: string,
): boolean =>
  Boolean(
    state.installations[addonId]?.enabled &&
      state.installations[addonId]?.grantedCapabilities.some(
        (grant) => grant.capability === capability && grant.granted,
      ),
  );

const memorySlotManifest = (manifest: AddOnManifest): boolean =>
  Boolean(manifest.systemSlots?.some((slot) => slot.id === "memory-system"));

const activeMemoryManifest = (
  state: ResonantShellState,
  manifests: AddOnManifest[],
): { manifest: AddOnManifest; installation: AddOnInstallation } | null => {
  for (const manifest of manifests.filter(memorySlotManifest)) {
    const installation = state.installations[manifest.id];
    if (installation?.enabled && capabilityGranted(state, manifest.id, "memory-provider")) {
      return { manifest, installation };
    }
  }
  return null;
};

const unavailable = (label: string, operation: string): never => {
  throw new Error(
    `${label} does not expose the ${operation} memory-provider operation yet. Select Living Archive or install a compatible memory add-on.`,
  );
};

export const livingArchiveMemoryProvider = (): MemoryProviderBroker => ({
  providerId: "addon.living-archive",
  label: "Living Archive",
  kind: "living-archive",
  supports: {
    status: true,
    search: true,
    read: true,
    intakeWrite: true,
    ingestRequest: true,
    review: true,
  },
  status: requestArchiveRuntimeStatus,
  search: requestArchiveSearch,
  read: requestArchiveDocument,
  intakeWrite: requestArchiveIntakeWrite,
  ingestRequest: requestArchiveIngestRequest,
  reviewQueue: requestArchiveReviewQueue,
  reviewArtifacts: requestArchiveReviewArtifacts,
  processIngestRequest: requestArchiveProcessIngestRequest,
  maintenanceCycle: requestArchiveMaintenanceCycle,
  backgroundCycle: requestArchiveBackgroundCycle,
  lint: requestArchiveLint,
  semanticLint: requestArchiveSemanticLint,
  decideReview: requestArchiveReviewDecision,
  promoteReviewArtifact: requestArchivePromoteReviewArtifact,
});

const endpointFromInstallation = (
  manifest: AddOnManifest,
  installation: AddOnInstallation,
): string | null => {
  const configured =
    typeof installation.config?.memoryServiceUrl === "string"
      ? installation.config.memoryServiceUrl
      : typeof installation.config?.serviceUrl === "string"
        ? installation.config.serviceUrl
        : undefined;
  const raw = configured ?? manifest.service?.entrypoint;
  if (!raw || !/^https?:\/\//i.test(raw)) {
    return null;
  }
  return raw.replace(/\/+$/, "");
};

const tokenFromInstallation = (installation: AddOnInstallation): string => {
  const configured =
    typeof installation.config?.memoryServiceToken === "string"
      ? installation.config.memoryServiceToken
      : typeof installation.config?.token === "string"
        ? installation.config.token
        : undefined;
  // Fall back to the operator-supplied env token used by the hardened memory service.
  const envToken =
    typeof process !== "undefined" && typeof process.env?.RESONANTOS_MEMORY_SERVICE_TOKEN === "string"
      ? process.env.RESONANTOS_MEMORY_SERVICE_TOKEN
      : "";
  return (configured ?? envToken).trim();
};

const postMemoryJson = async <Result>(
  endpoint: string,
  operation: string,
  input?: Record<string, unknown>,
  token?: string,
): Promise<Result> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  // DD-3 (F6): forward the bearer token so write operations authenticate against the
  // hardened memory service. Reads pass no token and stay unauth on loopback.
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${endpoint}/memory/${operation}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input ?? {}),
  });
  if (!response.ok) {
    throw new Error(`Memory provider ${operation} failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as Result;
};

export const httpJsonMemoryProvider = (
  manifest: AddOnManifest,
  installation: AddOnInstallation,
): MemoryProviderBroker => {
  const endpoint = endpointFromInstallation(manifest, installation);
  if (!endpoint) {
    return unsupportedMemoryProvider(
      manifest.id,
      `${manifest.name} is missing a valid http-json memoryServiceUrl or service entrypoint`,
    );
  }
  // Writes require a bearer token against the hardened memory service; reads stay unauth.
  const writeToken = tokenFromInstallation(installation);

  return {
    providerId: manifest.id,
    label: manifest.name,
    kind: "http-json",
    supports: {
      status: true,
      search: true,
      read: true,
      intakeWrite: true,
      ingestRequest: true,
      review: true,
    },
    status: () => postMemoryJson<ArchiveRuntimeStatus>(endpoint, "status"),
    search: (query, limit = 12) => postMemoryJson<ArchiveSearchResult>(endpoint, "search", { query, limit }),
    read: (path) => postMemoryJson<ArchiveDocumentPayload>(endpoint, "read", { path }),
    intakeWrite: (input) => postMemoryJson<ArchiveIntakeWriteResult>(endpoint, "intake-write", input, writeToken),
    ingestRequest: (input) => postMemoryJson<ArchiveIngestRequestResult>(endpoint, "ingest-request", input, writeToken),
    reviewQueue: () => postMemoryJson<ArchiveQueuedIngestRequest[]>(endpoint, "review-queue"),
    reviewArtifacts: () => postMemoryJson<ArchiveReviewArtifact[]>(endpoint, "review-artifacts"),
    processIngestRequest: (input) => postMemoryJson<ArchiveProcessIngestResult>(endpoint, "process-ingest-request", input, writeToken),
    maintenanceCycle: (input) => postMemoryJson<ArchiveMaintenanceCycleResult>(endpoint, "maintenance-cycle", input, writeToken),
    backgroundCycle: (input) => postMemoryJson<ArchiveBackgroundCycleResult>(endpoint, "background-cycle", input, writeToken),
    lint: () => postMemoryJson<ArchiveLintResult>(endpoint, "lint"),
    semanticLint: (input) => postMemoryJson<ArchiveSemanticLintResult>(endpoint, "semantic-lint", input),
    decideReview: (input) => postMemoryJson<ArchiveReviewDecisionResult>(endpoint, "decide-review", input, writeToken),
    promoteReviewArtifact: (input) => postMemoryJson<ArchivePromoteReviewArtifactResult>(endpoint, "promote-review-artifact", input, writeToken),
  };
};

export const unsupportedMemoryProvider = (
  providerId: string,
  label: string,
): MemoryProviderBroker => ({
  providerId,
  label,
  kind: "unsupported",
  supports: {
    status: false,
    search: false,
    read: false,
    intakeWrite: false,
    ingestRequest: false,
    review: false,
  },
  status: async () => unavailable(label, "status"),
  search: async () => unavailable(label, "search"),
  read: async () => unavailable(label, "read"),
  intakeWrite: async () => unavailable(label, "intakeWrite"),
  ingestRequest: async () => unavailable(label, "ingestRequest"),
  reviewQueue: async () => unavailable(label, "reviewQueue"),
  reviewArtifacts: async () => unavailable(label, "reviewArtifacts"),
  processIngestRequest: async () => unavailable(label, "processIngestRequest"),
  maintenanceCycle: async () => unavailable(label, "maintenanceCycle"),
  backgroundCycle: async () => unavailable(label, "backgroundCycle"),
  lint: async () => unavailable(label, "lint"),
  semanticLint: async () => unavailable(label, "semanticLint"),
  decideReview: async () => unavailable(label, "decideReview"),
  promoteReviewArtifact: async () => unavailable(label, "promoteReviewArtifact"),
});

export const resolveMemoryProviderBroker = (
  state: ResonantShellState,
  manifests: AddOnManifest[],
): MemoryProviderBroker => {
  const slotManifests = manifests.filter(memorySlotManifest);
  if (!slotManifests.length) {
    // Legacy/test manifest sets predate replaceable memory slots.
    return livingArchiveMemoryProvider();
  }

  const activeProvider = activeMemoryManifest(state, manifests);
  if (!activeProvider) {
    return unsupportedMemoryProvider("memory-system.none", "No active memory provider");
  }

  const { manifest, installation } = activeProvider;
  if (manifest.id === "addon.living-archive") {
    return livingArchiveMemoryProvider();
  }

  if (manifest.service?.protocol === "http-json") {
    return httpJsonMemoryProvider(manifest, installation);
  }

  return unsupportedMemoryProvider(manifest.id, manifest.name);
};
