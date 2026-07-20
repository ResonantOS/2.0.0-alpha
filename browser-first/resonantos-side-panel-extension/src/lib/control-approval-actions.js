export function createControlApprovalActions({
  activeTab = async () => null,
  addMessage = async () => undefined,
  agentControlRunner,
  approvalBoundaryForStep = () => "safe",
  controlStepLabel = () => "browser action",
  getCurrentControlRun = () => null,
  getPendingApproval = () => null,
  renderControlMonitor = () => undefined,
  renderTaskConsentPanel = async () => undefined,
  siteKeyForUrl = () => "unknown-site",
  taskConsentStore,
} = {}) {
  if (!agentControlRunner) {
    throw new Error("createControlApprovalActions requires agentControlRunner.");
  }
  if (!taskConsentStore) {
    throw new Error("createControlApprovalActions requires taskConsentStore.");
  }

  const approvePendingControlStep = async () => {
    const pendingApproval = getPendingApproval();
    const currentControlRun = getCurrentControlRun();
    if (!pendingApproval || !currentControlRun) return;

    const approval = pendingApproval;
    const boundary = approvalBoundaryForStep(approval.step, approval.reason);
    // #240: public-submit joins hard as non-approvable — an in-panel approval must
    // never execute a public commit. The human performs it on the page, then resumes.
    if (boundary === "hard" || boundary === "public-submit") {
      await addMessage(
        "system",
        boundary === "public-submit"
          ? `Cannot automate this action: ${controlStepLabel(approval.step)}.\nPublic submit and commit actions (send, publish, post, reserve, order, apply, confirm) are human-only — click it yourself on the page, then resume.`
          : `Cannot automate this action: ${controlStepLabel(approval.step)}.\nWallet, payment, login, credential, signing, and transfer actions are human-only.`
      );
      return;
    }

    await agentControlRunner.approvePendingControlStep(approval);
  };

  const allowCurrentTaskOnceForSafeActions = async () => {
    const pendingApproval = getPendingApproval();
    const currentControlRun = getCurrentControlRun();
    if (!pendingApproval || !currentControlRun) return;

    const approval = pendingApproval;
    const boundary = approvalBoundaryForStep(approval.step, approval.reason);
    const tab = await activeTab();
    if (boundary !== "safe") {
      await addMessage(
        "system",
        `Cannot allow this task class once for ${boundary} actions. Wallet, payment, login, credential, signing, public-submit, and transfer boundaries stay once-only human review.`
      );
      renderControlMonitor();
      return;
    }

    const consent = await taskConsentStore.setTaskConsent({
      siteKey: siteKeyForUrl(tab?.url),
      goal: currentControlRun.goal,
      mode: "allow-once",
      reason: `Allowed once after approval for: ${controlStepLabel(approval.step)}`,
      source: "approval-card",
    });
    await addMessage(
      "system",
      `Allowed safe ${consent.taskClass} actions on ${consent.siteKey} for this execution only and approved this safe step once: ${controlStepLabel(approval.step)}`
    );
    await taskConsentStore.consumeTaskConsent?.({
      siteKey: consent.siteKey,
      taskClass: consent.taskClass,
      reason: `Consumed by approved step: ${controlStepLabel(approval.step)}`,
      source: "approval-card"
    });
    await approvePendingControlStep();
    await renderTaskConsentPanel(tab);
  };

  const trustCurrentTaskForSafeActions = async () => {
    const pendingApproval = getPendingApproval();
    const currentControlRun = getCurrentControlRun();
    if (!pendingApproval || !currentControlRun) return;

    const approval = pendingApproval;
    const boundary = approvalBoundaryForStep(approval.step, approval.reason);
    const tab = await activeTab();
    if (boundary !== "safe") {
      await addMessage(
        "system",
        `Cannot trust this task class for ${boundary} actions. Wallet, payment, login, credential, signing, public-submit, and transfer boundaries stay once-only human review.`
      );
      renderControlMonitor();
      return;
    }

    const consent = await taskConsentStore.setTaskConsent({
      siteKey: siteKeyForUrl(tab?.url),
      goal: currentControlRun.goal,
      mode: "allow-safe",
      reason: `Trusted after approval for: ${controlStepLabel(approval.step)}`,
      source: "approval-card",
    });
    await addMessage(
      "system",
      `Trusted safe ${consent.taskClass} actions on ${consent.siteKey} for this task class and approved this safe step once: ${controlStepLabel(approval.step)}`
    );
    await approvePendingControlStep();
    await renderTaskConsentPanel(tab);
  };

  const denyPendingControlStep = async () => {
    const pendingApproval = getPendingApproval();
    const currentControlRun = getCurrentControlRun();
    if (!pendingApproval || !currentControlRun) return;
    await agentControlRunner.denyPendingControlStep(pendingApproval);
  };

  return {
    allowCurrentTaskOnceForSafeActions,
    approvePendingControlStep,
    denyPendingControlStep,
    trustCurrentTaskForSafeActions,
  };
}
