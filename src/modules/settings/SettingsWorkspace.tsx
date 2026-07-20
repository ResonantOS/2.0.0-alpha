// Intent citation: docs/architecture/ADR-002-modular-codebase.md

import { useEffect, useState } from "react";
import type {
  AddOnManifest,
  LivingArchiveMemoryServiceResult,
  LivingArchiveMemoryServiceStatus,
  ProviderDiagnosticReport,
  ProviderProfile,
  ProviderRequestAuditRecord,
  ProviderSmokeTestResult,
  ResonantShellState,
} from "../../core/contracts";
import { requestProviderRequestAudit } from "../../core/runtime";
import {
  buildStrategyRouteOptions,
  costPostureLabel,
  formatStrategyRoute,
  routeOptionKey,
  type WorkloadStrategyPatch,
} from "../../core/model-strategy";
import { resolveAgentChatRoute, resolveWorkloadRoute } from "../../core/provider-service";
import { Panel } from "../../components/Panel";
import type { CreateProviderProfileInput } from "./controller";
import {
  providerTemplateCategoryLabels,
  providerTemplates,
  providerTemplatesByCategory,
  type ProviderTemplateCategory,
  type ProviderTemplateId,
} from "./provider-templates";

export type SettingsSection = "profile" | "providers" | "memory" | "browser-control" | "addons" | "privacy" | "advanced";

type AdvancedSettingsSection = "diagnostics" | "routing" | "logician" | "defaults" | "shell";

export const settingsItems: Array<{ id: SettingsSection; label: string; eyebrow: string }> = [
  { id: "profile", label: "Profile", eyebrow: "identity + trust" },
  { id: "providers", label: "Providers", eyebrow: "models + secrets" },
  { id: "memory", label: "Memory", eyebrow: "MCP + archive" },
  { id: "browser-control", label: "Browser Control", eyebrow: "tabs + session" },
  { id: "addons", label: "Add-ons", eyebrow: "capabilities" },
  { id: "privacy", label: "Privacy", eyebrow: "boundaries" },
  { id: "advanced", label: "Advanced", eyebrow: "diagnostics + internals" },
];

const advancedSettingsItems: Array<{ id: AdvancedSettingsSection; label: string; eyebrow: string }> = [
  { id: "diagnostics", label: "Diagnostics", eyebrow: "health + logs" },
  { id: "routing", label: "Routing", eyebrow: "strategy" },
  { id: "logician", label: "Logician", eyebrow: "trust kernel" },
  { id: "defaults", label: "Defaults", eyebrow: "core behavior" },
  { id: "shell", label: "Shell", eyebrow: "layout + app" },
];

type SettingsWorkspaceProps = {
  state: ResonantShellState;
  manifests: AddOnManifest[];
  settingsSection: SettingsSection;
  settingsNotice: string | null;
  providerDiagnostics: ProviderDiagnosticReport[];
  providerDiagnosticsBusy: boolean;
  activeProviderProbeId: string | null;
  providerSmokeResults: Record<string, ProviderSmokeTestResult>;
  providerSmokeBusyId: string | null;
  providerDrafts: Record<string, string>;
  memoryServiceStatus: LivingArchiveMemoryServiceStatus | null;
  memoryServiceBusy: boolean;
  memoryServiceLastResult: LivingArchiveMemoryServiceResult | null;
  onSettingsSectionChange: (section: SettingsSection) => void;
  onUpdateProvider: (profileId: string, field: "primaryModel" | "fallbackModel" | "status", value: string) => void;
  onCreateProvider: (input: CreateProviderProfileInput) => void;
  onUpdateWorkloadStrategy: (strategyId: string, patch: WorkloadStrategyPatch) => void;
  onUpdateWorkloadStrategyRoute: (strategyId: string, routeKey: string) => void;
  onProviderDraftChange: (profileId: string, value: string) => void;
  onSaveProviderSecret: (profileId: string) => void;
  onProbeProvider: (profileId: string) => void;
  onProbeAllProviders: () => void;
  onSetupProvider: (profileId: string) => void;
  onSmokeTestProvider: (profileId: string) => void;
  onRefreshMemoryServiceStatus: () => void;
  onStartMemoryService: () => void;
  onStopMemoryService: () => void;
  onOpenLogicianAddOn: () => void;
};

type LogicianFlowNodeType = "decision" | "action" | "delegation" | "gate";

type LogicianFlowNode = {
  id: string;
  label: string;
  type: LogicianFlowNodeType;
  summary: string;
  detail: string;
  evidence: string;
};

type LogicianFlow = {
  id: string;
  name: string;
  category: string;
  trigger: string;
  description: string;
  nodes: LogicianFlowNode[];
};

const logicianNodeTypeLabels: Record<LogicianFlowNodeType, string> = {
  decision: "Decision",
  action: "Action",
  delegation: "Delegation",
  gate: "Gate",
};

