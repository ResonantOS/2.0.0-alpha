// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md

import type {
  AddOnHookDefinition,
  AddOnInstallation,
  AddOnManifest,
  AddOnScriptDefinition,
  Capability,
  EvidenceTrustTier,
  LogicianExecutionArtifact,
  LogicianExecutionStatus,
  LogicianEvidenceItem,
  VerifyAgentFinding,
  VerifyAgentReport,
} from "./contracts";
import {
  requestArchiveRuntimeStatus,
  requestBrowserEngineStatus,
  requestHermesStatus,
  requestObsidianVaultIndex,
  requestOpenCodeStatus,
  requestPaperclipStatus,
  requestProviderDiagnostics,
  requestTelegramServiceStatus,
} from "./runtime";

type ExecuteCommandInput = {
  manifest: AddOnManifest;
  installation: AddOnInstallation;
  script: AddOnScriptDefinition;
  humanInitiated: boolean;
};

type CommandExecution = {
  status: LogicianExecutionStatus;
  summary: string;
  detail: string;
  evidence: Record<string, unknown>;
};

export type LogicianActivationStatus = "active" | "blocked";

export type LogicianActivationIssueCode =
  | "addon-id-mismatch"
  | "addon-not-installed"
  | "addon-not-enabled"
  | "handler-not-found"
  | "hook-missing-capability"
  | "script-missing-capability"
  | "unattended-human-approval";

export type LogicianActivationIssue = {
  code: LogicianActivationIssueCode;
  message: string;
  capabilities?: Capability[];
};

export type LogicianHookActivation = {
  status: LogicianActivationStatus;
  addonId: string;
  hookId: string;
  scriptId?: string;
  requiredCapabilities: Capability[];
  missingCapabilities: Capability[];
  issues: LogicianActivationIssue[];
};

const hasGrantedCapability = (installation: AddOnInstallation, capability: Capability): boolean =>
  installation.grantedCapabilities.some((grant) => grant.capability === capability && grant.granted);

export const missingLogicianCapabilities = (
  installation: AddOnInstallation,
  requiredCapabilities: Capability[],
): Capability[] => requiredCapabilities.filter((capability) => !hasGrantedCapability(installation, capability));

const uniqueCapabilities = (capabilities: Capability[]): Capability[] => [...new Set(capabilities)];
const evidenceTrustTiers: EvidenceTrustTier[] = ["observed", "host-reported", "self-reported", "transcript-claim", "unknown"];

const evidenceItem = (
  id: string,
  label: string,
  kind: LogicianEvidenceItem["kind"],
  trustTier: EvidenceTrustTier,
  source: string,
  detail?: string,
): LogicianEvidenceItem => ({
  id,
  label,
  kind,
  trustTier,
  source,
  detail,
});

const finding = (
  code: string,
  severity: VerifyAgentFinding["severity"],
  message: string,
  evidenceRefs: string[],
): VerifyAgentFinding => ({
  code,
  severity,
  message,
  evidenceRefs,
});

