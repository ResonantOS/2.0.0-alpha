// Pure policy over canonical manifest dependencies and host-owned grants. This
// module alone interprets replacement and declared revocation behavior.
export function replacementAllowed(manifest, slot) {
  return manifest?.systemSlots?.find(item => item.id === slot)?.replaceable === true;
}

// What each reviewed adapter actually reaches, independent of what a manifest says about
// itself. Without this, a manifest's own declarations decided both what the operator was asked
// to approve and what the operator could later withdraw: an add-on could name the reviewed
// provider adapter, omit `providers`, and spend the operator's credential with that capability
// never shown and no lever to revoke it.
//
// A floor is what the adapter cannot avoid touching, not everything it might do. Adding an
// adapter here is part of reviewing it.
// Null-prototype: an adapter id such as `constructor` must look up to nothing, not to
// something inherited from Object.prototype.
const ADAPTER_CAPABILITY_FLOOR = Object.freeze(Object.assign(Object.create(null), {
  // `agent-runtime` backs the primary-agent slot rather than being something the adapter
  // reaches outward; the SDK validator already requires it, so it is here to keep each entry
  // a complete statement of what running this adapter needs.
  // Reaches the operator's configured providers through the host provider service.
  'provider-fabric-v1': Object.freeze(['agent-runtime', 'providers']),
  // Opens an outbound connection to its approved endpoint.
  'openai-compatible-v1': Object.freeze(['agent-runtime', 'network']),
  'dsh-typert-v1': Object.freeze(['agent-runtime', 'network']),
}));

/** Capabilities the named adapter reaches. Empty for an add-on with no reviewed runtime. */
export function adapterCapabilityFloor(manifest) {
  const adapterId = manifest?.agentRuntime?.adapterId;
  return typeof adapterId === 'string' && Object.hasOwn(ADAPTER_CAPABILITY_FLOOR, adapterId)
    ? [...ADAPTER_CAPABILITY_FLOOR[adapterId]] : [];
}

/** Floor capabilities the manifest never asks the operator for, so never shows and never offers to revoke. */
export function undeclaredAdapterCapabilities(manifest) {
  const requested = new Set((manifest?.requestedCapabilities ?? []).map(grant => grant?.capability));
  return adapterCapabilityFloor(manifest).filter(capability => !requested.has(capability));
}

function operationDependencies(manifest, operation) {
  const runtime = manifest.agentRuntime;
  // The floor joins the manifest's own runtime dependencies, so a manifest that never asked is
  // gated exactly like one that asked and was refused.
  const dependencies = new Set([...(runtime?.requiredCapabilities ?? []), ...adapterCapabilityFloor(manifest)]);
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
