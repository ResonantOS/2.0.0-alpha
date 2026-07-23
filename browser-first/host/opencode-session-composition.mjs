import { createOpencodeServerLifecycle } from "./opencode-client.mjs";
import {
  createOpencodeSessionHandlers,
  createOpencodeSessionHostService,
} from "./opencode-session-host-service.mjs";

function requiredFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`OpenCode session composition missing dependency: ${name}`);
  }
  return value;
}

function requiredLifecycle(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") {
    throw new Error("OpenCode session composition requires a lifecycle.");
  }
  for (const method of ["createClient", "shutdown", "start", "stop"]) {
    requiredFunction(`lifecycle.${method}`, lifecycle[method]);
  }
  return lifecycle;
}

function revokedPreflightError(error) {
  if (!error?.stopRequired) return error;
  const revoked = new Error(
    error instanceof Error ? error.message : "OpenCode host consent was revoked.",
    { cause: error },
  );
  revoked.revoked = true;
  return revoked;
}

export function createOpencodeSessionBridgeComposition({
  addonDelegationService,
  lifecycle,
  spawnImpl,
} = {}) {
  const executePreflight = requiredFunction(
    "addonDelegationService.executeOpenCodeLiveSessionPreflight",
    addonDelegationService?.executeOpenCodeLiveSessionPreflight,
  );
  const ownedLifecycle = requiredLifecycle(
    lifecycle ?? createOpencodeServerLifecycle({ spawnImpl }),
  );
  const handlers = createOpencodeSessionHandlers({
    async preflight(_payload, context = {}) {
      try {
        return await executePreflight.call(addonDelegationService, {
          activeSession: context.operation !== "start",
        });
      } catch (error) {
        throw revokedPreflightError(error);
      }
    },
    redactWorkspace: (_workspace, preflight) => preflight.workspaceLabel,
    startLifecycle: ({ preflight, workspace }) => ownedLifecycle.start({
      command: preflight.command,
      cwd: workspace,
      env: preflight.childEnvironment,
    }),
    createClient: ({ lifecycle: handle }) => ownedLifecycle.createClient(handle),
    stopLifecycle: (handle) => ownedLifecycle.stop(handle),
  });
  const { opencodeSessionRoutes } = createOpencodeSessionHostService(handlers);

  async function shutdownOpenCodeSession() {
    const results = await Promise.allSettled([
      handlers.shutdownOpenCodeSession(),
      ownedLifecycle.shutdown(),
    ]);
    const failure = results.find(({ status }) => status === "rejected");
    if (failure) throw failure.reason;
  }

  return Object.freeze({
    opencodeSessionRoutes,
    shutdownOpenCodeSession,
  });
}
