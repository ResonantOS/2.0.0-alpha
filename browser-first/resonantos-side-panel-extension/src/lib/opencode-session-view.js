// Pure DOM renderers for the live OpenCode session workspace (Option A). They
// emit structure + classes only; all visuals live in the stylesheet. Fed by the
// opencode-session-model reducer, so they stay deterministic and testable.

import { renderStepList } from "./step-list.js";

const view = (doc) => doc ?? (typeof document !== "undefined" ? document : null);
const TOOL_OUTPUT_LIMIT = 4000;

function appendText(parent, text, d) {
  if (text) parent.append(d.createTextNode(text));
}

function appendInlineMarkdown(parent, text, d) {
  const source = String(text ?? "");
  let i = 0;
  const canOpenEmphasis = (at) => at === 0 || /\s/.test(source[at - 1]);
  const findClosingEmphasis = (marker, from) => {
    let end = source.indexOf(marker, from);
    while (end >= 0) {
      const after = source[end + 1] ?? "";
      if (!after || /\s|[.,;:!?)]/.test(after)) return end;
      end = source.indexOf(marker, end + 1);
    }
    return -1;
  };
  while (i < source.length) {
    const rest = source.slice(i);
    const candidates = [
      { type: "code", at: rest.indexOf("`") },
      { type: "bold", at: rest.indexOf("**") },
      { type: "link", at: rest.indexOf("[") },
      { type: "italic-star", at: rest.indexOf("*") },
      { type: "italic-under", at: rest.indexOf("_") }
    ].filter((c) => c.at >= 0)
      .sort((a, b) => a.at - b.at);
    if (!candidates.length) {
      appendText(parent, source.slice(i), d);
      break;
    }

    const next = candidates[0];
    appendText(parent, source.slice(i, i + next.at), d);
    i += next.at;

    if (next.type === "code") {
      const end = source.indexOf("`", i + 1);
      if (end < 0) {
        appendText(parent, source.slice(i), d);
        break;
      }
      const code = d.createElement("code");
      code.textContent = source.slice(i + 1, end);
      parent.append(code);
      i = end + 1;
      continue;
    }

    if (next.type === "bold") {
      const end = source.indexOf("**", i + 2);
      if (end < 0) {
        appendText(parent, source.slice(i, i + 2), d);
        i += 2;
        continue;
      }
      const strong = d.createElement("strong");
      appendInlineMarkdown(strong, source.slice(i + 2, end), d);
      parent.append(strong);
      i = end + 2;
      continue;
    }

    if (next.type === "link") {
      const close = source.indexOf("]", i + 1);
      const openUrl = close >= 0 ? source.indexOf("(", close + 1) : -1;
      const closeUrl = openUrl >= 0 ? source.indexOf(")", openUrl + 1) : -1;
      if (close < 0 || openUrl !== close + 1 || closeUrl < 0) {
        appendText(parent, source[i], d);
        i += 1;
        continue;
      }
      appendText(parent, `${source.slice(i + 1, close)} (${source.slice(openUrl + 1, closeUrl)})`, d);
      i = closeUrl + 1;
      continue;
    }

    const marker = next.type === "italic-star" ? "*" : "_";
    if (source.startsWith("**", i)) {
      appendText(parent, "**", d);
      i += 2;
      continue;
    }
    if (!canOpenEmphasis(i) || !source[i + 1] || /\s/.test(source[i + 1])) {
      appendText(parent, marker, d);
      i += 1;
      continue;
    }
    const end = findClosingEmphasis(marker, i + 1);
    if (end < 0) {
      appendText(parent, marker, d);
      i += 1;
      continue;
    }
    const em = d.createElement("em");
    appendInlineMarkdown(em, source.slice(i + 1, end), d);
    parent.append(em);
    i = end + 1;
  }
}