export const assessLogicianHookActivation = (input: {
  manifest: AddOnManifest;
  installation: AddOnInstallation;
  hook: AddOnHookDefinition;
  humanInitiated: boolean;
}): LogicianHookActivation => {
  const script = input.manifest.scripts?.find((candidate) => candidate.id === input.hook.handlerRef);
  const hookMissingCapabilities = missingLogicianCapabilities(input.installation, input.hook.requiredCapabilities);
  const scriptMissingCapabilities = script ? missingLogicianCapabilities(input.installation, script.requiredCapabilities) : [];
  const requiredCapabilities = uniqueCapabilities([
    ...input.hook.requiredCapabilities,
    ...(script?.requiredCapabilities ?? []),
  ]);
  const missingCapabilities = uniqueCapabilities([...hookMissingCapabilities, ...scriptMissingCapabilities]);
  const issues: LogicianActivationIssue[] = [];

  if (input.installation.addonId !== input.manifest.id) {
    issues.push({
      code: "addon-id-mismatch",
      message: `Installation ${input.installation.addonId} cannot activate hooks for ${input.manifest.id}.`,
    });
  }
  if (!input.installation.installed) {
    issues.push({ code: "addon-not-installed", message: "Add-on must be installed before hooks can activate." });
  }
  if (!input.installation.enabled) {
    issues.push({ code: "addon-not-enabled", message: "Add-on must be enabled before hooks can activate." });
  }
  if (!script) {
    issues.push({
      code: "handler-not-found",
      message: `Hook handler ${input.hook.handlerRef} is not declared by ${input.manifest.id}.`,
    });
  }
  if (hookMissingCapabilities.length > 0) {
    issues.push({
      code: "hook-missing-capability",
      message: `Missing hook capability grants: ${hookMissingCapabilities.join(", ")}.`,
      capabilities: hookMissingCapabilities,
    });
  }
  if (scriptMissingCapabilities.length > 0) {
    issues.push({
      code: "script-missing-capability",
      message: `Missing handler script capability grants: ${scriptMissingCapabilities.join(", ")}.`,
      capabilities: scriptMissingCapabilities,
    });
  }
  if (script?.requiresHumanApproval && !input.humanInitiated) {
    issues.push({
      code: "unattended-human-approval",
      message: "Hook handler requires human approval and cannot activate unattended.",
    });
  }

  return {
    status: issues.length ? "blocked" : "active",
    addonId: input.manifest.id,
    hookId: input.hook.id,
    scriptId: script?.id,
    requiredCapabilities,
    missingCapabilities,
    issues,
  };
};

const artifactId = (addonId: string, targetId: string): string =>
  `logician-${addonId.replaceAll(".", "-")}-${targetId}-${Date.now()}`;

const summarizeProviderDiagnostics = async (): Promise<CommandExecution> => {
  const reports = await requestProviderDiagnostics();
  const healthy = reports.filter((report) => report.status === "healthy");
  const attention = reports.filter((report) => report.status === "attention");
  const status: LogicianExecutionStatus = healthy.length ? "passed" : attention.length ? "degraded" : "failed";
  return {
    status,
    summary: healthy.length
      ? `${healthy.length} provider route(s) healthy.`
      : attention.length
        ? `${attention.length} provider route(s) need attention but may be recoverable.`
        : "No viable provider route was found.",
    detail: reports.map((report) => `${report.providerLabel}: ${report.summary}`).join("\n") || "No provider diagnostics returned.",
    evidence: { reports },
  };
};

const executeManifestOnlyCheck = (input: ExecuteCommandInput): CommandExecution => {
  const missingSkillDocuments = [
    ...(input.manifest.skills ?? []).filter((skill) => !skill.documentPath).map((skill) => skill.id),
    ...(input.manifest.augmentorSkills ?? [])
      .filter((skill) => !skill.documentPath)
      .map((skill) => skill.objective),
    input.manifest.engineerSetup && !input.manifest.engineerSetup.documentPath ? "engineerSetup" : undefined,
  ].filter((documentPath): documentPath is string => Boolean(documentPath));
  return {
    status: missingSkillDocuments.length ? "failed" : "passed",
    summary: missingSkillDocuments.length
      ? "Manifest check failed because one or more scaffold documents are missing."
      : "Manifest-level deterministic check passed.",
    detail:
      missingSkillDocuments.length > 0
        ? `Missing document references: ${missingSkillDocuments.join(", ")}`
        : "The manifest declares bounded workflow scaffold metadata and does not require an external executable for this V1 check.",
    evidence: {
      addonId: input.manifest.id,
      commandRef: input.script.commandRef,
      workflowBoundaries: input.manifest.workflowBoundaries?.length ?? 0,
      skills: (input.manifest.skills?.length ?? 0) + (input.manifest.augmentorSkills?.length ?? 0),
      connectors: input.manifest.connectors?.length ?? 0,
      scripts: input.manifest.scripts?.length ?? 0,
      hooks: input.manifest.hooks?.length ?? 0,
    },
  };
};

