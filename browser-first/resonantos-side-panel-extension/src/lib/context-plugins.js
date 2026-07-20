/**
 * Resonant Context domain plugin registry.
 *
 * Restored from the retired browser-first branch and adapted for MV3 content
 * script loading. Hostname matching is exact or dot-label subdomain only.
 */
(function (root) {
  "use strict";

  if (root.ResonantOSContextPlugins) return;

  const UNIVERSAL_OVERLAYS = [
    "[role='dialog']",
    ".modal",
    "[class*='modal']",
    "[class*='overlay']",
    "[class*='popup']",
    "[class*='drawer']",
    "[data-radix-popper-content-wrapper]",
  ];

  const SENSITIVE_FIELD_NAME_PATTERN = /\b(?:password|passcode|passwd|pwd|secret|token|access[-_\s]?token|refresh[-_\s]?token|id[-_\s]?token|api[-_\s]?key|apikey|auth|authorization|bearer|credential|credentials|client[-_\s]?secret|private[-_\s]?key|seed|otp|2fa|mfa|card|credit|debit|cvc|cvv|iban|routing|account[-_\s]?number|ssn|social[-_\s]?security)\b/i;
  const SECRET_TEXT_PATTERNS = [
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    /\b(?:sk|sk-ant|sk-or-v1|xai|gsk|AIza|AKIA|gh[pousr]_|github_pat_|hf_|xox[baprs]-|pk_live_|rk_live_|SG\.)[A-Za-z0-9._\-+/=]{10,}\b/gi,
    /\b(?:api[_-]?key|token|password|secret|authorization|bearer|session|cookie|client[_-]?secret|private[_-]?key)\s*[:=]\s*['"]?[^'"\s]+/gi,
    /\b(?:\d[ -]?){13,19}\b/g,
  ];

  function normalizeHostname(input) {
    let value = String(input ?? "").trim().toLowerCase();
    if (!value) return "";
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        value = new URL(value).hostname;
      }
    } catch {
      return "";
    }
    return value.replace(/:\d+$/, "").replace(/\.+$/, "");
  }

  function hostMatchesDomain(hostname, domain) {
    const host = normalizeHostname(hostname);
    const target = normalizeHostname(domain);
    if (!host || !target || target === "*") return false;
    return host === target || host.endsWith(`.${target}`);
  }

  function sanitizeUrlForContext(value, base) {
    if (!String(value ?? "").trim()) return "";
    try {
      const url = new URL(String(value || ""), base || "https://example.invalid/");
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

  function redactFreeText(value) {
    let text = String(value ?? "");
    for (const pattern of SECRET_TEXT_PATTERNS) {
      text = text.replace(pattern, (candidate) => {
        if (pattern.source.includes("\\d")) {
          const digits = String(candidate).replace(/\D/g, "");
          return digits.length >= 13 && digits.length <= 19 ? "[redacted]" : candidate;
        }
        return "[redacted]";
      });
    }
    return text;
  }

  function fieldObjectLooksSensitive(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const haystack = [
      value.name,
      value.id,
      value.type,
      value.label,
      value.placeholder,
      value.autocomplete,
      value["aria-label"],
    ].filter(Boolean).join(" ");
    return SENSITIVE_FIELD_NAME_PATTERN.test(haystack);
  }

  function redactSensitiveFields(value, keyName = "", depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return Array.isArray(value) ? [] : {};
    if (SENSITIVE_FIELD_NAME_PATTERN.test(String(keyName || ""))) {
      return value ? "[redacted]" : value;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return typeof value === "string" ? redactFreeText(value) : value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => redactSensitiveFields(entry, keyName, depth + 1));
    }
    if (typeof value === "object") {
      const sensitiveFieldObject = fieldObjectLooksSensitive(value);
      return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => {
        if (sensitiveFieldObject && /^(value|valuePreview|text|content)$/i.test(entryKey)) {
          return [entryKey, entryValue ? "[redacted]" : entryValue];
        }
        return [entryKey, redactSensitiveFields(entryValue, entryKey, depth + 1)];
      }));
    }
    return "";
  }

  function buildPlugin(domain, sections, forms = [], extraOverlays = []) {
    const overlaySelectors = UNIVERSAL_OVERLAYS.concat(extraOverlays);
    return {
      domain,
      overlaySelectors,
      clickSelectors: "a, button, [onclick], [role='button'], [role='tab'], [role='menuitem'], [role='option']",
      maxHistory: 20,
      maxClicks: 30,
      persistSession: true,
      pages: {
        all: {
          match: () => true,
          sections,
          overlaySelectors,
          forms,
        },
      },
    };
  }

  const PLUGIN_JUPITER = buildPlugin(
    "jup.ag",
    [
      { selector: ".swap-form, [class*='swap-container'], [class*='SwapForm']", label: "Swap Form", priority: 10 },
      { selector: "[class*='connect'], [class*='wallet-button']", label: "Connect Wallet", priority: 9 },
      { selector: "[class*='portfolio'], [class*='Portfolio']", label: "Portfolio", priority: 7 },
      { selector: "[class*='token-list'], [class*='TokenList'], [class*='trending']", label: "Token List", priority: 5 },
      { selector: "[class*='chart'], [class*='Chart'], [class*='TradingView']", label: "Price Chart", priority: 6 },
      { selector: "[class*='order-book'], [class*='OrderBook']", label: "Order Book", priority: 5 },
      { selector: "[class*='stats'], [class*='Stats'], [class*='market-stats']", label: "Market Stats", priority: 4 },
    ],
    [
      {
        selector: "[class*='swap'], [class*='Swap']",
        name: "Swap Form",
        priority: 10,
        fields: [
          { selector: "input[inputmode='decimal'], input[type='number'], input[type='text'][class*='amount']", label: "Amount" },
        ],
      },
    ],
    ["[class*='SelectToken'], [class*='token-selector']"],
  );

  const PLUGIN_PHANTOM = buildPlugin(
    "phantom.app",
    [
      { selector: "[class*='balance'], [class*='Balance']", label: "Balance", priority: 9 },
      { selector: "[class*='send'], [class*='Send']", label: "Send", priority: 8 },
      { selector: "[class*='receive'], [class*='Receive']", label: "Receive", priority: 7 },
      { selector: "[class*='swap'], [class*='Swap']", label: "Swap", priority: 8 },
      { selector: "[class*='activity'], [class*='Activity'], [class*='transaction']", label: "Activity", priority: 6 },
      { selector: "[class*='nft'], [class*='NFT'], [class*='collectible']", label: "NFTs", priority: 4 },
      { selector: "[class*='settings'], [class*='Settings']", label: "Settings", priority: 3 },
    ],
    [
      {
        selector: "[class*='send-form'], form[class*='send']",
        name: "Send Form",
        priority: 10,
        fields: [
          { selector: "input[placeholder*='address'], input[placeholder*='Address']", label: "Recipient Address" },
          { selector: "input[placeholder*='amount'], input[placeholder*='Amount']", label: "Amount" },
        ],
      },
    ],
  );

  const PLUGIN_RAYDIUM = buildPlugin(
    "raydium.io",
    [
      { selector: "[class*='swap'], [class*='Swap'], .swap-card", label: "Swap Panel", priority: 10 },
      { selector: "[class*='liquidity'], [class*='Liquidity']", label: "Liquidity", priority: 8 },
      { selector: "[class*='farm'], [class*='Farm'], [class*='yield']", label: "Farms / Yield", priority: 7 },
      { selector: "[class*='pool'], [class*='Pool']", label: "Pools", priority: 6 },
      { selector: "[class*='staking'], [class*='Staking']", label: "Staking", priority: 6 },
      { selector: "[class*='portfolio'], [class*='wallet']", label: "Portfolio", priority: 5 },
    ],
    [
      {
        selector: "[class*='swap'], .swap-card",
        name: "Swap",
        priority: 10,
        fields: [
          { selector: "input[class*='input'], input[type='number']", label: "Token Amount" },
        ],
      },
    ],
  );

  const PLUGIN_ORCA = buildPlugin(
    "orca.so",
    [
      { selector: "[class*='swap'], [class*='Swap']", label: "Swap", priority: 10 },
      { selector: "[class*='pool'], [class*='Pool'], [class*='whirlpool']", label: "Whirlpools / Pools", priority: 8 },
      { selector: "[class*='position'], [class*='Position']", label: "Positions", priority: 7 },
      { selector: "[class*='wallet'], [class*='connect']", label: "Wallet", priority: 6 },
    ],
    [
      {
        selector: "[class*='swap-form'], [class*='swap-card']",
        name: "Swap Form",
        priority: 10,
        fields: [
          { selector: "input[type='number'], input[inputmode='decimal']", label: "Amount" },
        ],
      },
    ],
  );

  const PLUGIN_GITHUB = buildPlugin(
    "github.com",
    [
      { selector: "#readme, .markdown-body", label: "README / Content", priority: 8 },
      { selector: "[data-view-component='true'].diff-view, .file-diff", label: "Code Diff", priority: 10 },
      { selector: ".review-thread, .inline-comment", label: "Review Comments", priority: 9 },
      { selector: "#files_changed, [aria-label='Files changed']", label: "Files Changed", priority: 9 },
      { selector: ".commit-tease, .commit-meta", label: "Commit Info", priority: 7 },
      { selector: ".issues-list-item, #issue-title", label: "Issue / PR", priority: 8 },
      { selector: ".CodeMirror, .monaco-editor, [class*='code-editor']", label: "Code Editor", priority: 9 },
      { selector: ".file-header, [data-file-type]", label: "File View", priority: 7 },
      { selector: ".repo-stats, [aria-label='Repository stats']", label: "Repository Stats", priority: 4 },
    ],
    [
      {
        selector: "#new_comment_field, textarea[name='comment[body]'], .comment-form-textarea",
        name: "Comment Box",
        priority: 9,
        fields: [{ selector: "textarea", label: "Comment" }],
      },
      {
        selector: ".js-new-issue-form, #new_issue",
        name: "New Issue",
        priority: 10,
        fields: [
          { selector: "#issue_title", label: "Title" },
          { selector: "#issue_body", label: "Description" },
        ],
      },
      {
        selector: ".js-pull-request-review-form",
        name: "PR Review",
        priority: 10,
        fields: [{ selector: "textarea.comment-form-textarea", label: "Review Comment" }],
      },
    ],
    [".Overlay-backdrop", ".modal-backdrop"],
  );

  const PLUGIN_GOOGLE = buildPlugin(
    "google.com",
    [
      { selector: "#search, [role='main']", label: "Search Results", priority: 8 },
      { selector: "#searchform, form[role='search']", label: "Search Bar", priority: 9 },
      { selector: ".kix-page-content-wrapper, .docs-editor-container", label: "Document Content", priority: 9 },
      { selector: ".docsbar-container, .docs-title-outer", label: "Document Header", priority: 7 },
      { selector: "#grid-container, .grid-container", label: "Spreadsheet Grid", priority: 9 },
      { selector: ".docs-sheet-tab-strip", label: "Sheet Tabs", priority: 5 },
      { selector: ".nH.ar4.z0", label: "Email Thread", priority: 8 },
      { selector: ".dw.an, .compose-form", label: "Compose Email", priority: 9 },
      { selector: "[data-target='doc'], .r-ixnrzc", label: "Drive Files", priority: 7 },
    ],
    [
      {
        selector: "form[action*='search'], #tsf",
        name: "Search Form",
        priority: 10,
        fields: [{ selector: "input[name='q'], textarea[name='q']", label: "Search Query" }],
      },
    ],
    [".Tnsqgc", "[jsname='haAclf']"],
  );

  const PLUGIN_GENERIC = buildPlugin(
    "generic-web",
    [
      { selector: "main, [role='main'], #main, #content", label: "Main Content", priority: 5 },
      { selector: "article, .article, [role='article']", label: "Article", priority: 7 },
      { selector: "form", label: "Form", priority: 8 },
      { selector: "nav, [role='navigation']", label: "Navigation", priority: 2 },
      { selector: "header, [role='banner']", label: "Header", priority: 1 },
      { selector: "aside, [role='complementary']", label: "Sidebar", priority: 3 },
      { selector: "section[class*='hero'], .hero, [class*='banner']", label: "Hero / Banner", priority: 4 },
      { selector: "[class*='product'], [class*='listing']", label: "Product / Listing", priority: 6 },
      { selector: "[class*='price'], [class*='checkout'], [class*='cart']", label: "Pricing / Cart", priority: 9 },
      { selector: "[class*='table'], table", label: "Data Table", priority: 5 },
    ],
    [
      {
        selector: "form",
        name: "Page Form",
        priority: 5,
        fields: [
          { selector: "input[type='text'], input[type='email'], input[type='tel'], input[type='search'], textarea, select", label: "Field" },
        ],
      },
    ],
  );

  const REGISTRY = [
    ["jup.ag", PLUGIN_JUPITER],
    ["phantom.app", PLUGIN_PHANTOM],
    ["app.phantom.com", PLUGIN_PHANTOM],
    ["raydium.io", PLUGIN_RAYDIUM],
    ["orca.so", PLUGIN_ORCA],
    ["github.com", PLUGIN_GITHUB],
    ["google.com", PLUGIN_GOOGLE],
    ["docs.google.com", PLUGIN_GOOGLE],
    ["sheets.google.com", PLUGIN_GOOGLE],
    ["drive.google.com", PLUGIN_GOOGLE],
    ["mail.google.com", PLUGIN_GOOGLE],
  ];

  function getPluginForDomain(hostname) {
    const host = normalizeHostname(hostname);
    const match = REGISTRY.find(([domain]) => hostMatchesDomain(host, domain));
    return match?.[1] ?? PLUGIN_GENERIC;
  }

  const api = Object.freeze({
    UNIVERSAL_OVERLAYS,
    buildPlugin,
    getPluginForDomain,
    hostMatchesDomain,
    normalizeHostname,
    redactSensitiveFields,
    sanitizeUrlForContext,
    plugins: Object.freeze({
      jupiter: PLUGIN_JUPITER,
      phantom: PLUGIN_PHANTOM,
      raydium: PLUGIN_RAYDIUM,
      orca: PLUGIN_ORCA,
      github: PLUGIN_GITHUB,
      google: PLUGIN_GOOGLE,
      generic: PLUGIN_GENERIC,
    }),
  });

  root.ResonantOSContextPlugins = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
