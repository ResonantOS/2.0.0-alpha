// ── Resonant Context SDK ─────────────────────────────────────────────────────
// Loaded via content_scripts array before this file; window._ResonantContext and
// window.ResonantContext are populated by resonant-context.js at document_idle.
(() => {
if (window.__resonantOSContentScriptLoaded) return;
window.__resonantOSContentScriptLoaded = true;
function sanitizeBrowserContextUrl(value, base = window.location.href) {
  if (!String(value ?? "").trim()) return "";
  try {
    const url = new URL(String(value || ""), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}
(function initResonantContextSDK() {
  try {
    if (typeof window.ResonantContext === 'undefined' || typeof window._ResonantContext === 'undefined') {
      // SDK not loaded (e.g. unit-test harness) — skip silently
      return;
    }

    if (window.top !== window) {
      return;
    }

    var _rcFallbackPlugin = {
      domain: 'generic-web',
      viewportThreshold: 0.4,
      maxTextChars: 600,
      clickSelectors: 'a, button, [role="button"], input[type="submit"], [onclick]',
      persistSession: true,
      pages: {
        default: {
          match: function () { return true; },
          sections: [
            { selector: 'main',    label: 'Main content', priority: 8 },
            { selector: 'article', label: 'Article',      priority: 7 },
            { selector: 'header',  label: 'Header',       priority: 4 },
            { selector: 'nav',     label: 'Navigation',   priority: 3 },
            { selector: 'footer',  label: 'Footer',       priority: 1 }
          ]
        }
      }
    };
    var _rcPlugin = window.ResonantOSContextPlugins?.getPluginForDomain?.(window.location.hostname) || _rcFallbackPlugin;
    var _rcCollector = window.ResonantContext.init({ plugin: _rcPlugin });

    // Broadcast snapshots to the background service worker so the side-panel
    // can access live page context without making a separate read_page round-trip.
    var _rcSnapshotTimer = null;
    var _rcLastSnapshotAt = 0;
    function _rcSanitizeText(value, max) {
      return String(value || '')
        .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|sk-or-v1-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|hf_[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|xai-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{12,}|pk_live_[A-Za-z0-9]{12,}|rk_live_[A-Za-z0-9]{12,})\b/gi, '[redacted]')
        .replace(/\b(?:api[_-]?key|token|password|secret|authorization|bearer|session|cookie)\s*[:=]\s*['"]?[^'"\s]+/gi, '[redacted]')
        .replace(/\b(?:\d[ -]?){13,19}\b/g, function (candidate) {
          var digits = candidate.replace(/\D/g, '');
          return digits.length >= 13 && digits.length <= 19 ? '[redacted]' : candidate;
        })
        .replace(/\s{3,}/g, '  ')
        .trim()
        .slice(0, max || 1000);
    }
    function _rcSanitizeUrl(value) {
      return sanitizeBrowserContextUrl(value);
    }
    function _rcSanitizeStructured(value, depth, keyName) {
      if (value === null || value === undefined) return value;
      if (/^(value|password|passwd|pwd|secret|token|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|api[-_ ]?key|apikey|auth|authorization|bearer|cookie|session|credential|credentials|client[-_ ]?secret|private[-_ ]?key|seed|otp|2fa|mfa)$/i.test(String(keyName || ''))) {
        return value ? '[redacted]' : value;
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return _rcSanitizeText(value, 1000);
      }
      if (Array.isArray(value)) {
        if (depth > 3) return [];
        return value.slice(0, 30).map(function (entry) { return _rcSanitizeStructured(entry, depth + 1, keyName); });
      }
      if (typeof value === 'object') {
        if (depth > 3) return {};
        return Object.fromEntries(Object.entries(value).slice(0, 40).map(function (entry) {
          return [_rcSanitizeText(entry[0], 80), _rcSanitizeStructured(entry[1], depth + 1, entry[0])];
        }));
      }
      return '';
    }
    function _rcSanitizeSnapshot(snapshot) {
      var safe = _rcSanitizeStructured(snapshot, 0, '');
      safe.url = _rcSanitizeUrl(snapshot?.url || window.location.href);
      if (safe.page?.path) safe.page.path = String(safe.page.path).split(/[?#]/)[0].slice(0, 300);
      return safe;
    }
    function _rcScheduleSnapshot() {
      if (window.top !== window) return;
      if (_rcSnapshotTimer) return;
      _rcSnapshotTimer = window.setTimeout(function () {
        _rcSnapshotTimer = null;
        _rcLastSnapshotAt = Date.now();
        try {
          var snapshot = _rcSanitizeSnapshot(_rcCollector.getContext());
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: 'resonant-context-snapshot', payload: snapshot });
          }
        } catch (_e) { /* extension may have been reloaded */ }
      }, Math.max(500, 1500 - (Date.now() - _rcLastSnapshotAt)));
    }

    // Send an initial snapshot and re-send on navigation or meaningful DOM changes.
    _rcScheduleSnapshot();
    document.addEventListener('visibilitychange', _rcScheduleSnapshot);
    window.addEventListener('popstate', _rcScheduleSnapshot);
    window.addEventListener('hashchange', _rcScheduleSnapshot);
    if (typeof MutationObserver !== 'undefined') {
      var _rcMutationTarget = document.body || document.documentElement;
      if (_rcMutationTarget) {
        new MutationObserver(_rcScheduleSnapshot).observe(_rcMutationTarget, {
          childList: true,
          subtree: true
        });
      }
    }

    // Expose collector on window for debugging / other content-script modules.
    window._resonantContextCollector = _rcCollector;
  } catch (_initErr) {
    // Never crash the content script due to SDK init failure.
  }
})();

const inlineAssistantId = "resonantos-inline-assistant";
const inlineButtonId = "resonantos-inline-button";
const controlOverlayId = "resonantos-control-overlay";
const controlBubbleClass = "resonantos-control-bubble";
const controlToastId = "resonantos-control-toast";
const controlStatusTextClass = "ros-control-status-text";
const controlStopButtonClass = "ros-control-stop-button";
const editableSelector = "input, textarea, select, [contenteditable], [role='textbox']";
let lastInlineSelectionDetails = null;

const isTopWindow = () => window.top === window;
const classifyEditableField = (element) =>
  window.ResonantOSContentFieldSafety.classifyEditableField(element, { relatedLabelText });

const querySelectorAllDeep = (selector, { root = document, limit = 600 } = {}) => {
  const results = [];
  const visit = (scope) => {
    if (!scope?.querySelectorAll || results.length >= limit) return;
    let scopedElements = [];
    try {
      scopedElements = Array.from(scope.querySelectorAll(selector));
    } catch {
      return;
    }
    for (const element of scopedElements) {
      if (results.length >= limit) break;
      results.push(element);
    }
    let allElements = [];
    try {
      allElements = Array.from(scope.querySelectorAll("*"));
    } catch {
      return;
    }
    for (const element of allElements) {
      if (results.length >= limit) break;
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(root);
  return uniqueElements(results).slice(0, limit);
};

const openShadowHosts = () => querySelectorAllDeep("*")
  .filter((element) => element.shadowRoot);

const { ensureControlRef, elementByControlRef } = window.ResonantOSContentControlRefs.createControlRefStore({
  querySelectorAllDeep,
});

const visiblePageText = () => [
  document.body?.innerText ?? document.body?.textContent ?? "",
  ...openShadowHosts().map((host) => host.shadowRoot?.innerText ?? host.shadowRoot?.textContent ?? "")
].filter(Boolean).join("\n").slice(0, 12000);

const pageSnapshot = () => ({
  title: document.title,
  url: sanitizeBrowserContextUrl(location.href),
  frame: {
    isTop: window.top === window,
    referrer: sanitizeBrowserContextUrl(document.referrer)
  },
  text: visiblePageText(),
  iframes: querySelectorAllDeep("iframe")
    .slice(0, 20)
    .map((frame) => ({
      title: frame.getAttribute("title") || frame.getAttribute("aria-label") || "",
      src: sanitizeBrowserContextUrl(frame.src),
      width: frame.width || frame.getBoundingClientRect().width,
      height: frame.height || frame.getBoundingClientRect().height
    })),
  viewport: {
    scrollY: Math.round(window.scrollY),
    innerHeight: Math.round(window.innerHeight),
    maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  },
  links: querySelectorAllDeep("a[href]")
    .slice(0, 80)
    .map((link) => ({
      text: link.textContent?.trim().slice(0, 160) ?? "",
      href: sanitizeBrowserContextUrl(link.href)
    })),
  controls: candidateClickElements()
    .slice(0, 80)
    .map((element, index) => ({
      ref: ensureControlRef(element),
      text: visibleText(element).slice(0, 160),
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      approvalRequired: isSubmitLikeElement(element),
      ...elementContextDetails(element, { visibleIndex: index + 1 })
    })),
  fields: querySelectorAllDeep(editableSelector)
    .filter((element) => !isResonantosInternalElement(element))
    .slice(0, 80)
    .map((element, index) => describeEditable(element, { visibleIndex: index + 1 })),
  walletProviders: {
    phantomSolana: Boolean(globalThis.phantom?.solana?.isPhantom || globalThis.solana?.isPhantom)
  }
});

const { pulseControlOverlay, setControlSessionOverlay } = window.ResonantOSControlOverlay.createControlOverlayController({
  chromeRuntime: chrome.runtime,
  controlBubbleClass,
  controlOverlayId,
  controlStatusTextClass,
  controlStopButtonClass,
  controlToastId,
  isTopWindow,
});

const describeForms = () => ({
  forms: querySelectorAllDeep("form")
    .slice(0, 20)
    .map((form, index) => ({
      index,
      id: form.id || "",
      name: form.getAttribute("name") || "",
      action: sanitizeBrowserContextUrl(form.action),
      method: form.method || "get",
      fields: querySelectorAllDeep(editableSelector, { root: form })
        .filter((field) => !isResonantosInternalElement(field))
        .slice(0, 40)
        .map((field, fieldIndex) => describeEditable(field, { visibleIndex: fieldIndex + 1 }))
    })),
  looseFields: querySelectorAllDeep(editableSelector)
    .filter((field) => !isResonantosInternalElement(field))
    .filter((field) => !field.closest("form"))
    .slice(0, 40)
    .map((field, index) => describeEditable(field, { visibleIndex: index + 1 }))
});

const idReferenceText = (element, attribute) => {
  const root = element?.getRootNode?.() ?? document;
  return String(element?.getAttribute?.(attribute) ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => root.getElementById?.(id) ?? querySelectorAllDeep(`#${cssEscape(id)}`, { root, limit: 1 })[0])
    .filter(Boolean)
    .map((node) => node.textContent)
    .filter(Boolean)
    .join(" ");
};

const accessibleLabelText = (element) => [
  element?.getAttribute?.("aria-label"),
  idReferenceText(element, "aria-labelledby"),
  relatedLabelText(element),
  element?.getAttribute?.("placeholder"),
  element?.getAttribute?.("title")
].filter(Boolean).join(" ").trim();

const visibleText = (element) => (element.innerText || element.textContent || accessibleLabelText(element) || element.value || "").trim();

const isResonantosInternalElement = (element) => Boolean(element?.closest?.([
  `#${inlineAssistantId}`,
  `#${inlineButtonId}`,
  `#${controlOverlayId}`,
  `#${controlToastId}`,
  `.${controlBubbleClass}`
].join(", ")));

const candidateClickElements = () => [
  ...querySelectorAllDeep("button, a, [role='button'], input[type='button'], input[type='submit'], summary, [onclick]")
].filter((element) => !isResonantosInternalElement(element));

const uniqueElements = (elements) => Array.from(new Set(elements.filter(Boolean)));

const normalizedTargetText = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const clippedText = (value, max = 120) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const elementBounds = (element) => {
  const rect = element?.getBoundingClientRect?.();
  if (!rect) return null;
  return {
    height: Math.round(rect.height),
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width)
  };
};

const nearestContextElement = (element) => {
  let current = element?.parentElement ?? null;
  while (current && current !== document.body && current !== document.documentElement) {
    if (current.matches?.("form, fieldset, section, article, aside, nav, main, header, footer, li, tr, [role='group'], [role='region'], [aria-label], [data-testid]")) {
      return current;
    }
    current = current.parentElement;
  }
  return element?.parentElement && element.parentElement !== document.body ? element.parentElement : null;
};

const contextLabel = (element) => {
  const containsEditable = Boolean(element?.matches?.(editableSelector) || element?.querySelector?.(editableSelector));
  const explicitParts = [
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("data-testid"),
    element?.id ? `#${element.id}` : "",
    element?.getAttribute?.("name"),
    element?.querySelector?.("h1, h2, h3, legend, [role='heading']")?.textContent
  ].filter(Boolean);
  return clippedText([
    ...explicitParts,
    containsEditable || explicitParts.length ? "" : visibleText(element)
  ].filter(Boolean).join(" · "), 160);
};

const formContextDetails = (element) => {
  const form = element?.closest?.("form") ?? null;
  if (!form) return null;
  const forms = querySelectorAllDeep("form");
  return {
    action: clippedText(sanitizeBrowserContextUrl(form.action || form.getAttribute("action") || ""), 160),
    id: form.id || "",
    index: Math.max(1, forms.indexOf(form) + 1),
    label: contextLabel(form),
    method: form.method || form.getAttribute("method") || "get",
    name: form.getAttribute("name") || ""
  };
};

const elementContextDetails = (element, { visibleIndex = 0 } = {}) => {
  const container = nearestContextElement(element);
  const section = element?.closest?.("section, article, main, nav, aside, header, footer, [role='region']") ?? null;
  return {
    bounds: elementBounds(element),
    container: container ? {
      id: container.id || "",
      label: contextLabel(container),
      role: container.getAttribute("role") || "",
      tagName: container.tagName.toLowerCase()
    } : null,
    form: formContextDetails(element),
    section: section ? {
      id: section.id || "",
      label: contextLabel(section),
      role: section.getAttribute("role") || "",
      tagName: section.tagName.toLowerCase()
    } : null,
    visibleIndex
  };
};

const clickableCandidateDetails = (elements) => uniqueElements(elements)
  .slice(0, 8)
  .map((element, index) => ({
    ref: ensureControlRef(element),
    text: visibleText(element).slice(0, 160),
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || "",
    ariaLabel: element.getAttribute("aria-label") || "",
    approvalRequired: isSubmitLikeElement(element),
    ...elementContextDetails(element, { visibleIndex: index + 1 })
  }));

const editableCandidateDetails = (elements) => uniqueElements(elements)
  .slice(0, 8)
  .map((element, index) => {
    const fieldSafety = classifyEditableField(element);
    return {
      ref: ensureControlRef(element),
      tagName: element.tagName.toLowerCase(),
      type: element.getAttribute("type") || "",
      name: element.getAttribute("name") || "",
      id: element.id || "",
      role: element.getAttribute("role") || "",
      label: element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("title") || relatedLabelText(element) || "",
      ariaDescription: idReferenceText(element, "aria-describedby"),
      autocomplete: element.getAttribute("autocomplete") || "",
      contentEditable: contentEditableMode(element),
      fieldKind: fieldSafety.kind,
      hasValue: Boolean(editableRawValue(element)),
      placeholder: element.getAttribute("placeholder") || "",
      ...elementContextDetails(element, { visibleIndex: index + 1 })
    };
  });

const ambiguousTargetResponse = (kind, target, candidates) => ({
  ok: false,
  ambiguousTarget: true,
  error: `${kind} target "${target}" matched ${candidates.length} visible candidates. Retry with one exact ref from the candidates list.`,
  candidates
});

// #240: public-commit verbs. A control carrying one of these is treated as a
// public submit even without a <form> (SPA buttons, links, type="button" that
// wire up JS submit) — it is a human-only handoff, never auto-clicked.
const PUBLIC_COMMIT_VERBS = /\b(submit|send|post|publish|save|share|buy|pay|confirm|connect|sign|reserve|book|order|checkout|apply|vote|subscribe|register|comment)\b/i;
const isSubmitLikeElement = (element) => {
  const type = String(element.getAttribute("type") || "").toLowerCase();
  const role = String(element.getAttribute("role") || "").toLowerCase();
  const tag = element.tagName ? element.tagName.toLowerCase() : "";
  const label = `${visibleText(element)} ${element.getAttribute("value") || ""}`.toLowerCase();
  // Native form-submit controls are always human-only.
  if (type === "submit" || type === "image") return true;
  if (element instanceof HTMLButtonElement && (!type || type === "submit") && Boolean(element.closest("form"))) return true;
  // A control that BEHAVES like a button (incl. input[type=button] and scripted
  // <a onclick>/<div onclick>) AND carries a public-commit verb is human-only.
  // Plain navigation links (<a href> without button semantics) stay clickable so
  // safe reads like "Order History" or "How to apply" are not blocked.
  const behavesLikeButton =
    tag === "button" ||
    role === "button" ||
    (tag === "input" && ["button", "reset"].includes(type)) ||
    (typeof element.hasAttribute === "function" && element.hasAttribute("onclick"));
  return behavesLikeButton && PUBLIC_COMMIT_VERBS.test(label);
};

const isHardRestrictedElement = (element, fallbackText = "") => {
  const text = [
    visibleText(element),
    element?.getAttribute?.("aria-label"),
    element?.id,
    element?.className,
    fallbackText
  ].filter(Boolean).join(" ").toLowerCase();
  return /\b(wallet|phantom|sign|signature|approve|connect wallet|buy|sell|swap|stake|unstake|bridge|mint|claim|pay|payment|checkout|login|credential|password|transfer)\b/i.test(text);
};

const clickElement = (element, { userApproved = false, fallbackText = "" } = {}) => {
  pulseControlOverlay({ state: "active", label: `Clicking ${visibleText(element) || fallbackText}`, phase: "clicking", target: element });
  if (isHardRestrictedElement(element, fallbackText)) {
    pulseControlOverlay({ state: "blocked", label: "Blocked: human-only action", phase: "blocked", target: element });
    return {
      ok: false,
      approvalRequired: true,
      deniedToAutomation: true,
      error: `Clicking "${visibleText(element) || fallbackText}" crosses a wallet/payment/login/credential boundary and must be completed by the human.`
    };
  }
  // #240: submit-like is UNCONDITIONALLY human-only. Do not add a userApproved
  // or any other bypass gate here — an in-panel approval must never turn a public
  // submit into an agent-performed click. The human clicks it on the page.
  if (isSubmitLikeElement(element)) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    pulseControlOverlay({ state: "blocked", label: "Human-only: click this yourself", phase: "handoff", target: element });
    return {
      ok: false,
      approvalRequired: true,
      deniedToAutomation: true,
      humanHandoff: true,
      error: `Clicking "${visibleText(element) || fallbackText}" is a public submit/commit action and must be performed by the human on the page.`
    };
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  const rect = element.getBoundingClientRect();
  const eventOptions = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2)
  };
  for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const EventConstructor = eventName.startsWith("pointer") ? PointerEvent : MouseEvent;
    element.dispatchEvent(new EventConstructor(eventName, eventOptions));
  }
  element.click();
  pulseControlOverlay({ state: "done", label: `Clicked ${visibleText(element).slice(0, 80) || fallbackText}`, phase: "done", target: element });
  return {
    ok: true,
    ref: ensureControlRef(element),
    clickedText: visibleText(element).slice(0, 180),
    tagName: element.tagName.toLowerCase()
  };
};

const clickVisibleText = (targetText, { userApproved = false } = {}) => {
  const needle = String(targetText ?? "").trim().toLowerCase();
  if (!needle) {
    return { ok: false, error: "No click target text was provided." };
  }
  const candidates = uniqueElements(candidateClickElements())
    .filter((candidate) => normalizedTargetText(visibleText(candidate)).includes(needle));
  const exactMatches = candidates.filter((candidate) => normalizedTargetText(visibleText(candidate)) === needle);
  if (exactMatches.length > 1) {
    return ambiguousTargetResponse("Click", targetText, clickableCandidateDetails(exactMatches));
  }
  if (exactMatches.length === 1) {
    return clickElement(exactMatches[0], { userApproved, fallbackText: targetText });
  }
  if (candidates.length > 1) {
    return ambiguousTargetResponse("Click", targetText, clickableCandidateDetails(candidates));
  }
  const element = candidates[0] ?? null;
  if (!element) {
    return { ok: false, error: `No visible clickable element matched "${targetText}".` };
  }
  return clickElement(element, { userApproved, fallbackText: targetText });
};

const clickControlRef = (ref, { userApproved = false } = {}) => {
  const element = elementByControlRef(ref);
  if (!element) {
    return { ok: false, error: `No clickable element matched ref "${ref}".` };
  }
  if (!candidateClickElements().includes(element)) {
    return { ok: false, error: `Control ref "${ref}" is not a clickable element.` };
  }
  return clickElement(element, { userApproved, fallbackText: ref });
};

const editableCandidates = () => [
  deepActiveElement(),
  ...querySelectorAllDeep([
    "textarea[name='q']",
    "input[name='q']",
    "input[type='search']",
    "textarea",
    "input[type='text']",
    "input:not([type])",
    "input[type='email']",
    "input[type='url']",
    "input[type='tel']",
    "input[type='number']",
    "input[type='password']",
    "[contenteditable]",
    "[role='textbox']"
  ].join(", "))
].filter((element) => element && !isResonantosInternalElement(element));

const deepActiveElement = () => {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
};

const contentEditableMode = (element) => String(element?.getAttribute?.("contenteditable") ?? "").toLowerCase();

const isContentEditableElement = (element) =>
  Boolean(element?.isContentEditable) ||
  (element?.hasAttribute?.("contenteditable") && contentEditableMode(element) !== "false");

const isEditable = (element) =>
  ((element instanceof HTMLInputElement && !["button", "checkbox", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(element.type)) ||
    element instanceof HTMLTextAreaElement ||
    isContentEditableElement(element)) &&
  !element.disabled &&
  !element.readOnly;

const editableLabel = (element) => [
  accessibleLabelText(element),
  element.getAttribute("placeholder"),
  element.getAttribute("title"),
  element.getAttribute("autocomplete"),
  idReferenceText(element, "aria-describedby"),
  element.getAttribute("name"),
  element.id,
  relatedLabelText(element),
  element.textContent
].filter(Boolean).join(" ").toLowerCase();

const cssEscape = (value) => window.CSS?.escape?.(String(value ?? "")) ?? String(value ?? "").replace(/["\\]/g, "\\$&");

const relatedLabelText = (element) => {
  const labels = [];
  const root = element.getRootNode?.() ?? document;
  if (element.id) {
    querySelectorAllDeep(`label[for="${cssEscape(element.id)}"]`, { root }).forEach((label) => {
      labels.push(label.textContent);
    });
  }
  element.closest?.("label") && labels.push(element.closest("label").textContent);
  return labels.filter(Boolean).join(" ").toLowerCase();
};

const editableRawValue = (element) =>
  "value" in element ? String(element.value || "") : String(element.textContent || "");

const editableValuePreview = (element, fieldSafety) => {
  const rawValue = editableRawValue(element).slice(0, 120);
  if (!rawValue) {
    return "";
  }
  if (fieldSafety.kind === "search-query") {
    return rawValue;
  }
  return `[redacted:${fieldSafety.kind}]`;
};

const describeEditable = (element, { visibleIndex = 0 } = {}) => {
  const fieldSafety = classifyEditableField(element);
  const rawValue = editableRawValue(element);
  return {
    ref: ensureControlRef(element),
    tagName: element.tagName.toLowerCase(),
    type: element.getAttribute("type") || "",
    name: element.getAttribute("name") || "",
    id: element.id || "",
    role: element.getAttribute("role") || "",
    label: accessibleLabelText(element),
    ariaDescription: idReferenceText(element, "aria-describedby"),
    autocomplete: element.getAttribute("autocomplete") || "",
    contentEditable: contentEditableMode(element),
    fieldKind: fieldSafety.kind,
    hasValue: Boolean(rawValue),
    placeholder: element.getAttribute("placeholder") || "",
    valuePreview: editableValuePreview(element, fieldSafety),
    ...elementContextDetails(element, { visibleIndex })
  };
};

const resolveEditableTarget = (field, ref = "") => {
  const refTarget = elementByControlRef(ref);
  if (refTarget && isEditable(refTarget)) {
    return { ok: true, element: refTarget };
  }
  if (String(ref ?? "").trim()) {
    return { ok: false, error: `No editable field matched ref "${ref}".` };
  }
  const candidates = uniqueElements(editableCandidates()).filter(isEditable);
  const needle = String(field ?? "").trim().toLowerCase();
  if (!needle) {
    const active = isEditable(document.activeElement) ? document.activeElement : null;
    if (active) return { ok: true, element: active };
    const searchCandidates = candidates.filter((element) => classifyEditableField(element).kind === "search-query");
    if (searchCandidates.length === 1) return { ok: true, element: searchCandidates[0] };
    if (searchCandidates.length > 1) {
      return ambiguousTargetResponse("Typing", "search field", editableCandidateDetails(searchCandidates));
    }
    if (candidates.length === 1) return { ok: true, element: candidates[0] };
    if (candidates.length > 1) {
      return ambiguousTargetResponse("Typing", "editable field", editableCandidateDetails(candidates));
    }
    return { ok: false, error: "No editable field was found on this page." };
  }
  const matches = candidates.filter((element) => editableLabel(element).includes(needle));
  const exactMatches = matches.filter((element) => normalizedTargetText(editableLabel(element)) === needle);
  if (exactMatches.length > 1) {
    return ambiguousTargetResponse("Typing", field, editableCandidateDetails(exactMatches));
  }
  if (exactMatches.length === 1) return { ok: true, element: exactMatches[0] };
  if (matches.length > 1) {
    return ambiguousTargetResponse("Typing", field, editableCandidateDetails(matches));
  }
  if (matches.length === 1) return { ok: true, element: matches[0] };
  return { ok: false, error: `No editable field matched "${field}".` };
};

const isSearchLikeEditable = (element) => {
  return classifyEditableField(element).safeToSubmit;
};

const setNativeValue = (element, value) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(element, value);
  } else if (isContentEditableElement(element)) {
    element.textContent = value;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

// #240: a field that is safe to submit on its own (a search box) must NOT submit
// a form that also carries sensitive or public-commit fields. Only auto-submit a
// form whose every data field classifies as a search query.
const formIsSafeToAutoSubmit = (form) => {
  if (!form) return true; // no enclosing form -> Enter only affects the field itself
  const fields = form.querySelectorAll("input, textarea, select");
  for (const candidate of fields) {
    const candidateType = String(candidate.getAttribute("type") || "").toLowerCase();
    if (["hidden", "submit", "button", "image", "reset", "search"].includes(candidateType)) continue;
    if (classifyEditableField(candidate).kind !== "search-query") return false;
  }
  // A public-commit control anywhere in the form (e.g. "Place order", "Publish")
  // makes the whole form human-only, even if every data field is a search box.
  // A plain search submit ("Go"/"Search") carries no commit verb, so it stays safe.
  for (const control of form.querySelectorAll("button, input[type=submit], input[type=image], input[type=button], [role=button]")) {
    const controlLabel = `${visibleText(control)} ${control.getAttribute("value") || ""}`.toLowerCase();
    if (PUBLIC_COMMIT_VERBS.test(controlLabel)) return false;
  }
  return true;
};

const typeIntoPage = ({ text, field = "", ref = "", submit = false, userApproved = false } = {}) => {
  const value = String(text ?? "").trim();
  if (!value) {
    return { ok: false, error: "No text was provided for typing." };
  }
  const target = resolveEditableTarget(field, ref);
  if (!target.ok) {
    return target;
  }
  const element = target.element;
  const fieldSafety = classifyEditableField(element);
  if (!fieldSafety.safeToType) {
    pulseControlOverlay({ state: "blocked", label: fieldSafety.reason, phase: "blocked", target: element });
    return {
      ok: false,
      approvalRequired: true,
      deniedToAutomation: true,
      fieldSafety,
      error: fieldSafety.reason
    };
  }
  pulseControlOverlay({ state: "active", label: `Typing into ${field || visibleText(element) || element.getAttribute("aria-label") || "field"}`, phase: "typing", target: element });
  element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  element.focus();
  setNativeValue(element, value);
  if (submit) {
    if (!fieldSafety.safeToSubmit) {
      pulseControlOverlay({ state: "blocked", label: "Approval required to submit this field", phase: "blocked", target: element });
      return {
        ok: false,
        approvalRequired: true,
        deniedToAutomation: true,
        fieldSafety,
        error: "Submitting a non-search field requires human approval."
      };
    }
    if (!formIsSafeToAutoSubmit(element.form)) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      pulseControlOverlay({ state: "blocked", label: "Human-only: submit this form yourself", phase: "handoff", target: element });
      return {
        ok: false,
        approvalRequired: true,
        deniedToAutomation: true,
        humanHandoff: true,
        fieldSafety,
        error: "This search field is inside a form with sensitive or public-submit fields; the human must submit it on the page."
      };
    }
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    element.form?.requestSubmit?.();
  }
  pulseControlOverlay({ state: "done", label: `Typed ${value.slice(0, 80)}`, phase: "done", target: element });
  return {
    ok: true,
    ref: ensureControlRef(element),
    typedText: value,
    submitted: Boolean(submit),
    tagName: element.tagName.toLowerCase(),
    fieldSafety,
    fieldName: element.getAttribute("name") || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.id || ""
  };
};

const scrollPage = ({ direction = "down", amount = 720 } = {}) => {
  pulseControlOverlay({ state: "active", label: `Scrolling ${direction}`, phase: "working" });
  const normalized = String(direction || "down").toLowerCase();
  const viewport = Math.max(320, window.innerHeight || 720);
  const magnitude = Math.max(120, Math.min(4000, Number(amount) || viewport));
  let deltaY = magnitude;
  if (normalized === "up") deltaY = -magnitude;
  if (normalized === "top") deltaY = -document.documentElement.scrollHeight;
  if (normalized === "bottom") deltaY = document.documentElement.scrollHeight;
  window.scrollBy({ top: deltaY, left: 0, behavior: "auto" });
  pulseControlOverlay({ state: "done", label: `Scrolled ${normalized}`, phase: "done" });
  return {
    ok: true,
    direction: normalized,
    scrollY: Math.round(window.scrollY),
    maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  };
};

const inlineStyles = `
  #${inlineButtonId}, #${inlineAssistantId} { all: initial; color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; z-index: 2147483647; }
  #${inlineButtonId} { position: fixed; display: none; border: 1px solid rgba(36,209,143,.42); border-radius: 999px; background: rgba(5, 12, 9, .94); color: #eafff4; box-shadow: 0 16px 44px rgba(0,0,0,.32); padding: 8px 10px; font: 700 12px/1 ui-sans-serif, system-ui; cursor: pointer; }
  #${inlineAssistantId} { position: fixed; display: none; width: min(390px, calc(100vw - 24px)); max-height: min(460px, calc(100vh - 24px)); overflow: auto; border: 1px solid rgba(36,209,143,.28); border-radius: 18px; background: linear-gradient(145deg, rgba(8,20,14,.98), rgba(4,8,7,.98)); color: #effaf2; box-shadow: 0 28px 90px rgba(0,0,0,.42); padding: 12px; }
  #${inlineAssistantId} .ros-inline-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
  #${inlineAssistantId} strong { font: 800 13px/1.2 ui-sans-serif, system-ui; color:#effaf2; }
  #${inlineAssistantId} kbd { all: unset; border:1px solid rgba(255,255,255,.12); border-radius:5px; color:#85eec3; font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; margin-left:5px; padding:2px 4px; }
  #${inlineAssistantId} textarea { all: unset; display:block; box-sizing:border-box; width:100%; min-height:54px; margin: 0 0 9px; border:1px solid rgba(255,255,255,.09); border-radius:12px; background: rgba(255,255,255,.045); color:#effaf2; font: 12px/1.38 ui-sans-serif, system-ui; padding:9px; white-space:pre-wrap; }
  #${inlineAssistantId} button { all: unset; border-radius: 999px; color: #b9cbc0; cursor: pointer; font: 800 11px/1 ui-sans-serif, system-ui; padding: 7px 9px; }
  #${inlineAssistantId} button:hover { background: rgba(255,255,255,.08); color:#fff; }
  #${inlineAssistantId} .ros-inline-actions { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  #${inlineAssistantId} .ros-inline-result { white-space: pre-wrap; color:#dce9df; font: 12px/1.45 ui-sans-serif, system-ui; background: rgba(255,255,255,.045); border-radius: 12px; padding: 10px; }
`;

const { inlineActionByShortcut, renderInlineActions } = window.ResonantOSInlineActions;

const ensureInlineAssistantUi = () => {
  if (!document.getElementById("resonantos-inline-styles")) {
    const style = document.createElement("style");
    style.id = "resonantos-inline-styles";
    style.textContent = inlineStyles;
    document.documentElement.append(style);
  }
  let button = document.getElementById(inlineButtonId);
  if (!button) {
    button = document.createElement("button");
    button.id = inlineButtonId;
    button.type = "button";
    button.textContent = "Augmentor";
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => showInlinePanel("summarize"));
    document.documentElement.append(button);
  }
  let panel = document.getElementById(inlineAssistantId);
  if (!panel) {
    panel = document.createElement("section");
    panel.id = inlineAssistantId;
    panel.innerHTML = `
      <div class="ros-inline-head">
        <strong>Augmentor Inline</strong>
        <button type="button" data-action="close">Close</button>
      </div>
      <textarea class="ros-inline-prompt" placeholder="Optional custom instruction for the selected text"></textarea>
      <div class="ros-inline-actions">
        ${renderInlineActions()}
      </div>
      <div class="ros-inline-result">Select text, then choose an action.</div>
    `;
    panel.setAttribute("tabindex", "-1");
    panel.addEventListener("mousedown", (event) => {
      if (event.target?.classList?.contains("ros-inline-prompt")) return;
      event.preventDefault();
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        panel.style.display = "none";
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.target?.classList?.contains("ros-inline-prompt")) {
        return;
      }
      const action = inlineActionByShortcut(event.key);
      if (!action) return;
      event.preventDefault();
      void runInlineAction(action);
    });
    panel.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]")?.dataset?.action;
      if (!action) return;
      if (action === "close") {
        panel.style.display = "none";
        return;
      }
      void runInlineAction(action);
    });
    document.documentElement.append(panel);
  }
  return { button, panel };
};

