// A shared task/plan step-list renderer (Claude-app style), used identically in
// the sidecar and the main Augmentor panel. It emits structure only — each item
// carries a `data-state`; the glyphs (✓ done, spinner in-progress, ○ pending,
// ! blocked, ✕ failed), the done-strikethrough, the spinner animation, and the
// progress pill's spinner all live in step-list.css. Keeping visuals in CSS
// makes the renderer deterministic and easy to test.

const DONE_STATES = new Set(["completed"]);
const ACTIVE_STATES = new Set(["active", "running"]);

// The glyph is aria-hidden (it is a decorative circle/spinner), so each step
// carries a visually-hidden text equivalent for screen readers.
const STATE_TEXT = {
  completed: "done",
  active: "in progress",
  running: "in progress",
  pending: "pending",
  blocked: "needs review",
  failed: "failed",
  cancelled: "stopped"
};

export function stepStateText(state) {
  return STATE_TEXT[state] ?? "pending";
}

export function stepListProgress(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const total = list.length;
  const done = list.filter((step) => DONE_STATES.has(step?.state)).length;
  return { done, total };
}

// `renderExtra(step, index, view)` is an optional hook: return a node and it is
// appended under the step's number + label (in a `.step-list-extra` slot that
// clears the glyph column). Agent Control uses it to keep each action's detail
// expander attached to its step while the list itself stays Claude-app clean.
export function renderStepList(container, steps = [], { document: doc, label = (step) => step?.label ?? "", renderExtra = null } = {}) {
  const view = doc ?? (typeof document !== "undefined" ? document : null);
  if (!container || !view) return { done: 0, total: 0 };
  const list = Array.isArray(steps) ? steps : [];

  // Reuse the <ol> and the progress pill across renders. Rebuilding the
  // role="status" pill each time defeats the live region (screen readers often
  // won't announce a freshly-inserted, pre-populated status node), so only the
  // list items are replaced; the pill node persists and is updated in place.
  // role="list"/"listitem" keep list semantics where list-style:none drops them
  // (WebKit/VoiceOver).
  let ol = container.querySelector("ol.step-list");
  if (!ol) {
    ol = view.createElement("ol");
    ol.className = "step-list";
    ol.setAttribute("role", "list");
  }
  ol.replaceChildren();
  list.forEach((step, index) => {
    const item = view.createElement("li");
    item.className = "step-list-item";
    item.setAttribute("role", "listitem");
    item.dataset.state = step?.state ?? "pending";
    item.dataset.index = String(index + 1);

    const glyph = view.createElement("span");
    glyph.className = "step-list-glyph";
    glyph.setAttribute("aria-hidden", "true");

    const num = view.createElement("span");
    num.className = "step-list-num";
    num.textContent = `${index + 1}.`;

    const text = view.createElement("span");
    text.className = "step-list-label";
    text.textContent = label(step);

    const status = view.createElement("span");
    status.className = "step-list-sr";
    status.textContent = ` — ${stepStateText(step?.state ?? "pending")}`;

    item.append(glyph, num, text, status);

    if (typeof renderExtra === "function") {
      const extra = renderExtra(step, index, view);
      if (extra) {
        const slot = view.createElement("div");
        slot.className = "step-list-extra";
        slot.append(extra);
        item.append(slot);
      }
    }
    ol.append(item);
  });

  const { done, total } = stepListProgress(list);
  const anyActive = list.some((step) => ACTIVE_STATES.has(step?.state));

  let pill = container.querySelector(".step-list-pill");
  if (!pill) {
    pill = view.createElement("div");
    pill.className = "step-list-pill";
    pill.setAttribute("role", "status");
    const pillGlyph = view.createElement("span");
    pillGlyph.className = "step-list-pill-glyph";
    pillGlyph.setAttribute("aria-hidden", "true");
    const pillText = view.createElement("span");
    pillText.className = "step-list-pill-text";
    pill.append(pillGlyph, pillText);
  }
  pill.dataset.active = anyActive ? "true" : "false";
  pill.setAttribute("aria-label", `${done} of ${total} steps complete`);
  pill.querySelector(".step-list-pill-text").textContent = `${done} of ${total}`;

  // Keep container order: list, then pill (append is idempotent for reused nodes).
  container.append(ol, pill);

  return { done, total };
}