const logicianProtocolFlows: LogicianFlow[] = [
  {
    id: "protocol-selection-before-work",
    name: "Protocol Selection Before Work",
    category: "core",
    trigger: "Any user task that touches execution, code, memory, add-ons, or delegated agents.",
    description: "Forces the Oracle agent to look at protocols first, declare the match, then carry evidence into verification.",
    nodes: [
      {
        id: "request-classifier",
        label: "Classify Task",
        type: "decision",
        summary: "Identify task vector and risk class.",
        detail: "Map the request to implementation, research, memory, delegation, security, or verification work before acting.",
        evidence: "task vector, risk class, selected protocol candidates",
      },
      {
        id: "protocol-library",
        label: "Protocol Library",
        type: "action",
        summary: "Read applicable plays and protocols.",
        detail: "Use reviewed protocol and constitution scopes from the Logician add-on manifest before planning work.",
        evidence: "protocol ids, source scope, short applicability reason",
      },
      {
        id: "protocol-selector",
        label: "Protocol Selector",
        type: "decision",
        summary: "Pick the governing protocol set.",
        detail: "Choose the smallest protocol set that governs the task and explain why non-matching protocols were skipped.",
        evidence: "selected protocol ids, one-line selection rationale",
      },
      {
        id: "execution-brief",
        label: "Execution Brief",
        type: "action",
        summary: "Attach the protocol brief to the run.",
        detail: "The Oracle can proceed only after its plan carries protocol references and expected verification artifacts.",
        evidence: "brief artifact, expected checks, expected output artifacts",
      },
      {
        id: "selection-gate",
        label: "Selection Gate",
        type: "gate",
        summary: "Block execution if no protocol decision exists.",
        detail: "Missing protocol selection is a deterministic failure unless the task is explicitly marked trivial and no protocol applies.",
        evidence: "gate decision, failure reason or pass reason",
      },
    ],
  },
  {
    id: "build-task-verification",
    name: "Build Task Verification",
    category: "build",
    trigger: "Code, UI, add-on, automation, or integration work.",
    description: "Checks that claimed implementation work is backed by files, tests, build results, and Verify Agent findings.",
    nodes: [
      {
        id: "implementation-contract",
        label: "Implementation Contract",
        type: "action",
        summary: "Declare touched surfaces and acceptance checks.",
        detail: "The worker records intended files, runtime surfaces, required tests, and product acceptance conditions.",
        evidence: "changed paths, acceptance criteria, protocol ids",
      },
      {
        id: "artifact-capture",
        label: "Artifact Capture",
        type: "action",
        summary: "Collect actual outputs.",
        detail: "Observed files, command outputs, screenshots, and reports are captured as evidence with trust tiers.",
        evidence: "filesystem evidence, command output, browser screenshot",
      },
      {
        id: "verify-agent",
        label: "Verify Agent",
        type: "decision",
        summary: "Compare claims against evidence.",
        detail: "The deterministic verifier checks missing artifacts, protocol drift, weak evidence, and blocked findings.",
        evidence: "verification-report, evidence trust counts, findings",
      },
      {
        id: "completion-gate",
        label: "Completion Gate",
        type: "gate",
        summary: "Block false completion.",
        detail: "The task cannot be marked complete when mandatory evidence, tests, or verification artifacts are missing.",
        evidence: "pass, warn, degrade, or block decision",
      },
    ],
  },
  {
    id: "delegated-agent-completion",
    name: "Delegated Agent Completion",
    category: "delegation",
    trigger: "Hermes, OpenCode, OpenClaw, Paperclip, Codex, or another runtime returns work to Augmentor.",
    description: "Prevents delegated agents from self-certifying completion without evidence that Augmentor can inspect.",
    nodes: [
      {
        id: "delegation-packet",
        label: "Delegation Packet",
        type: "delegation",
        summary: "Send objective, scope, and required artifacts.",
        detail: "The sender specifies ownership, non-overlap boundaries, evidence format, and verification requirements.",
        evidence: "delegation id, write scope, expected artifact list",
      },
      {
        id: "runtime-output",
        label: "Runtime Output",
        type: "action",
        summary: "Receive claimed result.",
        detail: "External runtimes may report success, but their claims remain self-reported until corroborated.",
        evidence: "agent transcript, returned paths, returned status",
      },
      {
        id: "evidence-reconciliation",
        label: "Evidence Reconciliation",
        type: "decision",
        summary: "Promote or downgrade evidence trust.",
        detail: "Observed and host-reported evidence can support pass decisions; transcript-only claims create warnings.",
        evidence: "evidence trust tier map",
      },
      {
        id: "delegation-gate",
        label: "Delegation Gate",
        type: "gate",
        summary: "Accept, warn, or reject returned work.",
        detail: "Completion is accepted only when returned artifacts satisfy the original delegation contract.",
        evidence: "contract diff, verification-report",
      },
    ],
  },
  {
    id: "trusted-archive-promotion",
    name: "Trusted Archive Promotion",
    category: "memory",
    trigger: "A result, protocol, or research note is proposed for durable trusted memory.",
    description: "Keeps the Living Archive useful by separating intake, review, approval, and trusted knowledge promotion.",
    nodes: [
      {
        id: "intake-candidate",
        label: "Intake Candidate",
        type: "action",
        summary: "Write only to intake scope.",
        detail: "Agents can propose knowledge, but cannot directly write final trusted archive pages.",
        evidence: "intake artifact id, source references",
      },
      {
        id: "semantic-lint",
        label: "Semantic Lint",
        type: "decision",
        summary: "Check duplication, drift, and source quality.",
        detail: "The Logician checks whether the memory conflicts with current trusted pages or lacks sufficient source evidence.",
        evidence: "lint findings, duplicate candidates, source trust",
      },
      {
        id: "human-review",
        label: "Human Review",
        type: "gate",
        summary: "Require human approval for trusted promotion.",
        detail: "Trusted memory remains a human-governed boundary; the AI can prepare but not silently canonize.",
        evidence: "approval decision, reviewer note",
      },
    ],
  },
];

const logicianPolicyRuleFlows: LogicianFlow[] = [
  {
    id: "evidence-trust-rule",
    name: "Evidence Trust Rule",
    category: "evidence",
    trigger: "Any Verify Agent report containing self-reported, transcript-claim, or unknown evidence.",
    description: "Counterbalances probabilistic claims by requiring observed or host-reported evidence for pass decisions.",
    nodes: [
      {
        id: "tier-classifier",
        label: "Classify Evidence",
        type: "decision",
        summary: "Assign trust tier to every evidence item.",
        detail: "Observed and host-reported evidence can pass. Self-reported, transcript-claim, and unknown evidence raise findings.",
        evidence: "evidence tier counts",
      },
      {
        id: "finding-builder",
        label: "Build Findings",
        type: "action",
        summary: "Emit deterministic warnings or blocks.",
        detail: "Findings are generated from evidence trust, missing protocols, missing artifacts, and failed checks.",
        evidence: "finding severity, related artifact ids",
      },
      {
        id: "trust-gate",
        label: "Trust Gate",
        type: "gate",
        summary: "Prevent weak evidence from becoming trust.",
        detail: "The system can continue with warnings, but cannot mark weakly evidenced work as fully verified.",
        evidence: "gate status and remediation requirement",
      },
    ],
  },
  {
    id: "capability-gate-rule",
    name: "Capability Gate Rule",
    category: "security",
    trigger: "An add-on, runtime, or script requests a protected capability.",
    description: "Blocks execution when required capabilities are not granted or when revocation behavior requires hard stop.",
    nodes: [
      {
        id: "capability-request",
        label: "Capability Request",
        type: "action",
        summary: "Read required grants.",
        detail: "The Logician uses the add-on manifest as the source of truth for required capabilities.",
        evidence: "manifest capability list",
      },
      {
        id: "grant-check",
        label: "Grant Check",
        type: "decision",
        summary: "Compare requested and granted capabilities.",
        detail: "Missing grants produce deterministic warnings or blocking findings based on failure policy.",
        evidence: "grant diff, revocation behavior",
      },
      {
        id: "capability-gate",
        label: "Capability Gate",
        type: "gate",
        summary: "Block unauthorized protected operations.",
        detail: "The Oracle cannot bypass missing capability grants by claiming the action is necessary.",
        evidence: "block decision or approved grant list",
      },
    ],
  },
];

const logicianEvidencePolicy = [
  { tier: "observed", meaning: "ResonantOS runtime or UI state directly observed it.", action: "Can support pass decisions." },
  { tier: "host-reported", meaning: "A host-mediated command returned structured evidence.", action: "Can support pass decisions." },
  { tier: "self-reported", meaning: "An add-on or agent claimed it happened.", action: "Warn unless corroborated." },
  { tier: "transcript-claim", meaning: "Only copied transcript text supports the claim.", action: "Warn and request stronger evidence." },
  { tier: "unknown", meaning: "No trust tier is attached.", action: "Treat as untrusted." },
] as const;

const logicianRuntimeCoverage = ["Augmentor", "Engineer", "Hermes", "OpenCode", "OpenClaw", "Paperclip", "Codex"] as const;

const allLogicianFlowCategories = (flows: readonly LogicianFlow[]): string[] =>
  Array.from(new Set(flows.map((flow) => flow.category))).sort((first, second) => first.localeCompare(second));

const flowMatchesSearch = (flow: LogicianFlow, search: string): boolean => {
  const normalized = search.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    flow.name,
    flow.category,
    flow.trigger,
    flow.description,
    ...flow.nodes.flatMap((node) => [node.label, node.summary, node.detail, node.evidence, node.type]),
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
};

