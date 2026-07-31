export function sitePermissionDescription(mode) {
  if (mode === "blocked") return "Can see/do now: nothing on this site. Reading, clicking, typing, scrolling, wallet, login, payment, credential, and public-submit actions are blocked.";
  if (mode === "read-only") return "Can see/do now: page text, controls, fields, frames, and metadata. Cannot click, type, scroll, submit, use wallet, login, payment, or credentials.";
  if (mode === "trusted-for-safe-actions") return "Can see/do now: page context plus safe clicks, non-sensitive typing, scrolling, and search-like submits. Wallet, login, payment, credentials, personal autofill, and public-submit stay gated.";
  return "Can see/do now: page context. Augmentor asks before risky clicks, non-sensitive typing, scrolling, or submits, and blocks wallet, login, payment, credential, and personal autofill actions by default.";
}

export function controlRunProgress(run) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const total = steps.length;
  const completed = steps.filter((step) => step.state === "completed").length;
  const terminal = steps.filter((step) => ["completed", "blocked", "failed", "cancelled"].includes(step.state)).length;
  const pending = steps.filter((step) => step.state === "pending").length;
  const blockedCount = steps.filter((step) => step.state === "blocked").length;
  const failed = steps.filter((step) => step.state === "failed").length;
  const active = steps.findIndex((step) => step.state === "active");
  const blocked = steps.findIndex((step) => ["blocked", "failed"].includes(step.state));
  const status = run?.status ?? "idle";
  const activeLabel = active >= 0 ? `step ${active + 1}/${total || 1}` : blocked >= 0 ? `blocked at ${blocked + 1}/${total || 1}` : `${completed}/${total || 0}`;
  const currentStep = active >= 0
    ? steps[active]
    : blocked >= 0
      ? steps[blocked]
      : steps.find((step) => step.state === "pending") ?? steps.at(-1) ?? null;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const phase = controlRunPhase({ status, currentStep });
  return {
    active,
    activeLabel,
    blocked,
    blockedCount,
    completed,
    currentStep,
    failed,
    label: `${status} · ${activeLabel}`,
    pending,
    percent,
    phase,
    terminal,
    total,
  };
}

export function controlRunPhase({ status, currentStep } = {}) {
  if (status === "approval") return "approval";
  if (status === "cancelled") return "cancelled";
  if (["blocked", "failed", "denied"].includes(status)) return "blocked";
  if (status === "paused") return "waiting";
  if (status === "completed") return "completed";
  const type = currentStep?.type;
  if (["inspect", "read", "forms", "tabs"].includes(type)) return "reading";
  if (["open", "search", "switch_tab"].includes(type)) return "navigating";
  if (["click", "type", "scroll"].includes(type)) return "acting";
  if (type === "wait") return "waiting";
  if (status === "running") return "deciding";
  return "waiting";
}

export function controlRunPhaseLabel(phase = "waiting") {
  const labels = {
    acting: "Acting",
    approval: "Awaiting approval",
    blocked: "Blocked",
    cancelled: "Stopped",
    completed: "Completed",
    deciding: "Deciding",
    navigating: "Navigating",
    reading: "Reading page",
    waiting: "Waiting",
  };
  return labels[phase] ?? "Working";
}

export function controlRunProgressSummary(run) {
  const progress = controlRunProgress(run);
  return [
    controlRunPhaseLabel(progress.phase),
    `${progress.completed}/${progress.total || 0} complete`,
    progress.terminal !== progress.completed ? `${progress.terminal}/${progress.total || 0} resolved` : "",
    progress.pending ? `${progress.pending} queued` : "",
    progress.blockedCount ? `${progress.blockedCount} blocked` : "",
    progress.failed ? `${progress.failed} failed` : "",
    `${progress.percent}%`,
  ].filter(Boolean).join(" · ");
}

export function controlActionStateLabel(state = "pending") {
  if (state === "active") return "working";
  if (state === "completed") return "done";
  if (state === "blocked") return "needs review";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "stopped";
  if (state === "pending") return "queued";
  return String(state || "queued");
}

export function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} sec`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} sec`;
}

export function controlRunSummary(run) {
  const progress = controlRunProgress(run);
  const terminal = ["completed", "blocked", "failed", "denied", "cancelled"].includes(run?.status);
  const nextHumanAction = (Array.isArray(run?.steps) ? run.steps : [])
    .find((step) => step?.details?.nextHumanAction)?.details?.nextHumanAction ?? "";
  if (!terminal && run?.status !== "approval") return null;
  if (run?.status === "completed") {
    return {
      state: "completed",
      title: "Task completed",
      body: `${progress.completed}/${progress.total || progress.completed} actions completed. Review the trace below or save the report to Living Archive intake.`,
    };
  }
  if (run?.status === "approval") {
    return {
      state: "approval",
      title: "Human approval needed",
      body: "Augmentor stopped at a gated action. Review the page, then approve once, trust safe actions for this task class, deny, or delegate the issue.",
    };
  }
  if (run?.status === "cancelled") {
    return {
      state: "cancelled",
      title: "Task stopped",
      body: "Augmentor stopped before the next browser action. No pending approval or page control remains active. Review the page state, then continue the job, start a new task, or save a report.",
    };
  }
  if (run?.status === "denied") {
    return {
      state: "blocked",
      title: "Action denied",
      body: "The task stayed stopped because the human denied the proposed browser action.",
    };
  }
  return {
    state: "blocked",
    title: "Task stopped",
    body: [
      "Augmentor could not safely continue. The trace below shows the blocker and the recommended next human action.",
      nextHumanAction,
    ].filter(Boolean).join(" "),
  };
}