function appendMarkdownBlock(container, lines, d) {
  if (!lines.length) return;
  const text = lines.join("\n").trim();
  if (!text) return;

  const heading = text.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const h = d.createElement(`h${heading[1].length}`);
    appendInlineMarkdown(h, heading[2], d);
    container.append(h);
    return;
  }

  const unordered = lines.every((line) => /^\s*[-*]\s+/.test(line));
  const ordered = lines.every((line) => /^\s*\d+\.\s+/.test(line));
  if (unordered || ordered) {
    const list = d.createElement(unordered ? "ul" : "ol");
    for (const line of lines) {
      const item = d.createElement("li");
      appendInlineMarkdown(item, line.replace(unordered ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/, ""), d);
      list.append(item);
    }
    container.append(list);
    return;
  }

  const p = d.createElement("p");
  appendInlineMarkdown(p, text, d);
  container.append(p);
}

function renderMarkdown(text, d) {
  const root = d.createElement("div");
  root.className = "oc-markdown";
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let block = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,})/);
    if (fence) {
      appendMarkdownBlock(root, block, d);
      block = [];
      const fenceLength = fence[1].length;
      const closePattern = new RegExp(`^\\s*\`{${fenceLength},}\\s*$`);
      const codeLines = [];
      i += 1;
      while (i < lines.length && !closePattern.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      const pre = d.createElement("pre");
      const code = d.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      root.append(pre);
      continue;
    }
    if (!line.trim()) {
      appendMarkdownBlock(root, block, d);
      block = [];
      continue;
    }
    const startsList = /^\s*(?:[-*]|\d+\.)\s+/.test(line);
    const blockIsList = block.length && /^\s*(?:[-*]|\d+\.)\s+/.test(block[0]);
    if (block.length && startsList !== blockIsList) {
      appendMarkdownBlock(root, block, d);
      block = [];
    }
    block.push(line);
  }
  appendMarkdownBlock(root, block, d);
  return root;
}

function appendSourceBadge(parent, source, d) {
  const badge = d.createElement("span");
  badge.className = "oc-badge";
  const resolved = source === "governed" ? "governed" : "external";
  badge.dataset.source = resolved;
  badge.textContent = resolved === "governed" ? "Governed" : "External";
  parent.append(badge);
}

function displayValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateOutput(text) {
  const raw = String(text ?? "");
  return raw.length > TOOL_OUTPUT_LIMIT ? `${raw.slice(0, TOOL_OUTPUT_LIMIT)}\n[truncated]` : raw;
}

// Changed-files / diff pane. `files` is changedFilesView(state): newest first,
// with `justTouched` on the most-recent edit (borrowed "rolling highlight").
// Each row carries a revert control (borrowed checkpoint pattern).
export function renderChangedFiles(listEl, titleEl, files = [], { document: doc, onRevert } = {}) {
  const d = view(doc);
  if (!listEl || !d) return 0;
  if (titleEl) {
    titleEl.textContent = files.length ? `Changed files · ${new Set(files.map((file) => file.path)).size}` : "No changes yet";
    if (files.length) appendSourceBadge(titleEl, files.every((file) => file.source === "governed") ? "governed" : "external", d);
  }
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
    appendSourceBadge(row, file.source, d);
    listEl.append(row);
  }
  return files.length;
}

// Inline approval cards — the governance boundary. Reply routes to
// POST /session/:id/permissions/:permissionID via onReply(id, decision).
export function renderApprovals(container, approvals = [], { document: doc, onReply, disabled } = {}) {
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
      if (disabled) b.disabled = true;
      b.addEventListener("click", () => onReply?.(approval.id, decision));
      return b;
    };
    actions.append(
      make("Approve", { approved: true }, "oc-go"),
      make("Approve + remember", { approved: true, remember: true }, ""),
      make("Deny", { approved: false }, "oc-no")
    );
    card.append(head, actions);
    appendSourceBadge(card, approval.source, d);
    container.append(card);
  }
  return approvals.length;
}

