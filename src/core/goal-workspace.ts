// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

import type {
  GoalArtifact,
  GoalArtifactKind,
  GoalBlocker,
  GoalCostPolicy,
  GoalDelegationRef,
  GoalMemoryRef,
  GoalMemoryRefKind,
  GoalPhase,
  GoalStep,
  GoalStepStatus,
  GoalWorkspace,
  ResonantShellState,
} from "./contracts";

export type CreateGoalWorkspaceInput = {
  mission: string;
  title?: string;
  threadId?: string;
  owningAgentId?: string;
  successCriteria?: string[];
  constraints?: string[];
  deadline?: string;
  allowedAgents?: string[];
  allowedTools?: string[];
  memoryRefs?: Array<string | GoalMemoryRef>;
  costPolicy?: Partial<GoalCostPolicy>;
  createdAt?: string;
};

export type GoalWorkspaceStatusItem = {
  id: string;
  title: string;
  phase: GoalPhase;
  mission: string;
  openBlockers: number;
  blockerLabels: string[];
  totalSteps: number;
  plannedSteps: number;
  activeSteps: number;
  blockedSteps: number;
  completedSteps: number;
  artifacts: number;
  delegations: number;
  updatedAt: string;
};

export type GoalWorkspaceStatus = {
  active: GoalWorkspaceStatusItem[];
  blocked: GoalWorkspaceStatusItem[];
  waiting: GoalWorkspaceStatusItem[];
  delegated: GoalWorkspaceStatusItem[];
  completed: GoalWorkspaceStatusItem[];
  archived: GoalWorkspaceStatusItem[];
  needsAttention: GoalWorkspaceStatusItem[];
  total: number;
};

const DEFAULT_COST_POLICY: GoalCostPolicy = {
  sensitivity: "medium",
  preferredCostTier: "subscription",
  allowPaidEscalation: false,
  rationale: "Goal work should prefer already-owned subscription or local routes unless the human approves escalation.",
};

const compactIdFragment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56) || "goal";

const compactTitle = (mission: string): string => mission.replace(/\s+/g, " ").trim().slice(0, 72);

const timestampFragment = (createdAt: string): string => createdAt.replace(/[^0-9]/g, "").slice(0, 14) || "00000000000000";

const nextId = (prefix: string, value: string, createdAt: string): string =>
  `${prefix}-${compactIdFragment(value)}-${timestampFragment(createdAt)}`;

const normalizeList = (items: string[] | undefined): string[] => (items ?? []).map((item) => item.trim()).filter(Boolean);

export const defaultGoalCostPolicy = (overrides: Partial<GoalCostPolicy> = {}): GoalCostPolicy => ({
  ...DEFAULT_COST_POLICY,
  ...overrides,
});

export const createGoalWorkspace = (input: CreateGoalWorkspaceInput): GoalWorkspace => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const mission = input.mission.trim();
  const successCriteria = normalizeList(input.successCriteria);
  const constraints = normalizeList(input.constraints);
  const allowedAgents = normalizeList(input.allowedAgents);
  const allowedTools = normalizeList(input.allowedTools);
  if (mission.length < 8) {
    throw new Error("Goal mission must be concrete enough to supervise.");
  }

  return {
    id: nextId("goal", mission, createdAt),
    title: input.title?.trim() || compactTitle(mission),
    mission,
    phase: "active",
    createdAt,
    updatedAt: createdAt,
    owningAgentId: input.owningAgentId ?? "strategist.core",
    threadId: input.threadId ?? "thread-main-desktop",
    successCriteria: successCriteria.length ? successCriteria : ["Define concrete success criteria with the human."],
    constraints,
    deadline: input.deadline,
    allowedAgents: allowedAgents.length ? allowedAgents : ["augmentor"],
    allowedTools,
    memoryRefs: (input.memoryRefs ?? [
      createGoalMemoryRef({
        ref: "system://resonantos-super-ai-app-plan",
        label: "Super AI App implementation plan",
        kind: "system-memory",
        addedAt: createdAt,
      }),
    ]).map((ref) => normalizeGoalMemoryRef(ref, createdAt)),
    costPolicy: defaultGoalCostPolicy(input.costPolicy),
    steps: [
      createGoalStep({
        label: "Clarify success criteria and execution boundaries.",
        status: "planned",
        createdAt,
      }),
    ],
    artifacts: [],
    blockers: [],
    delegationRefs: [],
  };
};

