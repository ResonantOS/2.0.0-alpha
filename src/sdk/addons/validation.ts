// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md

import type {
  AddOnCategory,
  AddOnManifest,
  AddOnRuntimeType,
  AddOnSurfaceType,
  Capability,
  CapabilityScope,
  DelegationArtifactType,
  RevocationBehavior,
  RuntimeIsolationBoundary,
  SystemSlotId,
} from "../../core/contracts";
import {
  ADDON_CAPABILITIES,
  ADDON_SERVICE_PROTOCOLS,
  type AddOnManifestSource,
  type AddOnManifestValidationResult,
  type AddOnValidationIssue,
} from "./contracts";

const runtimeTypes: readonly AddOnRuntimeType[] = ["ui-module", "embedded-module", "local-service", "agent-addon", "channel-addon"];
const categories: readonly AddOnCategory[] = [
  "agent",
  "channel",
  "memory",
  "security",
  "knowledge",
  "tool",
  "integration",
  "orchestration",
];
const surfaceTypes: readonly AddOnSurfaceType[] = [
  "page",
  "panel",
  "rail",
  "floating-window",
  "embedded-pane",
  "modal",
  "tool-action",
  "background-task-monitor",
  "channel",
];
// Section IDs and dock icon names are open strings: core values are defined in CoreSectionId /
// CoreDockIconName in contracts.ts, but add-on manifests may register any string as a new section
// or dock icon. Validation here only checks that the field is a non-empty string.
const scopes: readonly CapabilityScope[] = ["none", "self", "workspace", "shared", "system", "intake-only"];
const revocationBehaviors: readonly RevocationBehavior[] = ["hard-stop", "degrade", "hide-surface"];
const isolationBoundaries: readonly RuntimeIsolationBoundary[] = [
  "shell-ui",
  "embedded-surface",
  "host-mediated-service",
  "host-mediated-agent",
  "host-mediated-channel",
];
const artifactTypes: readonly DelegationArtifactType[] = [
  "summary",
  "markdown",
  "diff",
  "file-list",
  "log",
  "citation-bundle",
  "diagnostic-report",
  "verification-report",
  "archive-intake-bundle",
];
const installModes = ["detect-existing-only", "detect-existing-or-install", "bundled", "manual"] as const;
const credentialSetupModes = ["none", "user-guided", "host-vault", "external"] as const;
const auditRemediationPolicies = ["suggest-only", "approval-gated", "automatic-safe"] as const;
const embeddedWorkspaceModes = ["hosted-dashboard", "native-panel", "terminal", "browser"] as const;
const settingsVisibilityModes = ["hidden-collapsible", "visible", "separate-panel"] as const;
const modelMetadataSources = ["runtime-audit", "provider-profile", "manifest-default", "user-config"] as const;
const outputFilteringModes = ["assistant-reply-only", "structured-events", "raw-log"] as const;
const archiveReadModes = ["none", "read-only-context", "retrieval-with-citations"] as const;
const archiveWriteModes = ["none", "intake-only"] as const;
const workflowRepeatabilityModes = ["one-off", "repeatable", "workflow-package"] as const;
const workflowOwners = ["human", "augmentor", "engineer", "addon-agent", "external-system"] as const;
const skillInvocationModes = ["manual", "agent-suggested", "automatic"] as const;
const connectorTypes = ["mcp-server", "app-connector", "api", "local-runtime", "filesystem"] as const;
const connectorConfigScopes = ["host-vault", "addon-private", "user-config", "none"] as const;
const scriptRunPolicies = ["manual", "preflight", "postflight", "scheduled", "on-demand"] as const;
const hookEvents = [
  "before-install",
  "after-install",
  "before-enable",
  "after-enable",
  "before-disable",
  "health-check",
  "before-task-complete",
  "before-archive-ingest",
  "after-archive-intake",
] as const;
const hookFailurePolicies = ["block", "degrade", "warn"] as const;

// systemSlots coverage (P1-b). A manifest that declares a systemSlot becomes the
// active provider for that slot (activeSystemSlotProvider), replacing a built-in
// surface. Each known SystemSlotId maps to a backing capability that MUST be
// declared in requestedCapabilities so the runtime grant gate
// (system-slots.ts capabilityForSlot / activeSystemSlotProvider) can apply.
// This map mirrors capabilityForSlot in src/modules/shell/system-slots.ts.
const systemSlotIds: readonly SystemSlotId[] = ["primary-agent", "chat-interface", "memory-system", "communication-channel"];
const slotBackingCapability: Record<SystemSlotId, Capability> = {
  "primary-agent": "agent-delegation",
  "chat-interface": "chat-interface",
  "memory-system": "memory-provider",
  "communication-channel": "notifications",
};

