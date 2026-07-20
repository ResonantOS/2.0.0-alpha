export function trimPlannerSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  return {
    title: String(snapshot.title ?? "").slice(0, 180),
    url: String(snapshot.url ?? "").slice(0, 800),
    text: String(snapshot.text ?? "").slice(0, 6000),
    viewport: snapshot.viewport ?? null,
    links: Array.isArray(snapshot.links) ? snapshot.links.slice(0, 30) : [],
    controls: Array.isArray(snapshot.controls) ? snapshot.controls.slice(0, 40) : [],
    fields: Array.isArray(snapshot.fields) ? snapshot.fields.slice(0, 30) : [],
    tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs.slice(0, 30) : [],
    walletProviders: snapshot.walletProviders ?? null,
  };
}

function sanitizeControlText(value, label, max = 280) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`Planner step is missing ${label}.`);
  }
  return text.slice(0, max);
}

export function sanitizeControlUrl(value) {
  const text = sanitizeControlText(value, "target", 900).replace(/[.,;:!?]+$/, "");
  const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Planner can only open http or https pages.");
  }
  return url.toString();
}

export function stepRequiresHumanApproval(step) {
  const combined = `${step.type ?? ""} ${step.text ?? ""} ${step.field ?? ""} ${step.target ?? ""} ${step.query ?? ""}`.toLowerCase();
  return /\b(seed|private key|password|passphrase|wallet|phantom|sign|signature|approve|confirm|buy|sell|swap|stake|unstake|bridge|mint|claim|pay|payment|checkout|login|submit|publish|post|delete|remove|transfer)\b/.test(combined);
}

export function sanitizeControlStep(step) {
  if (!step || typeof step !== "object") {
    throw new Error("Planner step must be an object.");
  }
  const type = String(step.type ?? "").trim().toLowerCase();
  if (["inspect", "read"].includes(type)) {
    return { type: "read" };
  }
  if (type === "forms") {
    return { type: "forms" };
  }
  if (type === "tabs") {
    return { type: "tabs" };
  }
  if (type === "switch_tab") {
    const tabId = Number(step.tabId ?? step.id);
    if (!Number.isInteger(tabId) || tabId < 0) {
      throw new Error("Switch-tab action requires a numeric tabId.");
    }
    return { type: "switch_tab", tabId };
  }
  if (type === "open") {
    const sanitized = { type: "open", target: sanitizeControlUrl(step.target ?? step.url) };
    if (stepRequiresHumanApproval(sanitized)) {
      throw new Error("Planner attempted to open a restricted wallet/payment/signing target.");
    }
    return sanitized;
  }
  if (type === "search") {
    return {
      type: "search",
      action: step.action === "news" ? "news" : "search",
      query: sanitizeControlText(step.query, "query", 220),
    };
  }
  if (type === "click") {
    const sanitized = {
      type: "click",
      text: step.text ? sanitizeControlText(step.text, "text") : "",
      ref: step.ref ? sanitizeControlText(step.ref, "ref", 80) : "",
    };
    if (!sanitized.text && !sanitized.ref) {
      throw new Error("Planner click step requires text or ref.");
    }
    if (stepRequiresHumanApproval(sanitized)) {
      throw new Error("Planner attempted to automate a restricted click.");
    }
    return sanitized;
  }
  if (type === "type") {
    const sanitized = {
      type: "type",
      text: sanitizeControlText(step.text, "text", 600),
      field: step.field ? sanitizeControlText(step.field, "field", 160) : "",
      ref: step.ref ? sanitizeControlText(step.ref, "ref", 80) : "",
      submit: Boolean(step.submit),
    };
    if (stepRequiresHumanApproval(sanitized)) {
      throw new Error("Planner attempted to automate restricted typing.");
    }
    return sanitized;
  }
  if (type === "scroll") {
    const direction = ["up", "down", "top", "bottom"].includes(step.direction) ? step.direction : "down";
    return { type: "scroll", direction };
  }
  if (type === "wait") {
    const ms = Math.min(5000, Math.max(250, Number(step.ms ?? 1000) || 1000));
    return { type: "wait", ms };
  }
  if (type === "stop") {
    return {
      type: "stop",
      reason: String(step.reason ?? "Planner stopped before a restricted action.").slice(0, 500),
    };
  }
  throw new Error(`Unsupported planner step type: ${type || "missing"}.`);
}

