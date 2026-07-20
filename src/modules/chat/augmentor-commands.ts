// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

import type {
  BrowserWorkspaceTabState,
  BrowserHostHealthResult,
  BrowserHostOpenUrlResult,
  BrowserHostReadPageResult,
  BrowserHostActionResult,
  BrowserHostEvidenceResult,
  BrowserOpenUrlResult,
  BrowserReadPageResult,
  BrowserToolCommand,
  DelegationPacket,
  GoalWorkspace,
  ResonantShellState,
  TaskWorkspace,
} from "../../core/contracts";
import { appendAssistantMessage } from "../../core/chat";
import {
  createEngineerDelegationPacket,
  createHermesDelegationPacket,
  createOpenCodeDelegationPacket,
  formatHermesTaskWorkspaceCreatedReply,
  formatOpenCodeTaskWorkspaceCreatedReply,
  formatTaskWorkspaceCreatedReply,
} from "../../core/delegation";
import {
  addGoalWorkspace as addCoreGoalWorkspace,
  attachGoalDelegation,
  createGoalDelegationRef,
  buildGoalWorkspaceStatus,
  createGoalWorkspace as createCoreGoalWorkspace,
  formatGoalWorkspaceStatus,
} from "../../core/goal-workspace";

export type AugmentorCommand =
  | {
      kind: "goal";
      mission: string;
      successCriteria: string[];
      constraints: string[];
      deadline?: string;
      allowedAgents: string[];
      allowedTools: string[];
      preferredCostTier?: GoalWorkspace["costPolicy"]["preferredCostTier"];
    }
  | {
      kind: "delegate";
      target: "engineer" | "hermes" | "opencode";
      mission: string;
    }
  | {
      kind: "browser";
      action: "inspect" | "open" | "research" | "capture";
      target: string;
    }
  | {
      kind: "status";
    };

export type AugmentorCommandParseResult =
  | { ok: true; command: AugmentorCommand }
  | { ok: false; error: string };

export type BrowserCommandExecutionPlan = {
  nextState: ResonantShellState;
  commands: BrowserToolCommand[];
};

export type BrowserCommandExecutionResult =
  | BrowserHostHealthResult
  | BrowserHostOpenUrlResult
  | BrowserHostReadPageResult
  | BrowserHostActionResult
  | BrowserHostEvidenceResult
  | BrowserOpenUrlResult
  | BrowserReadPageResult;

const commandPrefix = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i;

const splitSections = (body: string): string[] =>
  body
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

const splitList = (value: string): string[] =>
  value
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);

const parsePreferredCostTier = (value: string): GoalWorkspace["costPolicy"]["preferredCostTier"] | undefined => {
  const normalized = value.trim().toLowerCase();
  if (["free-local", "local", "free"].includes(normalized)) {
    return "free-local";
  }
  if (["subscription", "sub"].includes(normalized)) {
    return "subscription";
  }
  if (["paid-api", "paid", "api"].includes(normalized)) {
    return "paid-api";
  }
  if (["best-available", "best"].includes(normalized)) {
    return "best-available";
  }
  return undefined;
};

const parseGoal = (body: string): AugmentorCommandParseResult => {
  const sections = splitSections(body);
  const mission = sections[0]?.trim() ?? "";
  if (mission.length < 8) {
    return { ok: false, error: "Use `/goal <mission>` with a concrete mission." };
  }

  const command: Extract<AugmentorCommand, { kind: "goal" }> = {
    kind: "goal",
    mission,
    successCriteria: [],
    constraints: [],
    allowedAgents: ["augmentor"],
    allowedTools: [],
  };

  sections.slice(1).forEach((section) => {
    const [rawKey, ...rawValue] = section.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join(":").trim();
    if (!value) {
      return;
    }
    if (["success", "success criteria", "criteria"].includes(key)) {
      command.successCriteria = splitList(value);
    } else if (["constraint", "constraints"].includes(key)) {
      command.constraints = splitList(value);
    } else if (key === "deadline") {
      command.deadline = value;
    } else if (["agent", "agents"].includes(key)) {
      command.allowedAgents = splitList(value);
    } else if (["tool", "tools"].includes(key)) {
      command.allowedTools = splitList(value);
    } else if (["budget", "cost"].includes(key)) {
      command.preferredCostTier = parsePreferredCostTier(value);
    }
  });

  return { ok: true, command };
};

const parseDelegate = (body: string): AugmentorCommandParseResult => {
  const normalized = body.trim();
  const match = /^(engineer|hermes|opencode|open code)\b\s*([\s\S]*)$/i.exec(normalized);
  const target = match?.[1]?.toLowerCase().replace(/\s+/g, "") ?? "";
  const mission = (match?.[2] ?? normalized).trim();
  if (!match || mission.length < 8) {
    return { ok: false, error: "Use `/delegate <engineer|hermes|opencode> <mission>`." };
  }
  return {
    ok: true,
    command: {
      kind: "delegate",
      target: target === "opencode" ? "opencode" : (target as "engineer" | "hermes"),
      mission,
    },
  };
};

