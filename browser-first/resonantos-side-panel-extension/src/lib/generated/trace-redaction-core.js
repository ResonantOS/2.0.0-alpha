// One shared implementation for classic content scripts and ESM consumers.
(function () {
  'use strict';

  const apiKey = '__RESONANTOS_TRACE_REDACTION__';
  const registration = Object.getOwnPropertyDescriptor(globalThis, apiKey);
  if (registration) {
    const existing = registration.value;
    if (!existing || existing.version !== 1 || !Object.isFrozen(existing) ||
        typeof existing.redactTraceText !== 'function' || typeof existing.redactTraceValue !== 'function') {
      throw new Error('Incompatible ResonantOS trace redaction API');
    }
    return;
  }

  // Shared strict redaction for durable traces, reports and session summaries.
  // Live execution retains its original text; this is a lossy storage boundary.
  const SECRET_NAMES = "(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|otp|pin|auth[_-]?code|signature|jwt|session|sid|csrf|key|code|client[_-]?(?:secret|id|token)|session[_-]?(?:id|token|key)|id[_-]?token|csrf[_-]?token|jwt[_-]?token)";
  const SECRET_PROPERTY_PATTERN = new RegExp(`^${SECRET_NAMES}$`, "i");
  const URL_PARAM_PATTERN = new RegExp(`([?&])(${SECRET_NAMES})(=)([^&#\\s]*)`, "gi");
  const ENCODED_URL_PARAM_PATTERN = new RegExp(
    `(%3F|%26)(${SECRET_NAMES})(%3D)((?:(?!%26|%23)[^&#\\s])*)`, "gi"
  );
  // Capture delimiters; quoted values may contain spaces, colons and escapes.
  // Unquoted values retain the original comma/semicolon coverage.
  const QUOTED_VALUE = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
  const ASSIGNMENT_PATTERN = new RegExp(
    String.raw`\b(${SECRET_NAMES})(\s*[=:]\s*)(${QUOTED_VALUE}|[^\s&#]+)`, "gi"
  );
  // Preserve JSON neighbors for primitive values without narrowing the legacy
  // unquoted comma/semicolon credential family.
  const JSON_PRIMITIVE = String.raw`(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|REDACTED|\[redacted\])(?=\s*(?:,\s*["']|}))`;
  const QUOTED_ASSIGNMENT_PATTERN = new RegExp(
    String.raw`\b(${SECRET_NAMES})(\s*["']\s*[=:]\s*)(${QUOTED_VALUE}|${JSON_PRIMITIVE}|[^\s&#]+)`, "gi"
  );
  const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/=]+/g;
  const PROVIDER_KEY_PREFIX_PATTERN = /\b(?:sk_live_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{25,39}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,})\b/g;
  // Base58 excludes 0, O, I and l. Keep the legacy alternative (which included
  // l but omitted i/o) so correcting the alphabet never removes a redaction.
  // This length/alphabet heuristic can also redact benign identifiers or words.
  const BASE58_HEURISTIC_PATTERN = /\b(?:[A-HJ-NP-Za-km-z1-9]{40,90}|[A-HJ-NP-Za-hj-np-z1-9]{40,90})\b/g;
  const HEX_TOKEN_PATTERN = /\b[0-9a-fA-F]{32,}\b/g;

  function redactTraceText(value, {
    replacement = "REDACTED",
    tokenReplacement = "[REDACTED-TOKEN]"
  } = {}) {
    if (typeof value !== "string") return "";
    const replaceAssignment = (match, name, separator, secret) => {
      const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : "";
      return `${name}${separator}${quote}${replacement}${quote}`;
    };
    return value
      // Bearer must precede every name/value pass, including URL assignments.
      .replace(BEARER_PATTERN, () => replacement)
      .replace(QUOTED_ASSIGNMENT_PATTERN, replaceAssignment)
      .replace(ASSIGNMENT_PATTERN, replaceAssignment)
      .replace(URL_PARAM_PATTERN, (match, separator, name, eq) => `${separator}${name}${eq}${replacement}`)
      .replace(ENCODED_URL_PARAM_PATTERN, (match, separator, name, eq) => `${separator}${name}${eq}${replacement}`)
      .replace(PROVIDER_KEY_PREFIX_PATTERN, () => tokenReplacement)
      .replace(BASE58_HEURISTIC_PATTERN, () => tokenReplacement)
      .replace(HEX_TOKEN_PATTERN, () => tokenReplacement);
  }

  function redactTraceValue(value, options = {}) {
    const ancestors = new WeakSet();
    function visit(input) {
      if (typeof input === "string") return redactTraceText(input, options);
      if (input === null || typeof input === "boolean") return input;
      if (typeof input === "number") return Number.isFinite(input) ? input : null;
      if (typeof input !== "object" || ancestors.has(input)) return null;
      if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return null;
      ancestors.add(input);
      const output = Array.isArray(input) ? [] : {};
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Array.isArray(input)) {
        for (let index = 0; index < input.length; index++) {
          const descriptor = descriptors[index];
          output.push(descriptor && Object.hasOwn(descriptor, "value") ? visit(descriptor.value) : null);
        }
      } else {
        for (const [name, descriptor] of Object.entries(descriptors)) {
          if (!descriptor.enumerable) continue;
          const cleanName = redactTraceText(name, options);
          let key = cleanName;
          for (let suffix = 2; Object.hasOwn(output, key); suffix++) key = `${cleanName}#${suffix}`;
          const cleanValue = !Object.hasOwn(descriptor, "value") ? null
            : SECRET_PROPERTY_PATTERN.test(name) ? options.replacement ?? "REDACTED"
              : visit(descriptor.value);
          Object.defineProperty(output, key, { value: cleanValue, enumerable: true, writable: true, configurable: true });
        }
      }
      ancestors.delete(input);
      return output;
    }
    return visit(value);
  }

  Object.defineProperty(globalThis, apiKey, {
    value: Object.freeze({ version: 1, redactTraceText, redactTraceValue }),
    enumerable: false,
    writable: false,
    configurable: false
  });
})();
