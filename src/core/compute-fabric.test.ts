import { describe, expect, it } from "vitest";
import type { ComputeArtifactRecord, ComputeJob, ComputeNode, ResonantShellState } from "./contracts";
import { buildDefaultState } from "./defaults";
import {
  enrollComputeNode,
  isRootContainedArtifactPath,
  quarantineComputeNode,
  revokeComputeNode,
  selectComputeNodeForJob,
  submitComputeJob,
  validateComputeArtifactRecord,
  validateComputeJob,
  validateComputeNode,
} from "./compute-fabric";
import { normalizeState } from "./runtime";

const enrolledContainerNode: ComputeNode = {
  id: "compute-linux-amd64",
  label: "Linux amd64 Runner",
  kind: "ssh-remote",
  trustTier: "user-owned-remote",
  enrollmentState: "enrolled",
  endpoint: "ssh://runner.example",
  identityFingerprint: "SHA256:test-runner",
  supportedTransports: ["ssh"],
  roles: ["safe-command-runner", "container-runner", "cleanroom-runner", "artifact-store", "eval-runner"],
  healthState: "ready",
  probe: {
    os: "linux",
    arch: "amd64",
    ramGb: 64,
    containerRuntimes: ["docker"],
    containerPlatforms: ["linux/amd64"],
  },
};

const stateWithNode = (node: ComputeNode = enrolledContainerNode): ResonantShellState => ({
  ...buildDefaultState([]),
  computeFabric: {
    ...buildDefaultState([]).computeFabric,
    nodes: [node],
  },
});

const baseJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  id: "job-test",
  createdAt: "2026-05-10T00:00:00.000Z",
  createdBy: "strategist.core",
  consumerId: "core.test",
  purpose: "Validate compute fabric policy.",
  jobType: "safe-command",
  requiredNodeRoles: ["safe-command-runner"],
  constraints: {},
  targetNodeId: "compute-linux-amd64",
  workspacePolicy: {
    mode: "ephemeral",
    cleanup: "retain-for-review",
  },
  networkPolicy: {
    mode: "none",
    reason: "No network needed for this test job.",
  },
  filesystemPolicy: {
    readRoots: [],
    writeRoots: [],
    allowSymlinks: false,
    allowArchiveExtraction: false,
  },
  secretPolicy: {
    allowRawSecrets: false,
    approvedSecretRefs: [],
    exposure: "none",
    redactionRequired: true,
  },
  artifactPolicy: {
    expectedTypes: ["log"],
    maxFileBytes: 1_000_000,
    maxTotalBytes: 5_000_000,
    maxFileCount: 10,
    retention: "review",
    archiveIntakeAllowed: false,
  },
  approvalPolicy: {
    humanApprovalRequired: false,
    approvalReasons: [],
  },
  costPolicy: {
    sensitivity: "high",
    preferredCostTier: "free-local",
    allowPaidEscalation: false,
    rationale: "Test job.",
  },
  timeoutPolicy: {
    queueTimeoutSeconds: 60,
    executionTimeoutSeconds: 600,
    cancellationGraceSeconds: 10,
  },
  auditLogPath: "logs/audit.jsonl",
  command: {
    command: ["true"],
  },
  status: "queued",
  ...overrides,
});

const issueCodes = (result: { issues: Array<{ code: string }> }) => result.issues.map((item) => item.code);

describe("compute node validation", () => {
  it("requires enrolled nodes to have an identity fingerprint", () => {
    const result = validateComputeNode({ ...enrolledContainerNode, identityFingerprint: undefined });

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("enrolled-node-without-fingerprint");
  });

  it("keeps the default GX10 node enrolled with verified SSH and model-host roles", () => {
    const state = buildDefaultState([]);
    const gx10 = state.computeFabric.nodes.find((node) => node.id === "compute-gx10");

    expect(gx10?.enrollmentState).toBe("enrolled");
    expect(gx10?.endpoint).toBe("ssh://rlab@gx10-23bd.local");
    expect(gx10?.supportedTransports).toContain("ssh");
    expect(gx10?.roles).toEqual(["safe-command-runner", "service-host", "artifact-store", "model-host"]);
  });
});