const executeCommandRef = async (input: ExecuteCommandInput): Promise<CommandExecution> => {
  switch (input.script.commandRef) {
    case "provider.route.preflight":
      return summarizeProviderDiagnostics();
    case "archive_runtime_status": {
      const status = await requestArchiveRuntimeStatus();
      return {
        status: status.status === "ready" ? "passed" : status.status === "attention" ? "degraded" : "failed",
        summary: `Living Archive runtime is ${status.status}.`,
        detail: `Managed root: ${status.managedRoot}\nWiki root: ${status.wikiRoot}\nIntake root: ${status.intakeRoot}`,
        evidence: { status },
      };
    }
    case "browser.health": {
      const status = await requestBrowserEngineStatus();
      return {
        status: status.installed ? "passed" : "failed",
        summary: status.installed ? "Browser engine is installed." : "Browser engine is not installed.",
        detail: status.enginePath ?? status.installHint,
        evidence: { status },
      };
    }
    case "hermes.audit": {
      const profileHome = typeof input.installation.config?.profileHome === "string" ? input.installation.config.profileHome : undefined;
      const status = await requestHermesStatus({ profileHome, executable: true });
      return {
        status: status.compatibility === "ready" ? "passed" : status.compatibility === "degraded" ? "degraded" : "failed",
        summary: `Hermes compatibility is ${status.compatibility}.`,
        detail: status.findings.map((finding) => `${finding.severity}: ${finding.title}`).join("\n") || "No findings returned.",
        evidence: { status },
      };
    }
    case "obsidian.vault_index": {
      const vaultPath = typeof input.installation.config?.vaultPath === "string" ? input.installation.config.vaultPath : "";
      if (!vaultPath) {
        return {
          status: "blocked",
          summary: "Vault path is not configured.",
          detail: "Select a vault path in the Resonant Notes add-on settings before running this check.",
          evidence: {},
        };
      }
      const index = await requestObsidianVaultIndex(vaultPath, "", 25);
      return {
        status: "passed",
        summary: `Indexed ${index.notes.length} markdown note(s).`,
        detail: `Vault: ${vaultPath}`,
        evidence: { noteCount: index.notes.length, sampleNotes: index.notes.slice(0, 10) },
      };
    }
    case "opencode.launch_workspace": {
      const status = await requestOpenCodeStatus();
      return {
        status: status.installed ? "passed" : "failed",
        summary: status.installed ? "OpenCode is installed." : "OpenCode is not installed.",
        detail: status.binaryPath ?? status.installHint,
        evidence: { status },
      };
    }
    case "paperclip.status": {
      const endpoint = typeof input.installation.config?.endpoint === "string" ? input.installation.config.endpoint : undefined;
      const status = await requestPaperclipStatus(endpoint);
      return {
        status: status.endpointReachable ? "passed" : status.installed ? "degraded" : "failed",
        summary: status.endpointReachable ? "Paperclip endpoint is reachable." : "Paperclip endpoint is not reachable.",
        detail: `${status.endpoint}\n${status.installHint}`,
        evidence: { status },
      };
    }
    case "telegram_service_status": {
      const channelId = typeof input.installation.config?.channelId === "string" ? input.installation.config.channelId : undefined;
      const status = await requestTelegramServiceStatus(channelId);
      return {
        status: status.tokenConfigured ? "passed" : "blocked",
        summary: status.tokenConfigured ? "Telegram bot token is configured." : "Telegram bot token is missing.",
        detail: status.running ? "Telegram listener is running." : "Telegram listener is not running yet.",
        evidence: { status },
      };
    }
    case "logician.policy_check":
    case "openclaw.gateway_preflight":
    case "r-awareness.context_pack_check":
    case "shield.guard_preflight":
    case "terminal.run_command":
      return executeManifestOnlyCheck(input);
    default:
      return {
        status: "unsupported",
        summary: `Unsupported Logician commandRef: ${input.script.commandRef}`,
        detail: "The commandRef is not in the V1 Logician host-mediated allowlist.",
        evidence: { commandRef: input.script.commandRef },
      };
  }
};

