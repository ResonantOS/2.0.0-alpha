import { taskClassForGoal } from "./task-consent-store.js";

const DEFAULT_ID = () => `control-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

export function isLongAutonomousControlGoal(goal = "") {
  const text = String(goal ?? "").trim();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 8 || /\b(book|booking|buy|cart|checkout|appointment|reservation|fill|form|apply|submit|send|post|research|compare|find me|look up)\b/i.test(text);
}

export function normalizeControlPreflight(preflight) {
  if (!preflight?.id || !preflight?.goal) return null;
  return {
    id: String(preflight.id),
    goal: String(preflight.goal),
    mode: String(preflight.mode || "ask-before-action"),
    siteKey: String(preflight.siteKey || "unknown-site"),
    taskClass: String(preflight.taskClass || taskClassForGoal(preflight.goal)),
    createdAt: String(preflight.createdAt || new Date().toISOString())
  };
}

export function createControlPreflight({ goal, mode = "ask-before-action", siteKey = "unknown-site", createId = DEFAULT_ID, now = () => new Date().toISOString() }) {
  return normalizeControlPreflight({
    id: createId(),
    goal,
    mode,
    siteKey,
    taskClass: taskClassForGoal(goal),
    createdAt: now()
  });
}

export function shouldRequireControlPreflight({
  goal,
  mode = "ask-before-action",
  existingConsent = null,
  alreadyApproved = false,
  resumedFromJob = false
} = {}) {
  if (alreadyApproved || resumedFromJob) return false;
  if (mode === "blocked") return false;
  if (["allow-safe", "allow-once"].includes(existingConsent?.mode)) return false;
  return isLongAutonomousControlGoal(goal);
}

export function formatControlPreflightMessage(preflight) {
  const item = normalizeControlPreflight(preflight);
  if (!item) return "Agent Control preflight is unavailable.";
  return [
    "Agent Control preflight required before I operate this page.",
    "",
    `Task class: ${item.taskClass}`,
    `Site: ${item.siteKey} · ${item.mode}`,
    `Goal: ${item.goal}`,
    "",
    "If approved, Augmentor may read the page, scroll, click safe visible controls, type into editable fields, and verify each step.",
    "Still human-only: wallet, login, credential, payment, checkout, signing, transfer, destructive actions, and public submit unless a separate approval card appears.",
    "",
    `Approve: /approve-control ${item.id}`,
    `Allow class once: /allow-control-once ${item.id}`,
    `Deny: /deny-control ${item.id}`
  ].join("\n");
}
