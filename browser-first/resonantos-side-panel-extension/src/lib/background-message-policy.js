const INLINE_ACTIONS = new Set(["custom", "summarize", "summary", "explain", "translate", "rewrite"]);
const SENSITIVE_KEY_PATTERN = /\b(password|passcode|passwd|pwd|credential|secret|token|api[-_ ]?key|authorization|bearer|cookie|session|private[-_ ]?key|seed|otp|2fa|mfa|card|credit|debit|cvc|cvv|iban|routing|ssn|payment|wallet|value)\b/i;
const TOKEN_PATTERN = /\b(?:sk-[a-z0-9_-]{12,}|sk-ant-[a-z0-9_-]{12,}|sk-or-v1-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,}|hf_[a-z0-9_-]{12,}|xox[baprs]-[a-z0-9-]{12,}|xai-[a-z0-9_-]{12,}|gsk_[a-z0-9_-]{12,}|AIza[a-z0-9_-]{12,}|AKIA[A-Z0-9]{12,}|pk_live_[a-z0-9]{12,}|rk_live_[a-z0-9]{12,}|SG\.[a-z0-9._-]{12,})\b/gi;
const ASSIGNMENT_SECRET_PATTERN = /\b(?:api[_-]?key|token|password|secret|authorization|bearer|session|cookie)\s*[:=]\s*['"]?[^'"\s]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_PATTERN = /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g;
const FORMATTED_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

function redactSecrets(value) {
  return String(value ?? "")
    .replace(PEM_PATTERN, "[redacted]")
    .replace(JWT_PATTERN, "[redacted]")
    .replace(TOKEN_PATTERN, "[redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, "[redacted]")
    .replace(FORMATTED_CARD_PATTERN, (candidate) => {
      const digits = candidate.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 ? "[redacted]" : candidate;
    });
}

function safeText(value, max = 1000) {
  return redactSecrets(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s{3,}/g, "  ")
    .trim()
    .slice(0, max);
}

function safeUrl(value) {
  const text = safeText(value, 1200);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 900);
  } catch {
    return "";
  }
}

function safePath(value) {
  const text = safeText(value, 500);
  if (!text) return "";
  try {
    const url = new URL(text, "https://resonantos.invalid");
    return url.pathname.slice(0, 400) || "/";
  } catch {
    return text.split(/[?#]/)[0].slice(0, 400);
  }
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeBoolean(value) {
  return value === true;
}

function safeArray(value, limit, mapper) {
  return Array.isArray(value)
    ? value.slice(0, limit).map(mapper).filter(Boolean)
    : [];
}

function safeObject(value, maxKeys = 20, depth = 0) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return safeText(value, 500);
  if (Array.isArray(value)) {
    if (depth > 2) return [];
    return value.slice(0, 20).map((entry) => safeObject(entry, maxKeys, depth + 1));
  }
  if (typeof value !== "object") return "";
  if (depth > 2) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxKeys)
      .map(([key, entry]) => {
        const safeKey = safeText(key, 80);
        return [
          safeKey,
          SENSITIVE_KEY_PATTERN.test(safeKey) ? "[redacted]" : safeObject(entry, maxKeys, depth + 1)
        ];
      })
  );
}

function fieldKind(field) {
  const haystack = [
    field?.fieldKind,
    field?.kind,
    field?.type,
    field?.name,
    field?.id,
    field?.label,
    field?.autocomplete,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(password|passcode|secret|token|api[-_\s]?key|otp|2fa|mfa|seed|private\s*key)\b/.test(haystack)) return "credential";
  if (/\b(card|credit|debit|cvc|cvv|iban|routing|account\s*number|payment|wallet|billing|checkout)\b/.test(haystack)) return "payment";
  if (/\b(email|phone|address|name|username|login|signin|sign[-\s]?in)\b/.test(haystack)) return "personal-contact";
  if (/\b(search|query|find|filter|lookup)\b/.test(haystack)) return "search-query";
  return safeText(field?.fieldKind ?? field?.kind ?? "field", 40) || "field";
}

function safeFieldValue(field, kind) {
  const raw = field?.value;
  if (raw === undefined || raw === null || raw === "") return "";
  if (kind !== "search-query" && field?.safeForContext !== true) {
    return `[redacted:${kind}]`;
  }
  return safeText(raw, 240);
}