export const createGoalStep = (input: {
  label: string;
  status?: GoalStepStatus;
  createdAt?: string;
  ownerAgentId?: string;
  delegationWorkspaceId?: string;
  notes?: string;
}): GoalStep => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    id: nextId("goal-step", input.label, createdAt),
    label: input.label.trim(),
    status: input.status ?? "planned",
    createdAt,
    updatedAt: createdAt,
    ownerAgentId: input.ownerAgentId,
    delegationWorkspaceId: input.delegationWorkspaceId,
    notes: input.notes,
  };
};

export const createGoalArtifact = (input: {
  label: string;
  type: GoalArtifactKind;
  createdAt?: string;
  path?: string;
  summary?: string;
  source?: GoalArtifact["source"];
}): GoalArtifact => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    id: nextId("goal-artifact", input.label, createdAt),
    type: input.type,
    label: input.label.trim(),
    createdAt,
    path: input.path,
    summary: input.summary,
    source: input.source,
  };
};

export const createGoalBlocker = (input: {
  label: string;
  createdAt?: string;
  severity?: GoalBlocker["severity"];
  resolutionHint?: string;
}): GoalBlocker => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    id: nextId("goal-blocker", input.label, createdAt),
    label: input.label.trim(),
    createdAt,
    severity: input.severity ?? "medium",
    resolutionHint: input.resolutionHint,
  };
};

export const createGoalMemoryRef = (input: {
  ref: string;
  label?: string;
  kind?: GoalMemoryRefKind;
  scope?: GoalMemoryRef["scope"];
  addedAt?: string;
}): GoalMemoryRef => {
  const addedAt = input.addedAt ?? new Date().toISOString();
  const ref = input.ref.trim();
  if (!ref) {
    throw new Error("Goal memory reference cannot be empty.");
  }
  return {
    id: nextId("goal-memory", ref, addedAt),
    ref,
    kind: input.kind ?? inferMemoryRefKind(ref),
    label: input.label?.trim() || ref,
    scope: input.scope ?? "read-only",
    addedAt,
  };
};

export const createGoalDelegationRef = (input: {
  workspaceId: string;
  packetId: string;
  targetAgentId: string;
  createdAt?: string;
  status?: GoalDelegationRef["status"];
  summary?: string;
}): GoalDelegationRef => ({
  workspaceId: input.workspaceId,
  packetId: input.packetId,
  targetAgentId: input.targetAgentId,
  createdAt: input.createdAt ?? new Date().toISOString(),
  status: input.status ?? "created",
  summary: input.summary,
});

const inferMemoryRefKind = (ref: string): GoalMemoryRefKind => {
  if (ref.startsWith("system://")) {
    return "system-memory";
  }
  if (ref.startsWith("archive://") || ref.startsWith("living-archive://")) {
    return "living-archive";
  }
  if (ref.startsWith("thread://")) {
    return "conversation";
  }
  if (ref.startsWith("file://") || ref.startsWith("/")) {
    return "source";
  }
  return "external";
};

export const normalizeGoalMemoryRef = (value: string | GoalMemoryRef, fallbackTime: string): GoalMemoryRef =>
  typeof value === "string"
    ? createGoalMemoryRef({ ref: value, addedAt: fallbackTime })
    : {
        ...value,
        id: value.id || nextId("goal-memory", value.ref, value.addedAt ?? fallbackTime),
        label: value.label?.trim() || value.ref,
        kind: value.kind ?? inferMemoryRefKind(value.ref),
        scope: value.scope ?? "read-only",
        addedAt: value.addedAt ?? fallbackTime,
      };

export const normalizeGoalWorkspace = (goal: GoalWorkspace): GoalWorkspace => {
  const createdAt = goal.createdAt ?? new Date().toISOString();
  const updatedAt = goal.updatedAt ?? createdAt;
  const openBlockers = (goal.blockers ?? []).filter((blocker) => !blocker.resolvedAt);
  const phase = goal.phase === "blocked" && openBlockers.length === 0 ? "active" : goal.phase;
  const legacyMemoryRefs = goal.memoryRefs as Array<string | GoalMemoryRef> | undefined;
  const memoryRefs = (legacyMemoryRefs ?? []).map((ref) => normalizeGoalMemoryRef(ref, createdAt));

  return {
    ...goal,
    title: goal.title?.trim() || compactTitle(goal.mission ?? "Untitled goal"),
    mission: goal.mission?.trim() || "Untitled goal workspace",
    phase,
    createdAt,
    updatedAt,
    owningAgentId: goal.owningAgentId ?? "strategist.core",
    threadId: goal.threadId ?? "thread-main-desktop",
    successCriteria: goal.successCriteria?.length ? goal.successCriteria : ["Define concrete success criteria with the human."],
    constraints: goal.constraints ?? [],
    allowedAgents: goal.allowedAgents?.length ? goal.allowedAgents : ["augmentor"],
    allowedTools: goal.allowedTools ?? [],
    memoryRefs: memoryRefs.length
      ? memoryRefs
      : [
          createGoalMemoryRef({
            ref: "system://resonantos-super-ai-app-plan",
            label: "Super AI App implementation plan",
            kind: "system-memory",
            addedAt: createdAt,
          }),
        ],
    costPolicy: defaultGoalCostPolicy(goal.costPolicy),
    steps: goal.steps ?? [],
    artifacts: goal.artifacts ?? [],
    blockers: goal.blockers ?? [],
    delegationRefs: goal.delegationRefs ?? [],
  };
};

