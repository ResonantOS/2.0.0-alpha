import {
  createControlPreflight,
  formatControlPreflightMessage,
  normalizeControlPreflight
} from "./control-preflight.js";

export function createSidePanelControlPreflightController({
  addMessage = async () => undefined,
  controlPreflightStorageKey = "augmentorControlPreflight",
  getPendingControlPreflight = () => null,
  renderControlPreflightCard = () => undefined,
  renderPermissionManager = async () => undefined,
  renderSitePermissionPanel = async () => undefined,
  renderTaskConsentPanel = async () => undefined,
  runControlCommand = async () => undefined,
  setActivity = () => undefined,
  setContextDockExpanded = async () => undefined,
  setNextControlPreflightDecision = () => undefined,
  setPendingControlPreflight = () => undefined,
  setStatus = () => undefined,
  storage,
  taskConsentStore
} = {}) {
  const persistControlPreflight = async () => {
    await storage?.set?.({
      [controlPreflightStorageKey]: getPendingControlPreflight()
    }).catch(() => undefined);
    renderControlPreflightCard();
  };

  const clearControlPreflight = async () => {
    setPendingControlPreflight(null);
    await storage?.remove?.(controlPreflightStorageKey).catch(() => undefined);
    renderControlPreflightCard();
  };

  const hydrateControlPreflight = async () => {
    const settings = await storage?.get?.(controlPreflightStorageKey).catch(() => ({}));
    setPendingControlPreflight(normalizeControlPreflight(settings?.[controlPreflightStorageKey]));
    renderControlPreflightCard();
  };

  const preflightDecisionFromPreflight = (preflight, { mode, reason }) => ({
    id: preflight.id,
    goal: preflight.goal,
    siteKey: preflight.siteKey,
    taskClass: preflight.taskClass,
    mode,
    permissionMode: preflight.mode,
    decidedAt: new Date().toISOString(),
    source: "control-preflight",
    reason
  });

  const requestControlPreflight = async ({ goal, mode, siteKey, tab = null }) => {
    const preflight = createControlPreflight({ goal, mode, siteKey });
    setPendingControlPreflight(preflight);
    await persistControlPreflight();
    await setContextDockExpanded(true);
    await renderSitePermissionPanel(tab);
    await addMessage("system", formatControlPreflightMessage(preflight));
    setStatus("Preflight required");
    setActivity("approval", "Agent Control preflight required", preflight.taskClass);
    return preflight;
  };

  const resolvePreflightFromCommand = (body) => {
    const requested = String(body ?? "").trim();
    const pendingControlPreflight = getPendingControlPreflight();
    if (!pendingControlPreflight) return null;
    if (!requested || requested === pendingControlPreflight.id) return pendingControlPreflight;
    return null;
  };

  const approveControlPreflight = async (body) => {
    const preflight = resolvePreflightFromCommand(body);
    if (!preflight) {
      await addMessage("system", "No matching Agent Control preflight is waiting. Start a browser-control task first, or use the exact preflight id.");
      return;
    }
    setNextControlPreflightDecision(preflightDecisionFromPreflight(preflight, {
      mode: "approved-once",
      reason: "Human approved Agent Control preflight once."
    }));
    await clearControlPreflight();
    await addMessage("system", `Approved Agent Control preflight for ${preflight.taskClass} on ${preflight.siteKey}. Starting governed browser control now.`);
    setStatus("Taking control");
    await runControlCommand(preflight.goal, { preflightApproved: true });
  };

  const allowControlPreflightOnceForTaskClass = async (body) => {
    const preflight = resolvePreflightFromCommand(body);
    if (!preflight) {
      await addMessage("system", "No matching Agent Control preflight is waiting. Start a browser-control task first, or use the exact preflight id.");
      return;
    }
    const consent = await taskConsentStore.setTaskConsent({
      siteKey: preflight.siteKey,
      taskClass: preflight.taskClass,
      mode: "allow-once",
      reason: `Allowed once from Agent Control preflight: ${preflight.goal}`,
      source: "control-preflight"
    });
    setNextControlPreflightDecision(preflightDecisionFromPreflight(preflight, {
      mode: "allowed-task-class-once",
      reason: `Human allowed safe ${preflight.taskClass} actions once for ${preflight.siteKey}.`
    }));
    await clearControlPreflight();
    await taskConsentStore.consumeTaskConsent?.({
      siteKey: consent.siteKey,
      taskClass: consent.taskClass,
      reason: `Consumed by Agent Control preflight: ${preflight.goal}`,
      source: "control-preflight"
    });
    await renderTaskConsentPanel();
    await renderPermissionManager();
    await addMessage("system", `Allowed safe ${consent.taskClass} actions on ${consent.siteKey} for this execution only. Hard wallet, login, payment, credential, signing, transfer, destructive, and public-submit boundaries remain human-gated.`);
    setStatus("Taking control");
    await runControlCommand(preflight.goal, { preflightApproved: true });
  };

  const denyControlPreflight = async (body) => {
    const preflight = resolvePreflightFromCommand(body);
    if (!preflight) {
      await addMessage("system", "No matching Agent Control preflight is waiting.");
      return;
    }
    await clearControlPreflight();
    setStatus("Denied");
    await addMessage("system", `Denied Agent Control preflight for ${preflight.taskClass} on ${preflight.siteKey}. No browser actions were taken.`);
  };

  const trustControlPreflightForSafeActions = async (body) => {
    const preflight = resolvePreflightFromCommand(body);
    if (!preflight) {
      await addMessage("system", "No matching Agent Control preflight is waiting.");
      return;
    }
    const consent = await taskConsentStore.setTaskConsent({
      siteKey: preflight.siteKey,
      taskClass: preflight.taskClass,
      mode: "allow-safe",
      reason: `Trusted from Agent Control preflight: ${preflight.goal}`,
      source: "control-preflight"
    });
    setNextControlPreflightDecision(preflightDecisionFromPreflight(preflight, {
      mode: "trusted-safe-actions",
      reason: `Human trusted safe ${preflight.taskClass} actions for ${preflight.siteKey}.`
    }));
    await clearControlPreflight();
    await renderTaskConsentPanel();
    await renderPermissionManager();
    await addMessage("system", `Trusted safe ${consent.taskClass} actions on ${consent.siteKey} and starting governed browser control now. Hard wallet, login, payment, credential, signing, transfer, destructive, and public-submit boundaries remain human-gated.`);
    setStatus("Taking control");
    await runControlCommand(preflight.goal, { preflightApproved: true });
  };

  return {
    allowControlPreflightOnceForTaskClass,
    approveControlPreflight,
    clearControlPreflight,
    denyControlPreflight,
    hydrateControlPreflight,
    persistControlPreflight,
    requestControlPreflight,
    trustControlPreflightForSafeActions
  };
}
