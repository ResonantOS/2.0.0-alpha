import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const LOOPBACK_HOSTNAME = "127.0.0.1";
const SERVER_USERNAME = "resonantos";
const MAX_START_ATTEMPTS = 5;
const MAX_TERMINATION_WAIT_MS = 30_000;
const EARLY_CANDIDATE_EXIT_CODE = "OPENCODE_EARLY_CANDIDATE_EXIT";
const CLOSED_PERMISSION_POLICY = JSON.stringify({
  "*": "ask",
  external_directory: "deny",
});
const SERVER_ANNOUNCEMENT_LIMIT = 4_096;
const SERVER_ANNOUNCEMENT_PATTERN = (
  /(?:^|\r?\n)opencode server listening on (http:\/\/127\.0\.0\.1:([0-9]{1,5}))\r?(?:\n|$)/
);

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new Error(`OpenCode ${name} dependency is required.`);
  }
  return value;
}

function publicState(state) {
  return Object.freeze({ state });
}

function earlyCandidateExitError() {
  const error = new Error("OpenCode server exited before becoming ready.");
  error.code = EARLY_CANDIDATE_EXIT_CODE;
  return error;
}

function isEarlyCandidateExitError(error) {
  return error?.code === EARLY_CANDIDATE_EXIT_CODE;
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function unwrapSdkData(result) {
  let value = result;
  for (let depth = 0; depth < 2; depth += 1) {
    if (
      value === null
      || typeof value !== "object"
      || !Object.hasOwn(value, "data")
    ) {
      break;
    }
    value = value.data;
  }
  return value;
}

function childEnvironment(environment, configDirectory, password) {
  const supplied = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (
      key === "OPENCODE_CONFIG_DIR"
      || key === "OPENCODE_SERVER_USERNAME"
      || key === "OPENCODE_SERVER_PASSWORD"
      || key.startsWith("RESONANTOS_BROWSER_FIRST_")
    ) {
      continue;
    }
    if (value !== undefined) supplied[key] = value;
  }
  return {
    ...supplied,
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PERMISSION: CLOSED_PERMISSION_POLICY,
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
  };
}

function validateLoopbackBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("OpenCode SDK client requires a valid loopback base URL.");
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== LOOPBACK_HOSTNAME
    || !parsed.port
    || parsed.pathname !== "/"
  ) {
    throw new Error("OpenCode SDK client requires a valid loopback base URL.");
  }
}

export async function allocateLoopbackPort({
  createServerImpl = createServer,
} = {}) {
  const server = createServerImpl();
  return new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    server.once("error", fail);
    server.listen({
      host: LOOPBACK_HOSTNAME,
      port: 0,
      exclusive: true,
    }, () => {
      server.removeListener("error", fail);
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
          reject(new Error("OpenCode loopback port allocation returned an invalid port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function readOpencodeServerBaseUrl(child, {
  timeoutMs = 12_000,
} = {}) {
  const stdout = child?.stdout;
  if (
    !stdout
    || typeof stdout.on !== "function"
    || typeof stdout.removeListener !== "function"
  ) {
    throw new Error("OpenCode server did not expose its owned loopback address.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OpenCode server address timeout is invalid.");
  }

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("OpenCode server did not announce its loopback address in time."));
    }, timeoutMs);
    const onExit = () => {
      finish(new Error("OpenCode server exited before announcing its loopback address."));
    };
    const onData = (chunk) => {
      buffer += Buffer.from(chunk).toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > SERVER_ANNOUNCEMENT_LIMIT) {
        finish(new Error("OpenCode server emitted an invalid address announcement."));
        return;
      }
      const match = SERVER_ANNOUNCEMENT_PATTERN.exec(buffer);
      if (!match) return;
      const port = Number(match[2]);
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
        finish(new Error("OpenCode server announced an invalid loopback port."));
        return;
      }
      finish(null, match[1]);
    };
    const finish = (error, baseUrl = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stdout.removeListener("data", onData);
      child.removeListener?.("exit", onExit);
      stdout.resume?.();
      if (error) reject(error);
      else resolve(baseUrl);
    };

    stdout.on("data", onData);
    child.once?.("exit", onExit);
  });
}

export function splitOpencodeModelIdentifier(identifier) {
  const value = typeof identifier === "string" ? identifier : "";
  const separator = value.indexOf("/");
  const providerID = separator > 0 ? value.slice(0, separator) : "";
  const id = separator > 0 ? value.slice(separator + 1) : "";
  if (
    value !== value.trim()
    || !providerID
    || !id
    || providerID !== providerID.trim()
    || id !== id.trim()
  ) {
    throw new Error("OpenCode model identifier must use provider/model.");
  }
  return { providerID, id };
}