const addonIdPattern = /^addon\.[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const pushIssue = (
  issues: AddOnValidationIssue[],
  severity: AddOnValidationIssue["severity"],
  code: string,
  path: string,
  message: string,
) => {
  issues.push({ severity, code, path, message });
};

const validateString = (
  issues: AddOnValidationIssue[],
  manifest: Record<string, unknown>,
  field: string,
) => {
  if (!isString(manifest[field])) {
    pushIssue(issues, "error", "required-string", field, `${field} must be a non-empty string.`);
  }
};

const validateStringValue = (
  issues: AddOnValidationIssue[],
  value: unknown,
  path: string,
) => {
  if (!isString(value)) {
    pushIssue(issues, "error", "required-string", path, `${path} must be a non-empty string.`);
  }
};

const validateStringArray = (
  issues: AddOnValidationIssue[],
  value: unknown,
  path: string,
) => {
  if (!Array.isArray(value) || value.some((item) => !isString(item))) {
    pushIssue(issues, "error", "string-array", path, `${path} must be an array of non-empty strings.`);
  }
};

const validateCapabilityReferences = (
  issues: AddOnValidationIssue[],
  value: unknown,
  path: string,
  requestedCapabilitySet: Set<Capability>,
  code: string,
  message: string,
) => {
  if (!Array.isArray(value)) {
    pushIssue(issues, "error", "capabilities-array", path, `${path} must be an array of capabilities requested by the manifest.`);
    return;
  }
  value.forEach((capability, capabilityIndex) => {
    validateEnum(issues, capability, ADDON_CAPABILITIES, `${path}[${capabilityIndex}]`);
    if (ADDON_CAPABILITIES.includes(capability as Capability) && !requestedCapabilitySet.has(capability as Capability)) {
      pushIssue(issues, "error", code, `${path}[${capabilityIndex}]`, message);
    }
  });
};

const validateToolReference = (
  issues: AddOnValidationIssue[],
  value: unknown,
  path: string,
  declaredToolNames: Set<string>,
) => {
  if (isString(value) && !declaredToolNames.has(value)) {
    pushIssue(issues, "error", "unknown-tool-reference", path, `${path} must reference a tool declared by the manifest.`);
  }
};

const validateRequiredToolReference = (
  issues: AddOnValidationIssue[],
  value: unknown,
  path: string,
  declaredToolNames: Set<string>,
) => {
  validateStringValue(issues, value, path);
  validateToolReference(issues, value, path, declaredToolNames);
};

const validateUniqueStringId = (
  issues: AddOnValidationIssue[],
  value: unknown,
  path: string,
  seen: Set<string>,
  duplicateCode: string,
  label: string,
) => {
  validateStringValue(issues, value, path);
  if (!isString(value)) {
    return;
  }
  if (seen.has(value)) {
    pushIssue(issues, "error", duplicateCode, path, `${label} ids must be unique inside a manifest.`);
  }
  seen.add(value);
};

const validateEnum = <T extends string>(
  issues: AddOnValidationIssue[],
  value: unknown,
  allowed: readonly T[],
  path: string,
) => {
  if (!allowed.includes(value as T)) {
    pushIssue(issues, "error", "unknown-enum", path, `${path} has an unsupported value.`);
  }
};

export const validateAddOnManifest = (
  candidate: unknown,
  options: { source?: AddOnManifestSource } = {},
): AddOnManifestValidationResult => {
  const source = options.source ?? "bundled";
  const issues: AddOnValidationIssue[] = [];

  if (!isRecord(candidate)) {
    return {
      valid: false,
      issues: [
        {
          severity: "error",
          code: "manifest-object",
          path: "$",
          message: "Add-on manifest must be a JSON object.",
        },
      ],
    };
  }

  for (const field of ["id", "name", "version", "author", "category", "description", "runtimeType"]) {
    validateString(issues, candidate, field);
  }

  const manifestId = isString(candidate.id) ? candidate.id : undefined;
  if (manifestId && !addonIdPattern.test(manifestId)) {
    pushIssue(issues, "error", "invalid-addon-id", "id", "Add-on id must use the addon.namespace-name form.");
  }
  if (isString(candidate.version) && !semanticVersionPattern.test(candidate.version)) {
    pushIssue(issues, "error", "invalid-version", "version", "Add-on version must be semantic version-like, for example 0.1.0.");
  }
  validateEnum(issues, candidate.category, categories, "category");
  validateEnum(issues, candidate.runtimeType, runtimeTypes, "runtimeType");

  const manifestSurfaceTypes = new Set<AddOnSurfaceType>();
  if (!Array.isArray(candidate.surfaces)) {
    pushIssue(issues, "error", "surfaces-array", "surfaces", "surfaces must be an array.");
  } else {
    const surfaceIds = new Set<string>();
    candidate.surfaces.forEach((surface, index) => {
      const path = `surfaces[${index}]`;
      if (!isRecord(surface)) {
        pushIssue(issues, "error", "surface-object", path, "Surface must be an object.");
        return;
      }
      validateStringValue(issues, surface.id, `${path}.id`);
      validateStringValue(issues, surface.label, `${path}.label`);
      validateStringValue(issues, surface.description, `${path}.description`);
      validateEnum(issues, surface.type, surfaceTypes, `${path}.type`);
      if (surfaceTypes.includes(surface.type as AddOnSurfaceType)) {
        manifestSurfaceTypes.add(surface.type as AddOnSurfaceType);
      }
      if (surface.shellNavigation !== undefined) {
        if (!isRecord(surface.shellNavigation)) {
          pushIssue(issues, "error", "surface-navigation-object", `${path}.shellNavigation`, "shellNavigation must be an object.");
        } else {
          validateStringValue(issues, surface.shellNavigation.sectionId, `${path}.shellNavigation.sectionId`);
          validateStringValue(issues, surface.shellNavigation.dockIcon, `${path}.shellNavigation.dockIcon`);
          validateStringValue(issues, surface.shellNavigation.eyebrow, `${path}.shellNavigation.eyebrow`);
          if (
            surface.shellNavigation.order !== undefined &&
            (typeof surface.shellNavigation.order !== "number" || !Number.isFinite(surface.shellNavigation.order))
          ) {
            pushIssue(issues, "error", "surface-navigation-order", `${path}.shellNavigation.order`, "shellNavigation.order must be a finite number.");
          }
          if (surface.shellNavigation.requiredCapabilities !== undefined && !Array.isArray(surface.shellNavigation.requiredCapabilities)) {
            pushIssue(
              issues,
              "error",
              "surface-navigation-capabilities-array",
              `${path}.shellNavigation.requiredCapabilities`,
              "shellNavigation.requiredCapabilities must be an array.",
            );
          } else if (Array.isArray(surface.shellNavigation.requiredCapabilities)) {
            surface.shellNavigation.requiredCapabilities.forEach((capability, capabilityIndex) => {
              validateEnum(
                issues,
                capability,
                ADDON_CAPABILITIES,
                `${path}.shellNavigation.requiredCapabilities[${capabilityIndex}]`,
              );
            });
          }
        }
      }
      if (isString(surface.id)) {
        if (surfaceIds.has(surface.id)) {
          pushIssue(issues, "error", "duplicate-surface", `${path}.id`, "Surface ids must be unique inside a manifest.");
        }
        surfaceIds.add(surface.id);
      }
    });
  }

  const requestedCapabilities = Array.isArray(candidate.requestedCapabilities) ? candidate.requestedCapabilities : [];
  if (!Array.isArray(candidate.requestedCapabilities)) {
    pushIssue(issues, "error", "capabilities-array", "requestedCapabilities", "requestedCapabilities must be an array.");
  }
  const requestedCapabilitySet = new Set<Capability>();
  requestedCapabilities.forEach((grant, index) => {
    const path = `requestedCapabilities[${index}]`;
    if (!isRecord(grant)) {
      pushIssue(issues, "error", "capability-object", path, "Capability grant must be an object.");
      return;
    }
    validateEnum(issues, grant.capability, ADDON_CAPABILITIES, `${path}.capability`);
    validateEnum(issues, grant.scope, scopes, `${path}.scope`);
    validateEnum(issues, grant.revocationBehavior, revocationBehaviors, `${path}.revocationBehavior`);
    if (typeof grant.granted !== "boolean") {
      pushIssue(issues, "error", "capability-granted-boolean", `${path}.granted`, "Capability granted must be boolean.");
    }
    if (ADDON_CAPABILITIES.includes(grant.capability as Capability)) {
      const capability = grant.capability as Capability;
      if (requestedCapabilitySet.has(capability)) {
        pushIssue(issues, "error", "duplicate-capability", `${path}.capability`, "Requested capabilities must be unique.");
      }
      requestedCapabilitySet.add(capability);
    }
  });

  if (Array.isArray(candidate.surfaces)) {
    candidate.surfaces.forEach((surface, index) => {
      const shellNavigation = isRecord(surface) && isRecord(surface.shellNavigation) ? surface.shellNavigation : null;
      if (!shellNavigation || !Array.isArray(shellNavigation.requiredCapabilities)) {
        return;
      }
      shellNavigation.requiredCapabilities.forEach((capability, capabilityIndex) => {
        if (ADDON_CAPABILITIES.includes(capability as Capability) && !requestedCapabilitySet.has(capability as Capability)) {
          pushIssue(
            issues,
            "error",
            "surface-navigation-unrequested-capability",
            `surfaces[${index}].shellNavigation.requiredCapabilities[${capabilityIndex}]`,
            "Surface navigation capabilities must be declared in requestedCapabilities.",
          );
        }
      });
    });
  }

  if (
    (candidate.runtimeType === "embedded-module" || manifestSurfaceTypes.has("embedded-pane")) &&
    !requestedCapabilitySet.has("ui-embedding")
  ) {
    pushIssue(
      issues,
      "error",
      "embedded-surface-requires-ui-embedding",
      "requestedCapabilities",
      "Embedded add-ons and embedded-pane surfaces must request ui-embedding.",
    );
  }
  if (candidate.runtimeType === "ui-module" && !manifestSurfaceTypes.has("embedded-pane") && requestedCapabilitySet.has("ui-embedding")) {
    pushIssue(
      issues,
      "warning",
      "ui-module-ui-embedding-unnecessary",
      "requestedCapabilities",
      "UI module panels run inside the ResonantOS shell and should not request ui-embedding unless they expose an embedded-pane surface.",
    );
  }

  if (Array.isArray(candidate.grantPresets)) {
    const presetIds = new Set<string>();
    candidate.grantPresets.forEach((preset, presetIndex) => {
      const presetPath = `grantPresets[${presetIndex}]`;
      if (!isRecord(preset)) {
        pushIssue(issues, "error", "grant-preset-object", presetPath, "Grant preset must be an object.");
        return;
      }
      validateStringValue(issues, preset.id, `${presetPath}.id`);
      validateStringValue(issues, preset.label, `${presetPath}.label`);
      validateStringValue(issues, preset.description, `${presetPath}.description`);
      if (isString(preset.id)) {
        if (presetIds.has(preset.id)) {
          pushIssue(issues, "error", "duplicate-preset", `${presetPath}.id`, "Grant preset ids must be unique.");
        }
        presetIds.add(preset.id);
      }
      if (!Array.isArray(preset.grants)) {
        pushIssue(issues, "error", "grant-preset-grants-array", `${presetPath}.grants`, "Preset grants must be an array.");
        return;
      }
      preset.grants.forEach((grant, grantIndex) => {
        const grantPath = `${presetPath}.grants[${grantIndex}]`;
        if (!isRecord(grant)) {
          pushIssue(issues, "error", "grant-preset-grant-object", grantPath, "Preset grant must be an object.");
          return;
        }
        validateEnum(issues, grant.capability, ADDON_CAPABILITIES, `${grantPath}.capability`);
        if (ADDON_CAPABILITIES.includes(grant.capability as Capability) && !requestedCapabilitySet.has(grant.capability as Capability)) {
          pushIssue(
            issues,
            "error",
            "preset-grants-unrequested-capability",
            `${grantPath}.capability`,
            "Grant presets may only grant capabilities declared in requestedCapabilities.",
          );
        }
      });
    });
  }

  if (!isRecord(candidate.providerRequirements)) {
    pushIssue(issues, "error", "provider-requirements-object", "providerRequirements", "providerRequirements must be an object.");
  } else {
    validateStringArray(issues, candidate.providerRequirements.sharedProfiles, "providerRequirements.sharedProfiles");
    if (
      Array.isArray(candidate.providerRequirements.sharedProfiles) &&
      candidate.providerRequirements.sharedProfiles.length > 0 &&
      !requestedCapabilitySet.has("providers")
    ) {
      pushIssue(
        issues,
        "error",
        "provider-profile-requires-capability",
        "requestedCapabilities",
        "Add-ons declaring shared provider profiles must request providers.",
      );
    }
    if (typeof candidate.providerRequirements.supportsPrivateCredentials !== "boolean") {
      pushIssue(
        issues,
        "error",
        "private-credentials-boolean",
        "providerRequirements.supportsPrivateCredentials",
        "supportsPrivateCredentials must be boolean.",
      );
    }
  }

  if (!isRecord(candidate.archiveIntegration)) {
    pushIssue(issues, "error", "archive-integration-object", "archiveIntegration", "archiveIntegration must be an object.");
  } else {
    validateStringArray(issues, candidate.archiveIntegration.readScopes, "archiveIntegration.readScopes");
    validateStringArray(issues, candidate.archiveIntegration.intakeWriteScopes, "archiveIntegration.intakeWriteScopes");
    if (
      Array.isArray(candidate.archiveIntegration.readScopes) &&
      candidate.archiveIntegration.readScopes.length > 0 &&
      !requestedCapabilitySet.has("archive-read")
    ) {
      pushIssue(
        issues,
        "error",
        "archive-read-scope-requires-capability",
        "requestedCapabilities",
        "Add-ons declaring archive read scopes must request archive-read.",
      );
    }
    if (
      Array.isArray(candidate.archiveIntegration.intakeWriteScopes) &&
      candidate.archiveIntegration.intakeWriteScopes.length > 0 &&
      !requestedCapabilitySet.has("archive-intake-write")
    ) {
      pushIssue(
        issues,
        "error",
        "archive-intake-scope-requires-capability",
        "requestedCapabilities",
        "Add-ons declaring archive intake write scopes must request archive-intake-write.",
      );
    }
    if (candidate.archiveIntegration.canWriteKnowledgePages === true) {
      pushIssue(
        issues,
        "error",
        "addon-knowledge-write-forbidden",
        "archiveIntegration.canWriteKnowledgePages",
        "Add-ons cannot claim trusted Living Archive knowledge-page write authority.",
      );
    }
  }

  if (!isRecord(candidate.health) || !isString(candidate.health.strategy)) {
    pushIssue(issues, "error", "health-strategy", "health.strategy", "health.strategy must be a non-empty string.");
  }

  if (!isRecord(candidate.installHooks)) {
    pushIssue(issues, "error", "install-hooks-object", "installHooks", "installHooks must be an object.");
  }

  if (isRecord(candidate.engineerSetup)) {
    validateStringValue(issues, candidate.engineerSetup.documentPath, "engineerSetup.documentPath");
    validateStringValue(issues, candidate.engineerSetup.objective, "engineerSetup.objective");
    validateStringArray(issues, candidate.engineerSetup.allowedHostCommands, "engineerSetup.allowedHostCommands");
    validateStringArray(issues, candidate.engineerSetup.expectedInputs, "engineerSetup.expectedInputs");
    validateStringArray(issues, candidate.engineerSetup.expectedOutputs, "engineerSetup.expectedOutputs");
    if (!Array.isArray(candidate.engineerSetup.requiredCapabilities)) {
      pushIssue(
        issues,
        "error",
        "engineer-setup-capabilities",
        "engineerSetup.requiredCapabilities",
        "engineerSetup.requiredCapabilities must be an array of capabilities requested by the manifest.",
      );
    } else {
      candidate.engineerSetup.requiredCapabilities.forEach((capability, capabilityIndex) => {
        validateEnum(issues, capability, ADDON_CAPABILITIES, `engineerSetup.requiredCapabilities[${capabilityIndex}]`);
        if (ADDON_CAPABILITIES.includes(capability as Capability) && !requestedCapabilitySet.has(capability as Capability)) {
          pushIssue(
            issues,
            "error",
            "engineer-setup-unrequested-capability",
            `engineerSetup.requiredCapabilities[${capabilityIndex}]`,
            "Engineer setup runbooks may only require capabilities requested by the manifest.",
          );
        }
      });
    }
    if (typeof candidate.engineerSetup.requiresHumanApprovalBeforeExecution !== "boolean") {
      pushIssue(
        issues,
        "error",
        "engineer-setup-approval-boolean",
        "engineerSetup.requiresHumanApprovalBeforeExecution",
        "engineerSetup.requiresHumanApprovalBeforeExecution must be boolean.",
      );
    }
    if (typeof candidate.engineerSetup.auditLogRequired !== "boolean") {
      pushIssue(
        issues,
        "error",
        "engineer-setup-audit-boolean",
        "engineerSetup.auditLogRequired",
        "engineerSetup.auditLogRequired must be boolean.",
      );
    }
  }

  if (!isRecord(candidate.compatibility)) {
    pushIssue(issues, "error", "compatibility-object", "compatibility", "compatibility must be an object.");
  } else {
    validateStringValue(issues, candidate.compatibility.shellVersion, "compatibility.shellVersion");
    validateStringArray(issues, candidate.compatibility.platforms, "compatibility.platforms");
  }

  if (isRecord(candidate.runtimeIsolation)) {
    validateEnum(issues, candidate.runtimeIsolation.boundary, isolationBoundaries, "runtimeIsolation.boundary");
    if (typeof candidate.runtimeIsolation.supportsDegradedMode !== "boolean") {
      pushIssue(issues, "error", "runtime-isolation-boolean", "runtimeIsolation.supportsDegradedMode", "supportsDegradedMode must be boolean.");
    }
    if (typeof candidate.runtimeIsolation.requiresReviewedGrant !== "boolean") {
      pushIssue(issues, "error", "runtime-isolation-boolean", "runtimeIsolation.requiresReviewedGrant", "requiresReviewedGrant must be boolean.");
    }
  }

  if (isRecord(candidate.service)) {
    validateEnum(issues, candidate.service.protocol, ADDON_SERVICE_PROTOCOLS, "service.protocol");
    validateStringValue(issues, candidate.service.entrypoint, "service.entrypoint");
  } else if (candidate.runtimeType === "local-service") {
    pushIssue(
      issues,
      "warning",
      "local-service-entrypoint-missing",
      "service",
      "Local-service add-ons should declare a service entrypoint before they can be executed by the host.",
    );
  }

  const declaredToolNames = new Set<string>();
  if (Array.isArray(candidate.tools)) {
    candidate.tools.forEach((tool, index) => {
      const path = `tools[${index}]`;
      if (!isRecord(tool)) {
        pushIssue(issues, "error", "tool-object", path, "Tool definition must be an object.");
        return;
      }
      validateStringValue(issues, tool.name, `${path}.name`);
      validateStringValue(issues, tool.description, `${path}.description`);
      if (isString(tool.name)) {
        if (declaredToolNames.has(tool.name)) {
          pushIssue(issues, "error", "duplicate-tool", `${path}.name`, "Tool names must be unique.");
        }
        declaredToolNames.add(tool.name);
      }
      if (!Array.isArray(tool.requiredCapabilities)) {
        pushIssue(issues, "error", "tool-capabilities-array", `${path}.requiredCapabilities`, "Tool requiredCapabilities must be an array.");
      } else {
        tool.requiredCapabilities.forEach((capability, capabilityIndex) => {
          validateEnum(issues, capability, ADDON_CAPABILITIES, `${path}.requiredCapabilities[${capabilityIndex}]`);
          if (ADDON_CAPABILITIES.includes(capability as Capability) && !requestedCapabilitySet.has(capability as Capability)) {
            pushIssue(
              issues,
              "error",
              "tool-uses-unrequested-capability",
              `${path}.requiredCapabilities[${capabilityIndex}]`,
              "Tool capabilities must be declared in requestedCapabilities.",
            );
          }
        });
      }
      if (!isRecord(tool.inputSchema)) {
        pushIssue(issues, "error", "tool-input-schema", `${path}.inputSchema`, "Tool inputSchema must be an object.");
      }
      if (!isRecord(tool.outputSchema)) {
        pushIssue(issues, "error", "tool-output-schema", `${path}.outputSchema`, "Tool outputSchema must be an object.");
      }
      if (!isRecord(tool.audit)) {
        pushIssue(issues, "error", "tool-audit", `${path}.audit`, "Tool audit must be an object.");
      } else if (Array.isArray(tool.audit.artifactTypes)) {
        tool.audit.artifactTypes.forEach((artifactType, artifactIndex) => {
          validateEnum(issues, artifactType, artifactTypes, `${path}.audit.artifactTypes[${artifactIndex}]`);
        });
      } else {
        pushIssue(issues, "error", "tool-audit-artifacts", `${path}.audit.artifactTypes`, "Tool audit artifactTypes must be an array.");
      }
    });
  }

  if (Array.isArray(candidate.augmentorSkills)) {
    candidate.augmentorSkills.forEach((skill, index) => {
      const path = `augmentorSkills[${index}]`;
      if (!isRecord(skill)) {
        pushIssue(issues, "error", "augmentor-skill-object", path, "Augmentor skill must be an object.");
        return;
      }
      validateStringValue(issues, skill.documentPath, `${path}.documentPath`);
      validateStringValue(issues, skill.objective, `${path}.objective`);
      validateStringArray(issues, skill.requiredTools, `${path}.requiredTools`);
      validateStringArray(issues, skill.workflowPhases, `${path}.workflowPhases`);
      validateStringArray(issues, skill.approvalGates, `${path}.approvalGates`);
      validateStringArray(issues, skill.expectedInputs, `${path}.expectedInputs`);
      validateStringArray(issues, skill.expectedOutputs, `${path}.expectedOutputs`);
      if (!Array.isArray(skill.requiredCapabilities)) {
        pushIssue(
          issues,
          "error",
          "augmentor-skill-capabilities",
          `${path}.requiredCapabilities`,
          "Augmentor skill requiredCapabilities must be an array of capabilities requested by the manifest.",
        );
      } else {
        skill.requiredCapabilities.forEach((capability, capabilityIndex) => {
          validateEnum(issues, capability, ADDON_CAPABILITIES, `${path}.requiredCapabilities[${capabilityIndex}]`);
          if (ADDON_CAPABILITIES.includes(capability as Capability) && !requestedCapabilitySet.has(capability as Capability)) {
            pushIssue(
              issues,
              "error",
              "augmentor-skill-unrequested-capability",
              `${path}.requiredCapabilities[${capabilityIndex}]`,
              "Augmentor skills may only require capabilities requested by the manifest.",
            );
          }
        });
      }
      if (Array.isArray(skill.requiredTools)) {
        skill.requiredTools.forEach((toolName, toolIndex) => {
          if (isString(toolName) && !declaredToolNames.has(toolName)) {
            pushIssue(
              issues,
              "error",
              "augmentor-skill-unknown-tool",
              `${path}.requiredTools[${toolIndex}]`,
              "Augmentor skills may only require tools declared by the manifest.",
            );
          }
        });
      }
      if (typeof skill.producesDelegationPackets !== "boolean") {
        pushIssue(
          issues,
          "error",
          "augmentor-skill-delegation-boolean",
          `${path}.producesDelegationPackets`,
          "Augmentor skill producesDelegationPackets must be boolean.",
        );
      }
      if (typeof skill.auditLogRequired !== "boolean") {
        pushIssue(
          issues,
          "error",
          "augmentor-skill-audit-boolean",
          `${path}.auditLogRequired`,
          "Augmentor skill auditLogRequired must be boolean.",
        );
      }
    });
  }

  if (Array.isArray(candidate.workflowBoundaries)) {
    const boundaryIds = new Set<string>();
    candidate.workflowBoundaries.forEach((boundary, index) => {
      const path = `workflowBoundaries[${index}]`;
      if (!isRecord(boundary)) {
        pushIssue(issues, "error", "workflow-boundary-object", path, "Workflow boundary must be an object.");
        return;
      }
      validateUniqueStringId(issues, boundary.id, `${path}.id`, boundaryIds, "duplicate-workflow-boundary", "Workflow boundary");
      validateStringValue(issues, boundary.label, `${path}.label`);
      validateStringValue(issues, boundary.jobToBeDone, `${path}.jobToBeDone`);
      validateStringValue(issues, boundary.userValue, `${path}.userValue`);
      validateEnum(issues, boundary.repeatability, workflowRepeatabilityModes, `${path}.repeatability`);
      validateEnum(issues, boundary.owner, workflowOwners, `${path}.owner`);
      validateStringArray(issues, boundary.nonGoals, `${path}.nonGoals`);
    });
  }

  if (Array.isArray(candidate.skills)) {
    const skillIds = new Set<string>();
    candidate.skills.forEach((skill, index) => {
      const path = `skills[${index}]`;
      if (!isRecord(skill)) {
        pushIssue(issues, "error", "skill-object", path, "Skill definition must be an object.");
        return;
      }
      validateUniqueStringId(issues, skill.id, `${path}.id`, skillIds, "duplicate-skill", "Skill");
      validateStringValue(issues, skill.name, `${path}.name`);
      validateStringValue(issues, skill.description, `${path}.description`);
      validateStringValue(issues, skill.documentPath, `${path}.documentPath`);
      validateEnum(issues, skill.invocation, skillInvocationModes, `${path}.invocation`);
      validateCapabilityReferences(
        issues,
        skill.requiredCapabilities,
        `${path}.requiredCapabilities`,
        requestedCapabilitySet,
        "skill-unrequested-capability",
        "Skill definitions may only require capabilities requested by the manifest.",
      );
      if (Array.isArray(skill.requiredTools)) {
        skill.requiredTools.forEach((toolName, toolIndex) => {
          if (isString(toolName) && !declaredToolNames.has(toolName)) {
            pushIssue(
              issues,
              "error",
              "skill-unknown-tool",
              `${path}.requiredTools[${toolIndex}]`,
              "Skill definitions may only require tools declared by the manifest.",
            );
          }
        });
      } else if (skill.requiredTools !== undefined) {
        validateStringArray(issues, skill.requiredTools, `${path}.requiredTools`);
      }
    });
  }

  if (Array.isArray(candidate.connectors)) {
    const connectorIds = new Set<string>();
    candidate.connectors.forEach((connector, index) => {
      const path = `connectors[${index}]`;
      if (!isRecord(connector)) {
        pushIssue(issues, "error", "connector-object", path, "Connector definition must be an object.");
        return;
      }
      validateUniqueStringId(issues, connector.id, `${path}.id`, connectorIds, "duplicate-connector", "Connector");
      validateStringValue(issues, connector.name, `${path}.name`);
      validateStringValue(issues, connector.description, `${path}.description`);
      validateEnum(issues, connector.type, connectorTypes, `${path}.type`);
      validateEnum(issues, connector.configScope, connectorConfigScopes, `${path}.configScope`);
      validateCapabilityReferences(
        issues,
        connector.requiredCapabilities,
        `${path}.requiredCapabilities`,
        requestedCapabilitySet,
        "connector-unrequested-capability",
        "Connector definitions may only require capabilities requested by the manifest.",
      );
    });
  }

  const scriptIds = new Set<string>();
  const scriptsById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(candidate.scripts)) {
    candidate.scripts.forEach((script, index) => {
      const path = `scripts[${index}]`;
      if (!isRecord(script)) {
        pushIssue(issues, "error", "script-object", path, "Script definition must be an object.");
        return;
      }
      validateUniqueStringId(issues, script.id, `${path}.id`, scriptIds, "duplicate-script", "Script");
      if (isString(script.id)) {
        scriptsById.set(script.id, script);
      }
      validateStringValue(issues, script.name, `${path}.name`);
      validateStringValue(issues, script.description, `${path}.description`);
      validateStringValue(issues, script.commandRef, `${path}.commandRef`);
      validateEnum(issues, script.runPolicy, scriptRunPolicies, `${path}.runPolicy`);
      if (typeof script.deterministic !== "boolean") {
        pushIssue(issues, "error", "script-deterministic-boolean", `${path}.deterministic`, "Script deterministic must be boolean.");
      }
      if (typeof script.requiresHumanApproval !== "boolean") {
        pushIssue(
          issues,
          "error",
          "script-human-approval-boolean",
          `${path}.requiresHumanApproval`,
          "Script requiresHumanApproval must be boolean.",
        );
      }
      validateCapabilityReferences(
        issues,
        script.requiredCapabilities,
        `${path}.requiredCapabilities`,
        requestedCapabilitySet,
        "script-unrequested-capability",
        "Script definitions may only require capabilities requested by the manifest.",
      );
      if (Array.isArray(script.producesArtifacts)) {
        script.producesArtifacts.forEach((artifactType, artifactIndex) => {
          validateEnum(issues, artifactType, artifactTypes, `${path}.producesArtifacts[${artifactIndex}]`);
        });
      } else {
        pushIssue(issues, "error", "script-artifacts-array", `${path}.producesArtifacts`, "Script producesArtifacts must be an array.");
      }
    });
  }

  if (Array.isArray(candidate.hooks)) {
    const hookIds = new Set<string>();
    candidate.hooks.forEach((hook, index) => {
      const path = `hooks[${index}]`;
      if (!isRecord(hook)) {
        pushIssue(issues, "error", "hook-object", path, "Hook definition must be an object.");
        return;
      }
      validateUniqueStringId(issues, hook.id, `${path}.id`, hookIds, "duplicate-hook", "Hook");
      validateEnum(issues, hook.event, hookEvents, `${path}.event`);
      validateStringValue(issues, hook.handlerRef, `${path}.handlerRef`);
      const handlerScript = isString(hook.handlerRef) ? scriptsById.get(hook.handlerRef) : undefined;
      if (isString(hook.handlerRef) && !handlerScript) {
        pushIssue(
          issues,
          "error",
          "hook-unknown-handler",
          `${path}.handlerRef`,
          "Hook handlerRef must reference a script declared by the manifest.",
        );
      }
      validateEnum(issues, hook.failurePolicy, hookFailurePolicies, `${path}.failurePolicy`);
      validateCapabilityReferences(
        issues,
        hook.requiredCapabilities,
        `${path}.requiredCapabilities`,
        requestedCapabilitySet,
        "hook-unrequested-capability",
        "Hook definitions may only require capabilities requested by the manifest.",
      );
      if (handlerScript && Array.isArray(handlerScript.requiredCapabilities) && Array.isArray(hook.requiredCapabilities)) {
        const hookCapabilities = new Set(hook.requiredCapabilities);
        handlerScript.requiredCapabilities.forEach((capability, capabilityIndex) => {
          if (ADDON_CAPABILITIES.includes(capability as Capability) && !hookCapabilities.has(capability)) {
            pushIssue(
              issues,
              "error",
              "hook-omits-handler-capability",
              `${path}.requiredCapabilities`,
              `Hook must explicitly require handler script capability ${String(capability)} from ${path}.handlerRef.`,
            );
          }
          validateEnum(issues, capability, ADDON_CAPABILITIES, `scripts.${String(hook.handlerRef)}.requiredCapabilities[${capabilityIndex}]`);
        });
      }
      if (handlerScript?.requiresHumanApproval === true) {
        pushIssue(
          issues,
          "error",
          "hook-handler-requires-human-approval",
          `${path}.handlerRef`,
          "Automatic hooks may not reference scripts that require human approval.",
        );
      }
    });
  }

  if (isRecord(candidate.install)) {
    validateEnum(issues, candidate.install.mode, installModes, "install.mode");
    validateCapabilityReferences(
      issues,
      candidate.install.requiredCapabilities,
      "install.requiredCapabilities",
      requestedCapabilitySet,
      "install-unrequested-capability",
      "Install contracts may only require capabilities requested by the manifest.",
    );
    validateToolReference(issues, candidate.install.detectionTool, "install.detectionTool", declaredToolNames);
    validateToolReference(issues, candidate.install.installTool, "install.installTool", declaredToolNames);
    validateToolReference(issues, candidate.install.repairTool, "install.repairTool", declaredToolNames);
    validateEnum(issues, candidate.install.credentialSetup, credentialSetupModes, "install.credentialSetup");
    if (typeof candidate.install.requiresHumanApprovalBeforeInstall !== "boolean") {
      pushIssue(issues, "error", "install-approval-boolean", "install.requiresHumanApprovalBeforeInstall", "Install approval must be boolean.");
    }
    if (typeof candidate.install.preservesExistingUserConfig !== "boolean") {
      pushIssue(issues, "error", "install-preserves-config-boolean", "install.preservesExistingUserConfig", "preservesExistingUserConfig must be boolean.");
    }
    if (typeof candidate.install.auditLogRequired !== "boolean") {
      pushIssue(issues, "error", "install-audit-boolean", "install.auditLogRequired", "Install auditLogRequired must be boolean.");
    }
    if (Array.isArray(candidate.install.expectedArtifacts)) {
      candidate.install.expectedArtifacts.forEach((artifactType, artifactIndex) => {
        validateEnum(issues, artifactType, artifactTypes, `install.expectedArtifacts[${artifactIndex}]`);
      });
    } else {
      pushIssue(issues, "error", "install-artifacts-array", "install.expectedArtifacts", "Install expectedArtifacts must be an array.");
    }
    if (candidate.install.mode === "detect-existing-or-install" && !candidate.install.preservesExistingUserConfig) {
      pushIssue(
        issues,
        "error",
        "install-must-preserve-existing-config",
        "install.preservesExistingUserConfig",
        "Installers that detect existing local software must preserve existing user configuration.",
      );
    }
    if (candidate.install.mode === "detect-existing-or-install" && candidate.install.requiresHumanApprovalBeforeInstall !== true) {
      pushIssue(
        issues,
        "error",
        "install-requires-human-approval",
        "install.requiresHumanApprovalBeforeInstall",
        "Host-mediated installation of external software requires human approval.",
      );
    }
  }

  if (isRecord(candidate.audit)) {
    validateRequiredToolReference(issues, candidate.audit.tool, "audit.tool", declaredToolNames);
    validateStringArray(issues, candidate.audit.checks, "audit.checks");
    validateCapabilityReferences(
      issues,
      candidate.audit.requiredCapabilities,
      "audit.requiredCapabilities",
      requestedCapabilitySet,
      "audit-unrequested-capability",
      "Audit contracts may only require capabilities requested by the manifest.",
    );
    validateEnum(issues, candidate.audit.remediationPolicy, auditRemediationPolicies, "audit.remediationPolicy");
    if (typeof candidate.audit.auditLogRequired !== "boolean") {
      pushIssue(issues, "error", "audit-log-boolean", "audit.auditLogRequired", "Audit auditLogRequired must be boolean.");
    }
  }

  if (isRecord(candidate.embeddedWorkspace)) {
    const embeddedWorkspace = candidate.embeddedWorkspace;
    validateStringValue(issues, candidate.embeddedWorkspace.surfaceId, "embeddedWorkspace.surfaceId");
    if (
      isString(embeddedWorkspace.surfaceId) &&
      Array.isArray(candidate.surfaces) &&
      !candidate.surfaces.some((surface) => isRecord(surface) && surface.id === embeddedWorkspace.surfaceId)
    ) {
      pushIssue(
        issues,
        "error",
        "embedded-workspace-unknown-surface",
        "embeddedWorkspace.surfaceId",
        "Embedded workspace contracts must reference a declared surface.",
      );
    }
    validateEnum(issues, candidate.embeddedWorkspace.mode, embeddedWorkspaceModes, "embeddedWorkspace.mode");
    validateEnum(issues, candidate.embeddedWorkspace.settingsVisibility, settingsVisibilityModes, "embeddedWorkspace.settingsVisibility");
    validateToolReference(issues, candidate.embeddedWorkspace.healthTool, "embeddedWorkspace.healthTool", declaredToolNames);
    validateCapabilityReferences(
      issues,
      candidate.embeddedWorkspace.requiredCapabilities,
      "embeddedWorkspace.requiredCapabilities",
      requestedCapabilitySet,
      "embedded-workspace-unrequested-capability",
      "Embedded workspace contracts may only require capabilities requested by the manifest.",
    );
    if (typeof candidate.embeddedWorkspace.autoStart !== "boolean") {
      pushIssue(issues, "error", "embedded-workspace-autostart-boolean", "embeddedWorkspace.autoStart", "autoStart must be boolean.");
    }
  }

  if (isRecord(candidate.memoryAccess)) {
    validateEnum(issues, candidate.memoryAccess.archiveReadMode, archiveReadModes, "memoryAccess.archiveReadMode");
    validateEnum(issues, candidate.memoryAccess.archiveWriteMode, archiveWriteModes, "memoryAccess.archiveWriteMode");
    if (typeof candidate.memoryAccess.citationRequired !== "boolean") {
      pushIssue(issues, "error", "memory-access-citation-boolean", "memoryAccess.citationRequired", "citationRequired must be boolean.");
    }
    if (candidate.memoryAccess.directKnowledgeWriteAllowed !== false) {
      pushIssue(
        issues,
        "error",
        "memory-access-knowledge-write-forbidden",
        "memoryAccess.directKnowledgeWriteAllowed",
        "Add-on memory contracts must explicitly keep trusted knowledge writes disabled.",
      );
    }
    if (candidate.memoryAccess.archiveReadMode !== "none" && !requestedCapabilitySet.has("archive-read")) {
      pushIssue(
        issues,
        "error",
        "memory-access-read-requires-capability",
        "requestedCapabilities",
        "Memory read contracts require archive-read.",
      );
    }
    if (candidate.memoryAccess.archiveWriteMode === "intake-only" && !requestedCapabilitySet.has("archive-intake-write")) {
      pushIssue(
        issues,
        "error",
        "memory-access-intake-requires-capability",
        "requestedCapabilities",
        "Memory intake contracts require archive-intake-write.",
      );
    }
  }

  if (isRecord(candidate.agentRuntime)) {
    validateRequiredToolReference(issues, candidate.agentRuntime.invocationTool, "agentRuntime.invocationTool", declaredToolNames);
    validateStringValue(issues, candidate.agentRuntime.chatAuthorLabel, "agentRuntime.chatAuthorLabel");
    validateEnum(issues, candidate.agentRuntime.displayNameSource, ["manifest", "runtime-profile"] as const, "agentRuntime.displayNameSource");
    validateEnum(issues, candidate.agentRuntime.outputFiltering, outputFilteringModes, "agentRuntime.outputFiltering");
    validateCapabilityReferences(
      issues,
      candidate.agentRuntime.requiredCapabilities,
      "agentRuntime.requiredCapabilities",
      requestedCapabilitySet,
      "agent-runtime-unrequested-capability",
      "Agent runtime contracts may only require capabilities requested by the manifest.",
    );
    for (const booleanField of ["supportsStreaming", "supportsCancellation", "supportsModelSelection"] as const) {
      if (typeof candidate.agentRuntime[booleanField] !== "boolean") {
        pushIssue(issues, "error", "agent-runtime-boolean", `agentRuntime.${booleanField}`, `${booleanField} must be boolean.`);
      }
    }
    if (candidate.agentRuntime.supportsModelSelection && !isRecord(candidate.agentRuntime.modelSelection)) {
      pushIssue(
        issues,
        "error",
        "agent-runtime-model-selection-required",
        "agentRuntime.modelSelection",
        "Agent runtimes that support model selection must declare modelSelection.",
      );
    }
    if (isRecord(candidate.agentRuntime.modelSelection)) {
      validateEnum(issues, candidate.agentRuntime.modelSelection.source, modelMetadataSources, "agentRuntime.modelSelection.source");
      validateStringValue(issues, candidate.agentRuntime.modelSelection.currentModelField, "agentRuntime.modelSelection.currentModelField");
      validateToolReference(issues, candidate.agentRuntime.modelSelection.changeTool, "agentRuntime.modelSelection.changeTool", declaredToolNames);
      if (typeof candidate.agentRuntime.modelSelection.selectable !== "boolean") {
        pushIssue(issues, "error", "model-selection-selectable-boolean", "agentRuntime.modelSelection.selectable", "selectable must be boolean.");
      }
      validateCapabilityReferences(
        issues,
        candidate.agentRuntime.modelSelection.requiredCapabilities,
        "agentRuntime.modelSelection.requiredCapabilities",
        requestedCapabilitySet,
        "model-selection-unrequested-capability",
        "Model selection contracts may only require capabilities requested by the manifest.",
      );
    }
    if (candidate.agentRuntime.outputFiltering === "raw-log") {
      pushIssue(
        issues,
        "warning",
        "agent-runtime-raw-log-output",
        "agentRuntime.outputFiltering",
        "Agent chat integrations should normally filter terminal/TUI output and return assistant-visible reply text.",
      );
    }
  }

  if (Array.isArray(candidate.smokeTests)) {
    candidate.smokeTests.forEach((smokeTest, index) => {
      const path = `smokeTests[${index}]`;
      if (!isRecord(smokeTest)) {
        pushIssue(issues, "error", "smoke-test-object", path, "Smoke test must be an object.");
        return;
      }
      validateStringValue(issues, smokeTest.id, `${path}.id`);
      validateRequiredToolReference(issues, smokeTest.tool, `${path}.tool`, declaredToolNames);
      if (!isRecord(smokeTest.input)) {
        pushIssue(issues, "error", "smoke-test-input-object", `${path}.input`, "Smoke test input must be an object.");
      }
      validateStringValue(issues, smokeTest.expectedOutputPattern, `${path}.expectedOutputPattern`);
      if (typeof smokeTest.timeoutMs !== "number" || smokeTest.timeoutMs <= 0) {
        pushIssue(issues, "error", "smoke-test-timeout", `${path}.timeoutMs`, "Smoke test timeoutMs must be a positive number.");
      }
      validateCapabilityReferences(
        issues,
        smokeTest.requiredCapabilities,
        `${path}.requiredCapabilities`,
        requestedCapabilitySet,
        "smoke-test-unrequested-capability",
        "Smoke tests may only require capabilities requested by the manifest.",
      );
    });
  }

  // systemSlots coverage (P1-b). systemSlots is inside the manifest type but was
  // never validated, so a manifest could claim an active-provider slot (e.g.
  // primary-agent) that bypassed manifest capability validation. A slot claim is
  // only accepted when it uses a known SystemSlotId AND declares the slot's
  // backing capability in requestedCapabilities (so the runtime grant gate can
  // apply). Mirrors the block rule in
  // .craft/.../checks/containment/addon-provenance.mjs.
  if (candidate.systemSlots !== undefined) {
    if (!Array.isArray(candidate.systemSlots)) {
      pushIssue(issues, "error", "system-slots-array", "systemSlots", "systemSlots must be an array when present.");
    } else {
      candidate.systemSlots.forEach((slot, index) => {
        const path = `systemSlots[${index}]`;
        if (!isRecord(slot)) {
          pushIssue(issues, "error", "system-slot-object", path, "Each systemSlots entry must be an object.");
          return;
        }
        if (!isString(slot.id) || !systemSlotIds.includes(slot.id as SystemSlotId)) {
          pushIssue(
            issues,
            "error",
            "system-slot-unknown",
            `${path}.id`,
            `systemSlots id must be a known SystemSlotId (${systemSlotIds.join(", ")}).`,
          );
          return;
        }
        const backingCapability = slotBackingCapability[slot.id as SystemSlotId];
        if (!requestedCapabilitySet.has(backingCapability)) {
          pushIssue(
            issues,
            "error",
            "system-slot-undeclared-capability",
            `${path}.id`,
            `System slot "${slot.id}" requires capability "${backingCapability}" to be declared in requestedCapabilities so the runtime grant gate can apply; without it the slot claim bypasses manifest capability validation.`,
          );
        }
      });
    }
  }

  if (source === "sideload" && isRecord(candidate.provenance) && candidate.provenance.tier !== "sideloaded-unverified") {
    pushIssue(
      issues,
      "warning",
      "sideload-provenance-overridden",
      "provenance.tier",
      "Sideloaded add-ons are treated as sideloaded-unverified until host verification succeeds.",
    );
  }

  return {
    valid: issues.every((issue) => issue.severity !== "error"),
    manifestId,
    issues,
  };
};

export const assertValidAddOnManifest = (
  candidate: unknown,
  options: { source?: AddOnManifestSource; label?: string } = {},
): AddOnManifest => {
  const result = validateAddOnManifest(candidate, options);
  if (!result.valid) {
    const label = options.label ?? result.manifestId ?? "add-on manifest";
    const details = result.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${label}: ${details}`);
  }
  return candidate as AddOnManifest;
};
