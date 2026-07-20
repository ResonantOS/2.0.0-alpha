import assert from "node:assert/strict";
import test from "node:test";
import { createProviderHostService } from "../host/provider-host-service.mjs";

function createService() {
  return createProviderHostService({
    redactDiagnosticText: (value) => String(value ?? ""),
    extractJsonObject: (value) => JSON.parse(String(value ?? "{}")),
  });
}

test("provider host service owns provider and Augmentor bridge routes", () => {
  const service = createService();
  const routes = new Map(service.providerBridgeRoutes.map((route) => [`${route.method} ${route.path}`, route]));

  assert.equal(typeof service.executeProviderStatus, "function");
  assert.equal(typeof service.executeBridgeChat, "function");
  assert.equal(typeof service.executeInlineAssistant, "function");

  assert.equal(typeof routes.get("GET /providers/status")?.handler, "function");
  assert.equal(typeof routes.get("POST /providers/health")?.handler, "function");
  assert.equal(typeof routes.get("POST /providers/connectivity-test")?.handler, "function");
  assert.equal(typeof routes.get("GET /providers/diagnostics-history")?.handler, "function");
  assert.equal(typeof routes.get("GET /providers/routing-strategies")?.handler, "function");
  assert.equal(typeof routes.get("POST /augmentor/chat")?.handler, "function");
  assert.equal(typeof routes.get("POST /augmentor/inline")?.handler, "function");

  assert.equal(routes.get("POST /providers/health")?.requiredCapability, "provider-diagnostics-read");
  assert.equal(routes.get("POST /providers/connectivity-test")?.requiredCapability, "provider-diagnostics-read");
  assert.equal(routes.get("GET /providers/diagnostics-history")?.requiredCapability, "provider-diagnostics-read");
  assert.equal(routes.get("GET /providers/routing-strategies")?.requiredCapability, "provider-diagnostics-read");
  assert.equal(routes.get("POST /providers/credentials")?.requiredCapability, "provider-credential-write");
  assert.equal(routes.get("POST /providers/accounts")?.requiredCapability, "provider-credential-write");
  assert.equal(routes.get("POST /providers/routing-strategies")?.requiredCapability, "provider-routing-write");
  assert.equal(routes.get("POST /providers/model-preferences")?.requiredCapability, "provider-routing-write");
  assert.equal(routes.get("POST /augmentor/chat")?.requiredCapability, "provider-model-invoke");
  assert.equal(routes.get("POST /augmentor/inline")?.requiredCapability, "provider-model-invoke");
});
