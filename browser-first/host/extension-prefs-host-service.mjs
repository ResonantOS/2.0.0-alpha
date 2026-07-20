// ResonantOS bridge: extension preferences sync service.
//
// Stores user preferences set inside the extension (model defaults, appearance,
// work-context flags, etc.) on the bridge host so a user opening ResonantOS
// on a different machine — Linux, macOS, Windows — sees the same defaults.
//
//   GET  /settings/extension-prefs   — return the current prefs document
//   POST /settings/extension-prefs   — overwrite the prefs document
//
// The prefs file lives at <userRoot>/ExtensionPrefs/extension-prefs.json and
// is debounced/coalesced via an in-memory pending-write flag. Multiple rapid
// updates from the same client collapse into a single disk write.
//
// Reads do not require a capability token. Writes are capability-gated because
// they persist host-side user preferences from the extension.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PREFS_DIRNAME = "ExtensionPrefs";
const PREFS_FILENAME = "extension-prefs.json";

const MAX_PREFS_BYTES = 1_000_000; // 1 MB; soft limit on prefs document size

function prefsFilePath(userRoot) {
  return path.join(userRoot(), PREFS_DIRNAME, PREFS_FILENAME);
}

async function readPrefsDocument(userRoot) {
  const filePath = prefsFilePath(userRoot);
  if (!existsSync(filePath)) {
    return { ok: true, prefs: {}, source: "missing", path: filePath };
  }
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      prefs: {},
      source: "error",
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let parsed;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    return {
      ok: false,
      prefs: {},
      source: "error",
      path: filePath,
      error: `Prefs document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      prefs: {},
      source: "error",
      path: filePath,
      error: "Prefs document must be a JSON object.",
    };
  }
  return { ok: true, prefs: parsed, source: "stored", path: filePath };
}

export function createExtensionPrefsHostService({ userRoot } = {}) {
  function required(name, value) {
    if (!value) {
      throw new Error(`Extension prefs host service missing dependency: ${name}`);
    }
    return value;
  }
  required("userRoot", userRoot);

  let writeChain = Promise.resolve();
  let pendingPrefs = null;
  let pendingTimer = null;

  function scheduleWrite(prefs) {
    pendingPrefs = prefs;
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const nextPrefs = pendingPrefs;
      pendingPrefs = null;
      writeChain = writeChain.then(async () => {
        const filePath = prefsFilePath(userRoot);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(
          filePath,
          `${JSON.stringify(nextPrefs, null, 2)}\n`,
          { mode: 0o600 },
        );
      }).catch((error) => {
        console.error(
          JSON.stringify({
            event: "resonantos.extension_prefs_write_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }, 150);
  }

  async function flushPendingWrites() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      if (pendingPrefs) {
        const nextPrefs = pendingPrefs;
        pendingPrefs = null;
        writeChain = writeChain.then(async () => {
          const filePath = prefsFilePath(userRoot);
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(
            filePath,
            `${JSON.stringify(nextPrefs, null, 2)}\n`,
            { mode: 0o600 },
          );
        });
      }
    }
    await writeChain;
  }

  async function executeReadExtensionPrefs() {
    const result = await readPrefsDocument(userRoot);
    return {
      prefs: result.prefs,
      source: result.source,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  async function executeWriteExtensionPrefs(payload) {
    const incoming = payload?.prefs;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return { ok: false, error: "Body must be { prefs: { ... } }." };
    }
    const serialized = JSON.stringify(incoming);
    if (serialized.length > MAX_PREFS_BYTES) {
      return {
        ok: false,
        error: `Prefs document is too large (${serialized.length} bytes; max ${MAX_PREFS_BYTES}).`,
      };
    }
    scheduleWrite(incoming);
    return { ok: true, accepted: true, bytes: serialized.length };
  }

  return {
    executeReadExtensionPrefs,
    executeWriteExtensionPrefs,
    flushPendingWrites,
    extensionPrefsRoutes: [
      { method: "GET", path: "/settings/extension-prefs", handler: executeReadExtensionPrefs },
      {
        method: "POST",
        path: "/settings/extension-prefs",
        requiredCapability: "extension-prefs-write",
        handler: executeWriteExtensionPrefs,
      },
    ],
  };
}
