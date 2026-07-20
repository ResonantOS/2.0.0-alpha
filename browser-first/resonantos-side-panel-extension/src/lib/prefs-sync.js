// ResonantOS extension preference sync.
//
// The bridge on the Pi stores a JSON document at
// GET/POST /settings/extension-prefs. This module keeps that document in
// sync with a selected set of local chrome.storage keys so a user who
// configures their model defaults, augmentor persona, theme, etc. on one
// machine (the Pi's own browser) sees the same defaults the next time
// they open ResonantOS on a Mac/Windows box.
//
// Wire model:
//   - On startup, GET /settings/extension-prefs. For each synced key, compare
//     the local value's `updatedAt` timestamp with the bridge's. Whichever
//     is newer wins. If bridge wins, write it back to local storage so the
//     rest of the extension picks it up on its next render.
//   - On chrome.storage.onChanged, if one of the synced keys changed, POST
//     the merged document back to the bridge (debounced 800ms).
//
// This is intentionally additive: it never deletes local keys the user
// has set on a particular machine, and it only writes back what it
// received from the bridge (no data exfiltration; everything the user
// sets locally is also pushed back).
//
// `syncedSourceKeys` enumerates which chrome.storage keys travel with the
// bridge. Add new keys there to extend coverage; this module does not need
// to know about the values themselves.

const PUSH_DEBOUNCE_MS = 800;
const PREFS_STORAGE_KEY = "resonantosSyncedPrefs";

