import { publicControlOverlayActionForStep } from "./control-overlay-actions.js";

export function controlResultSummary(result = {}) {
  if (!result?.ok) {
    if (result?.ambiguousTarget) return result?.error ?? "ambiguous browser target";
    if (result?.approvalRequired) return result?.error ?? "human approval required";
    return result?.error ?? "action failed";
  }
  if (result.clickedText) return `clicked "${String(result.clickedText).slice(0, 80)}"`;
  if (result.typedText) return result.submitted ? `typed and submitted "${String(result.typedText).slice(0, 80)}"` : `typed "${String(result.typedText).slice(0, 80)}"`;
  if (result.url) return `opened ${result.url}`;
  if (result.query) return `searched "${String(result.query).slice(0, 80)}"`;
  if (result.direction) return `scrolled ${result.direction}`;
  if (result.snapshot?.title || result.snapshot?.url) return `read ${result.snapshot.title || result.snapshot.url}`;
  if (Array.isArray(result.tabs)) return `checked ${result.tabs.length} tabs`;
  if (Array.isArray(result.forms)) return `found ${result.forms.length} forms`;
  if (result.waitedMs) return `waited ${result.waitedMs}ms`;
  return "completed";
}

export function browserJobStepHistory(job = {}) {
  return Array.isArray(job?.steps)
    ? job.steps.slice(0, 12).map((step) => ({
      action: {
        type: step.type ?? "step",
        label: step.label ?? "Previous browser step"
      },
      result: {
        ok: step.state === "completed",
        ambiguousTarget: Boolean(step.details?.ambiguousTarget),
        approvalRequired: step.state === "blocked" || step.state === "approval",
        actionRetry: step.details?.actionRetry ?? null,
        candidates: targetCandidatesFromResult({ candidates: step.details?.targetCandidates ?? [] }),
        error: step.note || null,
        verificationChanged: step.details?.verificationChanged ?? null,
        verificationRetry: step.details?.verificationRetry ?? null
      },
      observation: {
        title: job.goal ?? null,
        url: null
      }
    }))
    : [];
}

function normalizedConfidence(value, fallback = "medium") {
  const normalized = String(value ?? "").toLowerCase();
  return ["high", "medium", "low"].includes(normalized) ? normalized : fallback;
}

function humanInterventionState({ boundary = "safe", result = {}, step = {} } = {}) {
  const text = [
    boundary,
    result?.error,
    step?.label,
    step?.text,
    step?.field,
    step?.url,
    step?.type
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(payment|pay|checkout|card|billing|purchase|buy|order|subscribe)\b/.test(text)) {
    return {
      state: "checkout",
      action: "Review and complete checkout, payment, billing, or purchase steps manually. Augmentor may resume only after the value action is finished or cancelled."
    };
  }
  if (/\b(wallet|sign|signature|connect wallet|transfer|swap|stake|unstake|bridge|mint|claim)\b/.test(text)) {
    return {
      state: "wallet",
      action: "Use the wallet UI manually. Augmentor must not connect wallets, sign messages, approve transactions, transfer value, or operate wallet prompts."
    };
  }
  if (/\b(login|log in|sign in|credential|password|2fa|mfa|otp|passkey|auth)\b/.test(text)) {
    return {
      state: "login",
      action: "Complete the login or credential step manually, then ask Augmentor to continue from the signed-in page."
    };
  }
  if (boundary === "public-submit" || /\b(submit|send|post|publish|share|comment|save)\b/.test(text)) {
    return {
      state: "public-submit",
      action: "Review the visible page state and destination, then approve once only if you intend to submit/post/send publicly, or deny/delegate the blocker."
    };
  }
  if (boundary === "hard") {
    return {
      state: "human-only",
      action: "Complete this action manually in the page. Augmentor must not operate wallet, login, payment, credential, signing, transfer, or irreversible value controls."
    };
  }
  return {
    state: "review",
    action: "Review the visible page state, then approve once, allow this task class once, trust safe actions for this task class, deny, or delegate the blocker."
  };
}

function controlStepEvidence({ boundary = "safe", decision = {}, result = {}, status = "" } = {}) {
  const failed = result && result.ok === false;
  const approvalRequired = Boolean(result?.approvalRequired) || status === "approval";
  const hardBoundary = ["hard", "public-submit"].includes(boundary);
  const confidence = normalizedConfidence(
    decision.confidence,
    failed || approvalRequired || hardBoundary ? "low" : boundary === "safe" ? "medium" : "medium"
  );
  const uncertainty = String(
    decision.uncertainty ??
    decision.approvalReason ??
    (failed ? result?.error : "") ??
    ""
  ).trim();
  let nextHumanAction = "";
  const humanState = humanInterventionState({ boundary, result, step: decision.action ?? {} });
  if (approvalRequired && boundary === "hard") {
    nextHumanAction = humanState.action;
  } else if (approvalRequired) {
    nextHumanAction = humanState.action;
  } else if (failed) {
    nextHumanAction = "Inspect the page state, adjust the instruction or target text, then resume or delegate the issue.";
  } else if (status === "blocked") {
    nextHumanAction = "Clarify the goal or provide a more concrete visible target before resuming.";
  }
  return {
    confidence,
    humanInterventionState: approvalRequired || hardBoundary ? humanState.state : null,
    uncertainty: uncertainty || null,
    nextHumanAction: nextHumanAction || null
  };
}