export const buildVerifyAgentReport = (input: {
  manifest: AddOnManifest;
  installation: AddOnInstallation;
  script: AddOnScriptDefinition;
  execution: CommandExecution;
  missingCapabilities: Capability[];
  activation?: LogicianHookActivation;
}): VerifyAgentReport => {
  const evidence: LogicianEvidenceItem[] = [
    evidenceItem(
      "manifest",
      `${input.manifest.name} manifest`,
      "manifest",
      "observed",
      "bundled-or-sideloaded-manifest",
      `${input.manifest.id} · ${input.manifest.runtimeType}`,
    ),
    evidenceItem(
      "installation",
      "Installation state",
      "installation",
      "observed",
      "runtime-state",
      `${input.installation.installed ? "installed" : "not installed"} · ${
        input.installation.enabled ? "enabled" : "disabled"
      }`,
    ),
    evidenceItem(
      `script:${input.script.id}`,
      input.script.name,
      "policy",
      "observed",
      "manifest.script",
      `${input.script.commandRef} · ${input.script.runPolicy}`,
    ),
  ];

  for (const capability of input.script.requiredCapabilities) {
    const granted = hasGrantedCapability(input.installation, capability);
    evidence.push(
      evidenceItem(
        `capability:${capability}`,
        `${capability} ${granted ? "granted" : "missing"}`,
        "capability",
        "observed",
        "runtime-state.grantedCapabilities",
      ),
    );
  }
  for (const artifact of input.script.producesArtifacts) {
    evidence.push(
      evidenceItem(
        `artifact:${artifact}`,
        artifact,
        "artifact",
        "self-reported",
        "manifest.script.producesArtifacts",
        "Declared output contract; not proof that the artifact was produced.",
      ),
    );
  }
  if (input.activation) {
    evidence.push(
      evidenceItem(
        `hook:${input.activation.hookId}`,
        input.activation.hookId,
        "hook",
        "observed",
        "logician.activation-policy",
        `${input.activation.status} · ${input.activation.requiredCapabilities.join(", ") || "no capabilities"}`,
      ),
    );
  }
  if (Object.keys(input.execution.evidence).length > 0) {
    evidence.push(
      evidenceItem(
        "command:evidence",
        `${input.script.commandRef} result evidence`,
        "runtime",
        "host-reported",
        "host-mediated-command",
        "Returned by an allowlisted Logician commandRef.",
      ),
    );
  }

  const findings: VerifyAgentFinding[] = [];
  if (input.installation.addonId !== input.manifest.id) {
    findings.push(
      finding(
        "addon-id-mismatch",
        "high",
        `Installation ${input.installation.addonId} cannot verify ${input.manifest.id}.`,
        ["installation", "manifest"],
      ),
    );
  }
  if (!input.installation.installed) {
    findings.push(finding("addon-not-installed", "high", "Add-on is not installed.", ["installation"]));
  }
  if (!input.installation.enabled) {
    findings.push(finding("addon-not-enabled", "high", "Add-on is not enabled.", ["installation"]));
  }
  if (input.missingCapabilities.length > 0) {
    findings.push(
      finding(
        "missing-capability-grants",
        "high",
        `Missing required grants: ${input.missingCapabilities.join(", ")}.`,
        input.missingCapabilities.map((capability) => `capability:${capability}`),
      ),
    );
  }
  if (!input.script.deterministic) {
    findings.push(
      finding("script-not-deterministic", "medium", "Logician scripts must be deterministic.", [`script:${input.script.id}`]),
    );
  }
  if (!input.script.producesArtifacts.includes("verification-report")) {
    findings.push(
      finding(
        "verification-report-not-declared",
        "medium",
        "Script does not declare a verification-report artifact.",
        [`script:${input.script.id}`],
      ),
    );
  }
  if (input.manifest.delegation?.acceptsTasks && !input.manifest.delegation.artifactReturnTypes.includes("verification-report")) {
    findings.push(
      finding(
        "delegation-verification-artifact-missing",
        "medium",
        "Delegated agent/tool add-ons must return a verification-report before completion.",
        ["manifest"],
      ),
    );
  }
  if (input.manifest.archiveIntegration.canWriteKnowledgePages) {
    findings.push(
      finding(
        "trusted-archive-write-authority",
        "high",
        "Add-ons must not write trusted Living Archive knowledge pages directly.",
        ["manifest"],
      ),
    );
  }
  if (input.execution.status === "unsupported") {
    findings.push(
      finding(
        "unsupported-command-ref",
        "high",
        `${input.script.commandRef} is not in the Logician allowlist.`,
        [`script:${input.script.id}`],
      ),
    );
  }
  if (input.execution.status === "failed") {
    findings.push(
      finding("command-failed", "high", input.execution.summary, ["command:evidence", `script:${input.script.id}`]),
    );
  }
  if (input.execution.status === "degraded") {
    findings.push(finding("command-degraded", "medium", input.execution.summary, ["command:evidence"]));
  }
  if (input.execution.status === "blocked") {
    findings.push(finding("command-blocked", "high", input.execution.summary, ["installation", `script:${input.script.id}`]));
  }

  const evidenceTrustCounts = evidenceTrustTiers.reduce<Record<EvidenceTrustTier, number>>(
    (counts, tier) => ({ ...counts, [tier]: evidence.filter((item) => item.trustTier === tier).length }),
    {
      observed: 0,
      "host-reported": 0,
      "self-reported": 0,
      "transcript-claim": 0,
      unknown: 0,
    },
  );
  const status = findings.some((item) => item.severity === "high")
    ? "fail"
    : findings.length > 0 || input.execution.status === "degraded"
      ? "warn"
      : "pass";
  const firstFinding = findings[0];
  const nextAction =
    status === "pass"
      ? "Proceed; keep the verification artifact attached to the run."
      : firstFinding
        ? firstFinding.message
        : "Review Logician output before continuing.";

  return {
    schemaVersion: "verify-agent-report/vnext-1",
    status,
    nextAction,
    evidenceTrustCounts,
    evidence,
    findings,
  };
};

