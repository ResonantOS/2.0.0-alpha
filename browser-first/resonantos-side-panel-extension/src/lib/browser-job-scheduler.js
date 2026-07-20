// Intent citation: docs/reference/CAPABILITY_MATRIX.md
// Owns the bounded supervisor for running multiple non-conflicting browser jobs.

const DEFAULT_MAX_CONCURRENT = 2;
const RESULT_JOB_STATUSES = new Set(["blocked", "approval", "failed", "cancelled", "paused", "completed"]);

function safeMaxConcurrent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENT;
  return Math.max(1, Math.min(8, Math.trunc(parsed)));
}

export function createBrowserJobScheduler({
  browserJobStore,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  now = () => new Date().toISOString(),
  onJobStarted = async () => undefined,
  onJobFinished = async () => undefined,
  onJobFailed = async () => undefined,
  runJob
}) {
  const running = new Map();
  let started = false;

  function schedulerState() {
    return browserJobStore.getSchedulerState({ maxConcurrent: safeMaxConcurrent(maxConcurrent) });
  }

  function activeJobIds() {
    return [...running.keys()];
  }

  async function settleJob(jobId, promise) {
    try {
      const result = await promise;
      const latestJob = browserJobStore.findJob?.(jobId);
      if (latestJob?.status === "running") {
        const resultStatus = RESULT_JOB_STATUSES.has(result?.status)
          ? result.status
          : result?.ok === false
            ? result?.approvalRequired ? "approval" : "blocked"
            : "completed";
        await browserJobStore.updateJob(jobId, {
          status: resultStatus
        });
      }
      await onJobFinished(jobId, result);
      return result;
    } catch (error) {
      const latestJob = browserJobStore.findJob?.(jobId);
      if (["paused", "cancelled"].includes(latestJob?.status)) {
        await onJobFinished(jobId, latestJob);
      } else {
        await browserJobStore.updateJob(jobId, {
          status: "failed",
          lastError: error instanceof Error ? error.message : String(error)
        });
        await onJobFailed(jobId, error);
      }
      return null;
    } finally {
      running.delete(jobId);
      if (started) {
        void tick();
      }
    }
  }

  async function startJob(jobSummary) {
    if (!jobSummary?.id || running.has(jobSummary.id)) return null;
    const job = browserJobStore.findJob(jobSummary.id);
    if (!job || job.status !== "queued") return null;
    if (!browserJobStore.getActiveJobId?.()) {
      await browserJobStore.activateJob?.(job.id);
    }
    const startedJob = await browserJobStore.updateJob(job.id, { status: "running" });
    await onJobStarted(startedJob);
    const execution = Promise.resolve().then(() => runJob(startedJob));
    running.set(job.id, execution);
    void settleJob(job.id, execution);
    return startedJob;
  }

  async function tick() {
    const state = schedulerState();
    const startedJobs = [];
    for (const job of state.runnableQueued ?? []) {
      if (running.size >= safeMaxConcurrent(maxConcurrent)) break;
      const startedJob = await startJob(job);
      if (startedJob) startedJobs.push(startedJob);
    }
    return {
      activeJobIds: activeJobIds(),
      schedulerState: schedulerState(),
      startedJobs
    };
  }

  function start() {
    started = true;
  }

  function stop() {
    started = false;
  }

  function isStarted() {
    return started;
  }

  return {
    activeJobIds,
    isStarted,
    schedulerState,
    start,
    stop,
    tick
  };
}
