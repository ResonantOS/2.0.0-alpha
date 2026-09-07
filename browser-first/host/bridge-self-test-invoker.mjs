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
} = {}) {
  return async function invokeBridgeRouteForSelfTest({
    method = "POST",
    routePath,
    body = {},
    capabilityToken = "",
  } = {}) {
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
    });
  };
}
