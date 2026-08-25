import { modelConnectionMessage } from "./runtime-error-messages.js";

export const DEFAULT_MAX_HISTORY_MESSAGES = 16;
const CHAT_TOKEN_PATTERN = /\b(?:sk-[a-z0-9_-]{12,}|sk-ant-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,}|hf_[a-z0-9_-]{12,}|xox[baprs]-[a-z0-9-]{12,}|AIza[a-z0-9_-]{12,}|AKIA[A-Z0-9]{12,})\b/gi;

function safeContextText(value, max = 1000) {
  return String(value ?? "")
    .replace(CHAT_TOKEN_PATTERN, "[redacted]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (candidate) => {
      const digits = candidate.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 ? "[redacted]" : candidate;
    })
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s{3,}/g, "  ")
    .trim()
    .slice(0, max);
}

function safeContextUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return safeContextText(String(value ?? "").split(/[?#]/)[0], 300);
  }
}

function formatVisibleSections(snapshot) {
  const sections = Array.isArray(snapshot.sections) && snapshot.sections.length
    ? snapshot.sections
    : snapshot.viewport?.visibleSections;
  if (!Array.isArray(sections) || !sections.length) return "";
  const lines = sections.slice(0, 6).map((section) => {
    const label = safeContextText(section?.label || section?.id || "Section", 80);
    const text = safeContextText(section?.text, 320);
    const visible = section?.currentlyVisible ? " visible" : "";
    return text ? `- ${label}${visible}: ${text}` : `- ${label}${visible}`;
  });
  return `Visible sections:\n${lines.join("\n")}`;
}

function formatForms(forms) {
  if (!Array.isArray(forms) || !forms.length) return "";
  const lines = forms.slice(0, 8).map((form) => {
    const name = safeContextText(form?.name || form?.id || "Form", 80);
    const fields = Array.isArray(form?.fields)
      ? form.fields.slice(0, 8).map((field) => {
        const fieldName = safeContextText(field?.name || field?.label || "field", 60);
        const kind = safeContextText(field?.fieldKind || "field", 40);
        const value = safeContextText(field?.value, 120);
        return value ? `${fieldName} (${kind})=${value}` : `${fieldName} (${kind})`;
      }).join("; ")
      : "";
    return fields ? `- ${name}: ${fields}` : `- ${name}`;
  });
  return `Forms:\n${lines.join("\n")}`;
}

function formatClickTrail(clickTrail) {
  if (!Array.isArray(clickTrail) || !clickTrail.length) return "";
  return `Recent clicks:\n${clickTrail.slice(-6).map((click) => `- ${safeContextText(click?.text || click?.selector, 120)}`).join("\n")}`;
}

export function pageContextForSnapshot(snapshot) {
  if (!snapshot) return null;
  const text = safeContextText(snapshot.text ?? snapshot.page?.visibleText ?? "", 7000);
  const summary = safeContextText(snapshot.summary, 1600);
  const headings = Array.isArray(snapshot.page?.headings)
    ? snapshot.page.headings.slice(0, 8).map((heading) => safeContextText(heading, 120)).filter(Boolean)
    : [];
  return [
    `Title: ${safeContextText(snapshot.title || snapshot.page?.title || "Untitled", 160)}`,
    `URL: ${safeContextUrl(snapshot.url) || "unknown"}`,
    snapshot.domain ? `Domain plugin: ${safeContextText(snapshot.domain, 120)}` : "",
    summary ? `Summary:\n${summary}` : "",
    headings.length ? `Headings:\n${headings.map((heading) => `- ${heading}`).join("\n")}` : "",
    text ? `Visible text:\n${text}` : "",
    formatVisibleSections(snapshot),
    snapshot.viewport?.activeOverlay ? `Active overlay: ${safeContextText(snapshot.viewport.activeOverlay.content || snapshot.viewport.activeOverlay.id, 500)}` : "",
    formatForms(snapshot.forms),
    formatClickTrail(snapshot.session?.clickTrail)
  ].filter(Boolean).join("\n\n");
}

// Budgeted, sanitized per-tab context blocks for explicitly scoped requests
// (#252). The total budget is split evenly across referenced tabs (with a
// floor) so N referenced tabs cannot crowd out conversation history; every
// block carries title/URL provenance.
export function tabContextsForScopedTabs(contexts, { totalBudget = 12000 } = {}) {
  const list = Array.isArray(contexts) ? contexts.filter((context) => context && (context.text || context.title)) : [];
  if (!list.length) return [];
  const perTab = Math.max(1500, Math.floor(totalBudget / list.length));
  return list.map((context) => ({
    tabId: context.tabId ?? null,
    title: safeContextText(context.title, 160),
    url: safeContextUrl(context.url),
    text: safeContextText(context.text, perTab)
  }));
}

export function runtimeContextForAttachments(attachments) {
  return attachments.length
    ? `Composer attachments:\n${attachments.map((item) => `- ${item.name}: ${item.content ?? item.summary}`).join("\n")}`
    : null;
}

export function providerMessagesFromHistory(messages, maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES) {
  return messages
    .filter((message) => ["user", "assistant"].includes(message.role))
    .slice(-maxHistoryMessages)
    .map((message) => ({ role: message.role, content: message.content }));
}

export function createChatTurnController({
  addMessage,
  bridgeRequest,
  getBridgeRequest,
  chatSessionStore,
  clearActivitySoon,
  clearAttachments,
    consumeScopedTabContexts = () => [],
getLastSnapshot,
  getModel,
  getSurface = () => "side-panel",
  getSystemPrompt = () => "",
  getThinkingDepth,
  maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES,
  setActivity,
  setStatus,
  setTurnBusy = () => undefined
}) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  let activeAbortController = null;

  async function bridgeChat({ signal, tabContexts = [] } = {}) {
    const attachments = chatSessionStore.getAttachments();
    return bridge()("/augmentor/chat", {
      method: "POST",
      signal,
      body: {
        model: getModel(),
        surface: getSurface(),
        workload: "augmentor-chat",
        thinkingDepth: getThinkingDepth(),
        systemPrompt: getSystemPrompt(),
        pageContext: pageContextForSnapshot(getLastSnapshot()),
        tabContexts,
        runtimeContext: runtimeContextForAttachments(attachments),
        messages: providerMessagesFromHistory(chatSessionStore.getMessages(), maxHistoryMessages)
      }
    });
  }

  async function runChatTurn() {
    if (activeAbortController) return;
    activeAbortController = new AbortController();
    setTurnBusy(true, { canStop: true });
    setStatus("Thinking");
    setActivity("thinking", "Thinking", "Calling the selected model route");
    try {
      const tabContexts = tabContextsForScopedTabs(consumeScopedTabContexts());
      const result = await bridgeChat({ signal: activeAbortController.signal, tabContexts });
      setStatus("Writing");
      setActivity("writing", "Writing response", result.model || getModel());
      await addMessage("assistant", result.reply, {
        usage: result.usage ?? { providerId: result.providerId, model: result.model },
        chips: tabContexts.map(({ title, url }) => ({ title, url }))
      });
      // Make a route fallback visible: the preferred model was unavailable and a
      // different one answered. Surfaced as a system notice with recovery guidance
      // rather than silently swapping the user's route.
      if (result.routeFallback && result.routeNotice) {
        await addMessage("system", result.routeNotice);
      }
      await clearAttachments();
      setStatus("Ready");
    } catch (error) {
      if (error?.name === "AbortError") {
        setStatus("Stopped");
        await addMessage("system", "Response stopped by the human before a reply was returned.");
        return;
      }
      setStatus("Provider failed");
      await addMessage("system", modelConnectionMessage(error));
    } finally {
      activeAbortController = null;
      setTurnBusy(false, { canStop: false });
      clearActivitySoon();
    }
  }

  function stopChatTurn() {
    activeAbortController?.abort();
  }

  return {
    bridgeChat,
    runChatTurn,
    stopChatTurn
  };
}
