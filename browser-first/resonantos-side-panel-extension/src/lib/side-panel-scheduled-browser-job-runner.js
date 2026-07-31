import { createAgentControlRunner } from "./agent-control-runner.js";

export function createSidePanelScheduledBrowserJobRunner({
  activateJobTab = async () => undefined,
  addMessage = async () => undefined,
  approvalBoundaryForStep,
  browserJobStore,
  chromeApi,
  controlStepLabel,
  createAgentControlRunnerFactory = createAgentControlRunner,
  executeControlStep = async () => ({ ok: false, error: "No step executor configured." }),
  getControlledTabId = () => null,
  getCurrentControlRun = () => null,
  getLastSnapshot = () => null,
  isReadableBrowserTab = () => false,
  readActivePage = async () => null,
  renderControlMonitor = () => undefined,
  renderJobMonitor = () => undefined,
  requestNextControlAction = async () => ({ type: "done" }),
  saveBrowserJobReportToArchive = async () => null,
  setActivity = () => undefined,
  setControlledTabId = () => undefined,
  setCurrentControlRun = () => undefined,
  setLastSnapshot = () => undefined,
  setPageControlOverlay = async () => undefined,
  setPendingApproval = () => undefined,
  setStatus = () => undefined,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  taskConsentStore,
  updateBrowserJob = async () => undefined,
  windowRef = globalThis,
  withBrowserActionLock = async (task) => task()
} = {}) {
  if (!browserJobStore) {
    throw new Error("createSidePanelScheduledBrowserJobRunner requires browserJobStore.");
  }

  const observeQueuedJobPage = async (job, { onSnapshot = null } = {}) => withBrowserActionLock(async () => {
    await activateJobTab(job);
    setActivity("reading", "Observing job page", job.goal);
    const response = await readActivePage({ announce: false }).catch(() => null);
    const snapshot = response?.snapshot ?? getLastSnapshot();
    const tabs = await chromeApi?.tabs?.query?.({}).catch(() => []) ?? [];
    if (snapshot && typeof onSnapshot === "function") {
      onSnapshot(snapshot);
    }
    return snapshot ? {
      ...snapshot,
      tabs: tabs.filter(isReadableBrowserTab).slice(0, 30).map((tab) => ({
        active: Boolean(tab.active),
        controlled: tab.id === getControlledTabId(),
        id: tab.id,
        title: tab.title || "",
        url: tab.url || ""
      }))
    } : null;
  });

  const executeQueuedJobStep = async (job, step, { beforeExecute = null } = {}) => withBrowserActionLock(async () => {
    const latestJob = browserJobStore.findJob(job?.id);
    if (["paused", "cancelled"].includes(latestJob?.status)) {
      throw new Error(`Browser job ${job.id} is ${latestJob.status}; scheduler stopped browser actions.`);
    }
    await activateJobTab(job);
    if (typeof beforeExecute === "function") {
      beforeExecute();
    }
    return executeControlStep(step);
  });

  const runScheduledBrowserJob = async (job) => {
    const scopedNextActionOverride = typeof windowRef.__resonantosNextActionOverride === "function"
      ? windowRef.__resonantosNextActionOverride
      : null;
    let localRun = {
      id: job.id,
      goal: job.goal,
      planner: job.planner,
      startedAt: new Date().toISOString(),
      status: "running",
      summary: job.summary,
      artifacts: Array.isArray(job.artifacts) ? job.artifacts : [],
      pageLock: job.pageLock,
      steps: Array.isArray(job.steps) ? job.steps : []
    };
    let localLastSnapshot = null;
    let localApproval = null;
    const syncFocusedLocalRun = () => {
      if (browserJobStore.getActiveJobId() === job.id) {
        setCurrentControlRun(localRun);
        setPendingApproval(localApproval);
        renderControlMonitor();
      }
      renderJobMonitor();
    };
    const persistLocalRun = async (patch = {}) => {
      const persisted = browserJobStore.findJob(job.id);
      const requestedStatus = patch.status ?? localRun.status ?? "running";
      const preservedHumanStopStatus = ["cancelled", "paused"].includes(persisted?.status) && !["cancelled", "paused"].includes(requestedStatus)
        ? persisted.status
        : "";
      localRun = {
        ...localRun,
        ...patch,
        status: preservedHumanStopStatus || requestedStatus
      };
      await updateBrowserJob(job.id, {
        artifacts: localRun.artifacts,
        planner: localRun.planner,
        status: localRun.status ?? "running",
        steps: localRun.steps,
        summary: localRun.summary
      });
    };
    const localRunner = createAgentControlRunnerFactory({
      addMessage,
      appendControlStep: (step) => {
        const record = {
          ...step,
          state: "pending",
          updatedAt: new Date().toISOString()
        };
        localRun = { ...localRun, steps: [...localRun.steps, record] };
        void persistLocalRun();
        syncFocusedLocalRun();
        return localRun.steps.length - 1;
      },
      approvalBoundaryForStep,
      controlStepLabel,
      createBrowserJob: async () => job,
      executeControlStep: (step) => executeQueuedJobStep(job, step, {
        beforeExecute: () => {
          setControlledTabId(job.pageLock?.tabId ?? getControlledTabId());
          setLastSnapshot(null);
        }
      }),
      finishControlRun: (status, artifact = null) => {
        localRun = {
          ...localRun,
          status,
          completedAt: new Date().toISOString(),
          artifacts: artifact ? [...localRun.artifacts, artifact] : localRun.artifacts
        };
        void persistLocalRun({
          status,
          artifacts: localRun.artifacts
        });
        if (browserJobStore.getActiveJobId() === job.id) {
          void setPageControlOverlay(false, "", "returning");
        }
        syncFocusedLocalRun();
      },
      getActiveJobId: () => job.id,
      getActiveJobStatus: () => browserJobStore.findJob(job.id)?.status ?? null,
      getCurrentControlRun: () => localRun,
      getLastSnapshot: () => localLastSnapshot,
      observeControlPage: () => observeQueuedJobPage(job, {
        onSnapshot: (snapshot) => {
          localLastSnapshot = snapshot;
        }
      }),
      renderControlMonitor: syncFocusedLocalRun,
      requestNextControlAction: (request) => requestNextControlAction({
        ...request,
        override: scopedNextActionOverride
      }),
      saveControlReportToArchive: async (_results, status) => {
        const latest = browserJobStore.findJob(job.id) ?? localRun;
        return saveBrowserJobReportToArchive({ ...latest, status }) ?? null;
      },
      setActivity,
      setPageControlOverlay: async (active, label, phase) => {
        if (browserJobStore.getActiveJobId() === job.id) {
          await setPageControlOverlay(active, label, phase);
        }
      },
      setPendingApproval: (approval) => {
        localApproval = approval;
        void updateBrowserJob(job.id, { pendingApproval: approval, status: approval ? "approval" : localRun.status });
        if (browserJobStore.getActiveJobId() === job.id) {
          setPendingApproval(approval);
        }
        syncFocusedLocalRun();
      },
      setStatus,
      sleep,
      startControlRun: ({ goal, plan }) => {
        localRun = {
          ...localRun,
          goal,
          planner: plan.source,
          summary: plan.summary,
          pageLock: plan.pageLock ?? localRun.pageLock,
          artifacts: Array.isArray(plan.artifacts) ? plan.artifacts : localRun.artifacts,
          steps: Array.isArray(plan.steps) ? plan.steps : localRun.steps
        };
        syncFocusedLocalRun();
      },
      taskConsentForStep: async ({ goal }) => {
        const consent = await taskConsentStore.consentFor({
          siteKey: job.pageLock?.siteKey,
          goal
        });
        if (consent?.mode === "allow-once") {
          await taskConsentStore.consumeTaskConsent?.({
            siteKey: consent.siteKey,
            taskClass: consent.taskClass,
            reason: `Consumed by scheduled safe approval retry for: ${goal}`,
            source: "browser-job-runner"
          });
        }
        return consent;
      },
      updateBrowserJob,
      updateControlRunArtifacts: (artifacts) => {
        localRun = { ...localRun, artifacts };
        void persistLocalRun({ artifacts });
        syncFocusedLocalRun();
      },
      updateControlStep: (index, state, note = "", details = {}) => {
        const steps = [...localRun.steps];
        if (!steps[index]) return;
        steps[index] = {
          ...steps[index],
          details: { ...(steps[index].details ?? {}), ...details },
          note,
          state,
          updatedAt: new Date().toISOString()
        };
        localRun = { ...localRun, steps };
        void persistLocalRun({ steps });
        syncFocusedLocalRun();
      }
    });
    await addMessage("system", `Browser job ${job.id} started in the scheduler.\nGoal: ${job.goal}`);
    const result = await localRunner.continueControlLoop({
      goal: job.goal,
      history: [],
      results: [],
      startIndex: 0,
      maxSteps: 12
    });
    if (localApproval && browserJobStore.getActiveJobId() !== job.id) {
      await addMessage("system", `Browser job ${job.id} needs approval. Focus the job in Browser Jobs to review the pending action.`);
    }
    return result;
  };

  return {
    executeQueuedJobStep,
    observeQueuedJobPage,
    runScheduledBrowserJob
  };
}