export const normalizeGoalWorkspaces = (goals: GoalWorkspace[] | undefined): GoalWorkspace[] =>
  (goals ?? []).map(normalizeGoalWorkspace).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

export const addGoalWorkspace = (state: ResonantShellState, goal: GoalWorkspace): ResonantShellState => ({
  ...state,
  goalWorkspaces: normalizeGoalWorkspaces([goal, ...(state.goalWorkspaces ?? []).filter((item) => item.id !== goal.id)]),
});

export const updateGoalWorkspace = (
  state: ResonantShellState,
  goalId: string,
  updater: (goal: GoalWorkspace) => GoalWorkspace,
): ResonantShellState => ({
  ...state,
  goalWorkspaces: normalizeGoalWorkspaces(
    (state.goalWorkspaces ?? []).map((goal) => (goal.id === goalId ? updater(normalizeGoalWorkspace(goal)) : goal)),
  ),
});

export const updateGoalPhase = (
  state: ResonantShellState,
  goalId: string,
  phase: GoalPhase,
  updatedAt = new Date().toISOString(),
): ResonantShellState =>
  updateGoalWorkspace(state, goalId, (goal) => ({
    ...goal,
    phase,
    updatedAt,
    completedAt: phase === "completed" ? updatedAt : goal.completedAt,
    archivedAt: phase === "archived" ? updatedAt : goal.archivedAt,
  }));

export const resumeGoalWorkspace = (
  state: ResonantShellState,
  goalId: string,
  resumedAt = new Date().toISOString(),
): ResonantShellState =>
  updateGoalWorkspace(state, goalId, (goal) => ({
    ...goal,
    phase: "active",
    updatedAt: resumedAt,
    resumedAt,
    statusSummary: "Goal resumed by Augmentor.",
  }));

export const completeGoalWorkspace = (
  state: ResonantShellState,
  goalId: string,
  completedAt = new Date().toISOString(),
): ResonantShellState => updateGoalPhase(state, goalId, "completed", completedAt);

export const archiveGoalWorkspace = (
  state: ResonantShellState,
  goalId: string,
  archivedAt = new Date().toISOString(),
): ResonantShellState => updateGoalPhase(state, goalId, "archived", archivedAt);

export const addGoalStepToState = (
  state: ResonantShellState,
  goalId: string,
  step: GoalStep,
): ResonantShellState =>
  updateGoalWorkspace(state, goalId, (goal) => ({
    ...goal,
    phase: goal.phase === "proposed" ? "active" : goal.phase,
    updatedAt: step.updatedAt,
    steps: [...(goal.steps ?? []).filter((item) => item.id !== step.id), step],
  }));

export const updateGoalStepStatus = (
  state: ResonantShellState,
  goalId: string,
  stepId: string,
  status: GoalStepStatus,
  updatedAt = new Date().toISOString(),
): ResonantShellState =>
  updateGoalWorkspace(state, goalId, (goal) => ({
    ...goal,
    updatedAt,
    steps: (goal.steps ?? []).map((step) =>
      step.id === stepId
        ? {
            ...step,
            status,
            updatedAt,
            completedAt: status === "completed" ? updatedAt : step.completedAt,
          }
        : step,
    ),
  }));

export const attachGoalArtifact = (
  state: ResonantShellState,
  goalId: string,
  artifact: GoalArtifact,
): ResonantShellState =>
  updateGoalWorkspace(state, goalId, (goal) => ({
    ...goal,
    updatedAt: artifact.createdAt,
    artifacts: [artifact, ...(goal.artifacts ?? []).filter((item) => item.id !== artifact.id)],
  }));

