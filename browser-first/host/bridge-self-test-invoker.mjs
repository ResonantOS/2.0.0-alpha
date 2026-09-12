import {
  bridgeCapabilityHeaderName,
  bridgeTokenHeaderName,
  evaluateBridgeRequestForSelfTest,
} from "./bridge-server.mjs";

export function createBridgeRouteSelfTestInvoker({
  bridgeToken,
  bridgeCapabilityTokens = {},
  capabilityBootstrapToken,
  routes = [],
  listenerPort,
  getPublicPort = () => undefined,
} = {}) {
  return async function invokeBridgeRouteForSelfTest({
    method = "POST",
    routePath,
    body = {},
    capabilityToken = "",
    headers: overrides = {},
    rawHeaders,
  } = {}) {
    // Parity with the live HTTP path: the handler receives the REAL bridge and capability tokens in
    // request.headers. Self-test handlers must never echo request.headers into payloads, logs, or audit
    // entries (no current handler reads headers at all; keep it that way).
    const headers = { Host: `127.0.0.1:${listenerPort}`, [bridgeTokenHeaderName]: bridgeToken };
    if (capabilityToken) {
      headers[bridgeCapabilityHeaderName] = capabilityToken;
    }

    for (const [key, value] of Object.entries(overrides)) {
      for (const existing of Object.keys(headers)) if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
      headers[key] = value;
    }
    const host = Object.entries(headers).find(([key]) => key.toLowerCase() === "host")?.[1];
    return evaluateBridgeRequestForSelfTest({
      method,
      url: routePath,
      headers,
      body,
      bridgeToken,
      bridgeCapabilityTokens,
      capabilityBootstrapToken,
      routes,
      listenerPort,
      getPublicPort,
      selfTest: true,
      rawHeaders: rawHeaders ?? (host ? ["Host", host] : []),
    });
  };
}