const editableRootForSelection = () => {
  const active = document.activeElement;
  if (active && isEditable(active)) return active;
  const node = window.getSelection()?.anchorNode;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return element?.closest?.("input, textarea, [contenteditable], [role='textbox']") ?? null;
};

const editableSelectionDetails = (element) => {
  if (!element || !isEditable(element)) return null;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? start;
    const text = String(element.value ?? "").slice(start, end);
    if (!text.trim()) return null;
    return {
      text: text.trim(),
      rect: element.getBoundingClientRect(),
      editable: true,
      activeRef: ensureControlRef(element),
      rangeStart: start,
      rangeEnd: end,
      rangeKind: "input"
    };
  }
  const selection = window.getSelection();
  const selectedText = selection?.toString?.() ?? "";
  if (!selectedText.trim() || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return null;
  return {
    text: selectedText.trim(),
    rect: range.getBoundingClientRect(),
    editable: true,
    activeRef: ensureControlRef(element),
    rangeKind: "contenteditable"
  };
};

const firstUsefulRangeRect = (range) => {
  const rects = Array.from(range?.getClientRects?.() ?? []);
  const usefulRect = rects.find((rect) => rect.width > 0 && rect.height > 0);
  if (usefulRect) return usefulRect;
  const fallbackRect = range?.getBoundingClientRect?.();
  if (fallbackRect?.width > 0 || fallbackRect?.height > 0) return fallbackRect;
  return {
    bottom: Math.min(window.innerHeight - 42, Math.max(8, window.innerHeight / 2)),
    height: 1,
    left: Math.min(window.innerWidth - 112, Math.max(8, window.innerWidth / 2)),
    right: Math.min(window.innerWidth - 8, Math.max(8, window.innerWidth / 2 + 1)),
    top: Math.min(window.innerHeight - 42, Math.max(8, window.innerHeight / 2 - 1)),
    width: 1
  };
};