const parseBrowser = (body: string): AugmentorCommandParseResult => {
  const normalized = body.trim();
  const match = /^(inspect|open|research|capture)\b\s*([\s\S]*)$/i.exec(normalized);
  const action = match?.[1]?.toLowerCase() as Extract<AugmentorCommand, { kind: "browser" }>["action"] | undefined;
  const target = (match?.[2] ?? "").trim();
  if (!action || target.length < 3) {
    return { ok: false, error: "Use `/browser <inspect|open|research|capture> <url or task>`." };
  }
  return { ok: true, command: { kind: "browser", action, target } };
};

const browserIntentVerbs =
  /\b(open|go\s+to|go\s+on|navigate(?:\s+to)?|visit|load|browse(?:\s+to)?|take\s+me\s+to|show\s+me|bring\s+up|pull\s+up|inspect|read|research|look\s+at|check|capture|screenshot)\b/i;
const browserTargetPattern = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>)]*)?)/i;
const browserRejectedFileExtensions = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "rs",
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "html",
  "py",
]);

const browserActionFromIntent = (message: string): Extract<AugmentorCommand, { kind: "browser" }>["action"] => {
  const normalized = message.toLowerCase();
  if (/\b(capture|screenshot)\b/.test(normalized)) {
    return "capture";
  }
  if (/\b(research|inspect|read|look\s+at|check)\b/.test(normalized)) {
    return "inspect";
  }
  return "open";
};

export const parseNaturalBrowserIntent = (message: string): Extract<AugmentorCommand, { kind: "browser" }> | null => {
  const normalized = message.trim();
  if (commandPrefix.test(normalized) || !browserIntentVerbs.test(normalized)) {
    return null;
  }
  const target = browserTargetPattern.exec(normalized)?.[1]?.replace(/[.,;:!?]+$/, "");
  if (!target) {
    return null;
  }
  const hostname = target.startsWith("http") ? new URL(normalizeBrowserUrl(target)).hostname : target.split("/")[0];
  const extension = hostname.split(".").at(-1)?.toLowerCase();
  if (!target.startsWith("http") && extension && browserRejectedFileExtensions.has(extension)) {
    return null;
  }
  return {
    kind: "browser",
    action: browserActionFromIntent(normalized),
    target,
  };
};

export const parseAugmentorCommand = (message: string): AugmentorCommandParseResult | null => {
  const match = commandPrefix.exec(message.trim());
  if (!match) {
    return null;
  }

  const name = match[1].toLowerCase();
  const body = (match[2] ?? "").trim();
  if (name === "goal") {
    return parseGoal(body);
  }
  if (name === "delegate") {
    return parseDelegate(body);
  }
  if (name === "browser") {
    return parseBrowser(body);
  }
  if (name === "status") {
    return { ok: true, command: { kind: "status" } };
  }
  return {
    ok: false,
    error: `Unknown Augmentor command /${name}. Available commands: /goal, /delegate, /browser, /status.`,
  };
};

export const createGoalWorkspace = (
  state: ResonantShellState,
  threadId: string,
  command: Extract<AugmentorCommand, { kind: "goal" }>,
  createdAt = new Date().toISOString(),
): GoalWorkspace => {
  void state;
  const preferredCostTier = command.preferredCostTier ?? "subscription";
  return createCoreGoalWorkspace({
    mission: command.mission,
    threadId,
    successCriteria: command.successCriteria,
    constraints: command.constraints,
    deadline: command.deadline,
    allowedAgents: command.allowedAgents,
    allowedTools: command.allowedTools,
    createdAt,
    costPolicy: {
      sensitivity: preferredCostTier === "paid-api" ? "low" : "medium",
      preferredCostTier,
      allowPaidEscalation: preferredCostTier === "paid-api" || preferredCostTier === "best-available",
      rationale: "Captured from the Augmentor /goal command. Provider routing remains centralized in ResonantOS.",
    },
  });
};

export const formatGoalCreatedReply = (goal: GoalWorkspace): string =>
  [
    `Goal created: **${goal.title}**`,
    "",
    `- Goal id: \`${goal.id}\``,
    `- Phase: ${goal.phase}`,
    `- Mission: ${goal.mission}`,
    `- Success criteria: ${goal.successCriteria.join("; ")}`,
    goal.constraints.length ? `- Constraints: ${goal.constraints.join("; ")}` : "",
    goal.deadline ? `- Deadline: ${goal.deadline}` : "",
    `- Cost posture: ${goal.costPolicy.preferredCostTier}`,
    "",
    "Use `/status` to see active goals and delegated work.",
  ]
    .filter(Boolean)
    .join("\n");

