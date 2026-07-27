import { parseNaturalDelegationIntent } from "./app-command-handlers.js";
import {
  parseAutonomousBrowserActionIntent,
  parseBrowserNavigationTaskIntent,
  parseClickIntent,
  parseFormsIntent,
  parseNaturalBrowserIntent,
  parseNaturalSearchIntent,
  parseScrollIntent,
  parseTypeIntent
} from "./browser-command-parser.js";

export const parseHermesSlashCommand = (value) => {
  const match = /^\/\s*hermes(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim());
  return match ? (match[1] ?? "").trim() : null;
};

export const parseMemorySlashCommand = (value) => {
  const match = /^\/\s*(?:memory|archive)(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim());
  return match ? (match[1] ?? "").trim() : null;
};

export const parseOpenCodeSlashCommand = (value) => {
  const match = /^\/\s*(?:opencode|open\s+code)(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim());
  return match ? (match[1] ?? "").trim() : null;
};

export const parseDelegationsSlashCommand = (value) => {
  const match = /^\/\s*(?:delegations|handoffs)(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim());
  return match ? (match[1] ?? "").trim() : null;
};

export const parseDraftSlashCommand = (value) => {
  const match = /^\/\s*(email|calendar)(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim());
  return match ? { target: match[1].toLowerCase(), body: (match[2] ?? "").trim() } : null;
};

export const parseIntakeSlashCommand = (value) => {
  const match = /^\/\s*(save|intake|trail|researchtrail)(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const command = match[1].toLowerCase();
  const body = (match[2] ?? "").trim();
  if (command === "trail" || command === "researchtrail") {
    return { action: "trail", body };
  }
  if (/^(?:selection|selected|quote|highlight)\b/i.test(body)) {
    return { action: "selection", body: body.replace(/^(?:selection|selected|quote|highlight)\b/i, "").trim() };
  }
  if (/^(?:summary|summarize|summarise)\b/i.test(body)) {
    return { action: "summary", body: body.replace(/^(?:summary|summarize|summarise)\b/i, "").trim() };
  }
  if (/^(?:trail|research\s+trail|researchtrail)\b/i.test(body)) {
    return { action: "trail", body: body.replace(/^(?:trail|research\s+trail|researchtrail)\b/i, "").trim() };
  }
  return { action: "page", body };
};

export const parseControlSlashCommand = (value) => {
  const match = /^\/\s*control(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim());
  return match ? (match[1] ?? "").trim() : null;
};

export const parseWorkspaceInspectionIntent = (value) => {
  const prompt = String(value ?? "").trim();
  if (!prompt) return null;
  const controlGoal = parseControlSlashCommand(prompt);
  const text = (controlGoal !== null ? controlGoal : prompt).trim();
  if (!text) return null;
  const asksForInspection = /\b(inspect|scan|summari[sz]e|inventory|diagnos|audit|list|what(?:'s| is| are)?|which)\b/i.test(text) ||
    /\b(technology\s+stack|tech\s+stack|languages?|frameworks?|runtimes?|package\s+managers?|dependencies)\b/i.test(text);
  const targetsWorkspace = /\b(this|current|local|resonantos|code)\s+(workspace|repo|repository|codebase|project)\b/i.test(text) ||
    /\b(self[-\s]?inspection|technology\s+stack|tech\s+stack)\b/i.test(text) ||
    /\b(your|its)\s+(languages?|frameworks?|runtimes?|package\s+managers?|dependencies)\b/i.test(text);
  return asksForInspection && targetsWorkspace
    ? { query: text, source: controlGoal !== null ? "control-slash" : "main-workspace" }
    : null;
};

export const parseWalletSlashCommand = (value) => {
  const match = /^\/\s*wallet(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const body = (match[1] ?? "status").trim() || "status";
  return /^status$/i.test(body)
    ? { action: "status", goal: "" }
    : /^audit\b/i.test(body)
      ? { action: "audit", goal: body.replace(/^audit\b/i, "").trim() }
      : null;
};

export const parseDaoSlashCommand = (value) => {
  const match = /^\/\s*dao(?:\s+([\s\S]*))?$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const body = (match[1] ?? "").trim();
  return /^audit\b/i.test(body)
    ? { action: "audit", goal: body.replace(/^audit\b/i, "").trim() }
    : { action: "guide", goal: body };
};

export function planMainWorkspacePrompt(value) {
  const prompt = String(value ?? "").trim();
  if (!prompt) return { action: "empty" };
  const workspaceInspection = parseWorkspaceInspectionIntent(prompt);
  if (workspaceInspection) return { action: "workspace-inspection", intent: workspaceInspection };
  const controlGoal = parseControlSlashCommand(prompt);
  if (controlGoal !== null) return { action: "control", goal: controlGoal };
  const memoryQuery = parseMemorySlashCommand(prompt);
  if (memoryQuery !== null) return { action: "memory", query: memoryQuery };
  const openCodeMission = parseOpenCodeSlashCommand(prompt);
  if (openCodeMission !== null) return { action: "opencode", mission: openCodeMission };
  const hermesMission = parseHermesSlashCommand(prompt);
  if (hermesMission !== null) return { action: "hermes", mission: hermesMission };
  const delegationFilter = parseDelegationsSlashCommand(prompt);
  if (delegationFilter !== null) return { action: "delegations", filter: delegationFilter };
  const intakeCommand = parseIntakeSlashCommand(prompt);
  if (intakeCommand) return { action: "intake", command: intakeCommand };
  const naturalDelegation = parseNaturalDelegationIntent(prompt);
  if (naturalDelegation) return { action: "delegate", intent: naturalDelegation };
  const walletCommand = parseWalletSlashCommand(prompt);
  if (walletCommand) return { action: "wallet", command: walletCommand };
  const daoCommand = parseDaoSlashCommand(prompt);
  if (daoCommand) return { action: "dao", command: daoCommand };
  const draftCommand = parseDraftSlashCommand(prompt);
  if (draftCommand) return { action: "draft", command: draftCommand };
  // Direct page-action intents (click / type / scroll / form / compound
  // navigate-and-act) run through Agent Control here, same as the side panel —
  // so a plain "click the FIFA News search result" acts on the page instead of
  // falling to chat and demanding a /control prefix.
  if (
    parseClickIntent(prompt) ||
    parseTypeIntent(prompt) ||
    parseScrollIntent(prompt) ||
    parseFormsIntent(prompt) ||
    parseBrowserNavigationTaskIntent(prompt) ||
    parseAutonomousBrowserActionIntent(prompt) ||
    parseNaturalBrowserIntent(prompt) ||
    parseNaturalSearchIntent(prompt)
  ) {
    return { action: "control" };
  }
  return { action: "chat" };
}
