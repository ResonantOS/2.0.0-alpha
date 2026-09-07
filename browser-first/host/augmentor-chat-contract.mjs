export function sanitizeAugmentorChatMessages(messages) {
  return Array.isArray(messages)
    ? messages
      .filter((message) => ["user", "assistant"].includes(message?.role) && String(message?.content ?? "").trim())
      .map((message) => ({ role: message.role, content: String(message.content).trim() }))
    : [];
}

export function augmentorSurfaceInstruction(surface = "side-panel") {
  const normalized = String(surface ?? "side-panel").trim().toLowerCase();
  if (normalized === "main-workspace" || normalized === "main") {
    return "You are running inside the full ResonantOS main workspace.";
  }
  if (normalized === "archive-intake" || normalized === "living-archive-intake") {
    return "You are running as a ResonantOS browser-page intake summarizer for the Living Archive review queue.";
  }
  return "You are running inside the ResonantOS browser side bar.";
}

// Browser tabs the user explicitly referenced with @tab mentions (#252). Each
// block carries title/URL provenance so answers can cite which tab a claim
// came from. Content is sanitized and budgeted by the extension; the host
// re-slices defensively and caps the whole section.
function referencedTabsContext(tabContexts) {
  if (!Array.isArray(tabContexts) || !tabContexts.length) return "";
  const blocks = tabContexts.slice(0, 8).map((tab, index) => {
    const title = String(tab?.title ?? "").slice(0, 160) || "Untitled";
    const url = String(tab?.url ?? "").slice(0, 400) || "unknown";
    const text = String(tab?.text ?? "").slice(0, 4000);
    return `--- Referenced tab ${index + 1}: ${title} — ${url} ---\n${text}`;
  });
  return `Browser tabs explicitly referenced by the user (scope the answer to these tabs; each block carries its tab provenance):\n${blocks.join("\n\n")}`.slice(0, 12000);
}

export function buildAugmentorSystemPrompt(payload = {}) {
  return [
    "You are Augmentor, the Strategist agent inside ResonantOS.",
    augmentorSurfaceInstruction(payload.surface),
    "The web page remains in the main browser viewport; never suggest replacing the page with chat UI.",
    "ResonantOS provides host-mediated browser tools outside the model call: open/search pages, read the active page, click visible page text, and type into editable fields.",
    "ResonantOS also provides a host-mediated agent control layer for delegation. Augmentor may delegate to approved add-on agents such as Hermes, OpenCode, and Resonant Engineer through governed task packets; never claim delegation is outside Augmentor's ResonantOS capabilities.",
    "If the user asks for delegation and the request was not executed before this model call, ask for the target agent and mission instead of telling them to use a separate system.",
    "If the user asks you to navigate, search a site, get current/latest news, research the web, shop, book, click, type, or operate a webpage, do not claim you will do it in plain chat. Those requests must be handled by the host Agent Control Mode before the model call.",
    "If such a browser-action request reaches you anyway, do not mention routers, tools, internals, or implementation details. Say briefly that this needs Agent Control and ask the user to resend it as `/control <task>`.",
    "When the host has already returned a browser-tool result in the conversation, treat that result as authoritative and explain the next useful action.",
    "If the user asks for a browser action, current information, or web research that was not executed by the host, ask them to retry with a specific Agent Control action instead of claiming you are only a text assistant or that you lack internet access.",
    "Wallet signing, seed phrases, credential autofill, and public submissions require explicit human approval and must not be automated.",
    "Be direct, pragmatic, and concise. Answer the human outcome first; do not expose file paths, route names, JSON, provider metadata, or system status unless the user asks for diagnostics.",
    "If browser page context is provided, use it as context but do not claim to mutate memory or execute tools unless the host explicitly returned that result.",
    payload.systemPrompt ? `Additional user-configured Augmentor system prompt:\n${String(payload.systemPrompt).slice(0, 8000)}` : "",
    payload.pageContext ? `Current browser page context:\n${String(payload.pageContext).slice(0, 8000)}` : "",
    referencedTabsContext(payload.tabContexts),
    payload.runtimeContext ? `Current ResonantOS runtime context:\n${String(payload.runtimeContext).slice(0, 6000)}` : "",
  ].filter(Boolean).join("\n\n");
}

export function buildAugmentorChatRequestMessages(payload = {}) {
  const messages = sanitizeAugmentorChatMessages(payload.messages);
  if (!messages.length) {
    throw new Error("No chat message was provided.");
  }
  return [
    { role: "system", content: buildAugmentorSystemPrompt(payload) },
    ...messages,
  ];
}
