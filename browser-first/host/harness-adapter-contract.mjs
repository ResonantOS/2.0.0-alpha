// Declarative boundary only. Registry ownership and transport authorization are
// separate host responsibilities; successful validation never grants execution.
import { HARNESS_OPERATIONS, HARNESS_PUBLIC_ERROR_MESSAGES as publicMessages } from "../../packages/addon-sdk/src/contracts.ts";
import { validateAddOnManifest } from "../../packages/addon-sdk/src/validation.ts";
export { validateAddOnManifest as validateHarnessManifest };

// Keep detailed SDK diagnostics out of host errors, including caller labels.
export function assertValidHarnessManifest(candidate, options = {}) {
  if (!validateAddOnManifest(candidate, options).valid) {
    throw Object.assign(new Error(publicMessages["invalid-manifest"]), { code: "invalid-manifest" });
  }
  return candidate;
}

export function publicHarnessError(error) {
  const code = typeof error?.code === "string" && Object.hasOwn(publicMessages, error.code)
    ? error.code : "runtime-unavailable";
  return { code, message: publicMessages[code] };
}

export function assertHarnessOperation(runtime, operation) {
  if (!HARNESS_OPERATIONS.includes(operation) || !Array.isArray(runtime?.supportedOperations) ||
      !runtime.supportedOperations.includes(operation)) {
    throw Object.assign(new Error(publicMessages["unsupported-operation"]), { code: "unsupported-operation" });
  }
  return operation;
}

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const counter = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;

// Shape/size validation is not provenance authentication or secret redaction.
// The owner must assign these identifiers and sanitize text before publication.
export function validateHarnessEvent(event) {
  if (!exactKeys(event, ["addonId", "sessionId", "turnId", "bootEpoch", "generation", "sequence", "type", "data"]) ||
      !id(event.addonId) || !/^addon\.[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(event.addonId) ||
      !id(event.sessionId) || !id(event.turnId) || !id(event.bootEpoch) ||
      !counter(event.generation, 0) || !counter(event.sequence, 1)) return false;
  const data = event.data;
  switch (event.type) {
    case "delta":
    case "final":
      return exactKeys(data, ["text"]) && typeof data.text === "string" && Buffer.byteLength(data.text, "utf8") <= 65_536;
    case "status":
      return exactKeys(data, ["status"]) && ["starting", "running", "idle", "unavailable"].includes(data.status);
    case "cancelled":
      return exactKeys(data, []);
    case "error":
      return exactKeys(data, ["code", "message"]) && typeof data.code === "string" &&
        Object.hasOwn(publicMessages, data.code) && data.message === publicMessages[data.code];
    default:
      return false;
  }
}