export async function createOpencodeSdkClient({
  authorization,
  baseUrl,
  directory,
  loadSdk = () => import("@opencode-ai/sdk/v2"),
} = {}) {
  if (
    typeof authorization !== "string"
    || !authorization.startsWith("Basic ")
    || typeof directory !== "string"
    || !path.isAbsolute(directory)
  ) {
    throw new Error("OpenCode SDK client requires authenticated loopback access and an absolute directory.");
  }
  validateLoopbackBaseUrl(baseUrl);
  const sdk = await requireFunction(loadSdk, "SDK loader")();
  const createClient = requireFunction(
    sdk?.createOpencodeClient,
    "SDK createOpencodeClient",
  );
  const client = createClient({
    baseUrl,
    directory,
    headers: { Authorization: authorization },
    throwOnError: true,
  });

  return Object.freeze({
    async createSession({ model: modelIdentifier } = {}) {
      const model = splitOpencodeModelIdentifier(modelIdentifier);
      const result = await requireFunction(
        client?.v2?.session?.create,
        "v2 session.create",
      ).call(client.v2.session, {
        model,
        location: { directory },
      });
      const created = unwrapSdkData(result);
      return {
        sessionId: typeof created?.id === "string" ? created.id : "",
      };
    },

    async prompt({ sessionID, text } = {}) {
      const result = await requireFunction(
        client?.v2?.session?.prompt,
        "v2 session.prompt",
      ).call(client.v2.session, {
        sessionID,
        prompt: { text },
        delivery: "queue",
      });
      return unwrapSdkData(result);
    },

    async replyPermission({ sessionID, requestID, reply } = {}) {
      if (reply !== "once" && reply !== "reject") {
        throw new Error("OpenCode permission reply must be once or reject.");
      }
      const result = await requireFunction(
        client?.v2?.session?.permission?.reply,
        "v2 session.permission.reply",
      ).call(client.v2.session.permission, {
        sessionID,
        requestID,
        reply,
      });
      return unwrapSdkData(result);
    },

    async subscribeEvents({ signal } = {}) {
      if (!signal || typeof signal.aborted !== "boolean") {
        throw new Error("OpenCode event subscription requires an abort signal.");
      }
      const subscription = await requireFunction(
        client?.v2?.event?.subscribe,
        "v2 event.subscribe",
      ).call(client.v2.event, { signal });
      if (!subscription?.stream) {
        throw new Error("OpenCode v2 event subscription did not return a stream.");
      }
      return subscription.stream;
    },
  });
}

