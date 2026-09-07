export interface AddonWorkRegistry {
  begin(addonId: string): () => void;
  inFlight(addonId: string): number;
  stopRunningWork(input: { addonId: string }): Promise<{ stopped: boolean; detail?: string }>;
}

const runningWorkDetail =
  "Work for this add-on is still running in the desktop shell. Wait for it to finish, then uninstall.";

export const createAddonWorkRegistry = (): AddonWorkRegistry => {
  const counts = new Map<string, number>();

  return {
    begin(addonId) {
      counts.set(addonId, (counts.get(addonId) ?? 0) + 1);
      let ended = false;
      return () => {
        if (ended) {
          return;
        }
        ended = true;
        const nextCount = Math.max(0, (counts.get(addonId) ?? 0) - 1);
        if (nextCount === 0) {
          counts.delete(addonId);
        } else {
          counts.set(addonId, nextCount);
        }
      };
    },
    inFlight(addonId) {
      return counts.get(addonId) ?? 0;
    },
    async stopRunningWork({ addonId }) {
      if ((counts.get(addonId) ?? 0) > 0) {
        return { stopped: false, detail: runningWorkDetail };
      }
      return { stopped: true };
    },
  };
};

export const addonWorkRegistry: AddonWorkRegistry = createAddonWorkRegistry();

export const withAddonWork = async <T>(
  registry: AddonWorkRegistry,
  addonId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const end = registry.begin(addonId);
  try {
    return await fn();
  } finally {
    end();
  }
};
