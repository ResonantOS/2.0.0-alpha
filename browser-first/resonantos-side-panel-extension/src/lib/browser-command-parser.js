export const browserIntentVerbs = /\b(open|go\s+to|go\s+on|navi\w*(?:\s+to)?|visit|load|browse(?:\s+to)?|take\s+me\s+to|show\s+me|bring\s+up|pull\s+up)\b/i;
export const browserTargetPattern = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>)]*)?)/i;
export const searchIntentVerbs = /\b(search|find|look\s+up|research|news|latest|internet|web|headline|headlines|breaking|today|current)\b/i;

export function normalizeBrowserUrl(target) {
  const trimmed = String(target ?? "").trim().replace(/[.,;:!?]+$/, "");
  if (!trimmed) {
    throw new Error("Browser navigation requires a URL or domain.");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("Only http and https browser navigation is supported.");
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https browser navigation is supported.");
  }
  return url.toString();
}

export function parseNaturalBrowserIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized) || !browserIntentVerbs.test(normalized)) {
    return null;
  }
  const target = browserTargetPattern.exec(normalized)?.[1];
  if (!target) {
    return null;
  }
  return { action: "open", target };
}

const quotedTextPattern = /["“”'‘’]([^"“”'‘’]{1,280})["“”'‘’]/;

export const parseQuotedText = (message) => quotedTextPattern.exec(String(message ?? ""))?.[1]?.trim() ?? "";

export const parseQuotedTexts = (message) =>
  Array.from(String(message ?? "").matchAll(/["“”'‘’]([^"“”'‘’]{1,280})["“”'‘’]/g))
    .map((match) => match[1]?.trim())
    .filter(Boolean);

function cleanUnquotedClickTarget(value) {
  const text = String(value ?? "")
    .replace(/\b(?:then|and\s+(?:then\s+)?(?:read|type|write|enter|scroll|open|go|search|find|summari[sz]e|inspect|click|press|tap|select|choose))\b[\s\S]*$/i, "")
    .replace(/[.,;:!?]+$/g, "")
    .replace(/^\s*(?:on|the|a|an)\s+/i, "")
    .replace(/\s+(?:button|link|tab|menu\s+item|menu|screen|page|section)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || "";
}

export function parseTypeIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized) || !/\b(type|write|enter|put|insert)\b/i.test(normalized)) {
    return null;
  }
  const quotedTexts = parseQuotedTexts(normalized);
  const text = quotedTexts.at(-1) ?? "";
  if (!text) {
    return null;
  }
  const submit = /\b(search bar|google|search field|address bar|submit|press enter|hit enter)\b/i.test(normalized);
  return { text, submit };
}

export function parseClickIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized) || !/\b(click|press|tap|select|choose|open)\b/i.test(normalized)) {
    return null;
  }
  const quotedTexts = parseQuotedTexts(normalized);
  const text = quotedTexts[0] ?? "";
  if (!text) {
    const directClick = /\b(?:click|press|tap|select|choose)\b\s+([\s\S]{1,280})/i.exec(normalized);
    if (directClick) {
      const target = cleanUnquotedClickTarget(directClick[1]);
      return target ? { text: target } : null;
    }
    const openPageTarget = /\bopen\b\s+([\s\S]{1,280})/i.exec(normalized);
    if (openPageTarget && !browserTargetPattern.test(normalized)) {
      const target = cleanUnquotedClickTarget(openPageTarget[1]);
      return target ? { text: target } : null;
    }
    return null;
  }
  return { text };
}

export function parseReadPageIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized)) {
    return null;
  }
  return (
    /\b(read|scan|summari[sz]e|inspect|look at|check|analyse|analyze|understand|see|view|access|tell me about)\b/i.test(normalized) ||
    /\b(can you|do you)\s+(see|view|access)\b/i.test(normalized) ||
    /\b(what'?s|what is|what can you see)\b/i.test(normalized)
  ) &&
    (/\b(this|current|active|the|open|loaded)\s+(page|website|webpage|site|tab|browser|window)\b/i.test(normalized) ||
      /\b(here|on screen|in front of you)\b/i.test(normalized))
    ? { action: "read_page" }
    : null;
}

