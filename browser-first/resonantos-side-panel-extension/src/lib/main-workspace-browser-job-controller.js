import { mutateBrowserJobStorage } from "./browser-job-store.js";

export function createMainWorkspaceBrowserJobController({
  addSystemMessage = async () => undefined,
  afterChange = () => undefined,
  now = () => new Date().toISOString(),
  openSidebar = async () => undefined,
  storage,
  storageKeys
} = {}) {
  const browserJobsKey = storageKeys?.browserJobs ?? "augmentorBrowserJobs";
  const activeBrowserJobKey = storageKeys?.activeBrowserJob ?? "augmentorActiveBrowserJob";
  const pendingSidebarPromptKey = storageKeys?.pendingSidebarPrompt ?? "augmentorPendingSidebarPrompt";

  const readJobs = async () => {
    const stored = await storage?.get?.([
      browserJobsKey,
      activeBrowserJobKey
    ]).catch(() => ({}));
    return {
      activeJobId: String(stored?.[activeBrowserJobKey] ?? ""),
      jobs: Array.isArray(stored?.[browserJobsKey]) ? stored[browserJobsKey] : []
    };
  };

  const openMonitor = async () => {
    await storage?.set?.({
      [pendingSidebarPromptKey]: {
        createdAt: now(),
        prompt: "/jobs"
      }
    }).catch(() => undefined);
    await openSidebar();
  };

  const routeJobCommand = async (job, command) => {
    try {
      const result = await mutateBrowserJobStorage({ storage, storageKeys, now,
        mutation: { type: "focus", jobId: job?.id, command } });
      if (!result.changed) return false;
    } catch (error) {
      await addSystemMessage(error.code === "unsafe-focus"
        ? "This saved browser job cannot be focused safely. Reopen the side panel to reload and repair browser job history."
        : "Browser job history could not be updated safely.");
      return false;
    }
    afterChange();
    await openSidebar();
    return true;
  };

  const focusJob = (job) => routeJobCommand(job, "jobs focus");
  const pauseJob = (job) => routeJobCommand(job, "pause");
  const continueJob = (job) => routeJobCommand(job, "continue");

  const cancelJob = async (job) => {
    if (!job?.id) return false;
    let result;
    try {
      result = await mutateBrowserJobStorage({ storage, storageKeys, now,
        mutation: { type: "cancel", jobId: job.id } });
    } catch {
      await addSystemMessage("Browser job history could not be updated safely.");
      return false;
    }
    if (!result.changed) return false;
    await addSystemMessage(`Stopped browser job ${result.job.id}: ${result.job.goal || "Untitled browser task"}`);
    afterChange();
    return true;
  };

  return {
    cancelJob,
    continueJob,
    focusJob,
    openMonitor,
    pauseJob,
    readJobs
  };
}