const DEFAULT_SYNCED_KEYS = [
  "augmentorUserProfile",
  "augmentorConfig",
  "augmentorModel",
  "augmentorThinkingDepth",
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestampOf(value) {
  // Each synced local value may carry a `updatedAt` ms timestamp; otherwise
  // treat the value as "local origin unknown" and assume it could be newer
  // than anything on the bridge.
  if (isPlainObject(value) && Number.isFinite(Number(value.updatedAt))) {
    return Number(value.updatedAt);
  }
  return Number.POSITIVE_INFINITY;
}

function shouldTakeRemote(remote, local) {
  if (remote === undefined) return false;
  if (local === undefined) return true;
  return timestampOf(remote) > timestampOf(local);
}

async function readLocalValues(storage, keys) {
  if (!storage?.get) return {};
  try {
    const result = await storage.get(keys);
    // Normalize: chrome.storage.get returns `{}` for any keys that are
    // absent. Collapse that to a real undefined for each key so callers
    // can tell "not set locally" from "explicitly set to a value".
    const out = {};
    for (const key of keys) {
      if (result && Object.prototype.hasOwnProperty.call(result, key)) {
        out[key] = result[key];
      } else {
        out[key] = undefined;
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function writeLocalValue(storage, key, value) {
  if (!storage?.set) return;
  try {
    await storage.set({ [key]: value });
  } catch {
    /* ignore — quota, locked storage, etc. */
  }
}

async function fetchRemotePrefs(getBridge) {
  try {
    const bridge = typeof getBridge === "function" ? getBridge : null;
    if (typeof bridge() !== "function") {
      return { ok: false, prefs: {}, error: "no-bridge" };
    }
    const result = await bridge()("/settings/extension-prefs", { method: "GET" });
    return { ok: true, prefs: result?.prefs ?? {}, source: result?.source ?? "stored" };
  } catch (error) {
    return { ok: false, prefs: {}, error: error?.message ?? String(error) };
  }
}

async function pushPrefs(getBridge, prefs) {
  try {
    const bridge = typeof getBridge === "function" ? getBridge : null;
    if (typeof bridge() !== "function") {
      return { ok: false, error: "no-bridge" };
    }
    const result = await bridge()("/settings/extension-prefs", {
      method: "POST",
      body: { prefs },
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

export function createPrefsSync({ bridgeRequest, getBridgeRequest, storage, syncedKeys = DEFAULT_SYNCED_KEYS } = {}) {
  if (!bridgeRequest && !getBridgeRequest) {
    return {
      async hydrate() { return { ok: false, reason: "no-bridge" }; },
      push() { /* no-op */ },
      teardown() { /* no-op */ },
      getState() { return { lastPushAt: 0, lastPullAt: 0, lastError: "no-bridge" }; },
    };
  }
  if (!storage) {
    storage = typeof chrome !== "undefined" && chrome?.storage?.local
      ? chrome.storage.local
      : null;
  }

  // Resolver returns the current bridgeRequest on every call. We support
  // a getter so callers can mutate their bridgeRequest reference (e.g.
  // after rebinding to a loopback URL) without having to recreate
  // prefsSync. If a plain `bridgeRequest` was passed, we wrap it in a
  // getter for a consistent code path.
  const resolveBridgeRequest = typeof getBridgeRequest === "function"
    ? getBridgeRequest
    : () => bridgeRequest;

  const state = {
    lastPushAt: 0,
    lastPullAt: 0,
    lastError: null,
    lastSource: null,
    pushing: false,
    pending: false,
  };

  let pushTimer = null;
  let pushInflight = false;
  let pushQueued = false;
  let listener = null;

  function nowMs() {
    return Date.now();
  }

  function schedulePush() {
    state.pending = true;
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void flush();
    }, PUSH_DEBOUNCE_MS);
  }

  async function flush() {
    if (pushInflight) {
      pushQueued = true;
      return;
    }
    pushInflight = true;
    state.pending = false;
    try {
      const local = await readLocalValues(storage, syncedKeys);
      const prefs = { ...local, _meta: { pushedAt: nowMs(), version: 1 } };
      const result = await pushPrefs(resolveBridgeRequest, prefs);
      if (result.ok) {
        state.lastPushAt = nowMs();
        state.lastError = null;
      } else {
        state.lastError = result.error;
      }
    } finally {
      pushInflight = false;
      if (pushQueued) {
        pushQueued = false;
        void flush();
      } else if (state.pending) {
        schedulePush();
      }
    }
  }

  async function hydrate() {
    const remote = await fetchRemotePrefs(resolveBridgeRequest);
    state.lastPullAt = nowMs();
    if (!remote.ok) {
      state.lastError = remote.error;
      return { ok: false, reason: remote.error };
    }
    state.lastSource = remote.source;
    const local = await readLocalValues(storage, syncedKeys);
    let wroteAny = false;
    for (const key of syncedKeys) {
      const remoteValue = remote.prefs?.[key];
      const localValue = local?.[key];
      if (shouldTakeRemote(remoteValue, localValue)) {
        await writeLocalValue(storage, key, remoteValue);
        wroteAny = true;
      }
    }
    // If we have nothing locally yet, push the (empty) local doc up so the
    // bridge learns about this machine's existence.
    if (wroteAny || !local || Object.keys(local).length === 0) {
      schedulePush();
    }
    return { ok: true, source: remote.source, wroteAny };
  }

  function install() {
    if (!storage?.onChanged?.addListener) return () => {};
    listener = (changes, area) => {
      if (area !== "local") return;
      for (const key of Object.keys(changes ?? {})) {
        if (syncedKeys.includes(key)) {
          schedulePush();
          break;
        }
      }
    };
    storage.onChanged.addListener(listener);
    return () => {
      if (listener && storage?.onChanged?.removeListener) {
        storage.onChanged.removeListener(listener);
      }
      listener = null;
    };
  }

  function teardown() {
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    if (listener && storage?.onChanged?.removeListener) {
      storage.onChanged.removeListener(listener);
    }
    listener = null;
  }

  return {
    hydrate,
    push: schedulePush,
    flush,
    install,
    teardown,
    getState: () => ({ ...state }),
    syncedKeys: [...syncedKeys],
  };
}

export const PREFS_SYNC_STORAGE_KEY = PREFS_STORAGE_KEY;