const currentSelectionDetails = () => {
  const editableDetails = editableSelectionDetails(editableRootForSelection());
  if (editableDetails) return editableDetails;
  const selection = window.getSelection();
  const text = selection?.toString?.().trim() ?? "";
  if (!text || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const rect = firstUsefulRangeRect(range);
  const active = document.activeElement;
  return {
    text,
    rect,
    editable: Boolean(active && isEditable(active)),
    activeRef: active && isEditable(active) ? ensureControlRef(active) : ""
  };
};

const currentSitePermission = async () => {
  const key = location.hostname.replace(/^www\./, "");
  if (!key) return "ask-before-action";
  try {
    const stored = await chrome.storage?.local?.get?.("augmentorSitePermissions");
    return stored?.augmentorSitePermissions?.[key] ?? "ask-before-action";
  } catch {
    return "ask-before-action";
  }
};

const positionInlineButton = () => {
  void currentSitePermission().then((mode) => {
    if (mode === "blocked") {
      const { button, panel } = ensureInlineAssistantUi();
      button.style.display = "none";
      panel.style.display = "none";
      return;
    }
    const details = currentSelectionDetails();
    const { button } = ensureInlineAssistantUi();
    if (!details || details.text.length < 2 || details.rect.width === 0) {
      button.style.display = "none";
      return;
    }
    lastInlineSelectionDetails = details;
    button.style.left = `${Math.min(window.innerWidth - 112, Math.max(8, details.rect.left))}px`;
    button.style.top = `${Math.min(window.innerHeight - 42, Math.max(8, details.rect.bottom + 8))}px`;
    button.style.display = "block";
  }).catch(() => {
    const { button } = ensureInlineAssistantUi();
    button.style.display = "none";
  });
};

const positionInlineButtonSync = () => {
  const details = currentSelectionDetails();
  const { button } = ensureInlineAssistantUi();
  if (!details || details.text.length < 2 || details.rect.width === 0) {
    button.style.display = "none";
    return;
  }
  lastInlineSelectionDetails = details;
  button.style.left = `${Math.min(window.innerWidth - 112, Math.max(8, details.rect.left))}px`;
  button.style.top = `${Math.min(window.innerHeight - 42, Math.max(8, details.rect.bottom + 8))}px`;
  button.style.display = "block";
};

const showInlinePanel = (initialAction = "summarize") => {
  const details = currentSelectionDetails() ?? lastInlineSelectionDetails;
  const { panel, button } = ensureInlineAssistantUi();
  if (!details) return;
  panel.dataset.selection = details.text;
  panel.dataset.activeRef = details.activeRef;
  panel.dataset.rangeKind = details.rangeKind ?? "";
  panel.dataset.rangeStart = Number.isFinite(details.rangeStart) ? String(details.rangeStart) : "";
  panel.dataset.rangeEnd = Number.isFinite(details.rangeEnd) ? String(details.rangeEnd) : "";
  panel.style.left = button.style.left || "12px";
  panel.style.top = `${Math.min(window.innerHeight - 220, Math.max(8, details.rect.bottom + 12))}px`;
  panel.style.display = "block";
  panel.focus({ preventScroll: true });
  void runInlineAction(initialAction);
};

const localInlineResult = (action, text) => {
  const clipped = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 800);
  if (action === "custom") return `Apply the custom instruction to this selected text:\n${clipped}`;
  if (action === "rewrite") return clipped.replace(/\bteh\b/gi, "the").replace(/\bi\b/g, "I");
  if (action === "fact-check") return `Fact-check this claim with primary sources before relying on it:\n${clipped}`;
  if (action === "translate") return `Translation requires the configured model. Selected text:\n${clipped}`;
  if (action === "explain") return `Explanation:\n${clipped}`;
  return `Summary:\n${clipped}`;
};