// A message that is essentially *just* a "summarize"/"tl;dr"/"recap" command
// means "summarize the page I'm looking at" — no /control and no need to spell
// out "the page". It is bounded to the whole message so a richer ask that only
// starts with the verb ("summarize these notes: ...") still falls through to
// normal chat. Routing this to a silent page read + a chat turn gives an LLM
// summary that matches the inline floating-panel Summarize.
export function parseSummarizePageIntent(message) {
  const normalized = String(message ?? "").trim();
  if (!normalized || /^\//.test(normalized)) return null;
  const command = /^(?:please\s+|pls\s+|can\s+you\s+|could\s+you\s+)?(?:summari[sz]e|summary|tl;?dr|recap|sum\s+(?:it\s+)?up)(?:\s+(?:it|this|that|the\s+page|this\s+page|the\s+site|for\s+me|please))*[.!?]*$/i;
  return command.test(normalized) ? { action: "summarize_page" } : null;
}

// A bare continuation phrase ("try again", "continue", "retry", "keep going")
// means "carry on the Agent Control run I just resumed" — not a new task and not
// chat. Callers gate this on there actually being a resumable run, so a stray
// "continue" in pure chat still goes to chat. Bounded to the whole message so
// "continue to the checkout and pay" stays a real task.
export function parseControlContinuationIntent(message) {
  const normalized = String(message ?? "").trim();
  if (!normalized || /^\//.test(normalized)) return null;
  const phrase = /^(?:please\s+|pls\s+)?(?:try\s+again|retry(?:\s+(?:it|that))?|continue|keep\s+going|carry\s+on|go\s+on|resume|one\s+more\s+time)[.!?]*$/i;
  return phrase.test(normalized) ? { action: "control_continue" } : null;
}

export function parseStructuredPageEditIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized) || !/\b(add|edit|update|write|insert|change|replace)\b/i.test(normalized)) {
    return null;
  }
  if (!/\b(doc|document|sheet|spreadsheet|page|row|line|cell|google\s+(sheet|doc|docs|sheets))\b/i.test(normalized)) {
    return null;
  }
  return { action: "structured_page_edit", instruction: normalized };
}

export function parseScrollIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized) || !/\b(scroll|move)\b/i.test(normalized)) {
    return null;
  }
  const direction = /\b(up|top)\b/i.test(normalized)
    ? /\btop\b/i.test(normalized) ? "top" : "up"
    : /\b(bottom|end)\b/i.test(normalized) ? "bottom" : "down";
  return { direction };
}

export function parseFormsIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized)) {
    return null;
  }
  return /\b(form|forms|field|fields|input|inputs)\b/i.test(normalized) &&
    /\b(detect|inspect|find|show|list|what)\b/i.test(normalized)
    ? { action: "detect_forms" }
    : null;
}

export function parseControlIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized)) {
    return null;
  }
  const match = /\b(take control|control the browser|use the browser|operate the browser|do this in the browser)\b[:\s-]*([\s\S]*)/i.exec(normalized);
  if (!match) {
    return null;
  }
  return { goal: (match[2] || normalized).trim() };
}

// A compound "go to <site> and <do something>" command needs navigation first,
// so it belongs in agent-control mode — not the single-action fast paths
// (click/type/scroll/read) that operate on the *current* page. Without this,
// "go to fifa.com and click on news" was swallowed by the click rule and never
// navigated. It fires only when BOTH a real navigation target and a follow-up
// action are present, so bare "click Submit" and bare "go to fifa.com" are
// untouched.
export function parseBrowserNavigationTaskIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized)) {
    return null;
  }
  const hasNavigationTarget = browserTargetPattern.test(normalized) && browserIntentVerbs.test(normalized);
  if (!hasNavigationTarget) {
    return null;
  }
  const hasFollowupAction = /\b(click|press|tap|select|choose|find|search|look\s+for|add|put|fill|complete|submit|scroll|read|inspect|check|compare|buy|book|type|enter|watch|play|download)\b/i.test(normalized);
  if (!hasFollowupAction) {
    return null;
  }
  return { goal: normalized };
}

export function parseAutonomousBrowserActionIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized)) {
    return null;
  }
  const hasPlainBrowserTarget = browserTargetPattern.test(normalized) && browserIntentVerbs.test(normalized);
  const hasWorkAfterNavigation = /\b(find|search|look\s+for|add|put|select|choose|click|compare|buy|shop|book|fill|complete|submit|scroll|read|inspect|check|analyse|analyze|summari[sz]e|extract)\b/i.test(normalized);
  if (hasPlainBrowserTarget && !hasWorkAfterNavigation) {
    return null;
  }
  const shoppingIntent = /\b(amazon|amazon\.it|cart|chart|basket|carrello|buy|shop|shopping|product|pringles|nvidia|rtx|5090)\b/i.test(normalized) &&
    /\b(go\s+to|open|find|search|look\s+for|add|put|select|choose|click)\b/i.test(normalized);
  const browserTaskVerbs = /\b(book|schedule|arrange|reserve|fill|complete|submit|click|press|tap|select|choose|pick|open|find|search|scroll|read|inspect|check|analyse|analyze|summari[sz]e|extract|look at|navigate|go to|visit|add|put)\b/i;
  const browserObjectHints = /\b(call|meeting|appointment|booking|calendar|form|page|site|website|webpage|tab|browser|window|button|field|slot|time|date|news|internet|web|amazon|shop|shopping|product|cart|chart|basket|carrello)\b/i;
  if (shoppingIntent) {
    return { goal: normalized };
  }
  if (!browserTaskVerbs.test(normalized) || !browserObjectHints.test(normalized)) {
    return null;
  }
  return { goal: normalized };
}

