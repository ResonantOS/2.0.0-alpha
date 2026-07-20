// Canonical source of the browser-first bridge capability set.
//
// Every capability-scoped bridge route declares a `requiredCapability`; the
// launcher mints one token per capability and the extension requests exactly
// these (its RUNTIME_CAPABILITY_ALLOWLIST, derived from BRIDGE_ROUTE_CAPABILITIES
// in resonantos-side-panel-extension/src/lib/bridge-client.js).
//
// Historically each launcher entry point (`run-bridge-minimal.mjs` and the
// production `resonantos-bridge-full.mjs`) carried its own hand-maintained
// `bridgeCapabilityTokens` object literal. Those drifted: when the extension
// gained a new capability, a launcher that was not updated failed to mint the
// token, `POST /api/capability-tokens` 500'd with `Unknown bridge capability
// requested: <name>`, and the dashboard iframe died with no breadcrumb (#200).
//
// Both launchers now derive their mint map from BRIDGE_CAPABILITY_TOKEN_SPECS
// here, so there is a single place to add a capability, and
// bridge-capability-token-consistency.test.mjs locks this list to the
// extension's allowlist so any future drift fails CI instead of production.
//
// The `arg`/`env` names are an external deployment contract (operators pass
// --<arg> or set the env var to pin a stable token) — do not rename them.

export const BRIDGE_CAPABILITY_TOKEN_SPECS = Object.freeze([
  { capability: "provider-credential-write", arg: "provider-credential-token", env: "RESONANTOS_BROWSER_FIRST_PROVIDER_CREDENTIAL_TOKEN" },
  { capability: "provider-routing-write", arg: "provider-routing-token", env: "RESONANTOS_BROWSER_FIRST_PROVIDER_ROUTING_TOKEN" },
  { capability: "provider-diagnostics-read", arg: "provider-diagnostics-token", env: "RESONANTOS_BROWSER_FIRST_PROVIDER_DIAGNOSTICS_TOKEN" },
  { capability: "provider-model-invoke", arg: "provider-model-invoke-token", env: "RESONANTOS_BROWSER_FIRST_PROVIDER_MODEL_INVOKE_TOKEN" },
  { capability: "agent-control-plan", arg: "agent-control-plan-token", env: "RESONANTOS_BROWSER_FIRST_AGENT_CONTROL_PLAN_TOKEN" },
  { capability: "memory-settings-write", arg: "memory-settings-token", env: "RESONANTOS_BROWSER_FIRST_MEMORY_SETTINGS_TOKEN" },
  { capability: "memory-source-browse", arg: "memory-source-browse-token", env: "RESONANTOS_BROWSER_FIRST_MEMORY_SOURCE_BROWSE_TOKEN" },
  { capability: "memory-source-scan", arg: "memory-source-scan-token", env: "RESONANTOS_BROWSER_FIRST_MEMORY_SOURCE_SCAN_TOKEN" },
  { capability: "memory-source-manage", arg: "memory-source-manage-token", env: "RESONANTOS_BROWSER_FIRST_MEMORY_SOURCE_MANAGE_TOKEN" },
  { capability: "memory-source-move", arg: "memory-source-move-token", env: "RESONANTOS_BROWSER_FIRST_MEMORY_SOURCE_MOVE_TOKEN" },
  { capability: "memory-source-review", arg: "memory-source-review-token", env: "RESONANTOS_BROWSER_FIRST_MEMORY_SOURCE_REVIEW_TOKEN" },
  { capability: "memory-source-intake", arg: "memory-source-intake-token", env: "RESONANTOS_BROWSER_FIRST_MEMORY_SOURCE_INTAKE_TOKEN" },
  { capability: "memory-source-file-intake", arg: "memory-source-file-intake-token", env: "RESONANTOS_BROWSER_FIRST_MEMORY_SOURCE_FILE_INTAKE_TOKEN" },
  { capability: "archive-read", arg: "archive-read-token", env: "RESONANTOS_BROWSER_FIRST_ARCHIVE_READ_TOKEN" },
  { capability: "archive-write", arg: "archive-write-token", env: "RESONANTOS_BROWSER_FIRST_ARCHIVE_WRITE_TOKEN" },
  { capability: "diagnostics-report-export", arg: "diagnostics-report-token", env: "RESONANTOS_BROWSER_FIRST_DIAGNOSTICS_REPORT_TOKEN" },
  { capability: "browser-download-action", arg: "browser-download-action-token", env: "RESONANTOS_BROWSER_FIRST_BROWSER_DOWNLOAD_ACTION_TOKEN" },
  { capability: "addon-execution-settings-write", arg: "addon-execution-settings-token", env: "RESONANTOS_BROWSER_FIRST_ADDON_EXECUTION_SETTINGS_TOKEN" },
  { capability: "addon-runtime-read", arg: "addon-runtime-read-token", env: "RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN" },
  { capability: "addon-runtime-control", arg: "addon-runtime-control-token", env: "RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN" },
  { capability: "addon-record-read", arg: "addon-record-read-token", env: "RESONANTOS_BROWSER_FIRST_ADDON_RECORD_READ_TOKEN" },
  { capability: "addon-record-write", arg: "addon-record-write-token", env: "RESONANTOS_BROWSER_FIRST_ADDON_RECORD_WRITE_TOKEN" },
  { capability: "extension-prefs-write", arg: "extension-prefs-write-token", env: "RESONANTOS_BROWSER_FIRST_EXTENSION_PREFS_WRITE_TOKEN" },
]);

// The canonical capability names, in declaration order.
export const BRIDGE_CAPABILITIES = Object.freeze(
  BRIDGE_CAPABILITY_TOKEN_SPECS.map((spec) => spec.capability),
);

// Build the launcher's capability→token mint map. For each capability the token
// is taken from an explicit CLI arg, then a pinned env var, then a freshly
// minted token — matching the prior per-entry precedence. `args` is any object
// with a `.get(name)` method (the launcher's parsed argv); `mint` produces a
// fresh token when neither override is present.
export function buildBridgeCapabilityTokens({ args, env = process.env, mint } = {}) {
  if (typeof mint !== "function") {
    throw new Error("buildBridgeCapabilityTokens requires a mint() function.");
  }
  const argGet = typeof args?.get === "function" ? (name) => args.get(name) : () => undefined;
  return Object.fromEntries(
    BRIDGE_CAPABILITY_TOKEN_SPECS.map(({ capability, arg, env: envName }) => [
      capability,
      argGet(arg) ?? env?.[envName] ?? mint(),
    ]),
  );
}