function LogicianFlowExplorer() {
  const [mode, setMode] = useState<"protocols" | "rules">("protocols");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [selectedFlowId, setSelectedFlowId] = useState(logicianProtocolFlows[0].id);
  const [selectedNodeId, setSelectedNodeId] = useState(logicianProtocolFlows[0].nodes[0].id);
  const flows = mode === "protocols" ? logicianProtocolFlows : logicianPolicyRuleFlows;
  const visibleFlows = flows.filter((flow) => (category === "all" || flow.category === category) && flowMatchesSearch(flow, search));
  const selectedFlow = visibleFlows.find((flow) => flow.id === selectedFlowId) ?? visibleFlows[0] ?? flows[0];
  const selectedNode = selectedFlow.nodes.find((node) => node.id === selectedNodeId) ?? selectedFlow.nodes[0];
  const categories = allLogicianFlowCategories(flows);

  const selectMode = (nextMode: "protocols" | "rules") => {
    const nextFlows = nextMode === "protocols" ? logicianProtocolFlows : logicianPolicyRuleFlows;
    setMode(nextMode);
    setCategory("all");
    setSelectedFlowId(nextFlows[0].id);
    setSelectedNodeId(nextFlows[0].nodes[0].id);
  };

  const selectFlow = (flow: LogicianFlow) => {
    setSelectedFlowId(flow.id);
    setSelectedNodeId(flow.nodes[0].id);
  };

  return (
    <div className="logician-flow-explorer">
      <div className="logician-flow-tabs" role="tablist" aria-label="Logician graph mode">
        <button
          type="button"
          className={mode === "protocols" ? "active" : ""}
          onClick={() => selectMode("protocols")}
          role="tab"
          aria-selected={mode === "protocols"}
        >
          Protocol Flows
        </button>
        <button
          type="button"
          className={mode === "rules" ? "active" : ""}
          onClick={() => selectMode("rules")}
          role="tab"
          aria-selected={mode === "rules"}
        >
          Policy Rules
        </button>
      </div>

      <div className="logician-flow-toolbar">
        <label>
          <span className="sr-only">Search Logician flows</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Logician flows"
            aria-label="Search Logician flows"
          />
        </label>
        <div className="logician-category-chips" aria-label="Logician flow categories">
          <button type="button" className={category === "all" ? "active" : ""} onClick={() => setCategory("all")}>
            All
          </button>
          {categories.map((item) => (
            <button type="button" className={category === item ? "active" : ""} onClick={() => setCategory(item)} key={item}>
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="logician-flow-layout">
        <div className="logician-flow-list" aria-label="Logician flow selector">
          {visibleFlows.map((flow) => (
            <button
              type="button"
              className={flow.id === selectedFlow.id ? "active" : ""}
              onClick={() => selectFlow(flow)}
              key={flow.id}
            >
              <span>{flow.category}</span>
              <strong>{flow.name}</strong>
              <p>{flow.description}</p>
              <small>
                {flow.nodes.length} nodes · {flow.nodes.filter((node) => node.type === "gate").length} gates
              </small>
            </button>
          ))}
        </div>

        <section className="logician-flow-canvas" aria-label={`${selectedFlow.name} block graph`}>
          <div className="logician-flow-canvas-head">
            <div>
              <span className="eyebrow">{selectedFlow.category}</span>
              <h4>{selectedFlow.name}</h4>
              <p>{selectedFlow.trigger}</p>
            </div>
            <span className="tone tone-active">{selectedFlow.nodes.length} nodes</span>
          </div>

          <div className="logician-flow-track">
            {selectedFlow.nodes.map((node, index) => (
              <div className="logician-flow-node-wrap" key={node.id}>
                <button
                  type="button"
                  className={`logician-flow-node logician-flow-node-${node.type} ${node.id === selectedNode.id ? "active" : ""}`}
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <span>{logicianNodeTypeLabels[node.type]}</span>
                  <strong>{node.label}</strong>
                  <p>{node.summary}</p>
                </button>
                {index < selectedFlow.nodes.length - 1 ? <i aria-hidden="true" className="logician-flow-connector" /> : null}
              </div>
            ))}
          </div>
        </section>

        <aside className="logician-node-detail-panel" aria-label="Selected Logician node details">
          <span className={`logician-node-type logician-node-type-${selectedNode.type}`}>{logicianNodeTypeLabels[selectedNode.type]}</span>
          <h4>{selectedNode.label}</h4>
          <p>{selectedNode.detail}</p>
          {selectedNode.type === "gate" ? <strong className="logician-node-detail-banner">Mandatory checkpoint</strong> : null}
          <dl>
            <div>
              <dt>Expected evidence</dt>
              <dd>{selectedNode.evidence}</dd>
            </div>
            <div>
              <dt>Flow</dt>
              <dd>{selectedFlow.name}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}

const providerNeedsSecret = (profile: ProviderProfile): boolean =>
  profile.providerType === "openai" || profile.providerType === "openai-compatible" || profile.providerType === "minimax";

const providerSecretLabel = (profile: ProviderProfile): string =>
  profile.providerType === "minimax" ? "Token Plan / API key" : "API key";

const providerSecretPlaceholder = (profile: ProviderProfile): string => {
  if (profile.credentialStatus === "configured") {
    return "Saved on desktop side";
  }
  return profile.providerType === "minimax" ? "minimax-..." : "sk-...";
};

const providerTemplateCategoryOrder: ProviderTemplateCategory[] = [
  "direct-provider",
  "aggregator",
  "local-runtime",
  "runtime-node",
  "custom",
];

const providerTemplateExecutionLabel = (state: string): string => {
  if (state === "routable-now") {
    return "Routable now";
  }
  if (state === "adapter-pending") {
    return "Adapter pending";
  }
  return "Profile only";
};

const formatAuditTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const formatAuditUsage = (record: ProviderRequestAuditRecord): string => {
  const usage = record.usage;
  if (!usage) {
    return "usage unavailable";
  }
  const parts = [];
  if (typeof usage.totalTokens === "number") {
    parts.push(`${usage.totalTokens.toLocaleString()} tokens`);
  }
  if (typeof usage.tokensPerSecond === "number") {
    parts.push(`${usage.tokensPerSecond.toFixed(1)} TPS`);
  }
  return parts.join(" · ") || "usage unavailable";
};

export function SettingsWorkspace(props: SettingsWorkspaceProps) {
  const [expandedProviderIds, setExpandedProviderIds] = useState<Set<string>>(new Set());
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [advancedSection, setAdvancedSection] = useState<AdvancedSettingsSection>("diagnostics");
  const [providerAuditRecords, setProviderAuditRecords] = useState<ProviderRequestAuditRecord[]>([]);
  const [providerAuditBusy, setProviderAuditBusy] = useState(false);
  const [providerAuditError, setProviderAuditError] = useState<string | null>(null);
  const [addProviderTemplateId, setAddProviderTemplateId] = useState<ProviderTemplateId>("minimax");
  const [addProviderLabel, setAddProviderLabel] = useState(providerTemplates[0]?.label ?? "");
  const [addProviderSecret, setAddProviderSecret] = useState("");
  const [addProviderBaseUrl, setAddProviderBaseUrl] = useState(providerTemplates[0]?.defaultApiBaseUrl ?? "");
  const selectedProviderTemplate =
    providerTemplates.find((template) => template.id === addProviderTemplateId) ?? providerTemplates[0];
  const strategyRouteOptions = buildStrategyRouteOptions(props.state);
  const logicianManifest = props.manifests.find((manifest) => manifest.id === "addon.logician");
  const logicianInstallation = props.state.installations["addon.logician"];
  const latestLogicianArtifact = logicianInstallation?.verificationArtifacts?.[0];
  const logicianHooks = logicianManifest?.hooks ?? [];
  const logicianScripts = logicianManifest?.scripts ?? [];
  const protectedManifests = props.manifests.filter((manifest) =>
    ["addon.hermes", "addon.opencode", "addon.openclaw", "addon.paperclip", "addon.logician"].includes(manifest.id),
  );
  const installations = Object.values(props.state.installations);
  const enabledInstallations = installations.filter((installation) => installation.enabled);
  const protectedCapabilityCount = props.manifests.reduce(
    (count, manifest) => count + manifest.requestedCapabilities.filter((capability) => capability.revocationBehavior === "hard-stop").length,
    0,
  );

  const refreshProviderAudit = async () => {
    setProviderAuditBusy(true);
    setProviderAuditError(null);
    try {
      setProviderAuditRecords(await requestProviderRequestAudit(50));
    } catch (error) {
      setProviderAuditError(error instanceof Error ? error.message : "Failed to read provider activity.");
    } finally {
      setProviderAuditBusy(false);
    }
  };

  useEffect(() => {
    if (props.settingsSection === "advanced" && advancedSection === "diagnostics") {
      void refreshProviderAudit();
    }
  }, [props.settingsSection, advancedSection]);

  const toggleProviderExpanded = (profileId: string) => {
    setExpandedProviderIds((current) => {
      const next = new Set(current);
      if (next.has(profileId)) {
        next.delete(profileId);
      } else {
        next.add(profileId);
      }
      return next;
    });
  };

  const handleProviderTemplateChange = (templateId: ProviderTemplateId) => {
    const template = providerTemplates.find((item) => item.id === templateId);
    setAddProviderTemplateId(templateId);
    setAddProviderLabel(template?.label ?? "");
    setAddProviderBaseUrl(template?.defaultApiBaseUrl ?? "");
    setAddProviderSecret("");
  };

  const handleCreateProvider = () => {
    if (!selectedProviderTemplate) {
      return;
    }
    props.onCreateProvider({
      templateId: selectedProviderTemplate.id,
      label: addProviderLabel,
      secret: addProviderSecret,
      apiBaseUrl: addProviderBaseUrl,
    });
    setAddProviderOpen(false);
    setAddProviderSecret("");
  };

  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <div className="settings-sidebar-head">
          <p className="eyebrow">Settings</p>
          <h2>System configuration</h2>
        </div>
        <nav className="settings-nav" aria-label="Settings sections">
          {settingsItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-item ${props.settingsSection === item.id ? "active" : ""}`}
              onClick={() => props.onSettingsSectionChange(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.eyebrow}</small>
            </button>
          ))}
        </nav>
      </aside>

      <div className="settings-content">
        {props.settingsSection === "advanced" && (
          <nav className="settings-secondary-nav" aria-label="Advanced settings sections">
            {advancedSettingsItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-secondary-nav-item ${advancedSection === item.id ? "active" : ""}`}
                onClick={() => setAdvancedSection(item.id)}
              >
                <span>{item.label}</span>
                <small>{item.eyebrow}</small>
              </button>
            ))}
          </nav>
        )}

        {props.settingsSection === "profile" && (
          <Panel title="Profile" subtitle="Manage the trusted identity people meet first in ResonantOS.">
            <div className="settings-action-hero">
              <div>
                <p className="eyebrow">Primary identity</p>
                <h3>Review the Strategist identity.</h3>
                <p>{props.state.strategistIdentity.trustNote}</p>
              </div>
              <span className="tone tone-active">trusted</span>
            </div>
            <div className="settings-grid">
              <SettingNote label="Default name" value={props.state.strategistIdentity.customName ?? props.state.strategistIdentity.defaultName} />
              <SettingNote label="Identity id" value={props.state.strategistIdentity.id} />
              <SettingNote label="Distribution" value={props.state.distributionModel} />
              <SettingNote label="Delegation posture" value="add-on agents are delegated" />
            </div>
          </Panel>
        )}

        {props.settingsSection === "providers" && (
          <Panel title="AI Providers" subtitle="Configure the model routes ResonantOS can use for agents, archive work, and recovery.">
            {props.settingsNotice && <div className="inline-notice">{props.settingsNotice}</div>}
            <div className="provider-hero">
              <div className="provider-hero-copy">
                <p className="eyebrow">Provider fabric</p>
                <h3>Add one provider, then let ResonantOS route work through policy.</h3>
                <p>
                  Keep this page focused: add credentials at the top, scan health when needed, and expand a provider only when
                  you need technical details.
                </p>
              </div>
              <div className="provider-hero-actions">
                <button type="button" className="button-primary touch-action" onClick={() => setAddProviderOpen(true)}>
                  Add AI Provider
                </button>
                <button type="button" className="button-secondary touch-action" onClick={props.onProbeAllProviders} disabled={props.providerDiagnosticsBusy}>
                  {props.providerDiagnosticsBusy && !props.activeProviderProbeId ? "Checking..." : "Check Health"}
                </button>
              </div>
            </div>

            <div className="provider-list" aria-label="Configured AI providers">
              {props.state.providers.map((profile) => (
                <article key={profile.id} className={`provider-row ${expandedProviderIds.has(profile.id) ? "expanded" : ""}`}>
                  <div className="provider-row-main">
                    <button
                      type="button"
                      className="provider-row-title"
                      onClick={() => toggleProviderExpanded(profile.id)}
                      aria-expanded={expandedProviderIds.has(profile.id)}
                    >
                      <span className={`provider-dot provider-dot-${profile.status}`} aria-hidden="true" />
                      <span>
                        <strong>{profile.label}</strong>
                        <small>
                          {profile.providerType} · {profile.authTier}
                        </small>
                      </span>
                    </button>
                    <div className="provider-row-models">
                      <span>{profile.primaryModel}</span>
                      <small>{profile.fallbackModel ? `Fallback ${profile.fallbackModel}` : "No fallback"}</small>
                    </div>
                    <div className="provider-row-meta">
                      <span className={`tone tone-${profile.credentialStatus === "configured" ? "active" : "warning"}`}>
                        {profile.credentialStatus}
                      </span>
                      <span>{profile.allowedModels.length} models</span>
                    </div>
                    <div className="provider-row-actions">
                      <button type="button" className="button-quiet" onClick={() => setEditingProviderId(editingProviderId === profile.id ? null : profile.id)}>
                        {editingProviderId === profile.id ? "Close" : "Edit"}
                      </button>
                      <button type="button" className="button-quiet" onClick={() => props.onProbeProvider(profile.id)} disabled={props.providerDiagnosticsBusy}>
                        Probe
                      </button>
                      <button type="button" className="button-quiet" onClick={() => props.onSetupProvider(profile.id)}>
                        Setup
                      </button>
                      <button type="button" className="button-quiet" onClick={() => props.onSmokeTestProvider(profile.id)} disabled={props.providerSmokeBusyId === profile.id}>
                        Test
                      </button>
                    </div>
                  </div>

                  {(expandedProviderIds.has(profile.id) || editingProviderId === profile.id) && (
                    <div className="provider-row-detail">
                      {editingProviderId === profile.id && (
                        <div className="provider-edit-panel">
                          <label className="field">
                            <span>Status</span>
                            <select value={profile.status} onChange={(event) => props.onUpdateProvider(profile.id, "status", event.target.value)}>
                              <option value="ready">ready</option>
                              <option value="fallback">fallback</option>
                              <option value="missing">missing</option>
                            </select>
                          </label>
                          <label className="field">
                            <span>Primary model</span>
                            <select value={profile.primaryModel} onChange={(event) => props.onUpdateProvider(profile.id, "primaryModel", event.target.value)}>
                              {profile.allowedModels.map((model) => (
                                <option key={model} value={model}>
                                  {model}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field">
                            <span>Fallback model</span>
                            <input
                              value={profile.fallbackModel ?? ""}
                              onChange={(event) => props.onUpdateProvider(profile.id, "fallbackModel", event.target.value)}
                              placeholder="optional"
                            />
                          </label>
                          {providerNeedsSecret(profile) && (
                            <div className="provider-secret-block">
                              <label className="field">
                                <span>{providerSecretLabel(profile)}</span>
                                <input
                                  type="password"
                                  value={props.providerDrafts[profile.id] ?? ""}
                                  onChange={(event) => props.onProviderDraftChange(profile.id, event.target.value)}
                                  placeholder={providerSecretPlaceholder(profile)}
                                />
                              </label>
                              <button type="button" className="button-secondary touch-action" onClick={() => props.onSaveProviderSecret(profile.id)}>
                                Save Key
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="provider-detail-grid">
                        <div>
                          <span className="eyebrow">Consumers</span>
                          <p>{profile.consumerScopes.join(", ")}</p>
                        </div>
                        <div>
                          <span className="eyebrow">Endpoint</span>
                          <p>{profile.apiBaseUrl ?? "Managed by runtime node"}</p>
                        </div>
                        <div>
                          <span className="eyebrow">Available models</span>
                          <p>{profile.allowedModels.join(", ")}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>

            {addProviderOpen && selectedProviderTemplate && (
              <div className="provider-dialog-backdrop" role="presentation" onClick={() => setAddProviderOpen(false)}>
                <form
                  className="provider-dialog-card"
                  onClick={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleCreateProvider();
                  }}
                >
                  <div className="provider-dialog-head">
                    <div>
                      <p className="eyebrow">Add provider</p>
                      <h3>Connect an AI provider</h3>
                    </div>
                    <button type="button" className="button-quiet" onClick={() => setAddProviderOpen(false)}>
                      Close
                    </button>
                  </div>
                  <label className="field">
                    <span>Provider</span>
                    <select value={addProviderTemplateId} onChange={(event) => handleProviderTemplateChange(event.target.value as ProviderTemplateId)}>
                      {providerTemplateCategoryOrder.map((category) => (
                        <optgroup key={category} label={providerTemplateCategoryLabels[category]}>
                          {providerTemplatesByCategory(category).map((template) => (
                            <option key={template.id} value={template.id}>
                              {template.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Name in ResonantOS</span>
                    <input value={addProviderLabel} onChange={(event) => setAddProviderLabel(event.target.value)} placeholder={selectedProviderTemplate.label} />
                  </label>
                  {selectedProviderTemplate.requiresBaseUrl && (
                    <label className="field">
                      <span>API base URL</span>
                      <input value={addProviderBaseUrl} onChange={(event) => setAddProviderBaseUrl(event.target.value)} placeholder="https://api.provider.com/v1" />
                    </label>
                  )}
                  {selectedProviderTemplate.requiresSecret && (
                    <label className="field">
                      <span>{selectedProviderTemplate.id === "minimax" ? "Token Plan / API key" : "API key"}</span>
                      <input
                        type="password"
                        value={addProviderSecret}
                        onChange={(event) => setAddProviderSecret(event.target.value)}
                        placeholder={selectedProviderTemplate.id === "minimax" ? "minimax-..." : "sk-..."}
                      />
                    </label>
                  )}
                  <div className="provider-template-note">
                    <strong>
                      {selectedProviderTemplate.shortLabel} · {providerTemplateExecutionLabel(selectedProviderTemplate.executionState)}
                    </strong>
                    <p>{selectedProviderTemplate.note}</p>
                  </div>
                  <div className="provider-dialog-actions">
                    <button type="button" className="button-secondary touch-action" onClick={() => setAddProviderOpen(false)}>
                      Cancel
                    </button>
                    <button type="submit" className="button-primary touch-action">
                      Add Provider
                    </button>
                  </div>
                </form>
              </div>
            )}
          </Panel>
        )}

        {props.settingsSection === "browser-control" && (
          <Panel title="Browser Control" subtitle="Review the browser workspace and controlled browsing session.">
            <div className="settings-action-hero">
              <div>
                <p className="eyebrow">Most likely action</p>
                <h3>Check whether a browser session is under control.</h3>
                <p>Use this section to see the user-facing browsing state before opening lower-level session diagnostics.</p>
              </div>
              <span className={`tone tone-${props.state.uiPreferences.browserWorkspace.controlledSession.status === "ready" ? "active" : "neutral"}`}>
                {props.state.uiPreferences.browserWorkspace.controlledSession.status}
              </span>
            </div>
            <div className="settings-grid">
              <SettingNote label="Open tabs" value={String(props.state.uiPreferences.browserWorkspace.tabs.length)} />
              <SettingNote label="Active tab" value={props.state.uiPreferences.browserWorkspace.activeTabId} />
              <SettingNote label="Controlled URL" value={props.state.uiPreferences.browserWorkspace.controlledSession.url ?? "none"} />
              <SettingNote label="Last sync" value={props.state.uiPreferences.browserWorkspace.controlledSession.lastSyncedAt ?? "not synced"} />
            </div>
          </Panel>
        )}

        {props.settingsSection === "addons" && (
          <Panel title="Add-ons" subtitle="Review installed add-ons and the capabilities they can request.">
            <div className="settings-action-hero">
              <div>
                <p className="eyebrow">Most likely action</p>
                <h3>Review capability grants before enabling add-ons.</h3>
                <p>Protected add-ons stay visible here; their hooks and internal policy details live under Advanced.</p>
              </div>
              <span className="tone tone-active">{enabledInstallations.length} enabled</span>
            </div>
            <div className="settings-grid">
              <SettingNote label="Available manifests" value={String(props.manifests.length)} />
              <SettingNote label="Installed add-ons" value={String(installations.length)} />
              <SettingNote label="Enabled add-ons" value={String(enabledInstallations.length)} />
              <SettingNote label="Hard-stop grants" value={String(protectedCapabilityCount)} />
            </div>
            <div className="settings-summary-list" aria-label="Installed add-ons">
              {props.manifests.slice(0, 8).map((manifest) => {
                const installation = props.state.installations[manifest.id];
                return (
                  <article key={manifest.id}>
                    <div>
                      <strong>{manifest.name}</strong>
                      <p>{manifest.description}</p>
                    </div>
                    <span className={`tone tone-${installation?.enabled ? "active" : "neutral"}`}>
                      {installation?.status ?? "available"}
                    </span>
                  </article>
                );
              })}
            </div>
          </Panel>
        )}

        {props.settingsSection === "privacy" && (
          <Panel title="Privacy" subtitle="Review data, credential, and memory boundaries before work leaves the shell.">
            <div className="settings-action-hero">
              <div>
                <p className="eyebrow">Most likely action</p>
                <h3>Confirm which boundaries protect credentials and memory writes.</h3>
                <p>Secrets stay host-owned; external memory clients can write intake artifacts but not trusted archive pages.</p>
              </div>
              <span className="tone tone-warning">boundary review</span>
            </div>
            <div className="settings-grid">
              <SettingNote label="Configured credentials" value={String(props.state.providers.filter((profile) => profile.credentialStatus === "configured").length)} />
              <SettingNote label="Archive ingest service" value={props.state.archivePolicy.ingestServiceId} />
              <SettingNote label="Archive owner" value={props.state.archivePolicy.strategistIdentityId} />
              <SettingNote label="Private provider links" value={String(installations.flatMap((installation) => installation.privateProviderProfileIds).length)} />
            </div>
            <div className="settings-callout">
              <p>Technical logs, raw provider metadata, route internals, and diagnostics are available from Advanced so they do not compete with everyday privacy choices.</p>
            </div>
          </Panel>
        )}

        {props.settingsSection === "advanced" && advancedSection === "diagnostics" && (
          <Panel title="Diagnostics" subtitle="Inspect provider health, runtime nodes, and host-side activity logs.">
            <div className="provider-activity-head">
              <div>
                <p className="eyebrow">Most likely action</p>
                <h3>Run health checks and inspect recent routed calls.</h3>
                <p>Prompts, replies, and secrets are not stored in the provider activity log.</p>
              </div>
              <div className="provider-hero-actions">
                <button type="button" className="button-secondary touch-action" onClick={props.onProbeAllProviders} disabled={props.providerDiagnosticsBusy}>
                  {props.providerDiagnosticsBusy && !props.activeProviderProbeId ? "Checking..." : "Check Health"}
                </button>
                <button type="button" className="button-secondary touch-action" onClick={refreshProviderAudit} disabled={providerAuditBusy}>
                  {providerAuditBusy ? "Refreshing..." : "Refresh Activity"}
                </button>
              </div>
            </div>

            <div className="advanced-diagnostics-list" aria-label="Provider diagnostics">
              {props.state.providers.map((profile) => (
                <article key={profile.id} className="provider-card">
                  <div className="provider-head">
                    <div>
                      <strong>{profile.label}</strong>
                      <p>
                        {profile.providerType} · {profile.authTier} · {profile.primaryModel}
                      </p>
                    </div>
                    <span className={`tone tone-${profile.status === "ready" ? "active" : "warning"}`}>{profile.status}</span>
                  </div>
                  {renderProviderDiagnostics(
                    props.providerDiagnostics.find((report) => report.providerId === profile.id),
                    props.providerDiagnosticsBusy && props.activeProviderProbeId === profile.id,
                    () => props.onProbeProvider(profile.id),
                    props.providerSmokeResults[profile.id],
                    props.providerSmokeBusyId === profile.id,
                    () => props.onSmokeTestProvider(profile.id),
                  )}
                  <div className="provider-runtime-list">
                    <span className="eyebrow">Runtime nodes</span>
                    <ul>
                      {props.state.runtimeNodes
                        .filter((node) => node.providerProfileId === profile.id)
                        .map((node) => (
                          <li key={node.id}>
                            <strong>{node.label}</strong>
                            <span>
                              {node.kind} · {node.locality} · {node.healthState}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                </article>
              ))}
            </div>

            <section className="provider-activity-panel" aria-label="Recent provider activity">
              <div className="provider-activity-head">
                <div>
                  <p className="eyebrow">Provider activity</p>
                  <h3>Recent routed calls</h3>
                  <p>Host-side audit records for routed provider calls.</p>
                </div>
              </div>
              {providerAuditError ? <div className="inline-notice warning">{providerAuditError}</div> : null}
              {providerAuditRecords.length ? (
                <div className="provider-activity-list">
                  {providerAuditRecords.slice(0, 12).map((record, index) => {
                    const provider = props.state.providers.find((item) => item.id === record.providerId);
                    const runtime = props.state.runtimeNodes.find((item) => item.id === record.runtimeNodeId);
                    return (
                      <article key={`${record.recordedAt}-${record.requestId ?? index}`} className="provider-activity-row">
                        <div>
                          <strong>{provider?.label ?? record.providerId}</strong>
                          <small>
                            {record.model} · {runtime?.label ?? record.runtimeNodeKind ?? "runtime unknown"}
                          </small>
                        </div>
                        <div>
                          <span className={`tone tone-${record.status === "ok" ? "active" : "warning"}`}>{record.status}</span>
                          <small>{record.endpointHost ?? "managed endpoint"}</small>
                        </div>
                        <div>
                          <span>{formatAuditUsage(record)}</span>
                          <small>{record.durationMs.toLocaleString()} ms</small>
                        </div>
                        <time dateTime={record.recordedAt}>{formatAuditTime(record.recordedAt)}</time>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="provider-empty-state">
                  <strong>No provider calls recorded yet.</strong>
                  <p>Send a chat message or run a provider smoke test, then refresh this panel.</p>
                </div>
              )}
            </section>
          </Panel>
        )}

        {props.settingsSection === "advanced" && advancedSection === "defaults" && (
          <Panel title="Core Defaults" subtitle="Default system behavior for the shell, archive, and Strategist.">
            <div className="settings-grid">
              <SettingNote label="Distribution model" value={props.state.distributionModel} />
              <SettingNote label="Default Strategist name" value={props.state.strategistIdentity.defaultName} />
              <SettingNote label="Archive write authority" value={props.state.archivePolicy.ingestServiceId} />
              <SettingNote label="Telegram mode" value="Strategist channel add-on" />
            </div>
          </Panel>
        )}

        {props.settingsSection === "memory" && (
          <Panel
            title="Memory"
            subtitle="Share scoped memory with external MCP clients while keeping trusted wiki writes inside ResonantOS."
          >
            {props.settingsNotice && <div className="inline-notice">{props.settingsNotice}</div>}
            <div className="memory-service-hero">
              <div>
                <p className="eyebrow">Local endpoint</p>
                <h3>{props.memoryServiceStatus?.running ? "Bridge running" : "Bridge stopped"}</h3>
                <p>
                  Human Knowledge is preserved; AI Memory is the maintained wiki. Start this service when Codex, Claude
                  Desktop, OpenCode, or another MCP-capable client needs scoped access to the same memory files.
                </p>
              </div>
              <span className={`tone tone-${props.memoryServiceStatus?.running ? "active" : "neutral"}`}>
                {props.memoryServiceStatus?.running ? "online" : "offline"}
              </span>
            </div>

            <div className="provider-toolbar">
              <div className="provider-toolbar-copy">
                <strong>{props.memoryServiceStatus?.endpoint ?? "http://127.0.0.1:4888"}</strong>
                <p>
                  MCP clients should set{" "}
                  <code>RESONANTOS_MEMORY_SERVICE_URL={props.memoryServiceStatus?.endpoint ?? "http://127.0.0.1:4888"}</code>.
                </p>
              </div>
              <button
                type="button"
                className="button-secondary touch-action"
                onClick={props.onRefreshMemoryServiceStatus}
                disabled={props.memoryServiceBusy}
              >
                {props.memoryServiceBusy ? "Checking..." : "Refresh"}
              </button>
              {props.memoryServiceStatus?.running ? (
                <button
                  type="button"
                  className="button-secondary touch-action"
                  onClick={props.onStopMemoryService}
                  disabled={props.memoryServiceBusy}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="button-primary touch-action"
                  onClick={props.onStartMemoryService}
                  disabled={props.memoryServiceBusy || props.memoryServiceStatus?.available === false}
                >
                  Start Bridge
                </button>
              )}
            </div>

            <div className="settings-grid">
              <SettingNote label="Memory root" value={props.memoryServiceStatus?.memoryRoot || "Not resolved yet"} />
              <SettingNote label="Session" value={props.memoryServiceStatus?.sessionId || "living-archive-memory-service"} />
              <SettingNote label="Readonly" value={props.memoryServiceStatus?.readonly ? "enabled" : "disabled"} />
              <SettingNote label="Process" value={props.memoryServiceStatus?.pid ? `pid ${props.memoryServiceStatus.pid}` : "not running"} />
            </div>

            <div className="provider-card">
              <div className="provider-head">
                <div>
                  <strong>Boundary</strong>
                  <p>{props.memoryServiceStatus?.statusDetail ?? "Run status to inspect the host-owned bridge state."}</p>
                </div>
                <span className="tone tone-warning">intake-only writes</span>
              </div>
              <ul>
                <li>External clients can search/read scoped memory and add raw intake notes.</li>
                <li>Trusted AI Memory wiki pages are still written only after ResonantOS review.</li>
                <li>Technical repair steps stay inside the desktop host boundary.</li>
              </ul>
              {props.memoryServiceLastResult ? (
                <p className="mono-inline">
                  Last action: {props.memoryServiceLastResult.endpoint} · {props.memoryServiceLastResult.command}
                </p>
              ) : null}
            </div>
          </Panel>
        )}

        {props.settingsSection === "advanced" && advancedSection === "routing" && (
          <Panel title="Model Strategy Profile" subtitle="User-agreed routing strategy for roles, workloads, and fallback behavior.">
            <div className="strategy-header">
              <div>
                <p className="eyebrow">Active profile</p>
                <h3>{props.state.modelStrategy.label}</h3>
                <p>{props.state.modelStrategy.summary}</p>
              </div>
            </div>

            <div className="strategy-grid">
              {props.state.modelStrategy.workloadStrategies.map((strategy) => {
                const routeDecision =
                  strategy.ownerType === "agent"
                    ? resolveAgentChatRoute(props.state, strategy.ownerId)
                    : resolveWorkloadRoute(props.state, strategy.workloadClass);
                return (
                  <article key={strategy.id} className="provider-card strategy-editor-card">
                    <div className="provider-head">
                      <div>
                        <strong>{strategy.label}</strong>
                        <p>
                          {strategy.workloadClass} · {strategy.ownerType} · {strategy.ownerId}
                        </p>
                      </div>
                      <span className={`tone tone-${strategy.hardStopWhenNoFallback ? "warning" : "active"}`}>
                        {strategy.hardStopWhenNoFallback ? "hard-stop" : "fallback-ok"}
                      </span>
                    </div>
                    <div className="strategy-route-block">
                      <span className="eyebrow">Current decision</span>
                      <strong>{routeDecision.model ?? "No viable route"}</strong>
                      <p>
                        {routeDecision.provider?.label ?? "Missing provider"}
                        {routeDecision.runtimeNode ? ` via ${routeDecision.runtimeNode.label}` : ""} ·{" "}
                        {routeDecision.decision.resolutionReason}
                      </p>
                    </div>
                    <label className="field">
                      <span>Primary route</span>
                      <select
                        value={routeOptionKey(strategy.primaryRoute)}
                        onChange={(event) => props.onUpdateWorkloadStrategyRoute(strategy.id, event.target.value)}
                      >
                        {strategyRouteOptions.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label} · {option.detail}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="strategy-route-block">
                      <span className="eyebrow">Agreed primary</span>
                      <strong>{formatStrategyRoute(props.state, strategy.primaryRoute)}</strong>
                      <p>{costPostureLabel(strategy.primaryRoute.costPosture)}</p>
                    </div>
                    <label className="field">
                      <span>Fallback chain</span>
                      <select
                        value={strategy.fallbackChainId}
                        onChange={(event) =>
                          props.onUpdateWorkloadStrategy(strategy.id, { fallbackChainId: event.target.value })
                        }
                      >
                        {props.state.modelStrategy.fallbackChains.map((chain) => (
                          <option key={chain.id} value={chain.id}>
                            {chain.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Failure behavior</span>
                      <select
                        value={strategy.hardStopWhenNoFallback ? "hard-stop" : "fallback"}
                        onChange={(event) =>
                          props.onUpdateWorkloadStrategy(strategy.id, {
                            hardStopWhenNoFallback: event.target.value === "hard-stop",
                          })
                        }
                      >
                        <option value="fallback">Use agreed fallbacks</option>
                        <option value="hard-stop">Hard-stop if chain fails</option>
                      </select>
                    </label>
                    <div className="strategy-chain-block">
                      <span className="eyebrow">Fallback order</span>
                      <strong>{resolveFallbackLabel(props.state, strategy.fallbackChainId)}</strong>
                      <ul>
                        {resolveFallbackSteps(props.state, strategy.fallbackChainId).map((route) => (
                          <li key={`${strategy.id}:${route.providerProfileId}:${route.model}`}>
                            {formatStrategyRoute(props.state, route)} · {costPostureLabel(route.costPosture)}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <ul>
                      {strategy.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>

            <div className="strategy-emergency-block">
              <div className="provider-head">
                <div>
                  <strong>Emergency policy</strong>
                  <p>{props.state.modelStrategy.emergencyPolicy.note}</p>
                </div>
                <span className="tone tone-warning">recovery</span>
              </div>
              <div className="strategy-chain-block">
                <span className="eyebrow">Promotion order</span>
                <ul>
                  {props.state.modelStrategy.emergencyPolicy.orderedPromotionTargets.map((route) => (
                    <li key={`emergency:${route.providerProfileId}:${route.model}`}>
                      {formatStrategyRoute(props.state, route)} · {costPostureLabel(route.costPosture)}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="strategy-route-block">
                <span className="eyebrow">Hard floor</span>
                <strong>{formatStrategyRoute(props.state, props.state.modelStrategy.emergencyPolicy.hardFloorRoute)}</strong>
                <p>{costPostureLabel(props.state.modelStrategy.emergencyPolicy.hardFloorRoute.costPosture)}</p>
              </div>
            </div>
          </Panel>
        )}

        {props.settingsSection === "advanced" && advancedSection === "shell" && (
          <Panel title="Shell Preferences" subtitle="Current layout and operating posture for ResonantOS vNext.">
            <div className="settings-grid">
              <SettingNote label="Theme" value={props.state.uiPreferences.theme} />
              <SettingNote label="Chat rail" value={props.state.uiPreferences.chatSidebarOpen ? "visible" : "collapsed"} />
              <SettingNote label="Primary section" value={props.state.uiPreferences.activeSection} />
              <SettingNote label="Desktop mode" value="workspace-first shell" />
            </div>
          </Panel>
        )}

        {props.settingsSection === "advanced" && advancedSection === "logician" && (
          <Panel title="Logician Trust Kernel" subtitle="Protocol gates, add-on verification, and deterministic counterweight to probabilistic agents.">
            <div className="settings-grid">
              <SettingNote label="Logician add-on" value={logicianInstallation?.status ?? "not installed"} />
              <SettingNote label="Protocol sources" value={logicianManifest?.archiveIntegration.readScopes.join(", ") || "not configured"} />
              <SettingNote label="Scripts" value={String(logicianScripts.length)} />
              <SettingNote label="Hooks" value={String(logicianHooks.length)} />
            </div>

            <div className="logician-settings-section">
              <div className="logician-settings-heading">
                <div>
                  <span className="eyebrow">Trust graph</span>
                  <h3>Protocol flow explorer</h3>
                </div>
                <span className="tone tone-active">inspectable gates</span>
              </div>
              <LogicianFlowExplorer />
            </div>

            <div className="logician-settings-columns">
              <section className="logician-settings-section">
                <div className="logician-settings-heading">
                  <div>
                    <span className="eyebrow">Protocols</span>
                    <h3>Selection and library policy</h3>
                  </div>
                </div>
                <div className="logician-protocol-list">
                  <article>
                    <strong>Protocol library</strong>
                    <p>Use reviewed protocol and constitution scopes before agent execution.</p>
                    <span>{logicianManifest?.archiveIntegration.readScopes.join(" · ") || "missing"}</span>
                  </article>
                  <article>
                    <strong>Selection rule</strong>
                    <p>Classify the task vector, pick matching protocols, then require visible execution evidence.</p>
                    <span>selector → brief → verification</span>
                  </article>
                  <article>
                    <strong>Protocol evidence</strong>
                    <p>Declared protocol use is not enough. The Verify Agent expects step evidence and artifacts.</p>
                    <span>declared + observed</span>
                  </article>
                </div>
              </section>

              <section className="logician-settings-section">
                <div className="logician-settings-heading">
                  <div>
                    <span className="eyebrow">Gates</span>
                    <h3>Hook enforcement</h3>
                  </div>
                </div>
                <div className="logician-gate-list">
                  {logicianHooks.map((hook) => (
                    <article key={hook.id}>
                      <strong>{hook.event}</strong>
                      <p>{hook.handlerRef}</p>
                      <span>failure policy: {hook.failurePolicy}</span>
                    </article>
                  ))}
                  {logicianScripts.map((script) => (
                    <article key={script.id}>
                      <strong>{script.name}</strong>
                      <p>{script.commandRef}</p>
                      <span>{script.producesArtifacts.join(", ")}</span>
                    </article>
                  ))}
                </div>
              </section>
            </div>

            <div className="logician-settings-section">
              <div className="logician-settings-heading">
                <div>
                  <span className="eyebrow">Verify Agent</span>
                  <h3>Evidence trust policy</h3>
                </div>
                {latestLogicianArtifact?.verifyAgentReport ? (
                  <span className={`tone tone-${latestLogicianArtifact.verifyAgentReport.status === "pass" ? "active" : "warning"}`}>
                    latest {latestLogicianArtifact.verifyAgentReport.status}
                  </span>
                ) : (
                  <span className="tone tone-neutral">no latest report</span>
                )}
              </div>
              <div className="logician-evidence-grid">
                {logicianEvidencePolicy.map((policy) => (
                  <article key={policy.tier}>
                    <strong>{policy.tier}</strong>
                    <p>{policy.meaning}</p>
                    <span>{policy.action}</span>
                  </article>
                ))}
              </div>
            </div>

            <div className="logician-settings-section">
              <div className="logician-settings-heading">
                <div>
                  <span className="eyebrow">Coverage</span>
                  <h3>Runtimes counterbalanced by Logician</h3>
                </div>
              </div>
              <div className="logician-runtime-grid">
                {logicianRuntimeCoverage.map((runtime) => (
                  <span key={runtime}>{runtime}</span>
                ))}
              </div>
              <div className="logician-protected-addons">
                {protectedManifests.map((manifest) => (
                  <article key={manifest.id}>
                    <strong>{manifest.name}</strong>
                    <p>{manifest.hooks?.map((hook) => `${hook.event}:${hook.failurePolicy}`).join(" · ") || "No hook declared"}</p>
                  </article>
                ))}
              </div>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function resolveFallbackLabel(state: ResonantShellState, fallbackChainId: string): string {
  return state.modelStrategy.fallbackChains.find((chain) => chain.id === fallbackChainId)?.label ?? fallbackChainId;
}

function resolveFallbackSteps(state: ResonantShellState, fallbackChainId: string) {
  const chain = state.modelStrategy.fallbackChains.find((item) => item.id === fallbackChainId);
  if (!chain) {
    return [];
  }
  return chain.lastResortRoute ? [...chain.orderedRoutes, chain.lastResortRoute] : chain.orderedRoutes;
}

function renderProviderDiagnostics(
  report: ProviderDiagnosticReport | undefined,
  busy: boolean,
  onProbe: () => void,
  smokeResult: ProviderSmokeTestResult | undefined,
  smokeBusy: boolean,
  onSmokeTest: () => void,
) {
  return (
    <div className="provider-diagnostics-block">
      <div className="provider-diagnostics-head">
        <div>
          <span className="eyebrow">Diagnostics</span>
          <p>{report?.summary ?? "No diagnostics have been run for this provider yet."}</p>
        </div>
        <div className="provider-diagnostics-actions">
          {report && <span className={`tone tone-${toneFromDiagnosticStatus(report.status)}`}>{report.status}</span>}
          <button type="button" className="button-secondary" onClick={onProbe} disabled={busy}>
            {busy ? "Probing..." : "Probe"}
          </button>
          <button type="button" className="button-secondary" onClick={onSmokeTest} disabled={smokeBusy}>
            {smokeBusy ? "Testing..." : "Smoke Test"}
          </button>
        </div>
      </div>
      {smokeResult && (
        <div className="provider-smoke-result">
          <strong>{smokeResult.summary}</strong>
          <span>
            {smokeResult.model} · {smokeResult.usage?.totalTokens ? `${smokeResult.usage.totalTokens} tokens` : "usage unavailable"}
          </span>
          <p>{smokeResult.replyPreview}</p>
        </div>
      )}
      {report && (
        <>
          <p className="provider-diagnostics-meta">
            Checked {report.checkedAt} · adapter {report.executionAdapter} · {report.credentialConfigured ? "credentials configured" : "credentials missing"}
          </p>
          <ul className="provider-diagnostics-list">
            {report.runtimeDiagnostics.map((runtime) => (
              <li key={runtime.runtimeNodeId}>
                <strong>{runtime.runtimeNodeLabel}</strong>
                <span>
                  {runtime.runtimeKind} · {runtime.locality} · {runtime.probeState}
                </span>
                <p>{runtime.detail}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function toneFromDiagnosticStatus(status: ProviderDiagnosticReport["status"]): "active" | "warning" | "neutral" {
  if (status === "healthy") {
    return "active";
  }
  if (status === "attention") {
    return "warning";
  }
  return "neutral";
}

function SettingNote(props: { label: string; value: string }) {
  return (
    <div className="setting-note">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