export const executeLogicianScript = async (input: ExecuteCommandInput): Promise<LogicianExecutionArtifact> => {
  const startedAt = new Date();
  const missingCapabilities = missingLogicianCapabilities(input.installation, input.script.requiredCapabilities);
  let execution: CommandExecution;

  if (input.installation.addonId !== input.manifest.id) {
    execution = {
      status: "blocked",
      summary: "Installation does not match manifest.",
      detail: `Installation ${input.installation.addonId} cannot execute checks for ${input.manifest.id}.`,
      evidence: { manifestId: input.manifest.id, installationAddonId: input.installation.addonId },
    };
  } else if (!input.installation.installed) {
    execution = {
      status: "blocked",
      summary: "Add-on is not installed.",
      detail: "Install the add-on before running Logician checks.",
      evidence: {},
    };
  } else if (!input.installation.enabled) {
    execution = {
      status: "blocked",
      summary: "Add-on is not enabled.",
      detail: "Install and enable the add-on before running Logician checks.",
      evidence: {},
    };
  } else if (missingCapabilities.length > 0) {
    execution = {
      status: "blocked",
      summary: "Required capability grants are missing.",
      detail: `Missing: ${missingCapabilities.join(", ")}`,
      evidence: { missingCapabilities },
    };
  } else if (input.script.requiresHumanApproval && !input.humanInitiated) {
    execution = {
      status: "blocked",
      summary: "Human approval is required.",
      detail: "This script may only run from a human-initiated action or a future explicit approval flow.",
      evidence: {},
    };
  } else {
    try {
      execution = await executeCommandRef(input);
    } catch (error) {
      execution = {
        status: "failed",
        summary: "Logician command failed.",
        detail: error instanceof Error ? error.message : String(error),
        evidence: {},
      };
    }
  }

  const completedAt = new Date();
  const verifyAgentReport = buildVerifyAgentReport({
    manifest: input.manifest,
    installation: input.installation,
    script: input.script,
    execution,
    missingCapabilities,
  });
  return {
    id: artifactId(input.manifest.id, input.script.id),
    addonId: input.manifest.id,
    kind: "script",
    targetId: input.script.id,
    label: input.script.name,
    commandRef: input.script.commandRef,
    status: execution.status,
    summary: execution.summary,
    detail: execution.detail,
    requiredCapabilities: input.script.requiredCapabilities,
    missingCapabilities,
    producedArtifacts: input.script.producesArtifacts,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    evidence: { ...execution.evidence, verifyAgentReport },
    verifyAgentReport,
  };
};

