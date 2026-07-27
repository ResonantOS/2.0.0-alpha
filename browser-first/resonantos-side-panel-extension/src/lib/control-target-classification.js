// Single source of truth for which browser tabs Agent Control can operate — and,
// when it can't, a specific, human-facing reason.
//
// Chrome forbids extensions from injecting content scripts into its own pages
// (chrome://, chrome-extension://, the Web Store, DevTools, view-source, about:,
// other Chromium internal schemes). Agent Control reads and clicks a page through
// an injected content script, so it can only operate normal http(s) websites.
// This is a hard platform limit, not a ResonantOS choice — so when the only
// available tab is a restricted page (e.g. chrome://settings), the right behavior
// is to explain clearly, not to fail with a generic "no target" message.

const GENERIC_NO_TARGET =
  "Agent Control needs a normal web page target. Open or select a website first, " +
  "or ask Augmentor to navigate to a site before operating the browser.";

// Prefix → friendly label for the restricted schemes a normal browser exposes.
const RESTRICTED_SCHEME_LABELS = [
  ["chrome://", "a Chrome page"],
  ["chrome-untrusted://", "a Chrome page"],
  ["chrome-extension://", "an extension page"],
  ["devtools://", "a DevTools page"],
  ["view-source:", "a view-source page"],
  ["about:", "a browser page"],
  ["edge://", "a browser page"],
  ["brave://", "a browser page"],
];

// The controllability predicate: a tab is operable only when it is an http(s)
// page. Used everywhere a tab is considered as an Agent Control target so the
// rule lives in exactly one place.
export function isControllableTabUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function shortTarget(url) {
  const value = String(url).trim();
  return value.length > 64 ? `${value.slice(0, 61)}…` : value;
}

// Classify a candidate target URL into { controllable, reason, label, guidance }.
// `guidance` is the message to show the human when a control command can't run:
//   - "ok"          → controllable http(s) page (no guidance needed)
//   - "empty"       → no open page / about:blank → the generic "open a site" ask
//   - "restricted"  → a browser-internal page Chrome won't let us script, named
//                     specifically, with what Agent Control can do instead
export function classifyControlTarget(url) {
  if (isControllableTabUrl(url)) {
    return { controllable: true, reason: "ok", label: "", guidance: "" };
  }
  const value = typeof url === "string" ? url.trim() : "";
  if (!value || /^about:blank$/i.test(value)) {
    return { controllable: false, reason: "empty", label: "no open web page", guidance: GENERIC_NO_TARGET };
  }
  const lower = value.toLowerCase();
  const match = RESTRICTED_SCHEME_LABELS.find(([prefix]) => lower.startsWith(prefix));
  const label = match ? match[1] : "a page it can't operate";
  return {
    controllable: false,
    reason: "restricted",
    label,
    guidance:
      `Agent Control can't operate ${label} (${shortTarget(value)}) — Chrome blocks extensions ` +
      "from reading or clicking its own pages. Open a normal website, or tell me to navigate to " +
      "one, and I'll operate that. To change a Chrome setting, ask me and I'll walk you through the steps.",
  };
}