export function normalizeSearchQuery(message) {
  const cleaned = String(message ?? "")
    .replace(/\b(hey|hi|hello|can you|please|could you|would you|tell me|show me|what'?s|what is|what are|which is|which are)\b/gi, " ")
    .replace(/\b(search|find|look\s+up|research|on the internet|on internet|online|web|the web|some|the most|most important|inportant|important|biggest|top)\b/gi, " ")
    .replace(/\b(new)\b/gi, " news ")
    .replace(/[?.!]+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^(news|latest news|today|world today|news today)$/i.test(cleaned)) {
    return "top stories";
  }
  return cleaned;
}

export function parseNaturalSearchIntent(message) {
  const normalized = String(message ?? "").trim();
  if (/^\//.test(normalized) || !searchIntentVerbs.test(normalized)) {
    return null;
  }
  if (/\b(amazon|cart|chart|basket|carrello|shop|shopping|product)\b/i.test(normalized)) {
    return null;
  }
  if (browserTargetPattern.test(normalized) && browserIntentVerbs.test(normalized)) {
    return null;
  }
  const wantsNews =
    /\b(news|new|latest|headline|headlines|breaking|today|current)\b/i.test(normalized) &&
    (/\b(world|global|today|headline|headlines|breaking|important|inportant|biggest|top)\b/i.test(normalized) ||
      /\b(news|new)\b/i.test(normalized));
  return {
    action: wantsNews ? "news" : "search",
    query: normalizeSearchQuery(normalized)
  };
}

export function parseAmazonShoppingTask(message) {
  const normalized = String(message ?? "").trim();
  if (!/\bamazon(?:\.it)?\b/i.test(normalized)) {
    return null;
  }
  let query = normalized
    .replace(/\b(can you|please|could you|would you|ok now|now)\b/gi, " ")
    .replace(/\b(go\s+to|open|visit|navigate\s+to|find|search|look\s+for|me|on|in|amazon(?:\.it)?|some|then|and|add|put|it|them|to|the|cart|chart|basket|carrello)\b/gi, " ")
    .replace(/[?.!]+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!query && /\b(nvidia|5090|rtx)\b/i.test(normalized)) {
    query = "nvidia 5090";
  }
  if (!query && /\bpringles\b/i.test(normalized)) {
    query = "pringles";
  }
  const base = "https://www.amazon.it";
  return {
    query,
    wantsCart: /\b(add|put).{0,30}\b(cart|chart|basket|carrello)\b/i.test(normalized),
    url: query ? `${base}/s?k=${encodeURIComponent(query)}` : base
  };
}

export function inferControlNavigationTarget(message) {
  const normalized = String(message ?? "").trim();
  const amazonTask = parseAmazonShoppingTask(normalized);
  if (amazonTask?.url) {
    return {
      kind: "navigation",
      source: "amazon-task",
      url: amazonTask.url
    };
  }

  const naturalBrowserIntent = parseNaturalBrowserIntent(normalized);
  if (naturalBrowserIntent?.target) {
    return {
      kind: "navigation",
      source: "browser-target",
      url: normalizeBrowserUrl(naturalBrowserIntent.target)
    };
  }

  const hasDirectPageActions = Boolean(
    parseClickIntent(normalized) ||
    parseTypeIntent(normalized) ||
    parseScrollIntent(normalized) ||
    parseFormsIntent(normalized) ||
    parseReadPageIntent(normalized)
  );
  if (hasDirectPageActions) {
    return null;
  }
  if (/@[a-z0-9]/i.test(normalized)) {
    return null;
  }

  const naturalSearchIntent = parseNaturalSearchIntent(normalized);
  if (naturalSearchIntent?.query) {
    const url = naturalSearchIntent.action === "news"
      ? `https://www.bing.com/news/search?q=${encodeURIComponent(naturalSearchIntent.query)}&setlang=en-US`
      : `https://www.google.com/search?q=${encodeURIComponent(naturalSearchIntent.query)}`;
    return {
      kind: "navigation",
      source: naturalSearchIntent.action === "news" ? "news-search" : "web-search",
      url
    };
  }

  return null;
}
