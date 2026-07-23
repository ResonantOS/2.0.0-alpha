import assert from "node:assert/strict";
import test from "node:test";

import { retryOwnedShutdown } from "../host/owned-shutdown-retry.mjs";

test("owned shutdown retries without abandoning the process until cleanup succeeds", async () => {
  const failures = [];
  const sleeps = [];
  let attempts = 0;

  const result = await retryOwnedShutdown({
    retryDelayMs: 25,
    shutdown: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`cleanup-${attempts}`);
    },
    sleep: async (delay) => {
      sleeps.push(delay);
    },
    onFailure(error, failureCount) {
      failures.push([error.message, failureCount]);
    },
  });

  assert.deepEqual(result, { failures: 2 });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [25, 25]);
  assert.deepEqual(failures, [["cleanup-1", 1], ["cleanup-2", 2]]);
});

test("owned shutdown observers cannot interrupt cleanup retries", async () => {
  let attempts = 0;
  const result = await retryOwnedShutdown({
    shutdown: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("first failure");
    },
    sleep: async () => {},
    onFailure() {
      throw new Error("observer failure");
    },
  });

  assert.deepEqual(result, { failures: 1 });
  assert.equal(attempts, 2);
});
