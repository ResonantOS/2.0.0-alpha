// Intent citation: docs/architecture/ADR-004-chat-rail.md

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const keyedArray = (value: unknown): value is Array<Record<string, unknown> & { id: string }> =>
  Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.id === "string");

function rebaseValue(base: unknown, candidate: unknown, latest: unknown): unknown {
  if (equal(candidate, base)) return latest;
  if (keyedArray(base) && keyedArray(candidate) && keyedArray(latest)) {
    const baseById = new Map(base.map((entry) => [entry.id, entry]));
    const candidateById = new Map(candidate.map((entry) => [entry.id, entry]));
    const latestById = new Map(latest.map((entry) => [entry.id, entry]));
    const order = [...candidate.map((entry) => entry.id), ...latest.map((entry) => entry.id)]
      .filter((id, index, ids) => ids.indexOf(id) === index);
    return order.flatMap((id) => {
      const candidateEntry = candidateById.get(id);
      const baseEntry = baseById.get(id);
      const latestEntry = latestById.get(id);
      if (!candidateEntry) {
        if (!baseEntry) return latestEntry ? [latestEntry] : [];
        return equal(latestEntry, baseEntry) ? [] : [latestEntry];
      }
      if (!baseEntry) return [candidateEntry];
      return [rebaseValue(baseEntry, candidateEntry, latestEntry ?? baseEntry) as Record<string, unknown>];
    });
  }
  if (Array.isArray(candidate)) return candidate;
  if (!isRecord(base) || !isRecord(candidate) || !isRecord(latest)) return candidate;

  const keys = [...new Set([...Object.keys(base), ...Object.keys(candidate), ...Object.keys(latest)])];
  const rebased: Record<string, unknown> = { ...latest };
  for (const key of keys) {
    const baseValue = base[key];
    const candidateHas = Object.prototype.hasOwnProperty.call(candidate, key);
    const latestHas = Object.prototype.hasOwnProperty.call(latest, key);
    if (!candidateHas) {
      if (Object.prototype.hasOwnProperty.call(base, key) && (!latestHas || equal(latest[key], baseValue))) {
        delete rebased[key];
      }
      continue;
    }
    rebased[key] = rebaseValue(baseValue, candidate[key], latestHas ? latest[key] : baseValue);
  }
  return rebased;
}

/**
 * Reapply changes made from `base` onto the latest state after an async turn.
 * Unchanged candidate fields never overwrite edits made while the turn was
 * waiting; keyed collections (threads, providers, agents, etc.) merge by id.
 */
export function rebaseStateOntoLatest<T>(base: T, candidate: T, latest: T): T {
  return rebaseValue(base, candidate, latest) as T;
}
