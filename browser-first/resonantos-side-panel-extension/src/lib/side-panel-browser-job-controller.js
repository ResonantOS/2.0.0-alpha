export function createSidePanelBrowserJobController({
  activateJobTab = async () => undefined,
  addMessage = async () => undefined,
  browserJobStore,
  consumeNextControlPreflightDecision = () => null,
  getCurrentControlRun = () => null,
  onHistoryLoadStateChange = () => undefined,
  prepareBrowserJobPageLock = async () => null,
  renderControlMonitor = () => undefined,
  renderJobMonitor = () => undefined,
  setCurrentControlRun = () => undefined,
  setPendingApproval = () => undefined
} = {}) {
  if (!browserJobStore) {
    throw new Error("createSidePanelBrowserJobController requires browserJobStore.");
  }

  let historyLoadState = "loading";
  let historyLoad = null;
  const getHistoryLoadState = () => historyLoadState;
  const setHistoryLoadState = (state) => {
    historyLoadState = state;
    renderJobMonitor();
    onHistoryLoadStateChange(state);
  };

  const loadBrowserJobs = () => {
    if (historyLoad) return historyLoad;
    // Install the shared promise before rendering, so even reentrant requests
    // use this one normal hydration/recovery path.
    historyLoad = Promise.resolve().then(async () => {
      let recovered;
      try {
        await browserJobStore.hydrate();
        if (browserJobStore.isHistoryReadBlocked?.()) {
          setHistoryLoadState("error");
          return [];
        }
        recovered = await browserJobStore.recoverInterruptedJobs({
          from: ["running", "approval"],
          to: "paused",
          reason: "Recovered after browser host reload. Use /resume <job> to continue from persisted step history."
        });
      } catch {
        setHistoryLoadState("error");
        return [];
      }
      setHistoryLoadState("ready");
      if (recovered.length) {
        await addMessage(
          "system",
          `Recovered ${recovered.length} interrupted browser job${recovered.length === 1 ? "" : "s"} after reload. Use /resume <job> to continue from persisted step history.`
        );
      }
      return recovered;
    }).finally(() => { historyLoad = null; });
    setHistoryLoadState("loading");
    return historyLoad;
  };

  const createBrowserJob = async ({ existingJob = null, goal, planner = "observe-act-verify-loop", summary = "", status = "running" }) => {
    const historyFailureMessage = "Browser job history could not be loaded. No browser job was started.";
    if (browserJobStore.isHistoryReadBlocked?.()) {
      throw new Error(historyFailureMessage);
    }
    const pageLock = await prepareBrowserJobPageLock({ goal, existingJob, status });
    if (existingJob?.id) {
      await browserJobStore.activateJob(existingJob.id);
      const updated = await browserJobStore.updateJob(existingJob.id, {
        allowHumanStopOverride: true,
        status,
        planner,
        summary,
        pageLock,
        preflightDecision: consumeNextControlPreflightDecision() ?? existingJob.preflightDecision ?? null
      });
      if (browserJobStore.isHistoryReadBlocked?.()) {
        throw new Error(historyFailureMessage);
      }
      renderJobMonitor();
      return updated ?? existingJob;
    }
    const job = await browserJobStore.createJob({
      activate: status !== "queued",
      goal,
      planner,
      summary,
      pageLock,
      preflightDecision: consumeNextControlPreflightDecision(),
      status
    });
    // The store may resolve null when admission is blocked; return a job or reject.
    if (job === null) {
      throw new Error(historyFailureMessage);
    }
    renderJobMonitor();
    return job;
  };

  const updateBrowserJob = async (jobId, patch) => {
    const updated = await browserJobStore.updateJob(jobId, patch);
    renderJobMonitor();
    return updated;
  };

  const focusBrowserJobRun = async (jobId) => {
    const focusedJob = await browserJobStore.activateJob(jobId);
    if (focusedJob) {
      await activateJobTab(focusedJob);
    }
    const nextRun = focusedJob ? {
      artifacts: Array.isArray(focusedJob.artifacts) ? focusedJob.artifacts : [],
      completedAt: focusedJob.completedAt ?? null,
      goal: focusedJob.goal,
      id: focusedJob.id,
      pageLock: focusedJob.pageLock ?? null,
      planner: focusedJob.planner,
      startedAt: focusedJob.timing?.startedAt ?? focusedJob.createdAt,
      status: focusedJob.status,
      steps: Array.isArray(focusedJob.steps) ? focusedJob.steps : [],
      summary: focusedJob.summary,
      timing: focusedJob.timing ?? {}
    } : getCurrentControlRun();
    setCurrentControlRun(nextRun);
    setPendingApproval(focusedJob?.pendingApproval ?? null);
    renderControlMonitor();
    renderJobMonitor();
    return focusedJob;
  };

  return {
    createBrowserJob,
    focusBrowserJobRun,
    getHistoryLoadState,
    loadBrowserJobs,
    updateBrowserJob
  };
}