describe("compute node lifecycle", () => {
  it("enrolls a pending model host with identity evidence and records audit", () => {
    const state = {
      ...buildDefaultState([]),
      computeFabric: {
        ...buildDefaultState([]).computeFabric,
        nodes: [
          ...buildDefaultState([]).computeFabric.nodes,
          {
            id: "compute-test-pending",
            label: "Pending Test Node",
            kind: "lan-remote" as const,
            trustTier: "user-owned-remote" as const,
            enrollmentState: "pending" as const,
            endpoint: "test://pending",
            supportedTransports: [],
            roles: ["model-host" as const],
            healthState: "unknown" as const,
          },
        ],
      },
    };
    const result = enrollComputeNode(state, "compute-test-pending", {
      actor: "strategist.core",
      identityFingerprint: "SHA256:gx10-test-fingerprint",
      endpoint: "ssh://gx10.lan",
      supportedTransports: ["ssh"],
      roles: ["model-host", "artifact-store"],
      probe: {
        os: "linux",
        arch: "amd64",
        ramGb: 128,
      },
      createdAt: "2026-05-10T12:00:00.000Z",
    });

    const gx10 = result.state.computeFabric.nodes.find((node) => node.id === "compute-test-pending");
    expect(result.validation.valid).toBe(true);
    expect(gx10).toMatchObject({
      enrollmentState: "enrolled",
      identityFingerprint: "SHA256:gx10-test-fingerprint",
      endpoint: "ssh://gx10.lan",
      supportedTransports: ["ssh"],
      roles: ["model-host", "artifact-store"],
      probe: {
        os: "linux",
        arch: "amd64",
      },
    });
    expect(result.auditRecord).toMatchObject({
      nodeId: "compute-test-pending",
      event: "enrolled",
      createdAt: "2026-05-10T12:00:00.000Z",
    });
  });

  it("blocks executable roles during enrollment until an executable probe has passed", () => {
    const state = {
      ...buildDefaultState([]),
      computeFabric: {
        ...buildDefaultState([]).computeFabric,
        nodes: [
          ...buildDefaultState([]).computeFabric.nodes,
          {
            id: "compute-test-pending",
            label: "Pending Test Node",
            kind: "lan-remote" as const,
            trustTier: "user-owned-remote" as const,
            enrollmentState: "pending" as const,
            endpoint: "test://pending",
            supportedTransports: [],
            roles: ["model-host" as const],
            healthState: "unknown" as const,
          },
        ],
      },
    };
    const result = enrollComputeNode(state, "compute-test-pending", {
      actor: "strategist.core",
      identityFingerprint: "SHA256:gx10-test-fingerprint",
      endpoint: "ssh://gx10.lan",
      supportedTransports: ["ssh"],
      roles: ["model-host", "safe-command-runner", "container-runner"],
    });

    expect(result.validation.valid).toBe(false);
    expect(issueCodes(result.validation)).toContain("executable-role-without-probe");
  });

  it("quarantines and revokes nodes with reasoned audit records", () => {
    const state = stateWithNode();
    const quarantined = quarantineComputeNode(state, "compute-linux-amd64", {
      actor: "strategist.core",
      reason: "Fingerprint changed during review.",
      createdAt: "2026-05-10T12:00:00.000Z",
    });
    const revoked = revokeComputeNode(quarantined.state, "compute-linux-amd64", {
      actor: "strategist.core",
      reason: "User removed runner trust.",
      createdAt: "2026-05-10T12:05:00.000Z",
    });

    expect(quarantined.validation.valid).toBe(true);
    expect(revoked.validation.valid).toBe(true);
    expect(revoked.state.computeFabric.nodes[0]).toMatchObject({
      enrollmentState: "revoked",
      healthState: "unavailable",
    });
    expect(revoked.state.computeFabric.audit.map((record) => record.event)).toEqual(["quarantined", "revoked"]);
  });
});

describe("compute job validation", () => {
  it("blocks passive probes from declaring commands or network access", () => {
    const job = baseJob({
      jobType: "passive-probe",
      requiredNodeRoles: ["safe-command-runner"],
      networkPolicy: { mode: "lan-only", reason: "Should be rejected." },
      command: { command: ["uname", "-m"] },
    });

    const result = validateComputeJob(job, stateWithNode());

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toEqual(expect.arrayContaining(["passive-probe-has-execution", "passive-probe-network"]));
  });

  it("requires executable jobs to target or resolve to an enrolled node", () => {
    const pendingNode = { ...enrolledContainerNode, enrollmentState: "pending" as const };
    const result = validateComputeJob(baseJob(), stateWithNode(pendingNode));

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("target-node-not-enrolled");
  });

  it("prevents add-ons from selecting compute nodes directly", () => {
    const result = validateComputeJob(
      baseJob({
        consumerId: "addon.programbench",
      }),
      stateWithNode(),
    );

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("addon-direct-node-selection");
  });

  it("allows ResonantOS to select an enrolled node from constraints", () => {
    const job = baseJob({
      targetNodeId: undefined,
      requiredNodeRoles: ["container-runner", "cleanroom-runner"],
      constraints: {
        os: ["linux"],
        arch: ["amd64"],
        containerPlatform: ["linux/amd64"],
        minRamGb: 32,
      },
      jobType: "cleanroom-container-job",
      workspacePolicy: { mode: "cleanroom", cleanup: "retain-for-review" },
      container: { image: "programbench/example@sha256:abc" },
      command: undefined,
    });

    const state = stateWithNode();
    const selected = selectComputeNodeForJob(state.computeFabric.nodes, job);
    const result = validateComputeJob(job, state);

    expect(selected?.id).toBe("compute-linux-amd64");
    expect(result.valid).toBe(true);
  });

  it("rejects auto-selection when no enrolled node satisfies constraints", () => {
    const job = baseJob({
      targetNodeId: undefined,
      constraints: {
        os: ["linux"],
        arch: ["amd64"],
        minRamGb: 256,
      },
    });

    const result = validateComputeJob(job, stateWithNode());

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("no-enrolled-node-for-job");
  });

  it("rejects direct target selection when the target does not satisfy constraints", () => {
    const job = baseJob({
      constraints: {
        os: ["linux"],
        arch: ["arm64"],
      },
    });

    const result = validateComputeJob(job, stateWithNode());

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("target-node-constraints-mismatch");
  });

  it("rejects cleanroom jobs with unrestricted internet access", () => {
    const job = baseJob({
      targetNodeId: undefined,
      jobType: "cleanroom-container-job",
      requiredNodeRoles: ["container-runner", "cleanroom-runner"],
      workspacePolicy: { mode: "cleanroom", cleanup: "retain-for-review" },
      networkPolicy: { mode: "internet-approved", reason: "Should be rejected." },
      approvalPolicy: { humanApprovalRequired: true, approvalReasons: ["broad-filesystem"], approvedBy: "human" },
      container: { image: "example/test:latest" },
      command: undefined,
    });

    const result = validateComputeJob(job, stateWithNode());

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toEqual(expect.arrayContaining(["cleanroom-unsafe-network", "cleanroom-internet"]));
  });

  it("rejects raw secret material in job specs by default", () => {
    const job = baseJob({
      command: {
        command: ["printenv"],
        env: {
          OPENAI_API_KEY: "sk-EXAMPLEEXAMPLEEXAMPLE",
        },
      },
    });

    const result = validateComputeJob(job, stateWithNode());

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("secret-material-in-job");
  });
});