export function sanitizeNextActionDecision(decision) {
  if (!decision || typeof decision !== "object") {
    throw new Error("Next-action response must be an object.");
  }
  const status = String(decision.status ?? "continue").trim().toLowerCase();
  if (!["continue", "done", "needs_approval", "blocked"].includes(status)) {
    throw new Error(`Unsupported next-action status: ${status || "missing"}.`);
  }
  const base = {
    source: String(decision.source ?? "llm").slice(0, 80),
    status,
    thought: String(decision.thought ?? "").trim().slice(0, 500),
    doneSummary: decision.doneSummary ? String(decision.doneSummary).trim().slice(0, 700) : null,
    approvalReason: decision.approvalReason ? String(decision.approvalReason).trim().slice(0, 700) : null,
    strategyPhase: decision.strategyPhase ? String(decision.strategyPhase).trim().slice(0, 300) : null,
    strategyRationale: decision.strategyRationale ? String(decision.strategyRationale).trim().slice(0, 500) : null,
    completionCheck: decision.completionCheck ? String(decision.completionCheck).trim().slice(0, 500) : null,
    action: null,
  };
  if (status === "done") {
    return {
      ...base,
      doneSummary: base.doneSummary || base.thought || "The browser task is complete.",
    };
  }
  if (status === "needs_approval" || status === "blocked") {
    return {
      ...base,
      approvalReason: base.approvalReason || base.thought || "The browser task cannot continue safely.",
    };
  }
  let action = null;
  try {
    action = sanitizeControlStep(decision.action);
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      approvalReason: error instanceof Error ? error.message : String(error),
      action: null,
    };
  }
  if (action.type === "stop") {
    return {
      ...base,
      status: "needs_approval",
      approvalReason: action.reason,
    };
  }
  if (stepRequiresHumanApproval(action)) {
    return {
      ...base,
      status: "needs_approval",
      approvalReason: "This browser action requires human approval.",
      action: null,
    };
  }
  return { ...base, action };
}

export function sanitizeControlPlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("Planner response must be an object.");
  }
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
  const steps = [];
  for (const rawStep of rawSteps.slice(0, 8)) {
    const step = sanitizeControlStep(rawStep);
    if (step.type === "stop") {
      return {
        summary: String(plan.summary ?? "Planner stopped before a restricted action.").slice(0, 500),
        steps,
        needsApproval: true,
        approvalReason: step.reason,
      };
    }
    steps.push(step);
  }
  if (!steps.length && !plan.needsApproval) {
    throw new Error("Planner returned no executable steps.");
  }
  return {
    summary: String(plan.summary ?? "Browser control plan").slice(0, 500),
    steps,
    needsApproval: Boolean(plan.needsApproval),
    approvalReason: plan.approvalReason ? String(plan.approvalReason).slice(0, 500) : null,
  };
}

