import { publicControlOverlayActionForStep } from "./control-overlay-actions.js";

export function createControlRunState({
  browserJobStore,
  getCurrentControlRun,
  minimumOverlayMs = 900,
  nowMs = () => Date.now(),
  renderControlMonitor,
  setCurrentControlRun,
  setPageControlOverlay,
  setPendingApproval,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  updateBrowserJob
}) {
  let overlayGeneration = 0;
  let overlayStartedAtMs = 0;

  const nowIso = () => new Date().toISOString();
  const terminalStepStates = new Set(["completed", "blocked", "failed", "cancelled"]);

  const stepLabel = (step) => {
    if (step?.label) return String(step.label);
    if (step?.type === "open") return `Opening ${step.url || "page"}`;
    if (step?.type === "search") return `Searching ${step.query || "web"}`;
    if (step?.type === "read") return "Reading page";
    if (step?.type === "inspect") return "Inspecting page";
    if (step?.type === "forms") return "Checking forms";
    if (step?.type === "tabs") return "Reading tabs";
    if (step?.type === "click") return `Clicking ${step.text || step.selector || "target"}`;
    if (step?.type === "type") return `Typing into ${step.field || "page"}`;
    if (step?.type === "scroll") return "Scrolling page";
    if (step?.type === "wait") return "Waiting";
    if (step?.type === "switch_tab") return "Switching tab";
    return "Working";
  };

  const overlayPhaseForStep = (step, state) => {
    if (["blocked", "failed"].includes(state)) return "blocked";
    if (state === "completed") return "working";
    if (["inspect", "read", "forms", "tabs"].includes(step?.type)) return "reading";
    if (["open", "search", "switch_tab"].includes(step?.type)) return "navigating";
    if (["click", "type", "scroll"].includes(step?.type)) return "acting";
    if (step?.type === "wait") return "waiting";
    return "working";
  };

  const updateOverlayForStep = (step, state, note = "") => {
    if (!["active", "blocked", "failed", "cancelled"].includes(state)) return;
    if (state === "active") {
      const action = publicControlOverlayActionForStep(step);
      void setPageControlOverlay(true, action.label, action.phase);
      return;
    }
    const prefix = state === "active"
      ? "Augmentor"
      : state === "blocked"
        ? "Blocked"
        : state === "cancelled"
          ? "Cancelled"
          : "Failed";
    const label = [prefix, stepLabel(step), note].filter(Boolean).join(": ");
    void setPageControlOverlay(true, label, overlayPhaseForStep(step, state));
  };

  const createStepRecord = (step, state = "pending", note = "", details = {}) => {
    const timestamp = nowIso();
    const timestampMs = nowMs();
    const timing = { ...(step?.timing ?? {}) };
    if (state === "active" && !timing.startedAt) {
      timing.startedAt = timestamp;
      timing.startedAtMs = timestampMs;
    }
    if (terminalStepStates.has(state) && !timing.completedAt) {
      timing.completedAt = timestamp;
      timing.completedAtMs = timestampMs;
      if (Number.isFinite(Number(timing.startedAtMs))) {
        timing.durationMs = Math.max(0, timestampMs - Number(timing.startedAtMs));
      }
    }
    return {
      ...step,
      state,
      note,
      details: {
        ...(step?.details ?? {}),
        ...details
      },
      timing,
      updatedAt: timestamp
    };
  };

  const startControlRun = ({ goal, plan }) => {
    const startedAt = nowIso();
    const startedAtMs = nowMs();
    const run = {
      id: browserJobStore.getActiveJobId() ?? `control-${Date.now()}`,
      goal,
      planner: plan.source,
      summary: plan.summary,
      status: "running",
      steps: plan.steps.map((step) => createStepRecord(step, step.state ?? "pending", step.note ?? "", step.details ?? {})),
      artifacts: Array.isArray(plan.artifacts) ? plan.artifacts : [],
      pageLock: plan.pageLock ?? null,
      startedAt,
      completedAt: null,
      timing: {
        startedAt,
        startedAtMs
      }
    };
    overlayGeneration += 1;
    overlayStartedAtMs = startedAtMs;
    setCurrentControlRun(run);
    setPendingApproval(null);
    renderControlMonitor();
    void setPageControlOverlay(true, `Augmentor operating: ${goal}`, "working");
    return run;
  };

  const updateControlStep = (index, state, note = "", details = {}) => {
    const currentControlRun = getCurrentControlRun();
    if (!currentControlRun?.steps[index]) return;
    const steps = [...currentControlRun.steps];
    steps[index] = createStepRecord(steps[index], state, note, details);
    setCurrentControlRun({ ...currentControlRun, steps });
    renderControlMonitor();
    updateOverlayForStep(steps[index], state, note);
  };

  const appendControlStep = (step) => {
    const currentControlRun = getCurrentControlRun();
    if (!currentControlRun) return -1;
    const index = currentControlRun.steps.length;
    setCurrentControlRun({
      ...currentControlRun,
      steps: [...currentControlRun.steps, createStepRecord(step)]
    });
    renderControlMonitor();
    return index;
  };

  const updateControlRunArtifacts = (artifacts) => {
    const currentControlRun = getCurrentControlRun();
    if (!currentControlRun) return;
    setCurrentControlRun({ ...currentControlRun, artifacts });
  };

  const finishControlRun = (status, artifact = null, nextPendingApproval = null) => {
    const currentControlRun = getCurrentControlRun();
    if (!currentControlRun) return;
    const completedAt = nowIso();
    const completedAtMs = nowMs();
    const runTiming = {
      ...(currentControlRun.timing ?? {}),
      completedAt,
      completedAtMs
    };
    if (Number.isFinite(Number(runTiming.startedAtMs))) {
      runTiming.durationMs = Math.max(0, completedAtMs - Number(runTiming.startedAtMs));
    }
    let steps = currentControlRun.steps;
    if (status === "cancelled") {
      const cancelledIndex = steps.findIndex((step) => ["active", "pending"].includes(step.state ?? "pending"));
      if (cancelledIndex >= 0) {
        steps = [...steps];
        steps[cancelledIndex] = createStepRecord(
          steps[cancelledIndex],
          "cancelled",
          "Stopped by human.",
          {
            ...(steps[cancelledIndex]?.details ?? {}),
            phase: "cancelled",
            nextHumanAction: "Review the page state and restart or resume the browser task when ready."
          }
        );
        updateOverlayForStep(steps[cancelledIndex], "cancelled", "Stopped by human.");
      }
    }
    const persistedJob = typeof browserJobStore.findJob === "function"
      ? browserJobStore.findJob(currentControlRun.id)
      : null;
    const preservedHumanStopStatus = ["cancelled", "paused"].includes(persistedJob?.status) && !["cancelled", "paused"].includes(status)
      ? persistedJob.status
      : "";
    const effectivePendingApproval = preservedHumanStopStatus ? null : nextPendingApproval;
    const completedRun = {
      ...currentControlRun,
      status: preservedHumanStopStatus || status,
      steps,
      completedAt,
      timing: runTiming,
      artifacts: artifact ? [...currentControlRun.artifacts, artifact] : currentControlRun.artifacts,
      pageLock: preservedHumanStopStatus ? (persistedJob?.pageLock ?? null) : currentControlRun.pageLock,
      pendingApproval: effectivePendingApproval
    };
    setCurrentControlRun(completedRun);
    setPendingApproval(effectivePendingApproval);
    const finishGeneration = overlayGeneration;
    const elapsedMs = Math.max(0, nowMs() - overlayStartedAtMs);
    const remainingMs = Math.max(0, minimumOverlayMs - elapsedMs);
    const releaseOverlay = () => {
      if (finishGeneration !== overlayGeneration) return;
      void setPageControlOverlay(false, "", "returning");
    };
    renderControlMonitor();
    if (remainingMs > 0 && typeof setTimeoutFn === "function") {
      setTimeoutFn(releaseOverlay, remainingMs);
    } else {
      releaseOverlay();
    }
    void updateBrowserJob(completedRun.id, {
      status: completedRun.status,
      artifacts: completedRun.artifacts,
      pageLock: completedRun.pageLock,
      pendingApproval: effectivePendingApproval,
      summary: completedRun.summary,
      planner: completedRun.planner,
      steps: completedRun.steps,
      timing: completedRun.timing
    });
    return completedRun;
  };

  const transitionControlRun = async (status, nextPendingApproval = null, { expectedStatus = "" } = {}) => {
    const currentControlRun = getCurrentControlRun();
    if (!currentControlRun) return { ok: false, run: null };
    const persistedJob = typeof browserJobStore.findJob === "function"
      ? browserJobStore.findJob(currentControlRun.id)
      : null;
    const observedStatus = persistedJob?.status ?? currentControlRun.status ?? "";
    if (expectedStatus && observedStatus !== expectedStatus) {
      const staleRun = {
        ...currentControlRun,
        status: observedStatus || currentControlRun.status,
        pageLock: persistedJob ? (persistedJob.pageLock ?? null) : currentControlRun.pageLock,
        pendingApproval: null
      };
      setCurrentControlRun(staleRun);
      setPendingApproval(null);
      renderControlMonitor();
      return { ok: false, run: staleRun };
    }
    const updated = await updateBrowserJob(currentControlRun.id, {
      status,
      pendingApproval: nextPendingApproval
    });
    const actualStatus = updated?.status ?? status;
    const accepted = actualStatus === status;
    const effectivePendingApproval = accepted && status === "approval"
      ? nextPendingApproval
      : null;
    const transitionedRun = {
      ...currentControlRun,
      status: actualStatus,
      pageLock: updated ? (updated.pageLock ?? null) : currentControlRun.pageLock,
      pendingApproval: effectivePendingApproval
    };
    setCurrentControlRun(transitionedRun);
    setPendingApproval(effectivePendingApproval);
    renderControlMonitor();
    return { ok: accepted, run: transitionedRun };
  };

  return {
    appendControlStep,
    finishControlRun,
    startControlRun,
    transitionControlRun,
    updateControlRunArtifacts,
    updateControlStep
  };
}