function snapshotFingerprint(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const controls = Array.isArray(snapshot.controls) ? snapshot.controls.length : 0;
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields.length : 0;
  const text = String(snapshot.text ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
  return [
    String(snapshot.title ?? "").trim(),
    String(snapshot.url ?? "").trim(),
    text,
    `controls:${controls}`,
    `fields:${fields}`
  ].join("\n");
}

function verifyBrowserAction({ before = null, after = null, result = {}, step = {} } = {}) {
  if (!["click", "type", "open", "search", "switch_tab"].includes(step?.type) || !result?.ok) {
    return { changed: null, uncertainty: null };
  }
  const beforeFingerprint = snapshotFingerprint(before);
  const afterFingerprint = snapshotFingerprint(after);
  if (!afterFingerprint) {
    return {
      changed: null,
      uncertainty: "Page verification could not read the state after this action."
    };
  }
  if (beforeFingerprint && beforeFingerprint === afterFingerprint) {
    return {
      changed: false,
      uncertainty: "No visible page-state change was detected after this action. The next step should verify whether the target was already satisfied, choose a more precise target, or stop safely."
    };
  }
  return { changed: true, uncertainty: null };
}

function completionEvidenceForDoneDecision({ decision = {}, history = [], results = [] } = {}) {
  const normalizedHistory = Array.isArray(history) ? history : [];
  const normalizedResults = Array.isArray(results) ? results : [];
  const lastHistory = [...normalizedHistory].reverse().find((entry) => entry?.result) ?? null;
  const lastResult = [...normalizedResults].reverse().find((entry) => entry?.result) ?? null;
  const lastActionType = lastResult?.step?.type ?? lastHistory?.action?.type ?? "";

  if (!lastHistory && !lastResult) {
    return {
      ok: true,
      summary: decision.doneSummary ?? "No browser mutation was needed; the planner judged the current page state sufficient."
    };
  }
  if (lastHistory?.result?.approvalRequired || lastHistory?.result?.ok === false || lastResult?.result?.ok === false) {
    return {
      ok: false,
      nextHumanAction: "Review the blocker, approve only if appropriate, retarget the action, or delegate the issue.",
      uncertainty: "The planner attempted to finish after a blocked or failed browser action."
    };
  }
  if (lastHistory?.result?.verificationChanged === false) {
    return {
      ok: false,
      nextHumanAction: "Reread the page, verify the requested outcome is visibly satisfied, or retarget the action before marking the task complete.",
      uncertainty: "The previous browser action reported success but no visible page-state change, so completion is not proven."
    };
  }
  if (lastHistory?.result?.verificationChanged === true) {
    return {
      ok: true,
      summary: decision.doneSummary ?? "The latest browser action produced a verified visible page-state change."
    };
  }
  if (["read", "forms", "list_tabs"].includes(lastActionType)) {
    return {
      ok: true,
      summary: decision.doneSummary ?? "The task completed through read-only browser evidence."
    };
  }
  return {
    ok: true,
    summary: decision.doneSummary ?? "The observed page state satisfies the goal."
  };
}

function canRetryPageStateVerification(step = {}, result = {}, verification = {}) {
  return Boolean(result?.ok) &&
    verification?.changed === false &&
    ["click", "type", "open", "search", "switch_tab"].includes(step?.type);
}

function visibleLabel(item = {}) {
  return String(item.text || item.label || item.name || item.placeholder || item.ref || "").replace(/\s+/g, " ").trim();
}

function visibleRefLabel(item = {}) {
  const label = visibleLabel(item);
  const ref = item.ref ? `#${item.ref}` : "";
  return [label, ref].filter(Boolean).join(" ");
}

function relevantVisibleItems(items = [], target = "") {
  const needle = String(target ?? "").toLowerCase().trim();
  const normalized = Array.isArray(items) ? items : [];
  const visible = normalized
    .map((item) => ({ item, label: visibleRefLabel(item) }))
    .filter(({ label }) => label);
  if (!needle) return visible.slice(0, 5);
  const exact = visible.filter(({ label }) => label.toLowerCase().includes(needle) || needle.includes(label.toLowerCase()));
  return (exact.length ? exact : visible).slice(0, 5);
}

function targetCandidateLabel(candidate = {}) {
  return [
    visibleRefLabel(candidate),
    candidate.tagName ? `tag:${candidate.tagName}` : "",
    candidate.fieldKind ? `kind:${candidate.fieldKind}` : "",
    candidate.visibleIndex ? `index:${candidate.visibleIndex}` : "",
    candidate.context ? `context:${candidate.context}` : "",
    candidate.approvalRequired ? "approval-required" : ""
  ].filter(Boolean).join(" · ");
}

function targetCandidateContext(candidate = {}) {
  return [
    candidate.context,
    candidate.container?.label,
    candidate.section?.label,
    candidate.form?.label
  ].filter(Boolean).map((value) => String(value).slice(0, 160))[0] ?? "";
}

function targetCandidatesFromResult(result = {}) {
  return Array.isArray(result?.candidates)
    ? result.candidates
      .map((candidate) => ({
        approvalRequired: Boolean(candidate.approvalRequired),
        context: targetCandidateContext(candidate),
        fieldKind: candidate.fieldKind ? String(candidate.fieldKind).slice(0, 80) : "",
        form: candidate.form && typeof candidate.form === "object"
          ? {
            id: candidate.form.id ? String(candidate.form.id).slice(0, 80) : "",
            index: Number.isFinite(Number(candidate.form.index)) ? Number(candidate.form.index) : null,
            label: candidate.form.label ? String(candidate.form.label).slice(0, 160) : "",
            name: candidate.form.name ? String(candidate.form.name).slice(0, 80) : ""
          }
          : null,
        label: visibleLabel(candidate).slice(0, 160),
        ref: candidate.ref ? String(candidate.ref).slice(0, 80) : "",
        tagName: candidate.tagName ? String(candidate.tagName).slice(0, 40) : "",
        visibleIndex: Number.isFinite(Number(candidate.visibleIndex)) ? Number(candidate.visibleIndex) : null
      }))
      .filter((candidate) => candidate.ref || candidate.label)
      .slice(0, 8)
    : [];
}

function exactVisibleClickCandidates(snapshot = null, text = "") {
  const needle = String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return [];
  return (Array.isArray(snapshot?.controls) ? snapshot.controls : [])
    .map((item) => ({ item, label: visibleLabel(item) }))
    .filter(({ item, label }) => item?.ref && label && label.toLowerCase() === needle);
}

function preciseRefRetryStep({ boundary, result = {}, snapshot = null, step = {}, verification = {} } = {}) {
  if (boundary !== "safe" || !result?.ok || verification?.changed !== false || step?.type !== "click" || step?.ref) {
    return null;
  }
  const candidates = exactVisibleClickCandidates(snapshot, step.text);
  if (candidates.length !== 1) return null;
  const ref = candidates[0].item.ref;
  if (!ref) return null;
  return {
    ...step,
    ref,
    retryOf: browserActionSignature(step),
    retryStrategy: "precise-ref-retry"
  };
}

function recoveryOptionsForStep({ snapshot = null, step = {}, result = {}, verification = {} } = {}) {
  const controls = Array.isArray(snapshot?.controls) ? snapshot.controls : [];
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  const targetText = step?.text || step?.target || step?.field || step?.ref || "";
  const options = [];
  const resultCandidates = targetCandidatesFromResult(result);

  if (result?.ambiguousTarget && resultCandidates.length) {
    options.push(`Ambiguous target candidates: ${resultCandidates.map(targetCandidateLabel).join("; ")}.`);
    options.push("Retry with one exact visible ref from the candidate list instead of repeating the label.");
  }
  if (verification?.changed === false) {
    options.push("First verify whether the page already satisfies the goal; if not, wait for page state, scroll to reveal hidden controls, or choose a more precise visible ref before retrying.");
  }
  if (result?.ok === false) {
    options.push("Reread the page and retarget from current visible controls instead of repeating the failed action blindly.");
  }
  if (step?.type === "click") {
    const candidates = relevantVisibleItems(controls, targetText);
    if (candidates.length) {
      options.push(`Potential click targets now visible: ${candidates.map(({ label }) => label).join("; ")}.`);
    } else {
      options.push("No matching visible click target was found in the latest page snapshot; ask the human to expose the control or provide its exact label.");
    }
  }
  if (step?.type === "type") {
    const candidates = relevantVisibleItems(fields, step?.field || step?.ref || "");
    if (candidates.length) {
      options.push(`Potential editable fields now visible: ${candidates.map(({ label }) => label).join("; ")}.`);
    } else {
      options.push("No matching editable field was found in the latest page snapshot; ask the human to focus the field or provide its exact label.");
    }
  }
  if (!options.length && (step?.type === "open" || step?.type === "search")) {
    options.push("If navigation/search did not reveal the expected page, read the current page, check the URL/title, then search with a narrower query before acting.");
  }

  return [...new Set(options)].slice(0, 4);
}

function strategyDetails(decision = {}) {
  return {
    strategyPhase: decision.strategyPhase ?? null,
    strategyRationale: decision.strategyRationale ?? null,
    completionCheck: decision.completionCheck ?? null,
    scenarioName: decision.scenarioName ?? null,
    preferredProbes: Array.isArray(decision.preferredProbes) ? decision.preferredProbes : [],
    successSignals: Array.isArray(decision.successSignals) ? decision.successSignals : [],
    stopConditions: Array.isArray(decision.stopConditions) ? decision.stopConditions : []
  };
}

function browserActionSignature(action = {}) {
  if (!action || typeof action !== "object") return "";
  return JSON.stringify({
    direction: action.direction ?? "",
    field: action.field ?? "",
    query: action.query ?? "",
    ref: action.ref ?? "",
    submit: Boolean(action.submit),
    tabId: action.tabId ?? "",
    target: action.target ?? "",
    text: action.text ?? "",
    type: action.type ?? ""
  });
}

function repeatedNoChangeActionEvidence(history = [], action = {}) {
  const previous = [...history].reverse().find((entry) => entry?.action && entry?.result?.verificationChanged === false);
  if (!previous) return null;
  if (browserActionSignature(previous.action) !== browserActionSignature(action)) return null;
  return {
    previousAction: previous.action,
    reason: "The planner repeated the same action after the previous execution produced no visible page-state change.",
    nextHumanAction: "Inspect the page, choose a more precise visible target, or delegate the blocker before retrying this same action."
  };
}

export function createAgentControlRunner(deps) {
  const {
    addMessage,
    appendControlStep,
    approvalBoundaryForStep = () => "safe",
    controlStepLabel,
    createBrowserJob,
    executeControlStep,
    finishControlRun,
    getActiveJobId,
    getCurrentControlRun,
    getLastSnapshot,
    renderControlMonitor,
    requestNextControlAction,
    saveControlReportToArchive,
    setActivity,
    setPageControlOverlay = async () => undefined,
    setPendingApproval,
    setStatus,
    sleep,
    startControlRun,
    taskConsentForStep = async () => null,
    updateBrowserJob,
    updateControlRunArtifacts,
    updateControlStep
  } = deps;

  async function continueControlLoop({ goal, history = [], results = [], startIndex = 0, maxSteps = 12 } = {}) {
    try {
      for (let loopIndex = startIndex; loopIndex < maxSteps; loopIndex += 1) {
        await updateBrowserJob(getActiveJobId(), { status: "running" });
        await setPageControlOverlay(true, "reading", "reading");
        const snapshot = await deps.observeControlPage();
        await setPageControlOverlay(true, "reading", "reading");
        setActivity("thinking", "Deciding next browser action", `Loop ${loopIndex + 1}/${maxSteps}`);
        setStatus("Deciding");
        const decision = await requestNextControlAction({ goal, snapshot, history });
        if (decision.thought) {
          setActivity("thinking", decision.thought, decision.action ? controlStepLabel(decision.action) : decision.status);
        }
        if (decision.status === "done") {
          const completionEvidence = completionEvidenceForDoneDecision({ decision, history, results });
          if (!completionEvidence.ok) {
            const blockedStep = {
              type: "verify_completion",
              label: "Verify task completion"
            };
            const stepIndex = appendControlStep(blockedStep);
            updateControlStep(stepIndex, "blocked", "completion not proven", {
              phase: "blocked",
              observation: {
                title: snapshot?.title ?? null,
                url: snapshot?.url ?? null
              },
              decision: decision.thought ?? null,
              action: controlStepLabel(blockedStep),
              result: "completion not proven",
              safetyClass: "safe",
              ...strategyDetails(decision),
              confidence: "low",
              uncertainty: completionEvidence.uncertainty,
              nextHumanAction: completionEvidence.nextHumanAction,
              recoveryOptions: [
                "Do not mark the task complete until visible page evidence proves the requested outcome.",
                "Reread the page, inspect the relevant controls or fields, then choose a safe next action or stop with a clear blocker."
              ]
            });
            finishControlRun("blocked");
            setStatus("Control blocked");
            setActivity("failed", "Completion not proven", goal);
            await addMessage(
              "system",
              [
                "Agent Control Mode blocked before completion.",
                `Goal: ${goal}`,
                "",
                completionEvidence.uncertainty,
                completionEvidence.nextHumanAction
              ].filter(Boolean).join("\n")
            );
            const reportResults = [
              ...results,
              {
                step: blockedStep,
                result: {
                  error: "completion not proven",
                  ok: false
                }
              }
            ];
            const archiveResult = await saveControlReportToArchive(reportResults, "blocked-completion-unverified");
            if (archiveResult?.path) {
              const artifacts = [...(getCurrentControlRun()?.artifacts ?? []), { type: "archive-intake", path: archiveResult.path }];
              updateControlRunArtifacts(artifacts);
              renderControlMonitor();
              await updateBrowserJob(getCurrentControlRun()?.id, { artifacts });
            }
            return { ok: false, results, completionUnverified: true };
          }
          const archiveResult = await saveControlReportToArchive(results, "completed");
          const artifact = archiveResult?.path ? { type: "archive-intake", path: archiveResult.path } : null;
          finishControlRun("completed", artifact);
          await addMessage(
            "system",
            [
              "Agent Control Mode completed.",
              `Goal: ${goal}`,
              "",
              completionEvidence.summary,
              "",
              "Completed actions:",
              ...(results.length ? results.map(({ step }, index) => `${index + 1}. ${controlStepLabel(step)}`) : ["- No browser mutation was needed."])
            ].join("\n")
          );
          setStatus("Ready");
          setActivity("completed", "Control mode completed", goal);
          return { ok: true, results };
        }
        if (decision.status === "needs_approval" || decision.status === "blocked" || !decision.action) {
          const isApproval = decision.status === "needs_approval" && Boolean(decision.action);
          finishControlRun(isApproval ? "approval" : "blocked");
          setStatus(isApproval ? "Needs approval" : "Control blocked");
          setActivity("failed", isApproval ? "Control mode needs approval" : "Control mode blocked", decision.approvalReason);
          await addMessage(
            "system",
            [
              `Agent Control Mode ${isApproval ? "needs approval" : "blocked"}.`,
              `Goal: ${goal}`,
              `Reason: ${decision.approvalReason ?? decision.thought ?? "No safe next action is available."}`
            ].join("\n")
          );
          await saveControlReportToArchive(results, isApproval ? "approval-required" : "blocked");
          return { ok: false, results, approvalRequired: isApproval };
        }

        const step = decision.action;
        const repeatedNoChange = repeatedNoChangeActionEvidence(history, step);
        if (repeatedNoChange) {
          const stepIndex = appendControlStep(step);
          const blockedResult = {
            approvalRequired: false,
            error: repeatedNoChange.reason,
            ok: false,
            repeatNoChangePrevented: true
          };
          updateControlStep(stepIndex, "blocked", "repeat no-change action prevented", {
            phase: "blocked",
            observation: {
              title: snapshot?.title ?? null,
              url: snapshot?.url ?? null
            },
            decision: decision.thought ?? null,
            action: controlStepLabel(step),
            result: "repeat no-change action prevented",
            safetyClass: approvalBoundaryForStep(step),
            ...strategyDetails(decision),
            confidence: "low",
            uncertainty: repeatedNoChange.reason,
            nextHumanAction: repeatedNoChange.nextHumanAction,
            recoveryOptions: recoveryOptionsForStep({
              snapshot,
              step,
              result: blockedResult,
              verification: { changed: false }
            })
          });
          results.push({ step, result: blockedResult });
          history.push({
            action: step,
            result: {
              ok: false,
              approvalRequired: false,
              error: repeatedNoChange.reason,
              repeatNoChangePrevented: true,
              verificationChanged: false
            },
            observation: {
              title: snapshot?.title ?? null,
              url: snapshot?.url ?? null
            }
          });
          finishControlRun("blocked");
          setStatus("Control blocked");
          setActivity("failed", "Repeated no-change action blocked", controlStepLabel(step));
          await addMessage(
            "system",
            [
              `Agent Control Mode blocked at action ${stepIndex + 1}: ${controlStepLabel(step)}`,
              repeatedNoChange.reason,
              repeatedNoChange.nextHumanAction
            ].join("\n")
          );
          await saveControlReportToArchive(results, "blocked-repeat-no-change");
          return { ok: false, results, repeatNoChangePrevented: true };
        }
        const stepIndex = appendControlStep(step);
        updateControlStep(stepIndex, "active", decision.thought, {
          phase: "acting",
          observation: {
            title: snapshot?.title ?? null,
            url: snapshot?.url ?? null
          },
          decision: decision.thought ?? null,
          action: controlStepLabel(step),
          safetyClass: approvalBoundaryForStep(step),
          ...strategyDetails(decision),
          ...controlStepEvidence({
            boundary: approvalBoundaryForStep(step),
            decision
          })
        });
        const overlayAction = publicControlOverlayActionForStep(step);
        await setPageControlOverlay(true, overlayAction.label, overlayAction.phase);
        setActivity("tool-running", `Executing browser action ${stepIndex + 1}`, controlStepLabel(step));
        const result = await executeControlStep(step);
        await setPageControlOverlay(true, "verifying", "verifying");
        const verificationSnapshot = await deps.observeControlPage().catch(() => null);
        const verification = verifyBrowserAction({
          after: verificationSnapshot,
          before: snapshot,
          result,
          step
        });
        const boundary = approvalBoundaryForStep(step, result?.error);
        const consent = result?.approvalRequired && boundary === "safe"
          ? await taskConsentForStep({ goal, step, result })
          : null;
        const finalStep = consent ? { ...step, userApproved: true } : step;
        const finalResult = consent ? await executeControlStep(finalStep) : result;
        let postActionSnapshot = verificationSnapshot;
        let finalVerification = consent
          ? verifyBrowserAction({
            after: (postActionSnapshot = await deps.observeControlPage().catch(() => verificationSnapshot)),
            before: verificationSnapshot ?? snapshot,
            result: finalResult,
            step: finalStep
          })
          : verification;
        let verificationRetry = null;
        if (canRetryPageStateVerification(finalStep, finalResult, finalVerification)) {
          verificationRetry = "settle-reread";
          await setPageControlOverlay(true, "verifying", "verifying");
          await sleep(650);
          const settledSnapshot = await deps.observeControlPage().catch(() => null);
          postActionSnapshot = settledSnapshot ?? postActionSnapshot;
          const settledVerification = verifyBrowserAction({
            after: postActionSnapshot,
            before: snapshot,
            result: finalResult,
            step: finalStep
          });
          finalVerification = settledVerification.changed === true
            ? settledVerification
            : { ...finalVerification, retry: verificationRetry };
        }
        let executedStep = finalStep;
        let executedResult = finalResult;
        let actionRetry = null;
        const retryStep = preciseRefRetryStep({
          boundary,
          result: finalResult,
          snapshot: postActionSnapshot ?? getLastSnapshot() ?? snapshot,
          step: finalStep,
          verification: finalVerification
        });
        if (retryStep) {
          actionRetry = retryStep.retryStrategy;
          await setPageControlOverlay(true, "clicking", "clicking");
          executedStep = retryStep;
          executedResult = await executeControlStep(retryStep);
          await setPageControlOverlay(true, "verifying", "verifying");
          const retrySnapshot = await deps.observeControlPage().catch(() => postActionSnapshot);
          postActionSnapshot = retrySnapshot ?? postActionSnapshot;
          finalVerification = verifyBrowserAction({
            after: postActionSnapshot,
            before: snapshot,
            result: executedResult,
            step: retryStep
          });
        }
        results.push({ step: executedStep, result: executedResult });
          history.push({
            action: executedStep,
            result: {
              ok: Boolean(executedResult?.ok),
              actionRetry,
              ambiguousTarget: Boolean(executedResult?.ambiguousTarget),
              approvalRequired: Boolean(executedResult?.approvalRequired),
              candidates: targetCandidatesFromResult(executedResult),
              error: executedResult?.error ?? null,
              clickedText: executedResult?.clickedText ?? null,
            typedText: executedResult?.typedText ?? null,
            url: executedResult?.url ?? null,
            query: executedResult?.query ?? null,
            taskConsent: consent ? `${consent.siteKey}::${consent.taskClass}` : null,
            verificationChanged: finalVerification.changed,
            verificationRetry,
          },
          observation: {
            title: postActionSnapshot?.title ?? getLastSnapshot()?.title ?? snapshot?.title ?? null,
            url: postActionSnapshot?.url ?? getLastSnapshot()?.url ?? snapshot?.url ?? null
          }
        });
        if (!executedResult?.ok) {
          const canRequestHumanApproval = executedResult?.approvalRequired && boundary === "public-submit";
          const status = canRequestHumanApproval ? "approval" : "blocked";
          const reason = executedResult?.approvalRequired
            ? "Stopped because this step requires human approval."
            : `Stopped because this step failed: ${executedResult?.error ?? "unknown error"}`;
          updateControlStep(stepIndex, executedResult?.approvalRequired ? "blocked" : "failed", controlResultSummary(executedResult), {
            phase: executedResult?.approvalRequired ? "waiting-for-human" : "blocked",
            observation: {
              title: getLastSnapshot()?.title ?? snapshot?.title ?? null,
              url: getLastSnapshot()?.url ?? snapshot?.url ?? null
            },
            decision: decision.thought ?? null,
            action: controlStepLabel(executedStep),
            actionRetry,
            ambiguousTarget: Boolean(executedResult?.ambiguousTarget),
            targetCandidates: targetCandidatesFromResult(executedResult),
            result: controlResultSummary(executedResult),
            safetyClass: boundary,
            ...strategyDetails(decision),
            ...controlStepEvidence({
              boundary,
              decision,
              result: executedResult,
              status
            }),
            recoveryOptions: recoveryOptionsForStep({
              snapshot: getLastSnapshot() ?? postActionSnapshot ?? snapshot,
              step: executedStep,
              result: executedResult,
              verification: finalVerification
            })
          });
          finishControlRun(status);
          setStatus(canRequestHumanApproval ? "Needs approval" : "Control blocked");
          setActivity("failed", "Control mode blocked", controlStepLabel(step));
          await addMessage("system", `Agent Control Mode blocked at action ${stepIndex + 1}: ${controlStepLabel(step)}\n${reason}`);
          if (canRequestHumanApproval) {
            setPendingApproval({
              step: { ...step },
              stepIndex,
              reason: executedResult?.error ?? "This browser action requires human approval.",
              results,
              history
            });
            renderControlMonitor();
          }
          const archiveResult = await saveControlReportToArchive(results, canRequestHumanApproval ? "approval-required" : "blocked");
          if (archiveResult?.path) {
            const artifacts = [...(getCurrentControlRun()?.artifacts ?? []), { type: "archive-intake", path: archiveResult.path }];
            updateControlRunArtifacts(artifacts);
            renderControlMonitor();
            await updateBrowserJob(getCurrentControlRun()?.id, { artifacts });
          }
          return { ok: false, results, approvalRequired: Boolean(executedResult?.approvalRequired) };
        }
        updateControlStep(stepIndex, "completed", consent ? `trusted task consent · ${controlResultSummary(executedResult)}` : controlResultSummary(executedResult), {
          phase: "verified",
          observation: {
            title: postActionSnapshot?.title ?? getLastSnapshot()?.title ?? snapshot?.title ?? null,
            url: postActionSnapshot?.url ?? getLastSnapshot()?.url ?? snapshot?.url ?? null
          },
          decision: decision.thought ?? null,
          action: controlStepLabel(executedStep),
          actionRetry,
          result: controlResultSummary(executedResult),
          safetyClass: boundary,
          ...strategyDetails(decision),
          ...controlStepEvidence({
            boundary,
            decision,
            result: executedResult
          }),
          uncertainty: finalVerification.uncertainty ?? null,
          verificationChanged: finalVerification.changed,
          verificationRetry,
          recoveryOptions: recoveryOptionsForStep({
            snapshot: postActionSnapshot ?? getLastSnapshot() ?? snapshot,
            step: executedStep,
            result: executedResult,
            verification: finalVerification
          })
        });
        await sleep(350);
      }

      finishControlRun("blocked");
      setStatus("Control blocked");
      setActivity("failed", "Control loop reached safety limit", `${maxSteps} actions`);
      await addMessage("system", `Agent Control Mode stopped after ${maxSteps} actions. The task did not reach a verified completion state.`);
      await saveControlReportToArchive(results, "blocked-step-limit");
      return { ok: false, results };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /cancelled/i.test(message) ? "cancelled" : /paused/i.test(message) ? "paused" : "failed";
      finishControlRun(status);
      await updateBrowserJob(getActiveJobId(), { status, lastError: message });
      setStatus(status === "paused" ? "Paused" : status === "cancelled" ? "Cancelled" : "Control failed");
      setActivity(status === "paused" ? "paused" : "failed", `Control mode ${status}`, message);
      await addMessage("system", `Agent Control Mode ${status}.\nGoal: ${goal}\nReason: ${message}`);
      return { ok: false, results, error: message };
    }
  }

  async function runControlCommand(body, options = {}) {
    const goal = String(body ?? "").trim();
    if (!goal) {
      await addMessage("system", "Use `/control <browser goal>` or ask Augmentor to operate the current page.");
      return;
    }
    const resumedFromJob = options?.resumedFromJob ?? null;
    const seededHistory = browserJobStepHistory(resumedFromJob);
    const continuationPrefix = resumedFromJob?.id ? `Continuation of ${resumedFromJob.id}. ` : "";
    setStatus("Taking control");
    setActivity("tool-running", "Agent Control Mode", goal);
    const job = await createBrowserJob({
      existingJob: resumedFromJob,
      goal,
      planner: "observe-act-verify-loop",
      summary: `${continuationPrefix}Adaptive browser-agent loop. The host observes the page, asks for one safe next action, executes it, then verifies before continuing.`
    });
    startControlRun({
      goal,
      plan: {
        source: "observe-act-verify-loop",
        summary: `${continuationPrefix}Adaptive browser-agent loop. The host observes the page, asks for one safe next action, executes it, then verifies before continuing.`,
        pageLock: job.pageLock ?? null,
        steps: Array.isArray(resumedFromJob?.steps) ? resumedFromJob.steps : [],
        artifacts: Array.isArray(resumedFromJob?.artifacts) ? resumedFromJob.artifacts : []
      }
    });
    await addMessage(
      "system",
      [
        resumedFromJob ? "Agent Control Mode continued." : "Agent Control Mode started.",
        `Job: ${job.id}`,
        ...(resumedFromJob ? [`Resumed same durable job: ${resumedFromJob.id}`, `Previous steps loaded: ${seededHistory.length}`] : []),
        `Goal: ${goal}`,
        "Mode: observe -> decide -> act -> verify.",
        "",
        "Approval boundary: wallet, login, payment, credential, public submit, and destructive actions remain blocked unless a human approval flow authorizes them."
      ].join("\n")
    );
    return continueControlLoop({
      goal,
      history: seededHistory,
      results: [],
      startIndex: seededHistory.length,
      maxSteps: Math.max(12, seededHistory.length + 8)
    });
  }

  async function approvePendingControlStep(approval) {
    if (!approval || !getCurrentControlRun()) return;
    setPendingApproval(null);
    renderControlMonitor();
    setStatus("Approved once");
    setActivity("tool-running", "Executing approved browser step", controlStepLabel(approval.step));
    await addMessage("system", `Human approved this browser action once: ${controlStepLabel(approval.step)}`);

    const step = { ...approval.step, userApproved: true };
    const results = approval.results.slice(0, approval.results.length - 1);
    updateControlStep(approval.stepIndex, "active", "approved once", {
      phase: "acting",
      decision: "Human approved this action once.",
      action: controlStepLabel(step),
      approvalDecision: "approved-once",
      safetyClass: approvalBoundaryForStep(step),
      confidence: "medium",
      uncertainty: "Human approval was required before this step could run."
    });
    const result = await executeControlStep(step);
    results.push({ step, result });
    if (!result?.ok) {
      updateControlStep(approval.stepIndex, result?.approvalRequired ? "blocked" : "failed", controlResultSummary(result), {
        phase: result?.approvalRequired ? "waiting-for-human" : "blocked",
        observation: {
          title: getLastSnapshot()?.title ?? null,
          url: getLastSnapshot()?.url ?? null
        },
        decision: "Human approved this action once, but the host still could not complete it safely.",
        action: controlStepLabel(step),
        approvalDecision: "approved-once",
        result: controlResultSummary(result),
        safetyClass: approvalBoundaryForStep(step, result?.error),
        ...controlStepEvidence({
          boundary: approvalBoundaryForStep(step, result?.error),
          decision: { uncertainty: "The approved browser action did not complete safely." },
          result,
          status: result?.approvalRequired ? "approval" : "blocked"
        })
      });
      finishControlRun(result?.approvalRequired ? "approval" : "blocked");
      setStatus(result?.approvalRequired ? "Needs approval" : "Control blocked");
      setActivity("failed", "Control mode blocked", controlStepLabel(step));
      await addMessage("system", `Agent Control Mode blocked after approval: ${controlStepLabel(step)}\n${result?.error ?? "unknown error"}`);
      await saveControlReportToArchive(results, result?.approvalRequired ? "approval-required" : "blocked");
      return;
    }
    updateControlStep(approval.stepIndex, "completed", controlResultSummary(result), {
      phase: "verified",
      observation: {
        title: getLastSnapshot()?.title ?? null,
        url: getLastSnapshot()?.url ?? null
      },
      decision: "Human approved this action once.",
      action: controlStepLabel(step),
      approvalDecision: "approved-once",
      result: controlResultSummary(result),
      safetyClass: approvalBoundaryForStep(step, result?.error),
      confidence: "medium",
      uncertainty: "Human approval was used for this completed action."
    });
    const history = [
      ...(approval.history ?? []),
      {
        action: step,
        result: {
          ok: true,
          approvalRequired: false,
          clickedText: result?.clickedText ?? null,
          typedText: result?.typedText ?? null
        },
        observation: {
          title: getLastSnapshot()?.title ?? null,
          url: getLastSnapshot()?.url ?? null
        }
      }
    ];
    await continueControlLoop({
      goal: getCurrentControlRun().goal,
      history,
      results,
      startIndex: history.length,
      maxSteps: 12
    });
  }

  async function denyPendingControlStep(denied) {
    if (!denied || !getCurrentControlRun()) return;
    setPendingApproval(null);
    updateControlStep(denied.stepIndex, "blocked", "denied by human", {
      phase: "blocked",
      decision: "Human denied this browser action.",
      action: controlStepLabel(denied.step),
      approvalDecision: "denied",
      result: "denied by human",
      safetyClass: approvalBoundaryForStep(denied.step, denied.reason),
      confidence: "high",
      uncertainty: denied.reason ?? "Human denied the proposed action.",
      nextHumanAction: "Revise the task, choose a safer target, or perform the denied action manually."
    });
    finishControlRun("denied");
    renderControlMonitor();
    setStatus("Denied");
    setActivity("failed", "Approval denied", controlStepLabel(denied.step));
    await addMessage("system", `Denied browser action: ${controlStepLabel(denied.step)}. The task remains stopped.`);
    await saveControlReportToArchive([
      ...(Array.isArray(denied.results) ? denied.results : []),
      {
        step: denied.step,
        result: {
          error: "denied by human",
          ok: false
        }
      }
    ], "denied");
  }

  return {
    approvePendingControlStep,
    continueControlLoop,
    denyPendingControlStep,
    runControlCommand
  };
}