export const addGoalToState = (state: ResonantShellState, goal: GoalWorkspace): ResonantShellState =>
  addCoreGoalWorkspace(state, goal);

export const packetForDelegateCommand = (
  state: ResonantShellState,
  command: Extract<AugmentorCommand, { kind: "delegate" }>,
): DelegationPacket => {
  assertDelegationTargetAvailable(state, command);
  const context = "Created from Augmentor /delegate. Create the workspace and return reviewable artifacts before any promotion.";
  if (command.target === "engineer") {
    return createEngineerDelegationPacket(state, { mission: command.mission, context });
  }
  if (command.target === "hermes") {
    return createHermesDelegationPacket(state, { mission: command.mission, context });
  }
  return createOpenCodeDelegationPacket(state, { mission: command.mission, context });
};

const delegationTargetAddonId = (target: Extract<AugmentorCommand, { kind: "delegate" }>["target"]): string | null => {
  if (target === "hermes") {
    return "addon.hermes";
  }
  if (target === "opencode") {
    return "addon.opencode";
  }
  return null;
};

export const assertDelegationTargetAvailable = (
  state: ResonantShellState,
  command: Extract<AugmentorCommand, { kind: "delegate" }>,
): void => {
  const addonId = delegationTargetAddonId(command.target);
  if (!addonId) {
    return;
  }
  const installation = state.installations[addonId];
  if (!installation?.installed || !installation.enabled || installation.status !== "enabled") {
    throw new Error(
      `Cannot delegate to ${command.target} until ${addonId} is installed, enabled, and explicitly granted by the user.`,
    );
  }
};

const latestGoalForThread = (state: ResonantShellState, threadId: string): GoalWorkspace | undefined =>
  [...(state.goalWorkspaces ?? [])]
    .filter((goal) => goal.threadId === threadId && !["completed", "archived"].includes(goal.phase))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

export const attachDelegationToActiveGoal = (
  state: ResonantShellState,
  threadId: string,
  workspace: TaskWorkspace,
  packet: DelegationPacket,
  createdAt = new Date().toISOString(),
): ResonantShellState => {
  const goal = latestGoalForThread(state, threadId);
  if (!goal) {
    return state;
  }
  return attachGoalDelegation(
    state,
    goal.id,
    createGoalDelegationRef({
      workspaceId: workspace.id,
      packetId: packet.id,
      targetAgentId: packet.targetAgentId,
      createdAt,
      status: "dispatched",
      summary: packet.mission,
    }),
  );
};

export const formatDelegationCommandReply = (
  command: Extract<AugmentorCommand, { kind: "delegate" }>,
  workspace: TaskWorkspace,
): string => {
  if (command.target === "engineer") {
    return formatTaskWorkspaceCreatedReply(workspace);
  }
  if (command.target === "hermes") {
    return formatHermesTaskWorkspaceCreatedReply(workspace);
  }
  return formatOpenCodeTaskWorkspaceCreatedReply(workspace);
};

const normalizeBrowserUrl = (target: string): string => {
  if (/^https?:\/\//i.test(target)) {
    return target;
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(target)) {
    return `https://${target}`;
  }
  return target;
};

const isBrowserUrl = (target: string): boolean => /^https?:\/\//i.test(normalizeBrowserUrl(target));

const browserTabLabel = (target: string, action: Extract<AugmentorCommand, { kind: "browser" }>["action"]): string => {
  if (!target.startsWith("http")) {
    return action;
  }
  try {
    return new URL(target).hostname;
  } catch {
    return action;
  }
};

export const applyBrowserCommand = (
  state: ResonantShellState,
  command: Extract<AugmentorCommand, { kind: "browser" }>,
): ResonantShellState => {
  const target = normalizeBrowserUrl(command.target);
  const existing = state.uiPreferences.browserWorkspace.tabs.find((tab) => tab.id === state.uiPreferences.browserWorkspace.activeTabId);
  const nextTab: BrowserWorkspaceTabState = {
    id: existing?.id ?? "tab-1",
    label: browserTabLabel(target, command.action),
    url: target,
    history: [...(existing?.history ?? []), target],
    historyIndex: existing?.history?.length ?? 0,
  };

  return {
    ...state,
    uiPreferences: {
      ...state.uiPreferences,
      activeSection: "browser",
      chatSidebarOpen: true,
      browserWorkspace: {
        ...state.uiPreferences.browserWorkspace,
        activeTabId: nextTab.id,
        tabs: [nextTab, ...state.uiPreferences.browserWorkspace.tabs.filter((tab) => tab.id !== nextTab.id)],
      },
    },
  };
};

