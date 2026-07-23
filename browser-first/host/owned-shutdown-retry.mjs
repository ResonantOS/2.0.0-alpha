function requiredFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`Owned shutdown retry requires ${name}.`);
  }
  return value;
}

export async function retryOwnedShutdown({
  onFailure,
  retryDelayMs = 1_000,
  shutdown,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  const runShutdown = requiredFunction("shutdown", shutdown);
  const wait = requiredFunction("sleep", sleep);
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("Owned shutdown retry delay must be a non-negative number.");
  }

  let failures = 0;
  while (true) {
    try {
      await runShutdown();
      return { failures };
    } catch (error) {
      failures += 1;
      try {
        onFailure?.(error, failures);
      } catch {
        // Diagnostics cannot interrupt cleanup of an owned child process.
      }
      await wait(retryDelayMs);
    }
  }
}