export const attachGoalDelegation = (
  state: ResonantShellState,
  goalId: string,
  delegationRef: GoalDelegationRef,
): ResonantShellState =>
  updateGoalWorkspace(state, goalId, (goal) => ({
    ...goal,
    phase: goal.phase === "blocked" ? "blocked" : "delegated",
    updatedAt: delegationRef.createdAt,
    delegationRefs: [
      delegationRef,
      ...(goal.delegationRefs ?? []).filter(
        (item) => item.workspaceId !== delegationRef.workspaceId && item.packetId !== delegationRef.packetId,
      ),
    ],
  }));

export const attachGoalMemoryRef = (
  state: ResonantShellState,
  goalId: string,
  memoryRef: GoalMemoryRef,
): ResonantShellState =>
  updateGoalWorkspace(state, goalId, (goal) => ({
    ...goal,
    updatedAt: memoryRef.addedAt,
    memoryRefs: [memoryRef, ...(goal.memoryRefs ?? []).filter((item) => item.ref !== memoryRef.ref)],
  }));

export const markGoalBlocked = (
  state: ResonantShellState,
  goalId: string,
  blocker: GoalBlocker,
): ResonantShellState =>
  updateGoalWorkspace(state, goalId, (goal) => ({
    ...goal,
    phase: "blocked",
    updatedAt: blocker.createdAt,
    blockers: [blocker, ...(goal.blockers ?? [])],
  }));

export const resolveGoalBlocker = (
  state: ResonantShellState,
  goalId: string,
  blockerId: string,
  resolvedAt = new Date().toISOString(),
  resolvedBy = "augmentor",
): ResonantShellState =>
  updateGoalWorkspace(state, goalId, (goal) => {
    const blockers = (goal.blockers ?? []).map((blocker) =>
      blocker.id === blockerId ? { ...blocker, resolvedAt, resolvedBy } : blocker,
    );
    const hasOpenBlockers = blockers.some((blocker) => !blocker.resolvedAt);
    return {
      ...goal,
      phase: goal.phase === "blocked" && !hasOpenBlockers ? "active" : goal.phase,
      updatedAt: resolvedAt,
      blockers,
    };
  });

const itemForGoal = (goal: GoalWorkspace): GoalWorkspaceStatusItem => {
  const normalized = normalizeGoalWorkspace(goal);
  const steps = normalized.steps ?? [];
  const activeSteps = steps.filter((step) => step.status === "active").length;
  const blockedSteps = steps.filter((step) => step.status === "blocked").length;
  return {
    id: normalized.id,
    title: normalized.title,
    phase: normalized.phase,
    mission: normalized.mission,
    openBlockers: normalized.blockers.filter((blocker) => !blocker.resolvedAt).length,
    blockerLabels: normalized.blockers.filter((blocker) => !blocker.resolvedAt).map((blocker) => blocker.label),
    totalSteps: steps.length,
    plannedSteps: steps.filter((step) => step.status === "planned").length,
    activeSteps,
    blockedSteps,
    completedSteps: steps.filter((step) => step.status === "completed").length,
    artifacts: normalized.artifacts.length,
    delegations: normalized.delegationRefs.length,
    updatedAt: normalized.updatedAt,
  };
};

export const buildGoalWorkspaceStatus = (state: Pick<ResonantShellState, "goalWorkspaces">): GoalWorkspaceStatus => {
  const items = normalizeGoalWorkspaces(state.goalWorkspaces).map(itemForGoal);
  const byPhase = (phase: GoalPhase): GoalWorkspaceStatusItem[] => items.filter((item) => item.phase === phase);
  const blocked = byPhase("blocked");
  const waiting = byPhase("waiting");
  return {
    active: byPhase("active").concat(byPhase("proposed")),
    blocked,
    waiting,
    delegated: byPhase("delegated"),
    completed: byPhase("completed"),
    archived: byPhase("archived"),
    needsAttention: [...blocked, ...waiting],
    total: items.length,
  };
};

export const formatGoalWorkspaceStatus = (status: GoalWorkspaceStatus): string => {
  const active = [...status.active, ...status.delegated, ...status.waiting, ...status.blocked].slice(0, 8);
  return [
    "Goal workspace status",
    "",
    active.length
      ? active
          .map(
            (goal) =>
              `- ${goal.title} · ${goal.phase} · ${goal.completedSteps}/${goal.totalSteps} steps complete · ${goal.openBlockers} blocker(s)${goal.blockerLabels.length ? `: ${goal.blockerLabels.join("; ")}` : ""} · \`${goal.id}\``,
          )
          .join("\n")
      : "- No active goals.",
    "",
    `Needs attention: ${status.needsAttention.length}`,
    `Completed: ${status.completed.length}`,
    `Archived: ${status.archived.length}`,
  ].join("\n");
};
