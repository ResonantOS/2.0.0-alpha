import os from "node:os";
import path from "node:path";
import { createProviderBridgeService } from "./provider-bridge-service.mjs";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function providerSecretsPath() {
  return path.join(os.homedir(), "ResonantOS_User", "Secrets", "provider-secrets.json");
}

function providerRoutingPath() {
  return path.join(os.homedir(), "ResonantOS_User", "ProviderFabric", "routing-strategies.json");
}

function providerModelPreferencesPath() {
  return path.join(os.homedir(), "ResonantOS_User", "ProviderFabric", "model-preferences.json");
}

function providerAccountsPath() {
  return path.join(os.homedir(), "ResonantOS_User", "ProviderFabric", "provider-accounts.json");
}

function providerDiagnosticsHistoryPath() {
  return path.join(os.homedir(), "ResonantOS_User", "ProviderFabric", "diagnostics-history.json");
}

export function createProviderHostService({ redactDiagnosticText, extractJsonObject } = {}) {
  const service = createProviderBridgeService({
    providerSecretsPath,
    providerAccountsPath,
    providerRoutingPath,
    providerModelPreferencesPath,
    providerDiagnosticsHistoryPath,
    redactDiagnosticText,
    unique,
    extractJsonObject,
  });

  return {
    ...service,
    providerBridgeRoutes: [
      { method: "GET", path: "/providers/status", handler: service.executeProviderStatus },
      {
        method: "POST",
        path: "/providers/health",
        requiredCapability: "provider-diagnostics-read",
        handler: service.executeProviderHealthCheck,
      },
      {
        method: "POST",
        path: "/providers/connectivity-test",
        requiredCapability: "provider-diagnostics-read",
        handler: service.executeProviderConnectivityTest,
      },
      {
        method: "GET",
        path: "/providers/diagnostics-history",
        requiredCapability: "provider-diagnostics-read",
        handler: service.executeProviderDiagnosticsHistory,
      },
      {
        method: "GET",
        path: "/providers/routing-strategies",
        requiredCapability: "provider-diagnostics-read",
        handler: service.executeProviderRoutingStrategies,
      },
      {
        method: "POST",
        path: "/providers/credentials",
        requiredCapability: "provider-credential-write",
        handler: service.executeProviderCredentialSave,
      },
      {
        method: "POST",
        path: "/providers/accounts",
        requiredCapability: "provider-credential-write",
        handler: service.executeProviderAccountSave,
      },
      {
        method: "POST",
        path: "/providers/accounts/remove",
        requiredCapability: "provider-credential-write",
        handler: service.executeProviderAccountRemove,
      },
      {
        method: "POST",
        path: "/providers/routing-strategies",
        requiredCapability: "provider-routing-write",
        handler: service.executeProviderRoutingStrategySave,
      },
      {
        method: "POST",
        path: "/providers/model-preferences",
        requiredCapability: "provider-routing-write",
        handler: service.executeProviderModelPreferencesSave,
      },
      {
        method: "POST",
        path: "/augmentor/chat",
        requiredCapability: "provider-model-invoke",
        handler: service.executeBridgeChat,
      },
      {
        method: "POST",
        path: "/augmentor/inline",
        requiredCapability: "provider-model-invoke",
        handler: service.executeInlineAssistant,
      },
    ],
  };
}
