import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AddOnInstallation, AddOnManifest, AddOnScriptDefinition, CapabilityGrant } from "./contracts";
import {
  assessLogicianHookActivation,
  buildVerifyAgentReport,
  executeLogicianHook,
  executeLogicianScript,
  missingLogicianCapabilities,
} from "./logician";

const grant = (capability: CapabilityGrant["capability"], granted = true): CapabilityGrant => ({
  capability,
  granted,
  scope: "shared",
  revocationBehavior: "hard-stop",
});

const manifest = (): AddOnManifest => ({
  id: "addon.logician-test",
  name: "Logician Test",
  version: "0.1.0",
  author: "test",
  category: "tool",
  description: "test",
  runtimeType: "local-service",
  surfaces: [],
  requestedCapabilities: [grant("filesystem"), grant("archive-read")],
  providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
  archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
  health: { strategy: "test" },
  installHooks: {},
  workflowBoundaries: [
    {
      id: "test-boundary",
      label: "Test boundary",
      jobToBeDone: "Test deterministic checks.",
      userValue: "Tests remain bounded.",
      repeatability: "workflow-package",
      owner: "engineer",
      nonGoals: [],
    },
  ],
  scripts: [
    {
      id: "manifest-check",
      name: "Manifest check",
      description: "Check manifest scaffold.",
      commandRef: "logician.policy_check",
      runPolicy: "preflight",
      deterministic: true,
      requiredCapabilities: ["filesystem", "archive-read"],
      producesArtifacts: ["verification-report"],
      requiresHumanApproval: false,
    },
  ],
  hooks: [
    {
      id: "before-complete",
      event: "before-task-complete",
      handlerRef: "manifest-check",
      requiredCapabilities: ["filesystem"],
      failurePolicy: "block",
    },
  ],
  compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
});

const installation = (granted = true): AddOnInstallation => ({
  addonId: "addon.logician-test",
  source: "bundled",
  provenanceTier: "curated-signed",
  verificationState: "verified",
  installed: true,
  enabled: true,
  status: "enabled",
  grantedCapabilities: [grant("filesystem", granted), grant("archive-read", granted)],
  recommendedGrantPresetIds: [],
  privateProviderProfileIds: [],
  notes: [],
});

const installationForManifest = (addonManifest: AddOnManifest): AddOnInstallation => ({
  addonId: addonManifest.id,
  source: "bundled",
  provenanceTier: "curated-signed",
  verificationState: "verified",
  installed: true,
  enabled: true,
  status: "enabled",
  grantedCapabilities: addonManifest.requestedCapabilities.map((item) => ({ ...item, granted: true })),
  recommendedGrantPresetIds: [],
  privateProviderProfileIds: [],
  notes: [],
});

const publicManifest = (file: string): AddOnManifest =>
  JSON.parse(readFileSync(resolve(process.cwd(), "public", "addons", file), "utf8")) as AddOnManifest;

const paperclipDelegationFixture = (): AddOnManifest => ({
  sdkVersion: "0.1.0",
  id: "addon.paperclip",
  name: "Paperclip",
  version: "0.1.0",
  author: "ResonantOS test fixture",
  category: "orchestration",
  description: "Portable Paperclip delegation contract fixture. The development manifest is intentionally ignored.",
  runtimeType: "local-service",
  requestedCapabilities: [],
  surfaces: [],
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
    strategy: "manual",
  },
  installHooks: {},
  compatibility: {
    shellVersion: ">=0.1.0",
    platforms: ["darwin", "linux", "win32"],
  },
  delegation: {
    acceptsTasks: true,
    taskTypes: ["routine-work", "system-diagnosis"],
    artifactReturnTypes: ["summary", "diagnostic-report", "verification-report"],
    defaultTargetRuntime: "local-service",
    requiresHumanApprovalBeforeExecution: true,
  },
  scripts: [
    {
      id: "paperclip-delegation-preflight",
      name: "Paperclip delegation preflight",
      description: "Validate Paperclip task handoff requirements.",
      commandRef: "paperclip.status",
      runPolicy: "preflight",
      deterministic: true,
      requiredCapabilities: [],
      requiresHumanApproval: false,
      producesArtifacts: ["diagnostic-report", "verification-report"],
    },
  ],
});