export const buildBrowserCommandExecutionPlan = (
  state: ResonantShellState,
  command: Extract<AugmentorCommand, { kind: "browser" }>,
): BrowserCommandExecutionPlan => {
  const target = normalizeBrowserUrl(command.target);
  const commands: BrowserToolCommand[] = [];
  if (command.action !== "capture" && !isBrowserUrl(command.target)) {
    throw new Error("Browser Tool Bridge v1 requires an http(s) URL or domain name for open, inspect, and research.");
  }

  commands.push({ type: "start", params: isBrowserUrl(command.target) ? { defaultUrl: target } : undefined });

  if (command.action === "open") {
    commands.push({ type: "open_url", params: { url: target } });
  } else if (command.action === "inspect" || command.action === "research") {
    commands.push({ type: "open_url", params: { url: target } }, { type: "read_page" });
  } else if (command.action === "capture") {
    if (isBrowserUrl(command.target)) {
      commands.push({ type: "open_url", params: { url: target } });
    }
    commands.push({ type: "capture_evidence" });
  }

  return {
    nextState: applyBrowserCommand(state, command),
    commands,
  };
};

export const applyBrowserCommandResult = (
  state: ResonantShellState,
  result: BrowserCommandExecutionResult,
  at = new Date().toISOString(),
): ResonantShellState => {
  const sessionId = "sessionId" in result ? result.sessionId : state.uiPreferences.browserWorkspace.controlledSession.sessionId;
  const url =
    "finalUrl" in result
      ? result.finalUrl
      : "url" in result
        ? result.url
        : state.uiPreferences.browserWorkspace.controlledSession.url;
  const title = ("title" in result ? result.title : state.uiPreferences.browserWorkspace.controlledSession.title) ?? null;

  return {
    ...state,
    uiPreferences: {
      ...state.uiPreferences,
      browserWorkspace: {
        ...state.uiPreferences.browserWorkspace,
        controlledSession: {
          ...state.uiPreferences.browserWorkspace.controlledSession,
          sessionId,
          status: "ready",
          url,
          title,
          error: null,
          lastSyncedAt: at,
        },
      },
    },
  };
};

const summarizeBrowserResult = (result: BrowserCommandExecutionResult): string => {
  if ("text" in result) {
    return `Read **${result.title || "Untitled"}** · ${result.text.length} text characters · ${result.links.length} links.`;
  }
  if ("evidenceRef" in result) {
    return `Captured browser evidence: \`${result.evidenceRef}\`.`;
  }
  if ("finalUrl" in result) {
    return `Opened **${result.title || result.finalUrl}** · ${result.finalUrl}.`;
  }
  if ("ready" in result) {
    return result.ready ? `Browser host ready${result.url ? ` · ${result.url}` : ""}.` : "Browser host is not ready.";
  }
  return "Browser action completed.";
};

export const formatBrowserCommandReply = (
  command: Extract<AugmentorCommand, { kind: "browser" }>,
  results: BrowserCommandExecutionResult[] = [],
): string =>
  [
    results.length || command.action === "open"
      ? `Browser task completed: **${command.action}**`
      : `Browser task staged: **${command.action}**`,
    "",
    `- Target: ${command.target}`,
    !results.length && command.action === "open" ? "- Opened in the dedicated Chrome/Brave Wallet Browser host." : "",
    ...results.map((result) => `- ${summarizeBrowserResult(result)}`),
    "- Browser control remains ResonantOS-mediated.",
    "- Wallet approvals, signing, extension loading, sensitive typing, and public submissions still require human approval.",
    "",
    results.length
      ? "I moved the center workspace to Browser and updated the controlled evidence session state."
      : "I moved the center workspace to Browser so the human can supervise the session.",
  ]
    .filter((line) => line !== "")
    .join("\n");

export const formatStatusReply = (state: ResonantShellState): string => {
  const goalStatus = buildGoalWorkspaceStatus(state);
  const browser = state.uiPreferences.browserWorkspace.controlledSession;
  const pendingOpenCode = state.uiPreferences.pendingOpenCodeWorkspaceId;

  return [
    "ResonantOS status",
    "",
    formatGoalWorkspaceStatus(goalStatus),
    "",
    "Delegated work:",
    pendingOpenCode ? `- OpenCode workspace pending: \`${pendingOpenCode}\`` : "- No pending delegated workspace is tracked in the shell state.",
    "",
    "Browser:",
    `- Controlled session: ${browser.status}${browser.url ? ` · ${browser.url}` : ""}`,
    "",
    "Use `/goal <mission>` to create a durable objective workspace.",
  ].join("\n");
};

export const appendCommandFailure = (state: ResonantShellState, threadId: string, error: string): ResonantShellState =>
  appendAssistantMessage(state, threadId, error, { status: "failed" });