export const executeLogicianHook = async (input: {
  manifest: AddOnManifest;
  installation: AddOnInstallation;
  hook: AddOnHookDefinition;
  humanInitiated: boolean;
}): Promise<LogicianExecutionArtifact> => {
  const activation = assessLogicianHookActivation(input);
  if (activation.status === "blocked") {
    const now = new Date().toISOString();
    return {
      id: artifactId(input.manifest.id, input.hook.id),
      addonId: input.manifest.id,
      kind: "hook",
      targetId: input.hook.id,
      label: input.hook.event,
      commandRef: input.hook.handlerRef,
      status: "blocked",
      summary: "Hook activation policy blocked execution.",
      detail: activation.issues.map((issue) => issue.message).join("\n"),
      requiredCapabilities: activation.requiredCapabilities,
      missingCapabilities: activation.missingCapabilities,
      producedArtifacts: [],
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      evidence: { hook: input.hook, activation },
    };
  }

  const script = input.manifest.scripts?.find((candidate) => candidate.id === input.hook.handlerRef);
  if (!script) {
    const now = new Date().toISOString();
    return {
      id: artifactId(input.manifest.id, input.hook.id),
      addonId: input.manifest.id,
      kind: "hook",
      targetId: input.hook.id,
      label: input.hook.event,
      commandRef: input.hook.handlerRef,
      status: "blocked",
      summary: "Hook handler was not found.",
      detail: `No script with id ${input.hook.handlerRef} is declared by ${input.manifest.id}.`,
      requiredCapabilities: input.hook.requiredCapabilities,
      missingCapabilities: [],
      producedArtifacts: [],
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      evidence: { hook: input.hook },
    };
  }

  const artifact = await executeLogicianScript({
    manifest: input.manifest,
    installation: input.installation,
    script,
    humanInitiated: input.humanInitiated,
  });
  const verifyAgentReport = buildVerifyAgentReport({
    manifest: input.manifest,
    installation: input.installation,
    script,
    execution: {
      status: artifact.status,
      summary: artifact.summary,
      detail: artifact.detail,
      evidence: artifact.evidence,
    },
    missingCapabilities: activation.missingCapabilities,
    activation,
  });
  return {
    ...artifact,
    kind: "hook",
    targetId: input.hook.id,
    label: input.hook.event,
    commandRef: input.hook.handlerRef,
    requiredCapabilities: activation.requiredCapabilities,
    missingCapabilities: artifact.missingCapabilities,
    evidence: { ...artifact.evidence, activation, verifyAgentReport },
    verifyAgentReport,
  };
};
