// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#3-boundary-rules
// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#6-capability-map
//
// Synthetic external-agent-runtime manifest fixture. The §3 trigger
// for ADR-040 is the conjunction of `providers` + `agent-delegation`
// in `requestedCapabilities`; this fixture exercises that conjunction
// so F1–F10 have a consistent target.
//
// This fixture mirrors the canonical local-service add-on shape from
// `examples/addons/recursive-mas.json` (ADR-040 §8 names that addon as
// already satisfying this ADR). It is *not* a copy of recursive-mas:
// recursive-mas is unverified-tier and out-of-tree; this fixture lives
// in-tree, is verified, and declares a minimal tool surface that F1–F10
// can target without depending on recursive-mas specifics.

import type {
  AddOnManifest,
  AddOnToolDefinition,
  Capability,
  CapabilityGrant,
  CapabilityScope,
} from "../../../src/core/contracts.ts";

import { validateAddOnManifest } from "../../../src/sdk/addons/validation.ts";

export type ExternalAgentRuntimeManifest = AddOnManifest & {
  /** Caller-attributed token id used by the mock host in F-cases. */
  callerId: string;
};

/**
 * The minimal tool set ADR-040 §3 Rule 3 requires an external agent
 * runtime to declare. Two declared tools:
 *
 *   - `send_model_request` — exercises F1, F2, F8, F9, F10 (any
 *     model-routing code path).
 *   - `run_task` — exercises F7 (requiresHumanApproval), F4
 *     (capability escalation), F5 (undeclared tool), F3 (workspace
 *     escape via payload).
 *
 * The two names are also the names the F-cases probe the manifest for.
 */