export function createOpencodeServerLifecycle({
  createClient = createOpencodeSdkClient,
  createConfigDirectory = () => mkdtemp(
    path.join(tmpdir(), "resonantos-opencode-config-"),
  ),
  fetchImpl = globalThis.fetch,
  randomPassword = () => randomBytes(32).toString("base64url"),
  readServerAddress = readOpencodeServerBaseUrl,
  removeConfigDirectory = (directory) => rm(directory, {
    force: true,
    recursive: true,
  }),
  sleep = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
  spawnImpl,
  maxStartAttempts = 3,
  pollMs = 100,
  readinessTimeoutMs = 12_000,
  readinessProbeTimeoutMs = 1_000,
  terminationGraceMs = 1_500,
  terminationKillTimeoutMs = 1_000,
} = {}) {
  requireFunction(createClient, "client factory");
  requireFunction(createConfigDirectory, "config directory factory");
  requireFunction(fetchImpl, "fetch");
  requireFunction(randomPassword, "password generator");
  requireFunction(readServerAddress, "server address reader");
  requireFunction(removeConfigDirectory, "config directory cleanup");
  requireFunction(sleep, "sleep");
  requireFunction(spawnImpl, "spawn");
  if (
    !Number.isSafeInteger(maxStartAttempts)
    || maxStartAttempts <= 0
    || maxStartAttempts > MAX_START_ATTEMPTS
  ) {
    throw new Error("OpenCode lifecycle start-attempt bound is invalid.");
  }
  if (
    !Number.isFinite(pollMs)
    || pollMs <= 0
    || !Number.isFinite(readinessTimeoutMs)
    || readinessTimeoutMs < 0
    || !Number.isFinite(readinessProbeTimeoutMs)
    || readinessProbeTimeoutMs <= 0
    || !Number.isFinite(terminationGraceMs)
    || terminationGraceMs <= 0
    || terminationGraceMs > MAX_TERMINATION_WAIT_MS
    || !Number.isFinite(terminationKillTimeoutMs)
    || terminationKillTimeoutMs <= 0
    || terminationKillTimeoutMs > MAX_TERMINATION_WAIT_MS
  ) {
    throw new Error("OpenCode lifecycle timing values are invalid.");
  }

  const records = new WeakMap();
  const observers = new Set();
  let active = null;
  let state = "stopped";

  function notifyExit(record) {
    const event = Object.freeze({
      state: "stopped",
      reason: "child-exit",
    });
    try {
      record.onExit?.(event);
    } catch {
      // A callback cannot block lifecycle cleanup.
    }
    for (const observer of [...observers]) {
      try {
        observer(event);
      } catch {
        // One observer cannot block cleanup or other observers.
      }
    }
  }

  async function waitForExit(record, timeoutMs) {
    if (record.exited) return true;
    let timeout;
    try {
      return await Promise.race([
        record.exitPromise.then(() => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function terminate(record) {
    if (!record.child || record.exited) return;
    if (active === record) state = "stopping";

    try {
      requireFunction(record.child.kill, "child-process kill").call(
        record.child,
        "SIGTERM",
      );
    } catch (error) {
      if (record.exited) return;
      state = "failed";
      throw new Error("OpenCode server SIGTERM request failed.", { cause: error });
    }
    if (await waitForExit(record, terminationGraceMs)) return;

    try {
      record.child.kill("SIGKILL");
    } catch (error) {
      if (record.exited) return;
      state = "failed";
      throw new Error("OpenCode server SIGKILL request failed.", { cause: error });
    }
    if (await waitForExit(record, terminationKillTimeoutMs)) return;

    state = "failed";
    throw new Error("OpenCode server did not terminate after SIGKILL.");
  }

  async function cleanup(record, { kill = false, notify = false } = {}) {
    if (!record) {
      if (!active) state = "stopped";
      return;
    }
    if (record.cleanupPromise) {
      await record.cleanupPromise;
      return;
    }
    const cleanupPromise = (async () => {
      if (kill && record.child && !record.exited) {
        await terminate(record);
      }
      if (record.child && !record.exited) {
        await record.exitPromise;
      }
      if (active === record) active = null;
      state = "stopped";
      if (record.child && record.onChildExit) {
        if (typeof record.child.off === "function") {
          record.child.off("exit", record.onChildExit);
        } else {
          record.child.removeListener?.("exit", record.onChildExit);
        }
      }
      try {
        if (record.configDirectory) {
          await removeConfigDirectory(record.configDirectory);
        }
      } finally {
        record.authorization = "";
        record.baseUrl = "";
        record.client = null;
        record.configDirectory = "";
        record.directory = "";
        record.password = "";
      }
      if (notify) notifyExit(record);
    })();
    record.cleanupPromise = cleanupPromise;
    try {
      await cleanupPromise;
    } catch (error) {
      if (record.cleanupPromise === cleanupPromise && !record.exited) {
        record.cleanupPromise = null;
      }
      throw error;
    }
  }

  async function authenticatedProbe(record, authorization, remainingMs) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(readinessProbeTimeoutMs, Math.max(1, remainingMs)),
    );
    try {
      const result = await fetchImpl(`${record.baseUrl}/doc`, {
        headers: { Authorization: authorization },
        signal: controller.signal,
      });
      return Number.isInteger(result?.status) ? result.status : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function authenticatedReady(record, deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const ownedStatus = await authenticatedProbe(
      record,
      record.authorization,
      remainingMs,
    );
    return ownedStatus !== null && ownedStatus >= 200 && ownedStatus < 300;
  }

  async function waitUntilReady(record) {
    const deadline = Date.now() + readinessTimeoutMs;
    while (true) {
      if (record.exited) {
        throw earlyCandidateExitError();
      }
      if (await authenticatedReady(record, deadline)) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(pollMs, remainingMs));
    }
    if (record.exited) {
      throw earlyCandidateExitError();
    }
    throw new Error("OpenCode server did not become ready in time.");
  }

  async function startAttempt({
    command,
    cwd,
    env,
    onExit,
  }) {
    state = "starting";
    let configDirectory = "";
    let record = null;
    try {
      configDirectory = await createConfigDirectory();
      if (typeof configDirectory !== "string" || !path.isAbsolute(configDirectory)) {
        throw new Error("OpenCode config directory factory returned an invalid path.");
      }
      const password = randomPassword();
      if (typeof password !== "string" || !password) {
        throw new Error("OpenCode password generator returned an invalid credential.");
      }
      const authorization = basicAuthorization(SERVER_USERNAME, password);
      const child = spawnImpl(command, [
        "serve",
        "--pure",
        "--hostname",
        LOOPBACK_HOSTNAME,
        "--port",
        "0",
      ], {
        cwd,
        env: childEnvironment(env, configDirectory, password),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (!child || typeof child !== "object") {
        throw new Error("OpenCode spawn did not return a child process.");
      }
      const handle = Object.freeze({
        process: child,
        redactSensitiveText(value, replacement = "[redacted]") {
          let text = typeof value === "string" ? value : "";
          const substitute = typeof replacement === "string"
            ? replacement
            : "[redacted]";
          for (const secret of [record?.authorization, record?.password]) {
            if (typeof secret === "string" && secret.length >= 4) {
              text = text.split(secret).join(substitute);
            }
          }
          return text;
        },
      });
      let resolveExit;
      record = {
        authorization,
        baseUrl: "",
        child,
        cleanupPromise: null,
        client: null,
        configDirectory,
        directory: cwd,
        exited: false,
        exitPromise: new Promise((resolve) => {
          resolveExit = resolve;
        }),
        handle,
        onChildExit: null,
        onExit,
        password,
        ready: false,
      };
      records.set(handle, record);
      record.onChildExit = () => {
        record.exited = true;
        resolveExit();
        void cleanup(record, { notify: record.ready }).catch(() => {
          state = "failed";
        });
      };
      child.once?.("exit", record.onChildExit);
      active = record;

      record.baseUrl = await readServerAddress(child, {
        timeoutMs: readinessTimeoutMs,
      });
      validateLoopbackBaseUrl(record.baseUrl);
      await waitUntilReady(record);
      if (record.exited) {
        throw earlyCandidateExitError();
      }
      record.ready = true;
      state = "running";
      return handle;
    } catch (error) {
      if (record) {
        await cleanup(record, { kill: !record.exited });
      } else {
        active = null;
        state = "stopped";
        if (configDirectory) await removeConfigDirectory(configDirectory);
      }
      throw error;
    }
  }

  async function start({
    command,
    cwd,
    env = {},
    onExit,
  } = {}) {
    if (state !== "stopped" || active) {
      throw new Error("OpenCode server lifecycle is already active.");
    }
    if (
      typeof command !== "string"
      || !command.trim()
      || !path.isAbsolute(command)
    ) {
      throw new Error("OpenCode runtime is not available to start.");
    }
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
      throw new Error("OpenCode server requires an approved absolute working directory.");
    }
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw new Error("OpenCode server requires a scoped environment object.");
    }
    if (onExit !== undefined && typeof onExit !== "function") {
      throw new Error("OpenCode lifecycle onExit must be a function.");
    }

    for (let attempt = 1; attempt <= maxStartAttempts; attempt += 1) {
      try {
        return await startAttempt({ command, cwd, env, onExit });
      } catch (error) {
        if (!isEarlyCandidateExitError(error) || attempt === maxStartAttempts) {
          throw error;
        }
        if (state !== "stopped" || active) {
          throw new Error("OpenCode candidate cleanup did not permit a safe retry.", {
            cause: error,
          });
        }
      }
    }
    throw new Error("OpenCode server lifecycle exhausted its start-attempt bound.");
  }

  async function createOwnedClient(handle) {
    const record = records.get(handle);
    if (!record || active !== record || state !== "running" || !record.authorization) {
      throw new Error("OpenCode lifecycle handle is not owned by this bridge.");
    }
    if (!record.client) {
      record.client = await createClient({
        authorization: record.authorization,
        baseUrl: record.baseUrl,
        directory: record.directory,
      });
    }
    return record.client;
  }

  async function stop(handle) {
    const record = records.get(handle);
    if (!record) {
      throw new Error("OpenCode lifecycle handle is not owned by this bridge.");
    }
    if (!active) {
      if (record.cleanupPromise) await record.cleanupPromise;
      return publicState("stopped");
    }
    if (active !== record) {
      throw new Error("OpenCode lifecycle handle is not owned by this bridge.");
    }
    await cleanup(record, { kill: true });
    return publicState("stopped");
  }

  async function shutdown() {
    if (!active) {
      state = "stopped";
      return publicState("stopped");
    }
    await cleanup(active, { kill: true });
    return publicState("stopped");
  }

  function status() {
    return publicState(state);
  }

  function watch(observer) {
    requireFunction(observer, "lifecycle observer");
    observers.add(observer);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      observers.delete(observer);
    };
  }

  return Object.freeze({
    createClient: createOwnedClient,
    shutdown,
    start,
    status,
    stop,
    watch,
  });
}
