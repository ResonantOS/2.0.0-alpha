// Pure DOM renderers for the live OpenCode session workspace (Option A). They
// emit structure + classes only; all visuals live in the stylesheet. Fed by the
// opencode-session-model reducer, so they stay deterministic and testable.

import { renderStepList } from "./step-list.js";

const view = (doc) => doc ?? (typeof document !== "undefined" ? document : null);

// Changed-files / diff pane. `files` is changedFilesView(state): newest first,
// with `justTouched` on the most-recent edit (borrowed "rolling highlight").
// Each row carries a revert control (borrowed checkpoint pattern).
export function renderChangedFiles(listEl, titleEl, files = [], { document: doc, onRevert } = {}) {
  const d = view(doc);
  if (!listEl || !d) return 0;
  if (titleEl) titleEl.textContent = files.length ? `Changed files · ${files.length}` : "No changes yet";
  listEl.replaceChildren();
  for (const file of files) {
    const row = d.createElement("li");
    row.className = "oc-file";
    row.dataset.path = file.path;
    if (file.justTouched) row.dataset.touched = "true";
    const name = d.createElement("span");
    name.className = "oc-file-name";
    name.textContent = file.path;
    const stat = d.createElement("span");
    stat.className = "oc-file-stat";
    const add = d.createElement("b");
    add.className = "oc-add";
    add.textContent = `+${file.added ?? 0}`;
    const del = d.createElement("b");
    del.className = "oc-del";
    del.textContent = `−${file.removed ?? 0}`;
    stat.append(add, del);
    const revert = d.createElement("button");
    revert.type = "button";
    revert.className = "oc-revert";
    revert.textContent = "Revert";
    revert.addEventListener("click", () => onRevert?.(file.path));
    row.append(name, stat, revert);
    listEl.append(row);
  }
  return files.length;
}

// Inline approval cards — the governance boundary. Reply routes to
// POST /session/:id/permissions/:permissionID via onReply(id, decision).
export function renderApprovals(container, approvals = [], { document: doc, onReply } = {}) {
  const d = view(doc);
  if (!container || !d) return 0;
  container.replaceChildren();
  container.hidden = approvals.length === 0;
  for (const approval of approvals) {
    const card = d.createElement("div");
    card.className = "oc-approve";
    card.dataset.id = approval.id;
    const head = d.createElement("div");
    head.className = "oc-approve-head";
    const name = d.createElement("strong");
    name.textContent = approval.title || approval.tool || "Approval needed";
    head.append(name);
    if (approval.detail) {
      const detail = d.createElement("code");
      detail.textContent = approval.detail;
      head.append(detail);
    }
    const actions = d.createElement("div");
    actions.className = "oc-approve-actions";
    const make = (label, decision, cls) => {
      const b = d.createElement("button");
      b.type = "button";
      if (cls) b.className = cls;
      b.textContent = label;
      b.addEventListener("click", () => onReply?.(approval.id, decision));
      return b;
    };
    actions.append(
      make("Approve", { approved: true }, "oc-go"),
      make("Approve + remember", { approved: true, remember: true }, ""),
      make("Deny", { approved: false }, "oc-no")
    );
    card.append(head, actions);
    container.append(card);
  }
  return approvals.length;
}

// The streamed transcript: text/reasoning prose + tool-call cards with a live
// state glyph (running spinner / ✓ / ✕).
export function renderTranscript(container, entries = [], { document: doc } = {}) {
  const d = view(doc);
  if (!container || !d) return;
  container.replaceChildren();
  for (const entry of entries) {
    if (entry.type === "text" || entry.type === "reasoning") {
      const block = d.createElement("div");
      block.className = entry.type === "reasoning" ? "oc-msg oc-reasoning" : "oc-msg";
      block.textContent = entry.text ?? "";
      container.append(block);
    } else if (entry.type === "tool") {
      const card = d.createElement("div");
      card.className = "oc-tool";
      card.dataset.state = entry.state ?? "running";
      const glyph = d.createElement("span");
      glyph.className = "oc-tool-glyph";
      glyph.setAttribute("aria-hidden", "true");
      const name = d.createElement("span");
      name.className = "oc-tool-name";
      name.textContent = entry.tool ?? "tool";
      const meta = d.createElement("code");
      meta.className = "oc-tool-meta";
      meta.textContent = String(entry.input ?? "");
      const sr = d.createElement("span");
      sr.className = "oc-tool-sr";
      sr.textContent = ` — ${entry.state ?? "running"}`;
      card.append(glyph, name, meta, sr);
      container.append(card);
    }
  }
}

// Plan / todo checklist — borrowed from Claude Code / Cline, rendered through the
// shared step-list component. Maps OpenCode's todo statuses to step states.
const TODO_STATE = { in_progress: "active", running: "active", completed: "completed", done: "completed", pending: "pending", cancelled: "cancelled", failed: "failed" };
export function renderTodoChecklist(container, todos = [], { document: doc } = {}) {
  const d = view(doc);
  if (!container || !d) return;
  container.hidden = todos.length === 0;
  renderStepList(
    container,
    todos.map((t) => ({ label: t.label, state: TODO_STATE[t.state] ?? "pending" })),
    { document: d }
  );
}
