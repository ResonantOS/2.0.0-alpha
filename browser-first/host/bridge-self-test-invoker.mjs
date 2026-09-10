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
  perCallerGrants,
  tokenKey,
  callerGrantVerifier,
  auditSink,
} = {}) {
  return async function invokeBridgeRouteForSelfTest({
    method = "POST",
    routePath,
    body = {},
    capabilityToken = "",
  } = {}) {
    // Parity with the live HTTP path: the handler receives the REAL bridge and capability tokens in
    // request.headers. Self-test handlers must never echo request.headers into payloads, logs, or audit
    // entries (no current handler reads headers at all; keep it that way).
    const headers = { [bridgeTokenHeaderName]: bridgeToken };
    if (capabilityToken) {
      headers[bridgeCapabilityHeaderName] = capabilityToken;
    }

    return evaluateBridgeRequestForSelfTest({
      method,
      url: routePath,
      headers,
      body,
      bridgeToken,
      bridgeCapabilityTokens,
      capabilityBootstrapToken,
      routes,
      perCallerGrants,
      tokenKey,
      callerGrantVerifier,
      auditSink,
    });
  };
}