// The streamed transcript: text/reasoning prose + tool-call cards with a live
// state glyph (running spinner / ✓ / ✕).
export function renderTranscript(container, entries = [], { document: doc, clipboard } = {}) {
  const d = view(doc);
  if (!container || !d) return;
  const clip = clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : null);
  container.replaceChildren();
  for (const entry of entries) {
    if (entry.type === "text" || entry.type === "reasoning") {
      const block = d.createElement("div");
      block.className = entry.type === "reasoning" ? "oc-msg oc-reasoning" : "oc-msg";
      if (entry.type === "reasoning") {
        const content = d.createElement("div");
        content.className = "oc-msg-content";
        content.textContent = entry.text ?? "";
        block.append(content);
      } else {
        const copy = d.createElement("button");
        copy.type = "button";
        copy.className = "oc-msg-copy";
        copy.title = "Copy message";
        copy.setAttribute("aria-label", "Copy message");
        copy.addEventListener("click", () => void clip?.writeText?.(entry.text ?? ""));
        const content = d.createElement("div");
        content.className = "oc-msg-content";
        content.append(renderMarkdown(entry.text ?? "", d));
        block.append(copy, content);
      }
      appendSourceBadge(block, entry.source, d);
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
      meta.textContent = displayValue(entry.input);
      const sr = d.createElement("span");
      sr.className = "oc-tool-sr";
      sr.textContent = ` — ${entry.state ?? "running"}`;
      card.append(glyph, name, meta, sr);
      appendSourceBadge(card, entry.source, d);
      const output = entry.state === "error" ? entry.error : entry.output;
      if (output) {
        const details = d.createElement("details");
        details.className = "oc-tool-output";
        details.dataset.kind = entry.state === "error" ? "error" : "output";
        if (entry.state === "error") details.open = true;
        const summary = d.createElement("summary");
        summary.textContent = "Show output";
        const pre = d.createElement("pre");
        pre.textContent = truncateOutput(output);
        details.append(summary, pre);
        card.append(details);
      }
      container.append(card);
    }
  }
}

function patchLines(entry) {
  if (typeof entry?.patch === "string") return entry.patch.replace(/\r\n/g, "\n").split("\n");
  if (typeof entry?.content === "string") return entry.content.replace(/\r\n/g, "\n").split("\n");
  const hunks = Array.isArray(entry?.hunks) ? entry.hunks : [];
  return hunks.flatMap((hunk) => {
    if (Array.isArray(hunk?.lines)) return hunk.lines;
    if (typeof hunk === "string") return hunk.replace(/\r\n/g, "\n").split("\n");
    if (typeof hunk?.patch === "string") return hunk.patch.replace(/\r\n/g, "\n").split("\n");
    if (typeof hunk?.content === "string") return hunk.content.replace(/\r\n/g, "\n").split("\n");
    return [];
  });
}

function patchKind(line) {
  if (/^(?:diff --git|index |@@ |--- |\+\+\+ )/.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

export function renderDiffContent(container, diff = [], { document: doc } = {}) {
  const d = view(doc);
  if (!container || !d) return 0;
  container.replaceChildren();
  const entries = Array.isArray(diff) ? diff : [];
  for (const entry of entries) {
    const details = d.createElement("details");
    details.className = "oc-patch-file";
    const summary = d.createElement("summary");
    summary.textContent = entry.path ?? entry.file ?? "unknown file";
    const pre = d.createElement("pre");
    pre.className = "oc-patch";
    for (const rawLine of patchLines(entry)) {
      const line = String(rawLine ?? "");
      const kind = patchKind(line);
      const row = d.createElement("span");
      row.className = `oc-patch-line oc-patch-${kind}`;
      row.dataset.kind = kind;
      row.textContent = kind === "remove" ? `−${line.slice(1)}` : line;
      pre.append(row);
    }
    details.append(summary, pre);
    appendSourceBadge(details, entry.source, d);
    container.append(details);
  }
  return entries.length;
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
  const items = [...container.querySelectorAll(".step-list-item")];
  items.forEach((item, index) => appendSourceBadge(item, todos[index]?.source, d));
}