describe("compute artifacts", () => {
  const artifact = (path: string): ComputeArtifactRecord => ({
    id: "artifact-1",
    jobId: "job-test",
    nodeId: "compute-linux-amd64",
    path,
    type: "log",
    sizeBytes: 10,
    sha256: "a".repeat(64),
    createdAt: "2026-05-10T00:00:00.000Z",
    retention: "review",
    sensitivity: "internal",
  });

  it("rejects traversal outside artifact roots", () => {
    expect(isRootContainedArtifactPath("/tmp/resonantos/artifacts", "../secrets.txt")).toBe(false);
    expect(validateComputeArtifactRecord(artifact("../secrets.txt"), "/tmp/resonantos/artifacts").valid).toBe(false);
  });

  it("accepts contained absolute and relative artifact paths", () => {
    expect(isRootContainedArtifactPath("/tmp/resonantos/artifacts", "/tmp/resonantos/artifacts/logs/out.txt")).toBe(true);
    expect(isRootContainedArtifactPath("/tmp/resonantos/artifacts", "logs/out.txt")).toBe(true);
  });
});

describe("compute fabric state normalization", () => {
  it("adds default compute fabric to older persisted state", () => {
    const base = buildDefaultState([]);
    const legacy = { ...base } as Partial<ResonantShellState>;
    delete legacy.computeFabric;

    const normalized = normalizeState(legacy as ResonantShellState, base);

    expect(normalized.computeFabric.policyEngineId).toBe("compute-fabric.core");
    expect(normalized.computeFabric.nodes.find((node) => node.id === "compute-desktop-local")).toBeDefined();
  });
});

describe("compute job submission", () => {
  it("queues a valid job, selects the runner, and records an audit event", () => {
    const state = stateWithNode();
    const job = baseJob({
      targetNodeId: undefined,
      constraints: {
        os: ["linux"],
        arch: ["amd64"],
      },
      status: "blocked",
    });

    const result = submitComputeJob(state, job, { createdAt: "2026-05-10T12:00:00.000Z" });

    expect(result.validation.valid).toBe(true);
    expect(result.state).not.toBe(state);
    expect(result.state.computeFabric.jobs).toHaveLength(1);
    expect(result.state.computeFabric.jobs[0]).toMatchObject({
      id: "job-test",
      targetNodeId: "compute-linux-amd64",
      status: "queued",
    });
    expect(result.auditRecord).toMatchObject({
      jobId: "job-test",
      nodeId: "compute-linux-amd64",
      event: "submitted",
      createdAt: "2026-05-10T12:00:00.000Z",
    });
    expect(result.state.computeFabric.audit).toEqual([result.auditRecord]);
  });

  it("leaves state unchanged and writes no audit record for invalid add-on direct selection", () => {
    const state = stateWithNode();
    const result = submitComputeJob(
      state,
      baseJob({
        consumerId: "addon.programbench",
      }),
    );

    expect(result.validation.valid).toBe(false);
    expect(issueCodes(result.validation)).toContain("addon-direct-node-selection");
    expect(result.state).toBe(state);
    expect(result.auditRecord).toBeUndefined();
  });
});