describe("Logician execution layer", () => {
  it("detects missing capability grants before execution", () => {
    expect(missingLogicianCapabilities(installation(false), ["filesystem", "archive-read"])).toEqual([
      "filesystem",
      "archive-read",
    ]);
  });

  it("blocks script execution when required grants are missing", async () => {
    const script = manifest().scripts?.[0] as AddOnScriptDefinition;

    const artifact = await executeLogicianScript({
      manifest: manifest(),
      installation: installation(false),
      script,
      humanInitiated: true,
    });

    expect(artifact.status).toBe("blocked");
    expect(artifact.missingCapabilities).toEqual(["filesystem", "archive-read"]);
  });

  it("executes manifest-only checks through the allowlisted Logician path", async () => {
    const script = manifest().scripts?.[0] as AddOnScriptDefinition;

    const artifact = await executeLogicianScript({
      manifest: manifest(),
      installation: installation(true),
      script,
      humanInitiated: true,
    });

    expect(artifact.status).toBe("passed");
    expect(artifact.commandRef).toBe("logician.policy_check");
    expect(artifact.verifyAgentReport?.status).toBe("pass");
    expect(artifact.verifyAgentReport?.evidenceTrustCounts.observed).toBeGreaterThan(0);
  });

  it("attaches a deterministic Verify Agent report to blocked execution artifacts", async () => {
    const script = manifest().scripts?.[0] as AddOnScriptDefinition;

    const artifact = await executeLogicianScript({
      manifest: manifest(),
      installation: installation(false),
      script,
      humanInitiated: true,
    });

    expect(artifact.status).toBe("blocked");
    expect(artifact.verifyAgentReport).toMatchObject({
      schemaVersion: "verify-agent-report/vnext-1",
      status: "fail",
    });
    expect(artifact.verifyAgentReport?.findings.map((item) => item.code)).toContain("missing-capability-grants");
  });

  it("warns when an add-on can delegate work without a verification-report return contract", () => {
    const testManifest = manifest();
    testManifest.delegation = {
      acceptsTasks: true,
      taskTypes: ["routine-work"],
      artifactReturnTypes: ["summary", "log"],
      defaultTargetRuntime: "external-agent",
      requiresHumanApprovalBeforeExecution: true,
      notes: [],
    };
    const script = testManifest.scripts?.[0] as AddOnScriptDefinition;
    const report = buildVerifyAgentReport({
      manifest: testManifest,
      installation: installationForManifest(testManifest),
      script,
      missingCapabilities: [],
      execution: {
        status: "passed",
        summary: "ok",
        detail: "ok",
        evidence: {},
      },
    });

    expect(report.status).toBe("warn");
    expect(report.findings.map((item) => item.code)).toContain("delegation-verification-artifact-missing");
  });

  it("runs hooks by resolving their declared handler script", async () => {
    const hook = manifest().hooks?.[0];
    if (!hook) {
      throw new Error("missing test hook");
    }

    const artifact = await executeLogicianHook({
      manifest: manifest(),
      installation: installation(true),
      hook,
      humanInitiated: true,
    });

    expect(artifact.kind).toBe("hook");
    expect(artifact.targetId).toBe("before-complete");
    expect(artifact.status).toBe("passed");
  });

  it("blocks hooks when hook-level grants are missing", async () => {
    const testManifest = manifest();
    const hook = testManifest.hooks?.[0];
    if (!hook) {
      throw new Error("missing test hook");
    }

    const artifact = await executeLogicianHook({
      manifest: testManifest,
      installation: installation(false),
      hook,
      humanInitiated: true,
    });

    expect(artifact.kind).toBe("hook");
    expect(artifact.status).toBe("blocked");
    expect(artifact.missingCapabilities).toEqual(["filesystem", "archive-read"]);
  });

  it("blocks unattended hooks whose handler script requires human approval", () => {
    const testManifest = manifest();
    const hook = testManifest.hooks?.[0];
    const script = testManifest.scripts?.[0];
    if (!hook || !script) {
      throw new Error("missing test hook");
    }
    script.requiresHumanApproval = true;

    const activation = assessLogicianHookActivation({
      manifest: testManifest,
      installation: installation(true),
      hook,
      humanInitiated: false,
    });

    expect(activation.status).toBe("blocked");
    expect(activation.issues.map((issue) => issue.code)).toContain("unattended-human-approval");
  });

  it("keeps script-level missing grants visible in hook artifacts", async () => {
    const testInstallation = installation(true);
    testInstallation.grantedCapabilities = [grant("filesystem", true), grant("archive-read", false)];
    const hook = manifest().hooks?.[0];
    if (!hook) {
      throw new Error("missing test hook");
    }

    const artifact = await executeLogicianHook({
      manifest: manifest(),
      installation: testInstallation,
      hook,
      humanInitiated: true,
    });

    expect(artifact.status).toBe("blocked");
    expect(artifact.missingCapabilities).toEqual(["archive-read"]);
    expect(artifact.detail).toContain("Missing handler script capability grants: archive-read.");
  });

  it("requires installed and enabled state before hook activation", () => {
    const hook = manifest().hooks?.[0];
    if (!hook) {
      throw new Error("missing test hook");
    }
    const disabledInstallation = { ...installation(true), installed: false, enabled: false };

    const activation = assessLogicianHookActivation({
      manifest: manifest(),
      installation: disabledInstallation,
      hook,
      humanInitiated: true,
    });

    expect(activation.status).toBe("blocked");
    expect(activation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["addon-not-installed", "addon-not-enabled"]),
    );
  });

  it("activates Hermes, OpenCode, and OpenClaw hooks only when their manifest grants are present", () => {
    for (const file of ["hermes.json", "opencode.json", "openclaw.json"]) {
      const addonManifest = publicManifest(file);
      const addonInstallation = installationForManifest(addonManifest);
      const hooks = addonManifest.hooks ?? [];

      expect(hooks.length).toBeGreaterThan(0);
      for (const hook of hooks) {
        const activation = assessLogicianHookActivation({
          manifest: addonManifest,
          installation: addonInstallation,
          hook,
          humanInitiated: false,
        });
        expect({ file, hook: hook.id, activation }).toMatchObject({
          activation: { status: "active", missingCapabilities: [] },
        });
      }
    }
  });

  it("requires Hermes, OpenCode, OpenClaw, and Paperclip delegation contracts to return verification reports", () => {
    const manifests = [
      { file: "hermes.json", addonManifest: publicManifest("hermes.json") },
      { file: "opencode.json", addonManifest: publicManifest("opencode.json") },
      { file: "openclaw.json", addonManifest: publicManifest("openclaw.json") },
      { file: "paperclip.fixture", addonManifest: paperclipDelegationFixture() },
    ];
    for (const { file, addonManifest } of manifests) {
      expect(addonManifest.delegation?.artifactReturnTypes).toContain("verification-report");
      for (const script of addonManifest.scripts ?? []) {
        expect({ file, script: script.id, producesArtifacts: script.producesArtifacts }).toMatchObject({
          producesArtifacts: expect.arrayContaining(["verification-report"]),
        });
      }
    }
  });
});
