// Pure policy over canonical manifest dependencies and host-owned grants. This
// module alone interprets replacement and declared revocation behavior.
export function replacementAllowed(manifest, slot) {
  return manifest?.systemSlots?.find(item => item.id === slot)?.replaceable === true;
}

function operationDependencies(manifest, operation) {
  const runtime = manifest.agentRuntime;
  const dependencies = new Set(runtime?.requiredCapabilities ?? []);
  const tool = name => manifest.tools?.find(item => item.name === name)?.requiredCapabilities ?? [];
  if (operation === 'invoke') for (const capability of tool(runtime?.invocationTool)) dependencies.add(capability);
  if (['modelCatalog', 'selectModel'].includes(operation)) {
    for (const capability of runtime?.modelSelection?.requiredCapabilities ?? []) dependencies.add(capability);
    if (operation === 'selectModel') for (const capability of tool(runtime?.modelSelection?.changeTool)) dependencies.add(capability);
  }
  return [...dependencies];
}

export function evaluateHarnessPolicy(manifest, grants, { revoked = [], slot = 'primary-agent' } = {}) {
  const allowed = capability => grants.some(grant => grant.capability === capability && grant.granted);
  const disabledOperations = (manifest.agentRuntime?.supportedOperations ?? []).filter(operation =>
    operationDependencies(manifest, operation).some(capability => !allowed(capability)));
  const hiddenSurfaceIds = (manifest.surfaces ?? []).filter(surface => {
    const dependencies = new Set(surface.shellNavigation?.requiredCapabilities ?? []);
    // Match the SDK's implicit surface dependencies as well as authored lists.
    dependencies.add('ui-embedding');
    if (manifest.systemSlots?.some(item => item.id === 'chat-interface')) dependencies.add('chat-interface');
    if (manifest.embeddedWorkspace?.surfaceId === surface.id) {
      for (const capability of manifest.embeddedWorkspace.requiredCapabilities) dependencies.add(capability);
    }
    return grants.some(grant => !grant.granted && grant.revocationBehavior === 'hide-surface' && dependencies.has(grant.capability));
  }).map(surface => surface.id);
  const hardStop = grants.some(grant => revoked.includes(grant.capability) && !grant.granted &&
    (grant.revocationBehavior === 'hard-stop' || (slot === 'primary-agent' && grant.capability === 'agent-runtime')));
  return { hardStop, disabledOperations, hiddenSurfaceIds };
}