const timeoutAfter = (ms, errorMessage) => new Promise((_, reject) => {
  window.setTimeout(() => reject(new Error(errorMessage)), ms);
});

const runInlineAction = async (action) => {
  const { panel } = ensureInlineAssistantUi();
  const result = panel.querySelector(".ros-inline-result");
  const selection = panel.dataset.selection || currentSelectionDetails()?.text || "";
  if (!selection) {
    result.textContent = "No selected text is available.";
    return;
  }
  if (action === "send") {
    await chrome.storage?.local?.set?.({
      augmentorInlineDraft: {
        selection,
        url: sanitizeBrowserContextUrl(location.href),
        title: document.title,
        createdAt: new Date().toISOString()
      }
    }).catch(() => undefined);
    result.textContent = "Sent selected context to the Augmentor side panel.";
    return;
  }
  if (action === "insert") {
    const active = elementByControlRef(panel.dataset.activeRef);
    if (!active || !isEditable(active)) {
      result.textContent = "Insertion is only available when the selection came from an editable field.";
      return;
    }
    const replacement = result.textContent || selection;
    active.focus();
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = Number.parseInt(panel.dataset.rangeStart || "", 10);
      const end = Number.parseInt(panel.dataset.rangeEnd || "", 10);
      const rangeStart = Number.isFinite(start) ? start : active.selectionStart ?? 0;
      const rangeEnd = Number.isFinite(end) ? end : active.selectionEnd ?? rangeStart;
      active.setRangeText(replacement, rangeStart, rangeEnd, "end");
      active.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: replacement }));
      active.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (isContentEditableElement(active)) {
      const selectionObject = window.getSelection();
      if (selectionObject?.rangeCount && active.contains(selectionObject.getRangeAt(0).commonAncestorContainer)) {
        const range = selectionObject.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
        selectionObject.removeAllRanges();
        active.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: replacement }));
        active.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        setNativeValue(active, replacement);
      }
    }
    result.textContent = "Inserted into the active field.";
    return;
  }
  if (action === "rewrite") {
    // Intent citation: browser-first/test/agent-control-live.mjs
    // Rewrites must be available inside editable fields even when the provider
    // bridge is slow or unavailable, otherwise Agent Control cannot rely on
    // deterministic text-repair behavior during page interaction.
    result.textContent = localInlineResult(action, selection);
    return;
  }
  result.textContent = "Thinking...";
  try {
    const prompt = panel.querySelector(".ros-inline-prompt")?.value?.trim() ?? "";
    const payload = await Promise.race([
      chrome.runtime?.sendMessage?.({
      channel: "resonantos.browser_first",
      type: "inline_assistant_request",
      body: {
        action,
        prompt,
        selection,
        pageContext: `${document.title}\n${sanitizeBrowserContextUrl(location.href)}\n${document.body?.innerText?.slice(0, 3000) ?? ""}`
      }
      }),
      timeoutAfter(5000, "Inline assistant provider timed out.")
    ]);
    const reply = payload?.ok && payload?.reply ? String(payload.reply) : "";
    result.textContent = reply
      ? /^(summary|summarize)$/i.test(action) && !/^summary\b/i.test(reply.trim())
        ? `Summary:\n${reply}`
        : reply
      : localInlineResult(action, selection);
  } catch {
    result.textContent = localInlineResult(action, selection);
  }
};