function decodeXmlEntities(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

export function createAgentControlHostService(dependencies = {}) {
  const {
    extractAssistantContent,
    extractJsonObject,
    fetchImpl = globalThis.fetch,
    openAiReasoningEffort,
    providerRouteForModel,
    allModelCatalog,
    allProviderProfiles,
    readProviderSecrets,
    sanitizeAssistantContent,
  } = dependencies;

  function required(name, value) {
    if (typeof value !== "function") {
      throw new Error(`Agent Control host service missing dependency: ${name}`);
    }
    return value;
  }

  const providerRoute = required("providerRouteForModel", providerRouteForModel);
  const readSecrets = required("readProviderSecrets", readProviderSecrets);
  const assistantContent = required("extractAssistantContent", extractAssistantContent);
  const parseJson = required("extractJsonObject", extractJsonObject);
  const sanitizeAssistant = required("sanitizeAssistantContent", sanitizeAssistantContent);
  const reasoningEffort = required("openAiReasoningEffort", openAiReasoningEffort);
  const fetchFn = required("fetchImpl", fetchImpl);

  // Route through the dynamic catalog when the host provides it, so a user-added
  // provider selected for planning reaches its own endpoint instead of the
  // built-in default. Falls back to built-in routing when not injected.
  const dynamicCatalog = typeof allModelCatalog === "function" ? allModelCatalog : null;
  const dynamicProfiles = typeof allProviderProfiles === "function" ? allProviderProfiles : null;
  async function routeForModel(model) {
    if (dynamicCatalog && dynamicProfiles) {
      const [catalog, profiles] = await Promise.all([dynamicCatalog(), dynamicProfiles()]);
      return providerRoute(model, { catalog, profiles });
    }
    return providerRoute(model);
  }

  async function executeControlPlan(payload = {}) {
    const route = await routeForModel(payload.model);
    const secrets = await readSecrets();
    const apiKey = secrets[route.providerId];
    if (!apiKey) {
      throw new Error(`${route.label} credential missing. Falling back to deterministic browser control is required.`);
    }
    const goal = String(payload.goal ?? "").trim();
    if (!goal) {
      throw new Error("Planner requires a browser goal.");
    }
    const pageSnapshot = trimPlannerSnapshot(payload.pageSnapshot);
    const runbook = payload.runbook && typeof payload.runbook === "object" ? payload.runbook : null;
    const plannerPrompt = [
      "You are the ResonantOS browser control planner.",
      "Return strict JSON only. Do not include markdown or commentary.",
      "You do not execute actions. You only propose a bounded plan for the host to validate and execute.",
      "Allowed step types:",
      "- {\"type\":\"read\"}",
      "- {\"type\":\"open\",\"target\":\"https://example.com\"}",
      "- {\"type\":\"search\",\"query\":\"query\",\"action\":\"search|news\"}",
      "- {\"type\":\"forms\"}",
      "- {\"type\":\"tabs\"}",
      "- {\"type\":\"switch_tab\",\"tabId\":123}",
      "- {\"type\":\"click\",\"text\":\"visible button or link text\",\"ref\":\"optional observed control ref\"}",
      "- {\"type\":\"type\",\"text\":\"text to type\",\"field\":\"optional visible search/input label\",\"ref\":\"optional observed field ref\",\"submit\":false}",
      "- {\"type\":\"scroll\",\"direction\":\"up|down|top|bottom\"}",
      "- {\"type\":\"stop\",\"reason\":\"why human approval is required\"}",
      "Never plan wallet signing, seed phrases, passwords, payments, public posting, account login, destructive document changes, or public form submission. Search-field enter is allowed.",
      "If the goal requires one of those restricted actions, return needsApproval true and a stop reason.",
      "Prefer read/forms before clicking or typing when the page state is unclear.",
      "Follow the supplied strategyRunbook. Include strategyPhase, strategyRationale, and completionCheck in the response.",
      "Use strategyRunbook.preferredProbes before acting, strategyRunbook.successSignals before claiming completion, and strategyRunbook.stopConditions before asking for approval or blocking.",
      "Use visible controls and fields from the supplied snapshot when possible.",
      "JSON schema: {\"summary\":\"short\", \"steps\":[...], \"needsApproval\":false, \"approvalReason\":null, \"strategyPhase\":\"short\", \"strategyRationale\":\"short\", \"completionCheck\":\"short\"}",
    ].join("\n");
    const userPrompt = JSON.stringify({
      goal,
      pageSnapshot,
      strategyRunbook: runbook,
    });
    const response = await fetchFn(`${route.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: route.wireModel,
        messages: [
          { role: "system", content: plannerPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(route.providerType === "openai" ? { reasoning_effort: reasoningEffort(payload.thinkingDepth), response_format: { type: "json_object" } } : {}),
      }),
    });
    const responsePayload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = responsePayload?.error?.message ?? `Provider planner request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    const content = sanitizeAssistant(route.providerType, assistantContent(responsePayload));
    return {
      plan: sanitizeControlPlan(parseJson(content)),
      providerId: route.providerId,
      model: payload.model || route.wireModel,
      usage: responsePayload?.usage ?? null,
    };
  }

  async function executeNextAction(payload = {}) {
    const route = await routeForModel(payload.model);
    const secrets = await readSecrets();
    const apiKey = secrets[route.providerId];
    if (!apiKey) {
      throw new Error(`${route.label} credential missing. Falling back to deterministic browser control is required.`);
    }
    const goal = String(payload.goal ?? "").trim();
    if (!goal) {
      throw new Error("Next-action route requires a browser goal.");
    }
    const pageSnapshot = trimPlannerSnapshot(payload.pageSnapshot);
    const runbook = payload.runbook && typeof payload.runbook === "object" ? payload.runbook : null;
    const history = Array.isArray(payload.history)
      ? payload.history.slice(-10).map((item) => ({
          action: item?.action ?? null,
          result: item?.result ?? null,
          observation: item?.observation ?? null,
        }))
      : [];
    const nextActionPrompt = [
      "You are the ResonantOS browser agent controller.",
      "You are not a chatbot in this route. You choose exactly one next browser action after observing the current page.",
      "Return strict JSON only. Do not include markdown or commentary.",
      "Use an observe-decide-act-verify loop: choose one action, wait for the host to execute it, then decide again from the next observation.",
      "The observation can include open tabs. Use them for context, but act only through the controlled tab unless an explicit tab-switch tool exists.",
      "Allowed action types:",
      "- {\"type\":\"read\"}",
      "- {\"type\":\"open\",\"target\":\"https://example.com\"}",
      "- {\"type\":\"search\",\"query\":\"query\",\"action\":\"search|news\"}",
      "- {\"type\":\"forms\"}",
      "- {\"type\":\"tabs\"}",
      "- {\"type\":\"switch_tab\",\"tabId\":123}",
      "- {\"type\":\"click\",\"text\":\"visible button, link, option, or control text\",\"ref\":\"optional observed control ref\"}",
      "- {\"type\":\"type\",\"text\":\"text to type\",\"field\":\"optional visible search/input label\",\"ref\":\"optional observed field ref\",\"submit\":false}",
      "- {\"type\":\"scroll\",\"direction\":\"up|down|top|bottom\"}",
      "- {\"type\":\"wait\",\"ms\":1000}",
      "Never automate wallet signing, seed phrases, passwords, payment, checkout, login, public submission, posting, destructive document edits, or irreversible account actions. Search-field enter is allowed.",
      "If the next step needs one of those actions, return status needs_approval with approvalReason.",
      "If the goal is complete based on the current page observation, return status done and doneSummary.",
      "If you cannot continue because the page lacks the required controls or content, return status blocked and approvalReason.",
      "Follow the supplied strategyRunbook. Choose the next action that advances the currentPhase and preserves safetyStops.",
      "Use strategyRunbook.preferredProbes before acting, strategyRunbook.successSignals before claiming completion, and strategyRunbook.stopConditions before asking for approval or blocking.",
      "Include strategyPhase, strategyRationale, and completionCheck in every response so the host trace explains the strategy, not only the low-level action.",
      "Prefer observed refs from controls and fields when available; otherwise use precise visible text. Do not claim completion unless the observation proves it.",
      "JSON schema: {\"thought\":\"short user-visible status\", \"status\":\"continue|done|needs_approval|blocked\", \"action\":{...}|null, \"approvalReason\":null|string, \"doneSummary\":null|string, \"strategyPhase\":\"short\", \"strategyRationale\":\"short\", \"completionCheck\":\"short\"}",
    ].join("\n");
    const userPrompt = JSON.stringify({
      goal,
      pageSnapshot,
      history,
      strategyRunbook: runbook,
    });
    const response = await fetchFn(`${route.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: route.wireModel,
        messages: [
          { role: "system", content: nextActionPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(route.providerType === "openai" ? { reasoning_effort: reasoningEffort(payload.thinkingDepth), response_format: { type: "json_object" } } : {}),
      }),
    });
    const responsePayload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = responsePayload?.error?.message ?? `Provider next-action request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    const content = sanitizeAssistant(route.providerType, assistantContent(responsePayload));
    return {
      decision: sanitizeNextActionDecision(parseJson(content)),
      providerId: route.providerId,
      model: payload.model || route.wireModel,
      usage: responsePayload?.usage ?? null,
    };
  }

  async function executeNewsSearch(payload = {}) {
    const query = String(payload.query ?? "top stories").trim() || "top stories";
    const url = query === "top stories"
      ? "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"
      : `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const response = await fetchFn(url, {
      headers: { "User-Agent": "Mozilla/5.0 ResonantOS BrowserFirst" },
    });
    if (!response.ok) {
      throw new Error(`News fetch failed with HTTP ${response.status}.`);
    }
    const xml = await response.text();
    const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)]
      .slice(0, Number(payload.limit ?? 5))
      .map((match) => {
        const item = match[0];
        const title = decodeXmlEntities(/<title>([\s\S]*?)<\/title>/i.exec(item)?.[1] ?? "");
        const link = decodeXmlEntities(/<link>([\s\S]*?)<\/link>/i.exec(item)?.[1] ?? "");
        const source = decodeXmlEntities(/<source[^>]*>([\s\S]*?)<\/source>/i.exec(item)?.[1] ?? "");
        const publishedAt = decodeXmlEntities(/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(item)?.[1] ?? "");
        return { title, link, source, publishedAt };
      })
      .filter((item) => item.title);
    return { query, items };
  }

  return {
    agentControlRoutes: [
      {
        method: "POST",
        path: "/augmentor/control-plan",
        requiredCapability: "agent-control-plan",
        handler: executeControlPlan,
      },
      {
        method: "POST",
        path: "/augmentor/next-action",
        requiredCapability: "agent-control-plan",
        handler: executeNextAction,
      },
      {
        method: "POST",
        path: "/web/news",
        requiredCapability: "agent-control-plan",
        handler: executeNewsSearch,
      },
    ],
    executeControlPlan,
    executeNextAction,
    executeNewsSearch,
  };
}
