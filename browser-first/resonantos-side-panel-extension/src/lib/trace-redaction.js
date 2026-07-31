// Redaction pass for durable Agent Control trace artifacts (reports and
// delegation packets). The in-memory run keeps full fidelity for resume and
// UX; only exported artifacts pass through this scrubber so secrets echoed in
// goals, URLs, notes, or errors never reach the archive.

const SECRET_URL_PARAM_NAMES =
  "(?:token|key|secret|password|passwd|pwd|pin|otp|auth[_-]?code|access[_-]?token|refresh[_-]?token|api[_-]?key|session|sid|signature|csrf|jwt)";
const URL_PARAM_PATTERN = new RegExp(`([?&])(${SECRET_URL_PARAM_NAMES})(=)([^&#\\s]*)`, "gi");
const SECRET_ASSIGNMENT_NAMES =
  "(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|otp|pin|auth[_-]?code|signature|jwt)";
const ASSIGNMENT_PATTERN = new RegExp(`\\b(${SECRET_ASSIGNMENT_NAMES})(\\s*[=:]\\s*)[^\\s,;&#]+`, "gi");
const HEX_TOKEN_PATTERN = /\b[0-9a-fA-F]{32,}\b/g;

export function redactTraceText(value) {
  if (typeof value !== "string") return "";
  return String(value)
    .replace(URL_PARAM_PATTERN, (match, separator, name, eq) => `${separator}${name}${eq}REDACTED`)
    .replace(ASSIGNMENT_PATTERN, (match, name, separator) => `${name}${separator}REDACTED`)
    .replace(HEX_TOKEN_PATTERN, "[REDACTED-TOKEN]");
}
