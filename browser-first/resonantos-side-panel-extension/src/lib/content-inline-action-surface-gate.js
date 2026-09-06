// Inline action surface gate: same restricted-scheme prefixes Agent Control
// uses (see control-target-classification.js), kept in sync locally so the
// content script need not import the runner. Order matters — the first match
// wins. Loaded as a classic content-script file before content.js so the
// functions are available on globalThis without ESM syntax.

(() => {
  if (globalThis.ResonantOSInlineActionSurfaceGate) return;
  const INLINE_RESTRICTED_SCHEMES = Object.freeze([
    "chrome://",
    "chrome-untrusted://",
    "chrome-extension://",
    "devtools://",
    "view-source:",
    "about:",
    "edge://",
    "brave://"
  ]);
  const inlineActionRestrictedScheme = (url) => {
    const value = String(url ?? "").trim().toLowerCase();
    if (!value) return "no open web page";
    return INLINE_RESTRICTED_SCHEMES.find((prefix) => value.startsWith(prefix)) ?? "";
  };
  const inlineActionAllowedForLocationGate = (url) => {
    const restricted = inlineActionRestrictedScheme(url);
    if (restricted) {
      return {
        allowed: false,
        reason: "restricted-scheme",
        message: `Augmentor inline actions are disabled on this page (${restricted}); Chrome blocks extensions from reading or acting on this kind of page. Open a normal website to use the inline assistant.`
      };
    }
    return { allowed: true };
  };
  globalThis.ResonantOSInlineActionSurfaceGate = Object.freeze({
    INLINE_RESTRICTED_SCHEMES,
    inlineActionRestrictedScheme,
    inlineActionAllowedForLocationGate
  });
})();

// Classic content script: the API is published on globalThis above. Do NOT add
// `export` here — manifest content_scripts are not modules and a SyntaxError
// silently disables this whole file on every page.
