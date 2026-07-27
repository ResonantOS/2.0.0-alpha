// Renderers for the main-workspace top-bar dock panels that don't already have a
// renderer (Jobs reuses renderMainBrowserJobStatus; Chats reuses the rail tree).
// These are deliberately small and side-effect-light so they're easy to unit
// test — the main workspace is a full-page app (no live browser tab), so they
// read from the shared browserJobStore / sitePermissionStore rather than a tab.

import { renderStepList } from "./step-list.js";

// Permissions panel: the stored site grants, mirroring the side panel's manager
// filter (a plain "ask-before-action" default isn't a stored grant). Each row
// carries a Reset control. Returns the number of grants rendered.
export function renderDockPermissions(listEl, titleEl, permissions = {}, { document: doc, onReset } = {}) {
  const view = doc ?? (typeof document !== "undefined" ? document : null);
  if (!listEl || !titleEl || !view) return 0;
  const entries = Object.entries(permissions ?? {})
    .filter(([siteKey, mode]) => siteKey && mode && mode !== "ask-before-action")
    .sort(([a], [b]) => a.localeCompare(b));
  titleEl.textContent = entries.length
    ? `${entries.length} browser ${entries.length === 1 ? "grant" : "grants"}`
    : "No stored browser grants";
  listEl.replaceChildren();
  entries.forEach(([siteKey, mode]) => {
    const item = view.createElement("li");
    const details = view.createElement("div");
    const strong = view.createElement("strong");
    strong.textContent = siteKey;
    const small = view.createElement("small");
    small.textContent = `site permission · ${mode}`;
    details.append(strong, small);
    const reset = view.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset";
    reset.addEventListener("click", () => onReset?.(siteKey));
    item.append(details, reset);
    listEl.append(item);
  });
  return entries.length;
}

// Control panel: a read-only view of the current run's steps (the live loop runs
// in the sidebar; the main workspace observes the shared job store) rendered
// through the shared Claude-app step-list component.
export function renderDockControl({ titleEl, statusEl, stepListEl } = {}, job = null, { document: doc } = {}) {
  const view = doc ?? (typeof document !== "undefined" ? document : null);
  if (!titleEl || !statusEl || !stepListEl || !view) return;
  if (!job) {
    titleEl.textContent = "No active browser task";
    statusEl.textContent = "idle";
    stepListEl.replaceChildren();
    return;
  }
  titleEl.textContent = job.goal || "Browser task";
  statusEl.textContent = job.status || "running";
  renderStepList(stepListEl, Array.isArray(job.steps) ? job.steps : [], {
    document: view,
    label: (step) => step?.label || step?.type || "step"
  });
}
