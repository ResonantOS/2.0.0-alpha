function itemReference(url) {
  const match = String(url ?? "").match(/\/(?:issues|pull)\/(\d+)(?:$|[/?#])/);
  return match ? `#${match[1]}` : String(url ?? "unknown item");
}

export async function pollForRemoteResult(
  read,
  { attempts = 3, delayMs = 250, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await read();
    if (result) return result;
    if (attempt < attempts) await sleep(attempt * delayMs);
  }
  return null;
}

export async function runCompensatingWrites(operations) {
  const completed = [];

  for (const operation of operations) {
    try {
      await operation.apply();
      completed.push(operation);
    } catch (writeError) {
      const compensationErrors = [];

      if (operation.recover) {
        try {
          await operation.recover();
        } catch (recoveryError) {
          compensationErrors.push(recoveryError);
        }
      }

      // A failed response may follow a committed remote write, so compensate it too.
      for (const candidate of [operation, ...[...completed].reverse()]) {
        try {
          await candidate.compensate();
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
      }

      if (compensationErrors.length > 0) {
        throw new AggregateError(
          [writeError, ...compensationErrors],
          `Project sync write failed and ${compensationErrors.length} recovery or compensation operation(s) also failed.`,
          { cause: writeError },
        );
      }

      throw writeError;
    }
  }
}

export function assertProjectConfiguration(
  fields,
  { releaseScopes = [], areas = [], statuses = [] },
) {
  const requirements = [
    [fields.releaseScope, releaseScopes],
    [fields.area, areas],
    [fields.status, statuses],
  ];
  const missing = [];

  for (const [field, requiredOptions] of requirements) {
    const available = new Set((field?.options ?? []).map((option) => option.name));
    const absent = requiredOptions.filter((option) => !available.has(option));
    if (absent.length > 0) {
      missing.push(`${field?.name ?? "Unknown field"}: ${absent.join(", ")}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Project configuration is missing required options:\n${missing.join("\n")}`);
  }
}

export function assertNoManagedLabelConflicts(
  items,
  { scopeLabels, areaLabels },
) {
  const conflicts = [];

  for (const item of items) {
    const labels = new Set(item.labels ?? []);
    const scopeMatches = [...scopeLabels].filter((label) => labels.has(label));
    const areaMatches = [...areaLabels].filter((label) => labels.has(label));
    const problems = [];

    if (!item.releaseScope && scopeMatches.length > 1) {
      problems.push(`multiple managed scope labels (${scopeMatches.join(", ")})`);
    }
    if (!item.area && areaMatches.length > 1) {
      problems.push(`multiple managed area labels (${areaMatches.join(", ")})`);
    }
    if (problems.length) conflicts.push(`${itemReference(item.url)}: ${problems.join("; ")}`);
  }

  if (conflicts.length) {
    throw new Error(`Project sync preflight failed:\n${conflicts.join("\n")}`);
  }
}