document.addEventListener("selectionchange", () => {
  window.clearTimeout(globalThis.__resonantosInlineSelectionTimer);
  globalThis.__resonantosInlineSelectionTimer = window.setTimeout(positionInlineButton, 120);
});

document.addEventListener("select", (event) => {
  if (!isEditable(event.target)) return;
  window.clearTimeout(globalThis.__resonantosInlineSelectionTimer);
  globalThis.__resonantosInlineSelectionTimer = window.setTimeout(positionInlineButton, 120);
}, true);

document.addEventListener("mouseup", () => {
  window.clearTimeout(globalThis.__resonantosInlineSelectionTimer);
  globalThis.__resonantosInlineSelectionTimer = window.setTimeout(positionInlineButton, 120);
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const { button, panel } = ensureInlineAssistantUi();
    button.style.display = "none";
    panel.style.display = "none";
  }
});

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !changes.augmentorSitePermissions) return;
  void currentSitePermission().then((mode) => {
    if (mode === "blocked") {
      const { button, panel } = ensureInlineAssistantUi();
      button.style.display = "none";
      panel.style.display = "none";
    }
  });
});

const subframeActionTypes = new Set([
  "click_text",
  "detect_forms",
  "get_selection",
  "read_page",
  "scroll_page",
  "type_text"
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.channel !== "resonantos.browser_first.content") {
    return false;
  }
  if (!isTopWindow() && !subframeActionTypes.has(message.type)) {
    return false;
  }

  if (message.type === "read_page") {
    if (isTopWindow() && document.getElementById(controlOverlayId)?.dataset.session !== "active") {
      pulseControlOverlay({ state: "active", label: "Reading page context", phase: "reading" });
    }
    if (isTopWindow()) {
      window.setTimeout(() => pulseControlOverlay({ state: "done", label: "Page context captured", phase: "done" }), 300);
    }
    sendResponse({ ok: true, snapshot: pageSnapshot() });
    return true;
  }

  if (message.type === "get_selection") {
    sendResponse({ ok: true, selection: currentSelectionDetails(), title: document.title, url: sanitizeBrowserContextUrl(location.href) });
    return true;
  }

  if (message.type === "show_inline_assistant_for_text") {
    const text = String(message.text ?? "").trim().slice(0, 8000);
    if (!text) {
      sendResponse({ ok: false, error: "No selected text was provided." });
      return true;
    }
    const { button } = ensureInlineAssistantUi();
    const rect = {
      bottom: Number(message.rect?.bottom ?? 96),
      height: Number(message.rect?.height ?? 1),
      left: Number(message.rect?.left ?? 24),
      right: Number(message.rect?.right ?? 240),
      top: Number(message.rect?.top ?? 72),
      width: Number(message.rect?.width ?? 216),
    };
    lastInlineSelectionDetails = { activeRef: "", editable: false, rect, text };
    button.style.left = `${Math.min(window.innerWidth - 112, Math.max(8, rect.left))}px`;
    button.style.top = `${Math.min(window.innerHeight - 42, Math.max(8, rect.bottom + 8))}px`;
    button.style.display = "block";
    sendResponse({ ok: true, textLength: text.length });
    return true;
  }

  if (message.type === "resonator") {
    const action = String(message.action ?? "").toLowerCase();
    const allowedActions = new Set(["arrow", "clear", "highlight", "spotlight", "step"]);
    if (!allowedActions.has(action)) {
      sendResponse({ ok: false, error: "Unknown Resonator action." });
      return true;
    }
    const resonator = window.Resonator;
    if (!resonator || typeof resonator[action] !== "function") {
      sendResponse({ ok: false, error: "Resonator is not available on this page." });
      return true;
    }
    const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
    if (action !== "clear") {
      resonator.clear?.();
    }
    const result = resonator[action](payload);
    sendResponse({
      ok: action === "clear" ? true : result?.ok !== false,
      action,
      result,
      error: result?.ok === false ? result.error : undefined
    });
    return true;
  }

  if (message.type === "control_overlay") {
    sendResponse(setControlSessionOverlay({ active: Boolean(message.active), label: message.label, phase: message.phase }));
    return true;
  }

  if (message.type === "click_text") {
    sendResponse(message.ref
      ? clickControlRef(message.ref, { userApproved: Boolean(message.userApproved) })
      : clickVisibleText(message.text, { userApproved: Boolean(message.userApproved) }));
    return true;
  }

  if (message.type === "type_text") {
    sendResponse(typeIntoPage({ text: message.text, field: message.field, ref: message.ref, submit: message.submit, userApproved: Boolean(message.userApproved) }));
    return true;
  }

  if (message.type === "scroll_page") {
    sendResponse(scrollPage({ direction: message.direction, amount: message.amount }));
    return true;
  }

  if (message.type === "detect_forms") {
    sendResponse({ ok: true, ...describeForms() });
    return true;
  }

  sendResponse({ ok: false, error: "Unknown ResonantOS content command." });
  return true;
});

})();
