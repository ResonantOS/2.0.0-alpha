function rawErrorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "unknown error");
}

export function redactSensitiveErrorMessage(error) {
  return rawErrorMessage(error)
    .replace(/sk-[a-z0-9_-]+/gi, "[redacted-key]")
    .replace(/bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted-token]")
    .replace(/api[_-]?key\s*[:=]\s*[^\s]+/gi, "api_key=[redacted]")
    .replace(/token\s*[:=]\s*[^\s]+/gi, "token=[redacted]")
    .replace(/secret\s*[:=]\s*[^\s]+/gi, "secret=[redacted]");
}

export function isBridgeNetworkError(error) {
  const message = redactSensitiveErrorMessage(error);
  return /\bBridge is unreachable\b/i.test(message) ||
    /\bFailed to fetch\b/i.test(message) ||
    /\bLoad failed\b/i.test(message) ||
    /\bNetworkError\b/i.test(message) ||
    /\bnet::ERR_/i.test(message) ||
    /\bERR_CONNECTION/i.test(message) ||
    /\bnetwork request failed\b/i.test(message);
}

export function isBridgeAuthError(error) {
  const message = redactSensitiveErrorMessage(error);
  return /\bUnauthorized browser-first bridge request\b/i.test(message) ||
    /\bHTTP\s*401\b/i.test(message) ||
    /\breplied\s+401\b/i.test(message) ||
    /\btoken mismatch\b/i.test(message) ||
    /\brequires\b.*\bcapability\b/i.test(message) ||
    /\brequires .*authorization\b/i.test(message);
}

export function bridgeSetupMessage() {
  return "ResonantOS bridge is unreachable. Start the ResonantOS browser-first bridge, then verify Settings > Bridge Target.";
}

export function bridgeAuthMessage() {
  return "ResonantOS bridge rejected this browser profile token. Restart the browser-first bridge, reload the extension, or clear stale Settings > Bridge Target overrides.";
}

export function modelConnectionMessage(error) {
  if (isBridgeNetworkError(error)) {
    return `Model connection unavailable: ${bridgeSetupMessage()}`;
  }
  const detail = redactSensitiveErrorMessage(error);
  return `Model connection unavailable: ${detail}. Check Settings > Providers, the selected model, and Settings > Bridge Target.`;
}

export function mainWorkspaceRequestMessage(error) {
  if (isBridgeNetworkError(error)) {
    return `Main workspace request failed: ${bridgeSetupMessage()}`;
  }
  return `Main workspace request failed: ${redactSensitiveErrorMessage(error)}`;
}

export function regenerationMessage(error) {
  if (isBridgeNetworkError(error)) {
    return `Regeneration failed: ${bridgeSetupMessage()}`;
  }
  return `Regeneration failed: ${redactSensitiveErrorMessage(error)}`;
}

export function hermesStatusMessage(error, action = "Hermes status unavailable") {
  if (isBridgeNetworkError(error)) {
    return `${action}: ${bridgeSetupMessage()} Hermes dashboard setup can continue after the bridge is connected.`;
  }
  return `${action}: ${redactSensitiveErrorMessage(error)}. Open Settings > Add-ons and confirm Hermes is installed and enabled.`;
}

export function opencodeStatusMessage(error, action = "OpenCode status unavailable") {
  if (isBridgeNetworkError(error)) {
    return `${action}: ${bridgeSetupMessage()} OpenCode setup can continue after the bridge is connected.`;
  }
  return `${action}: ${redactSensitiveErrorMessage(error)}. Open Settings > Add-ons and confirm OpenCode is installed and enabled.`;
}

export function addonWorkspaceMessage(error, action) {
  if (isBridgeNetworkError(error)) {
    return `${action}: ${bridgeSetupMessage()}`;
  }
  return `${action}: ${redactSensitiveErrorMessage(error)}`;
}
