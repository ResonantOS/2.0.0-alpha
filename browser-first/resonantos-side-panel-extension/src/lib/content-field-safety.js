// Intent citation: docs/architecture/ADR-036-wallet-capable-browser-host.md

(() => {
  if (globalThis.ResonantOSContentFieldSafety) return;

  // #224 hardening: alias matching must be token-exact, never substring.
  // Candidate strings are split on underscores/hyphens/spaces, on lower->Upper
  // camelCase transitions, and on letter<->digit boundaries, then pure-digit
  // tokens are dropped: pin1 -> [pin], passwd2 -> [passwd],
  // userPin -> [user, pin], txtPasswd -> [txt, passwd]. Word-boundary regexes
  // alone never fire inside camelCase or digit-suffixed concatenations, which
  // let "pincode"/"pin1"/"userPin"/"txtPasswd" reach generic-text.
  const tokenizeFieldDescriptor = (value) => String(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !/^[0-9]+$/.test(token));

  // Token-exact credential aliases (single tokens plus compact compounds such
  // as pincode/passcode/seccode). "pass" is intentionally a standalone alias:
  // as a whole token it names a password field, while "passenger", "compass",
  // "shipping", "spinner", and "pinned" stay single non-matching tokens.
  const credentialTokenAliases = new Set([
    "password", "passcode", "passphrase", "passwd", "pwd", "pass", "pin",
    "pincode", "passkey", "seccode", "securitycode", "verificationcode",
    "credential", "secret", "seed", "otp", "mfa", "authenticator"
  ]);

  const hasCredentialToken = (descriptors) => {
    for (const descriptor of descriptors) {
      const tokens = tokenizeFieldDescriptor(descriptor);
      for (let index = 0; index < tokens.length; index += 1) {
        if (credentialTokenAliases.has(tokens[index])) return true;
        // Adjacent-token compounds keep secCode/sec_code/securityCode aligned
        // with their compact one-word spellings without substring matching.
        if (index + 1 < tokens.length && credentialTokenAliases.has(tokens[index] + tokens[index + 1])) return true;
      }
    }
    return false;
  };

  function classifyEditableField(element, { relatedLabelText = () => "" } = {}) {
    const tagName = element?.tagName?.toLowerCase?.() ?? "";
    const type = element instanceof HTMLInputElement ? String(element.getAttribute("type") || "text").toLowerCase() : "";
    const form = element?.closest?.("form");
    const descriptors = [
      type,
      tagName,
      element?.getAttribute?.("name"),
      element?.getAttribute?.("id"),
      element?.getAttribute?.("role"),
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("placeholder"),
      element?.getAttribute?.("title"),
      element?.getAttribute?.("autocomplete"),
      relatedLabelText(element),
      form?.getAttribute?.("role"),
      form?.getAttribute?.("aria-label"),
      form?.getAttribute?.("id"),
      form?.getAttribute?.("name"),
      form?.getAttribute?.("action")
    ].filter(Boolean);
    const haystack = descriptors.join(" ").replaceAll("_", " ").toLowerCase();

    if (
      type === "password" ||
      // #224: credential names also cover passwd/pwd/pin/passkey/security-code
      // aliases — sites frequently use type="text" for these, and an unblocked
      // generic-text classification would let Agent Control type into them.
      // Token-exact matching closes camelCase/digit-suffix bypasses (pincode,
      // pin1, userPin, txtPasswd, secCode) the \b regex below cannot see.
      hasCredentialToken(descriptors) ||
      /\b(password|passcode|passphrase|passwd|pwd|pin|passkey|security[\s_-]*code|credential|secret|seed|private\s*key|otp|2fa|mfa|one[-\s]?time|verification\s*code|authenticator)\b/.test(haystack)
    ) {
      return { kind: "credential", safeToType: false, safeToSubmit: false, reason: "Credential fields are human-only until the secure vault approval model exists." };
    }
    if (/\b(card|credit|debit|cc-|cvc|cvv|iban|routing|account\s*number|expiry|expiration|billing|payment|checkout|wallet|phantom)\b/.test(haystack)) {
      return { kind: "payment", safeToType: false, safeToSubmit: false, reason: "Payment and wallet fields are human-only." };
    }
    if (/\b(login|signin|sign[-\s]?in|username|user\s*name|account\s*email)\b/.test(haystack)) {
      return { kind: "login", safeToType: false, safeToSubmit: false, reason: "Login fields are human-only." };
    }
    if (
      ["email", "tel"].includes(type) ||
      /\b(email|e-mail|phone|telephone|mobile|address|street|postcode|postal|zip|city|country|first\s*name|last\s*name|full\s*name|surname|guest\s*name)\b/.test(haystack)
    ) {
      return { kind: "personal-contact", safeToType: false, safeToSubmit: false, reason: "Personal contact fields require a human-controlled autofill flow." };
    }
    if (
      type === "search" ||
      element?.getAttribute?.("role") === "searchbox" ||
      form?.getAttribute?.("role") === "search" ||
      /\b(search|query|find|filter|lookup)\b/.test(haystack) ||
      /\bq\b/.test(haystack)
    ) {
      return { kind: "search-query", safeToType: true, safeToSubmit: true, reason: "Search/query fields may be typed and submitted by Agent Control." };
    }
    // Single-line notes are a supported draft surface (the #223 certification
    // fixture uses one). Require an exact name/label, never a generic text input.
    const isNotesInput = type === "text" && [
      element?.getAttribute?.("name"),
      element?.getAttribute?.("aria-label"),
      relatedLabelText(element)
    ].some((value) => /^notes$/i.test(String(value ?? "").trim()));
    const contentEditable = element?.getAttribute?.("contenteditable")?.toLowerCase();
    if (
      isNotesInput || element instanceof HTMLTextAreaElement || element?.isContentEditable ||
      ["", "true", "plaintext-only"].includes(contentEditable)
    ) {
      return { kind: "document-edit", safeToType: true, safeToSubmit: false, reason: "Document-like fields may be edited but not submitted automatically." };
    }
    // D3: editing requires a positive benign classification at every automation level.
    return { kind: "unknown", safeToType: false, safeToSubmit: false, reason: "This control was not recognised, so a human performs it on the page." };
  }

  globalThis.ResonantOSContentFieldSafety = Object.freeze({
    classifyEditableField
  });
})();