function safeField(field) {
  if (!field || typeof field !== "object") return null;
  const kind = fieldKind(field);
  return {
    name: safeText(field.name ?? field.id ?? field.label ?? "", 100),
    label: safeText(field.label ?? "", 100),
    type: safeText(field.type ?? field.tagName ?? "", 40),
    fieldKind: kind,
    value: safeFieldValue(field, kind),
    touched: safeBoolean(field.touched),
    safeToSubmit: safeBoolean(field.safeToSubmit),
  };
}

function safeForm(form) {
  if (!form || typeof form !== "object") return null;
  return {
    id: safeText(form.id, 100),
    name: safeText(form.name, 120),
    completeness: safeNumber(form.completeness, 0),
    priority: safeNumber(form.priority, 0),
    fields: safeArray(form.fields, 40, safeField),
  };
}

function safeVisibleSection(section) {
  if (!section || typeof section !== "object") return null;
  return {
    id: safeText(section.id ?? section.selector, 120),
    label: safeText(section.label, 100),
    text: safeText(section.text ?? section.summary, 700),
    dwellMs: safeNumber(section.dwellMs, 0),
    pctVisible: safeNumber(section.pctVisible, 0),
    priority: safeNumber(section.priority, 0),
    currentlyVisible: safeBoolean(section.currentlyVisible),
  };
}

function safeNavigation(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    path: safePath(entry.path ?? entry.url),
    title: safeText(entry.title, 160),
    dwellMs: safeNumber(entry.dwellMs, 0),
  };
}

function safeClickTrail(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    selector: safeText(entry.selector, 160),
    text: safeText(entry.text, 160),
    ts: safeNumber(entry.ts, 0),
  };
}

export function isTopFrameSender(sender = {}) {
  return sender?.frameId === 0;
}

export function sanitizeInlineAssistantBody(body) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const action = safeText(source.action, 40).toLowerCase();
  return {
    action: INLINE_ACTIONS.has(action) ? action : "summarize",
    prompt: safeText(source.prompt, 1200),
    selection: safeText(source.selection, 8000),
    pageContext: safeText(source.pageContext, 5000),
  };
}

export function sanitizeResonantContextSnapshot(snapshot, { tabId = null, title = "", url = "" } = {}) {
  const source = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  const sourcePage = source.page && typeof source.page === "object" && !Array.isArray(source.page) ? source.page : {};
  const sourceViewport = source.viewport && typeof source.viewport === "object" && !Array.isArray(source.viewport) ? source.viewport : {};
  const sourceSession = source.session && typeof source.session === "object" && !Array.isArray(source.session) ? source.session : {};
  const sourceUrl = safeUrl(source.url ?? sourcePage.url) || safeUrl(url);
  const sections = Array.isArray(source.sections)
    ? safeArray(source.sections, 8, safeVisibleSection)
    : safeArray(sourceViewport.visibleSections, 8, safeVisibleSection);

  return {
    tabId,
    title: safeText(source.title || sourcePage.title || title, 160),
    url: sourceUrl,
    text: safeText(source.text ?? source.visibleText ?? sourcePage.visibleText ?? source.summary, 7000),
    v: safeText(source.v ?? source.schema, 40),
    domain: safeText(source.domain ?? source.hostname, 120),
    summary: safeText(source.summary, 1600),
    page: {
      path: safePath(sourcePage.path ?? source.path ?? sourceUrl),
      title: safeText(sourcePage.title || source.title || title, 160),
      timeOnPageMs: safeNumber(sourcePage.timeOnPageMs, 0),
      headings: safeArray(sourcePage.headings, 12, (heading) => safeText(heading, 160)),
    },
    viewport: {
      visibleSections: sections,
      activeOverlay: sourceViewport.activeOverlay ? {
        id: safeText(sourceViewport.activeOverlay.id, 100),
        type: safeText(sourceViewport.activeOverlay.type, 80),
        content: safeText(sourceViewport.activeOverlay.content, 700),
      } : null,
    },
    forms: safeArray(source.forms, 20, safeForm),
    session: {
      navigation: safeArray(sourceSession.navigation, 8, safeNavigation),
      clickTrail: safeArray(sourceSession.clickTrail, 15, safeClickTrail),
      entryPoint: safeUrl(sourceSession.entryPoint),
    },
    domain_data: safeObject(source.domain_data, 20, 0) ?? {},
    sections,
    receivedAt: new Date().toISOString(),
  };
}