const MOCK_EXTERNAL_AGENT_TOOLS: AddOnToolDefinition[] = [
  {
    name: "send_model_request",
    description: "Send a model request through the host's provider-fabric adapter using a routed handle.",
    requiredCapabilities: ["providers", "network"],
    inputSchema: {
      type: "object",
      properties: {
        routingDecisionId: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["routingDecisionId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { model: { type: "string" }, content: { type: "string" } },
      required: ["model", "content"],
      additionalProperties: false,
    },
    audit: {
      logRequest: true,
      logResult: true,
      artifactTypes: ["log"],
    },
  },
  {
    name: "run_task",
    description: "Run a delegated task within the runtime's task workspace.",
    requiredCapabilities: ["providers", "agent-delegation", "filesystem"],
    inputSchema: {
      type: "object",
      properties: {
        mission: { type: "string" },
        path: { type: "string" },
      },
      required: ["mission", "path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        artifacts: { type: "array", items: { type: "string" } },
        surface: { type: "string" },
      },
      required: ["artifacts"],
      additionalProperties: false,
    },
    audit: {
      logRequest: true,
      logResult: true,
      artifactTypes: ["summary"],
    },
    requiresHumanApproval: true,
  },
];

const MOCK_EXTERNAL_AGENT_CAPABILITY_GRANTS: CapabilityGrant[] = [
  { capability: "providers", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
  { capability: "agent-delegation", granted: false, scope: "workspace", revocationBehavior: "degrade" },
  { capability: "network", granted: false, scope: "self", revocationBehavior: "hard-stop" },
  { capability: "filesystem", granted: false, scope: "self", revocationBehavior: "hard-stop" },
  { capability: "archive-read", granted: false, scope: "workspace", revocationBehavior: "degrade" },
  { capability: "archive-intake-write", granted: false, scope: "intake-only", revocationBehavior: "degrade" },
  { capability: "notifications", granted: false, scope: "self", revocationBehavior: "degrade" },
];

const FIXTURE_ID = "addon.testing.external-agent-runtime";
const MOCK_CALLER_ID = "caller.testing-external-agent";

/**
 * Returns a fresh external-agent-runtime fixture. By default the
 * capability grants are *not* marked `granted: true`; tests use
 * the returned object to either flip individual grants to `true`
 * (simulating the host passing through the user-accepted grant
 * preset) or to invoke the mock host bridge unauthenticated.
 *
 * The fixture validates against `validateAddOnManifest` at module
 * load time; if shape drift occurs, the package fails to import.
 */
let validatedFixture: AddOnManifest | undefined;

function buildBase(): AddOnManifest {
  return {
    sdkVersion: "0.1.0",
    id: FIXTURE_ID,
    name: "Testing External Agent Runtime",
    version: "0.1.0",
    author: "Resonant Extension Framework Tests",
    category: "agent",
    description: "Synthetic external-agent-runtime manifest used by ADR-040 §7 failure-mode tests.",
    runtimeType: "local-service",
    surfaces: [
      {
        id: "testing-external-agent-runs",
        type: "background-task-monitor",
        label: "Testing External Agent Runs",
        description: "Track delegated agent-runtime tasks under test.",
      },
    ],
    requestedCapabilities: MOCK_EXTERNAL_AGENT_CAPABILITY_GRANTS,
    provenance: {
      tier: "curated-signed",
      verificationState: "verified",
      signed: true,
      signer: "Resonant Extension Framework Testing",
    },
    runtimeIsolation: {
      boundary: "host-mediated-service",
      supportsDegradedMode: true,
      requiresReviewedGrant: true,
    },
    grantPresets: [
      {
        id: "testing-external-agent-default",
        label: "Testing default external agent runtime",
        description: "Default granted set: providers (shared), agent-delegation (workspace), network (self), filesystem (self), archive-read (workspace), archive-intake-write (intake-only), notifications (self).",
        grants: MOCK_EXTERNAL_AGENT_CAPABILITY_GRANTS.map((g) => ({ ...g, granted: true })),
      },
    ],
    providerRequirements: {
      sharedProfiles: ["resonant-deepseek-v4-pro"],
      supportsPrivateCredentials: false,
      recommendedPrimaryModel: "deepseek-v4-pro",
      recommendedFallbackModel: "deepseek-mini",
      preferredRuntimeKinds: ["local", "remote-user-owned"],
      allowExperimentalAuth: false,
    },
    systemSlots: [],
    archiveIntegration: {
      readScopes: ["LivingArchive/INTAKE/testing-external-agent"],
      intakeWriteScopes: ["LivingArchive/INTAKE/testing-external-agent"],
      canRequestIngest: true,
      canWriteKnowledgePages: false,
    },
    health: {
      strategy: "external-agent-runtime-ready",
      endpoint: "http://127.0.0.1:4891/healthz",
    },
    service: {
      protocol: "http-json",
      entrypoint: "http://127.0.0.1:4891",
      visibleEntrypoint: "http://127.0.0.1:4891",
      healthCommand: "GET /healthz",
      shutdownCommand: "POST /shutdown",
    },
    delegation: {
      acceptsTasks: true,
      taskTypes: ["research", "design"],
      artifactReturnTypes: ["summary", "log"],
      defaultTargetRuntime: "external-agent",
      requiresHumanApprovalBeforeExecution: true,
      notes: ["Synthetic external-agent-runtime test fixture; ADR-040 §3 trigger."],
    },
    installHooks: {
      onInstall: "install-external-agent.sh",
      onEnable: "enable-external-agent.sh",
      onUpgrade: "upgrade-external-agent.sh",
    },
    workflowBoundaries: [
      {
        id: "testing-agent-task-boundary",
        label: "Testing External Agent Task Boundary",
        jobToBeDone: "Run delegated tasks under the §3 boundary rules.",
        userValue: "Allow the host to validate an external agent runtime against ADR-040 §7.",
        repeatability: "workflow-package",
        owner: "addon-agent",
        nonGoals: ["Provider selection", "Credential storage", "Workspace escape"],
      },
    ],
    tools: MOCK_EXTERNAL_AGENT_TOOLS,
    engineerSetup: {
      documentPath: "docs/testing/external-agent-setup.md",
      objective: "Bring up the testing external agent runtime against the mock host.",
      requiredCapabilities: ["providers", "agent-delegation", "filesystem"],
      allowedHostCommands: ["start", "stop", "reset"],
      expectedInputs: ["manifest", "routing decision"],
      expectedOutputs: ["task artifacts"],
      requiresHumanApprovalBeforeExecution: true,
      auditLogRequired: true,
    },
    compatibility: {
      shellVersion: "0.1.0",
      platforms: ["darwin-arm64", "linux-x64"],
    },
    agents: [
      {
        id: "testing-external-agent",
        displayName: "Testing External Agent",
        trustTier: "external",
        workspaceBehavior: "delegated",
      },
    ],
  };
}

/**
 * Returns the fixture base manifest. Tests should treat the returned
 * value as immutable; use `externalAgentRuntimeFixture()` for a fresh
 * copy each test.
 */
export function externalAgentRuntimeFixture(): ExternalAgentRuntimeManifest {
  if (!validatedFixture) {
    const candidate = buildBase();
    const validation = validateAddOnManifest(candidate);
    if (!validation.valid) {
      throw new Error(
        `externalAgentRuntimeFixture failed validation: ${JSON.stringify(validation.issues)}`,
      );
    }
    validatedFixture = candidate;
  }
  return { ...validatedFixture, callerId: MOCK_CALLER_ID } as ExternalAgentRuntimeManifest;
}

/**
 * Helpers that tests use to flip a single grant to `granted: true` on
 * a fresh fixture, simulating the user accepting a specific
 * `grantPreset` (or the host passing a single grant outside a preset).
 */
export function withGranted(manifest: ExternalAgentRuntimeManifest, capability: Capability): ExternalAgentRuntimeManifest {
  const next: AddOnManifest = {
    ...manifest,
    requestedCapabilities: manifest.requestedCapabilities.map((g) =>
      g.capability === capability ? { ...g, granted: true } : g,
    ),
  };
  return { ...next, callerId: manifest.callerId };
}

export function withScope(manifest: ExternalAgentRuntimeManifest, capability: Capability, scope: CapabilityScope): ExternalAgentRuntimeManifest {
  const next: AddOnManifest = {
    ...manifest,
    requestedCapabilities: manifest.requestedCapabilities.map((g) =>
      g.capability === capability ? { ...g, scope } : g,
    ),
  };
  return { ...next, callerId: manifest.callerId };
}

export function withTool(manifest: ExternalAgentRuntimeManifest, tool: AddOnToolDefinition): ExternalAgentRuntimeManifest {
  const tools = manifest.tools ? [...manifest.tools, tool] : [tool];
  return { ...manifest, tools };
}

/** The fixture's mock caller id; exported so F-cases don't have to read it off the manifest. */
export const FIXTURE_CALLER_ID = MOCK_CALLER_ID;

/** The fixture's declared tool names, used by F5 (undeclared tool probe). */
export function declaredToolNames(manifest: ExternalAgentRuntimeManifest): readonly string[] {
  return (manifest.tools ?? []).map((t) => t.name);
}
