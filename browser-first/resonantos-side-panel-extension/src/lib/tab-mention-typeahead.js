// Composer @tab mention typeahead (#252).
//
// Typing `@` in the composer opens a dropdown over the user's open, readable
// (permitted) tabs; selecting one inserts the deliberate `@"quoted title"`
// mention form, which the command router treats as an explicit tab scope:
// referenced tabs' content is attached to the request, and a reference that
// no longer resolves fails loudly instead of silently widening scope.
//
// Boundary (#252 non-goals): only tabs already open and readable in this
// session are listed (the same set the mention resolver can address); no
// navigation, activation, or automation authority is added.

// Where is the caret inside an @mention token? Returns
// { start, query, quoted } — start = index of the token's `@` — or null when
// the caret is not inside a mention token. Email-style `bob@acme.com` never
// matches because the `@` must follow a boundary character.
export function mentionQueryAtCaret(text, caret) {
  const value = String(text ?? "");
  const position = Number.isInteger(caret) ? Math.max(0, Math.min(caret, value.length)) : value.length;
  const before = value.slice(0, position);
  const match = /(?:^|[\s,;!?([{])@("?)([a-z0-9][a-z0-9.:_ -]{0,80})?$/i.exec(before);
  if (!match) return null;
  const quoted = match[1] === '"';
  const query = match[2] ?? "";
  // An unquoted token terminates at whitespace: "@Alpha Be<caret>" means the
  // mention ended and "Be" is new prose, not a longer query.
  if (!quoted && /\s/.test(query)) return null;
  const tokenStart = position - query.length - (quoted ? 2 : 1);
  return { start: tokenStart, query, quoted };
}

function domainForUrl(url) {
  try {
    return new URL(String(url ?? "")).hostname || String(url ?? "");
  } catch {
    return String(url ?? "").slice(0, 60);
  }
}

// Rank open tabs for a mention query. Only readable (permitted) tabs are
// candidates, matching the resolver's addressable set exactly. Empty query
// lists everything (ranked by tab order); otherwise title prefix beats title
// substring beats URL/domain substring. `index` is the tab's 1-based position
// among readable tabs so the list can hint the `@tab N` form.
export function rankMentionCandidates(tabs, query, isReadableBrowserTab, { limit = 8 } = {}) {
  const readable = (Array.isArray(tabs) ? tabs : []).filter(isReadableBrowserTab);
  const needle = String(query ?? "").trim().toLowerCase();
  const scored = [];
  readable.forEach((tab, index) => {
    const title = String(tab?.title ?? "").toLowerCase();
    const url = String(tab?.url ?? "").toLowerCase();
    let score = null;
    if (!needle) score = 1;
    else if (title.startsWith(needle)) score = 0;
    else if (title.includes(needle)) score = 1;
    else if (url.includes(needle)) score = 2;
    if (score === null) return;
    scored.push({ tab, index, score });
  });
  scored.sort((left, right) => left.score - right.score || left.index - right.index);
  return scored.slice(0, limit).map(({ tab, index }) => ({
    tabId: tab.id ?? null,
    title: String(tab?.title ?? ""),
    url: String(tab?.url ?? ""),
    index: index + 1
  }));
}

// The deliberate mention form inserted on selection: `@"Title"` (quotes and
// line breaks stripped so the token grammar always parses it back), falling
// back to the ranked `@tab N` form when the tab has no usable title.
export function mentionInsertionForTab(candidate) {
  const title = String(candidate?.title ?? "").replace(/["\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!title) return `@tab ${candidate?.index ?? 1} `;
  return `@"${title}" `;
}

let typeaheadInstanceCounter = 0;

export function createTabMentionTypeahead({
  input,
  chrome,
  isReadableBrowserTab = () => false,
  doc = globalThis.document,
  maxCandidates = 8,
  queryTabs = null,
  // #410: debounce input-triggered refreshes so a burst of keystrokes inside a
  // mention token re-queries tabs once, not per character. 0 keeps the refresh
  // synchronous (used by unit tests for deterministic timing).
  debounceMs = 90
} = {}) {
  if (!input) throw new Error("createTabMentionTypeahead requires an input element.");
  if (!doc) throw new Error("createTabMentionTypeahead requires a document.");
  const listTabs = typeof queryTabs === "function"
    ? queryTabs
    : async () => (await chrome?.tabs?.query?.({}).catch(() => [])) ?? [];
  const keydownHost = input.form ?? input;
  const listboxId = `tab-mention-listbox-${++typeaheadInstanceCounter}`;
  const optionId = (position) => `${listboxId}-opt-${position}`;

  let container = null;
  let optionEls = [];
  let candidates = [];
  let activeIndex = -1;
  let queryInfo = null;
  let open = false;
  let refreshTimer = null;

  const isOpen = () => open;

  // #410 (a11y): mark the composer as an editable combobox that owns the popup.
  // Active-option state is conveyed via aria-activedescendant (APG virtual
  // focus) so focus stays in the input and screen readers still announce the
  // highlighted option.
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");

  function setExpanded(expanded) {
    input.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (expanded) {
      input.setAttribute("aria-controls", listboxId);
    } else {
      input.removeAttribute("aria-controls");
      input.removeAttribute("aria-activedescendant");
    }
  }

  function close() {
    open = false;
    candidates = [];
    optionEls = [];
    activeIndex = -1;
    queryInfo = null;
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    container?.remove();
    container = null;
    setExpanded(false);
  }

  function paintActive(position, isActive) {
    const option = optionEls[position];
    if (!option) return;
    option.classList.toggle("active", isActive);
    option.setAttribute("aria-selected", isActive ? "true" : "false");
  }

  // #410 (perf): move the highlight without rebuilding every option — only the
  // previously- and newly-active options change, plus aria-activedescendant.
  function setActiveOption(nextIndex) {
    if (nextIndex === activeIndex) return;
    paintActive(activeIndex, false);
    activeIndex = nextIndex;
    paintActive(activeIndex, true);
    const active = optionEls[activeIndex];
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView?.({ block: "nearest" });
    }
  }

  function renderList() {
    if (!container) {
      container = doc.createElement("div");
      container.className = "tab-mention-typeahead";
      container.id = listboxId;
      container.setAttribute("role", "listbox");
      container.setAttribute("aria-label", "Reference an open tab");
      input.insertAdjacentElement("afterend", container);
    }
    container.replaceChildren();
    optionEls = candidates.map((candidate, position) => {
      const option = doc.createElement("button");
      option.type = "button";
      option.id = optionId(position);
      option.className = `tab-mention-option${position === activeIndex ? " active" : ""}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", position === activeIndex ? "true" : "false");
      const title = doc.createElement("strong");
      title.textContent = candidate.title || candidate.url || "(untitled tab)";
      const domain = doc.createElement("span");
      domain.textContent = `@tab ${candidate.index} · ${domainForUrl(candidate.url)}`;
      option.append(title, domain);
      // mousedown (not click) so selection lands before the input blur closes.
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectCandidate(position);
      });
      container.append(option);
      return option;
    });
    const active = optionEls[activeIndex];
    if (active) input.setAttribute("aria-activedescendant", active.id);
  }

  async function refresh() {
    const info = mentionQueryAtCaret(input.value, input.selectionStart);
    if (!info) {
      close();
      return;
    }
    queryInfo = info;
    const tabs = await listTabs();
    if (queryInfo !== info) return; // a newer refresh superseded this one
    candidates = rankMentionCandidates(tabs, info.query, isReadableBrowserTab, { limit: maxCandidates });
    if (!candidates.length) {
      close();
      return;
    }
    open = true;
    if (activeIndex < 0 || activeIndex >= candidates.length) activeIndex = 0;
    setExpanded(true);
    renderList();
  }

  function scheduleRefresh() {
    if (debounceMs <= 0) {
      void refresh();
      return;
    }
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, debounceMs);
  }

  function selectCandidate(position) {
    const candidate = candidates[position];
    if (!candidate || !queryInfo) return;
    const caret = input.selectionStart ?? input.value.length;
    const insertion = mentionInsertionForTab(candidate);
    input.value = input.value.slice(0, queryInfo.start) + insertion + input.value.slice(caret);
    const nextCaret = queryInfo.start + insertion.length;
    input.setSelectionRange?.(nextCaret, nextCaret);
    close();
    // Notify other composer listeners (undo stack, context meter) of the edit.
    const view = input.ownerDocument?.defaultView;
    input.dispatchEvent(new (view?.Event ?? Event)("input", { bubbles: true }));
    input.focus?.();
  }

  // Capture phase on the form: runs before the composer controller's own
  // keydown handler (Enter → submit), so an open dropdown wins the key.
  function onKeydown(event) {
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setActiveOption((activeIndex + 1) % candidates.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActiveOption((activeIndex - 1 + candidates.length) % candidates.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      selectCandidate(activeIndex);
    } else if (event.key === "Tab") {
      // #410 (keyboard): don't trap the user — Tab dismisses the dropdown and
      // moves focus to the next control (no preventDefault). Enter or a click
      // is the deliberate commit path.
      close();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  const onInput = () => scheduleRefresh();
  const onBlur = () => close();

  input.addEventListener("input", onInput);
  input.addEventListener("blur", onBlur);
  keydownHost.addEventListener("keydown", onKeydown, true);

  function destroy() {
    close();
    input.removeEventListener("input", onInput);
    input.removeEventListener("blur", onBlur);
    keydownHost.removeEventListener("keydown", onKeydown, true);
    input.removeAttribute("role");
    input.removeAttribute("aria-autocomplete");
    input.removeAttribute("aria-expanded");
  }

  return { close, destroy, isOpen };
}
