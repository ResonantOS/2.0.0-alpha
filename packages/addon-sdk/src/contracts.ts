// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md

import type {
  AddOnAugmentorSkill,
  AddOnEngineerSetupRunbook,
  AddOnLocalServiceDefinition,
  AddOnManifest,
  AddOnAgentRuntimeContract,
  AddOnAuditContract,
  AddOnConnectorDefinition,
  AddOnEmbeddedWorkspaceContract,
  AddOnHookDefinition,
  AddOnInstallContract,
  AddOnMemoryAccessContract,
  AddOnScriptDefinition,
  AddOnServiceProtocol,
  AddOnSkillDefinition,
  AddOnDeterministicSmokeTest,
  AddOnToolDefinition,
  AddOnWorkflowBoundary,
  Capability,
} from "../../../src/core/contracts";

export const ADDON_SDK_VERSION = "0.1.0";

export type AddOnSdkManifest = AddOnManifest & {
  sdkVersion: string;
  service?: AddOnLocalServiceDefinition;
  tools?: AddOnToolDefinition[];
  workflowBoundaries?: AddOnWorkflowBoundary[];
  skills?: AddOnSkillDefinition[];
  connectors?: AddOnConnectorDefinition[];
  scripts?: AddOnScriptDefinition[];
  hooks?: AddOnHookDefinition[];
  engineerSetup?: AddOnEngineerSetupRunbook;
  augmentorSkills?: AddOnAugmentorSkill[];
  install?: AddOnInstallContract;
  audit?: AddOnAuditContract;
  embeddedWorkspace?: AddOnEmbeddedWorkspaceContract;
  agentRuntime?: AddOnAgentRuntimeContract;
  memoryAccess?: AddOnMemoryAccessContract;
  smokeTests?: AddOnDeterministicSmokeTest[];
};

export type AddOnManifestSource = "bundled" | "sideload";

export type AddOnValidationSeverity = "error" | "warning";

export type AddOnValidationIssue = {
  severity: AddOnValidationSeverity;
  code: string;
  path: string;
  message: string;
};

export type AddOnManifestValidationResult = {
  valid: boolean;
  manifestId?: string;
  issues: AddOnValidationIssue[];
};

export const ADDON_CAPABILITIES: readonly Capability[] = [
  "filesystem",
  "archive-read",
  "archive-intake-write",
  "chat-interface",
  "memory-provider",
  "providers",
  "shell",
  "network",
  "ui-embedding",
  "browser-control",
  "agent-delegation",
  "notifications",
  "device-integration",
  "channel.send",
  "channel.account-write",
];

export const ADDON_SERVICE_PROTOCOLS: readonly AddOnServiceProtocol[] = [
  "stdio-json-rpc",
  "http-json",
  "websocket-json",
  "host-command",
];
