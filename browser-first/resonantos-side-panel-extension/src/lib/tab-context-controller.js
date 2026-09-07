import { parseTabMentionTokens, resolveScopedTabs, resolveTabComparison } from "./tab-comparison-resolver.js";

// Raw per-tab text cap at capture time; chat-turn-controller applies the
// shared per-request budget and sanitization on top of this.
const SCOPED_CAPTURE_TEXT_LIMIT = 12000;
const INLINE_DRAFT_KEY = "augmentorInlineDraft";

// Token grammar matches tab-comparison-resolver (Tom's review): no greedy
// space in the inner char class; `@tab N` and `@"quoted title"` are alternate
// capture paths. The first match wins, so `@Booking` is still a single token.
export function parseTabMention(message) {
  // Match requires a word-boundary-style prefix (start of string, or any of
  // whitespace/comma/colon/etc.) so `bob@acme.com` no longer yields `acme`.
  const match = /(?:^|[\s,;!?([{])@(?:(tab\s+\d+)|"([^"]+)"|([a-z0-9][a-z0-9.:_-]{0,80}))/i.exec(String(message ?? ""));
  if (!match) return null;
  // Apply the post-match consumption length so the prefix is included in the
  // consumed span; the matched prefix character is left in the message so
  // downstream consumers see the original text.
  return String(match[1] ?? match[2] ?? match[3] ?? "").trim().replace(/[.,;!?]+$/g, "");
}

export function createTabContextController({
  addMessage,
  chrome,
  getControlledTabId,
  isReadableBrowserTab,
  readTabPage = async () => ({ ok: false, error: "Tab page capture unavailable." }),
  refreshTabContext,
  renderSitePermissionPanel,
  setContextMeter,
  setControlledTabId,
  setLastSnapshot,
  sitePermissionStorageKey
}) {
  const resolveTabMention = async (message) => {
    const raw = parseTabMention(message);
    if (!raw) return null;
    const tabs = (await chrome.tabs.query({}).catch(() => [])).filter(isReadableBrowserTab);
    if (/^tab\s+\d+$/i.test(raw)) {
      const index = Number(/\d+/.exec(raw)?.[0] ?? "0") - 1;
      return tabs[index] ?? null;
    }
    const needle = raw.toLowerCase();
    return tabs.find((tab) =>
      String(tab.title ?? "").toLowerCase().includes(needle) ||
      String(tab.url ?? "").toLowerCase().includes(needle)
    ) ?? null;
  };

  const bindMentionedTab = async (message) => {
    const tab = await resolveTabMention(message);
    if (!tab?.id) return null;
    setControlledTabId(tab.id);
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
    setLastSnapshot(null);
    setContextMeter(null);
    await renderSitePermissionPanel(tab);
    await addMessage("system", `Using @tab context: ${tab.title || tab.url}`);
    return tab;
  };

  const consumeInlineDraft = async (draft) => {
    if (!draft?.selection) return;
    await addMessage(
      "system",
      [
        "Inline Assistant context received.",
        draft.title ? `Page: ${draft.title}` : "",
        draft.url ? `URL: ${draft.url}` : "",
        "",
        String(draft.selection).slice(0, 4000)
      ].filter(Boolean).join("\n")
    );
    await chrome.storage?.local?.remove?.(INLINE_DRAFT_KEY).catch(() => undefined);
  };

  const handleStorageChanged = (changes, area) => {
    if (area === "local" && changes[INLINE_DRAFT_KEY]?.newValue) {
      void consumeInlineDraft(changes[INLINE_DRAFT_KEY].newValue);
    }
    if (area === "local" && changes[sitePermissionStorageKey]) {
      void renderSitePermissionPanel();
    }
  };

  const handleTabUpdated = (tabId, changeInfo) => {
    if (changeInfo.status === "complete" && (!getControlledTabId() || getControlledTabId() === tabId)) {
      void refreshTabContext();
    }
  };

  const bindBrowserListeners = () => {
    chrome.storage?.onChanged?.addListener(handleStorageChanged);
    chrome.tabs?.onActivated?.addListener(() => void refreshTabContext());
    chrome.tabs?.onUpdated?.addListener(handleTabUpdated);
  };

  const hydrateInitialContext = async () => {
    await refreshTabContext();
    const draft = await chrome.storage?.local?.get?.(INLINE_DRAFT_KEY).catch(() => ({}));
    await consumeInlineDraft(draft?.[INLINE_DRAFT_KEY]);
  };
  // Scoped tab references (#252): contexts captured for the CURRENT composer
  // submit only. The router resolves mentions before runChatTurn, and the
  // chat-turn controller consumes (and clears) them when building the request
  // payload, so a stale scope can never leak into a later turn.
  let pendingScopedContexts = [];

  const resolveScopedTabContext = async (message) => {
    const allTabs = (await chrome.tabs.query({}).catch(() => []));
    const scoped = resolveScopedTabs(message, allTabs, isReadableBrowserTab);
    const { items, skipped, ambiguous } = scoped;
    pendingScopedContexts = [];

    // Explicit (quoted, typeahead-inserted) references that no longer resolve
    // fail loudly and NEVER widen scope. Bare mentions keep the #308 prose
    // rule: silent unless they named an unreadable/internal tab.
    for (const entry of skipped) {
      if (entry.quoted) {
        await addMessage("system", `@"${entry.mention}" could not be resolved — the tab is closed or not readable in this session. The request scope was not widened.`);
      } else if (entry.title || entry.url) {
        await addMessage("system", entry.reason);
      }
    }

    for (const entry of ambiguous) {
      const candidates = entry.candidates
        .map((candidate) => `"${candidate.title || candidate.url}"`)
        .join(", ");
      await addMessage("system", `@${entry.mention} matched ${entry.candidates.length} open tabs: ${candidates}. Specify which tab you mean (e.g. by full title or @tab N).`);
    }

    if (items.length === 0) return { ...scoped, contexts: [] };

    const contexts = [];
    for (const item of items) {
      const read = await readTabPage({ id: item.tabId, title: item.title, url: item.url }).catch(() => null);
      if (!read?.ok) {
        await addMessage("system", `Skipped: could not read "${item.title || item.url || "referenced tab"}" (${read?.error ?? "no page context"}).`);
        continue;
      }
      const snapshot = read.snapshot ?? {};
      contexts.push({
        tabId: item.tabId,
        mention: item.mention,
        title: snapshot.title || item.title,
        url: snapshot.url || item.url,
        text: String(snapshot.text ?? snapshot.page?.visibleText ?? "").slice(0, SCOPED_CAPTURE_TEXT_LIMIT)
      });
    }
    pendingScopedContexts = contexts;

    if (contexts.length > 0) {
      const provenanceLines = contexts.map((context) =>
        `- @${context.mention}: ${context.title || context.url || "(no title)"} — ${context.url || "(no url)"}`
      );
      await addMessage(
        "system",
        `Scoped to ${contexts.length} referenced tab${contexts.length === 1 ? "" : "s"} (content attached to this request; no tab activated):\n${provenanceLines.join("\n")}`,
        { chips: contexts.map((context) => ({ title: context.title, url: context.url })) }
      );
    }
    return { ...scoped, contexts };
  };

  const consumeScopedTabContexts = () => {
    const contexts = pendingScopedContexts;
    pendingScopedContexts = [];
    return contexts;
  };
  const resolveComparisonContext = async (message) => {
    const allTabs = (await chrome.tabs.query({}).catch(() => []));
    const comparison = resolveTabComparison(message, allTabs, isReadableBrowserTab);
    const { items, skipped, ambiguous } = comparison;

    // Truly zero-resolution: nothing resolved AND nothing to ask about. Stay
    // silent so ordinary prose containing two coincidental `@` symbols does
    // not produce chat noise. The previous behavior posted "no open tab
    // matched" system messages even when nothing matched; that was equivalent
    // to the pre-existing single-tab path's silent no-op.
    if (items.length === 0 && ambiguous.length === 0) return comparison;

    // Ambiguous references: ask for clarification with candidate refs (#220).
    for (const entry of ambiguous) {
      const candidates = entry.candidates
        .map((candidate) => `"${candidate.title || candidate.url}"`)
        .join(", ");
      await addMessage("system", `@${entry.mention} matched ${entry.candidates.length} open tabs: ${candidates}. Specify which tab you mean (e.g. by full title or @tab N).`);
    }

    // No items resolved: stop here (silently on skipped noise, but we already
    // posted the ambiguous clarification above). No tab is bound.
    if (items.length === 0) return comparison;

    // Only emit skip reasons for mentions that matched an unreadable/internal
    // tab. Pure "no open tab matched" lines stay silent (covered above).
    for (const entry of skipped) {
      if (!entry.title && !entry.url) continue;
      await addMessage("system", entry.reason);
    }

    // A single, unambiguous mention preserves the pre-existing single-tab bind
    // exactly, so the cross-tab path is a strict superset of the old behavior.
    if (items.length === 1 && skipped.length === 0 && ambiguous.length === 0) {
      return bindMentionedTab(message);
    }

    // Cross-tab comparison: post the provenance summary but DO NOT activate
    // any tab. The previous implementation called `setControlledTabId` +
    // `chrome.tabs.update({active:true})` on the first resolved tab, which
    // switched browser focus and contradicted the PR's read-only claim.
    // Comparison is a context-only binding; the user (or a follow-up
    // single-tab mention) decides which tab to land on.
    const provenanceLines = items.map((item) =>
      `- @${item.mention}: ${item.title || item.url || "(no title)"} — ${item.url || "(no url)"}`
    );
    await addMessage("system", `Comparing ${items.length} tabs (each item carries tab provenance; no tab is activated — say "@${items[0].mention}" to switch):\n${provenanceLines.join("\n")}`);
    return comparison;
  };

  return {
    bindBrowserListeners,
    bindMentionedTab,
    consumeInlineDraft,
    consumeScopedTabContexts,
    handleStorageChanged,
    handleTabUpdated,
    hydrateInitialContext,
    resolveComparisonContext,
    resolveScopedTabContext,
    resolveTabMention
  };
}
