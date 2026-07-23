import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const LOOPBACK_HOSTNAME = "127.0.0.1";
const SERVER_USERNAME = "resonantos";
const CLOSED_PERMISSION_POLICY = JSON.stringify({
  "*": "ask",
  external_directory: "deny",
});
const OWNERSHIP_CHALLENGE_AUTHORIZATION = basicAuthorization(
  SERVER_USERNAME,
  "__invalid_resonantos_readiness_probe__",
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
  allocatePort = allocateLoopbackPort,
  createClient = createOpencodeSdkClient,
  createConfigDirectory = () => mkdtemp(
    path.join(tmpdir(), "resonantos-opencode-config-"),
  ),
  fetchImpl = globalThis.fetch,
  randomPassword = () => randomBytes(32).toString("base64url"),
  removeConfigDirectory = (directory) => rm(directory, {
    force: true,
    recursive: true,
  }),
  sleep = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
  spawnImpl,
  pollMs = 100,
  readinessTimeoutMs = 12_000,
  readinessProbeTimeoutMs = 1_000,
} = {}) {
  requireFunction(allocatePort, "port allocator");
  requireFunction(createClient, "client factory");
  requireFunction(createConfigDirectory, "config directory factory");
  requireFunction(fetchImpl, "fetch");
  requireFunction(randomPassword, "password generator");
  requireFunction(removeConfigDirectory, "config directory cleanup");
  requireFunction(sleep, "sleep");
  requireFunction(spawnImpl, "spawn");
  if (
    !Number.isFinite(pollMs)
    || pollMs <= 0
    || !Number.isFinite(readinessTimeoutMs)
    || readinessTimeoutMs < 0
    || !Number.isFinite(readinessProbeTimeoutMs)
    || readinessProbeTimeoutMs <= 0
  ) {
    throw new Error("OpenCode readiness timing values are invalid.");
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

  async function cleanup(record, { kill = false, notify = false } = {}) {
    if (!record) {
      if (!active) state = "stopped";
      return;
    }
    if (record.cleanupPromise) {
      await record.cleanupPromise;
      return;
    }
    record.cleanupPromise = (async () => {
      if (active === record) active = null;
      state = "stopped";
      if (record.child && record.onChildExit) {
        if (typeof record.child.off === "function") {
          record.child.off("exit", record.onChildExit);
        } else {
          record.child.removeListener?.("exit", record.onChildExit);
        }
      }
      if (kill && record.child && !record.exited && !record.killRequested) {
        record.killRequested = true;
        try {
          record.child.kill?.();
        } catch {
          // The owned process may already be gone.
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
    await record.cleanupPromise;
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
      return Boolean(result?.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function authenticatedReady(record, deadline) {
    let remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    if (await authenticatedProbe(
      record,
      OWNERSHIP_CHALLENGE_AUTHORIZATION,
      remainingMs,
    )) {
      return false;
    }
    remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    return authenticatedProbe(record, record.authorization, remainingMs);
  }

  async function waitUntilReady(record) {
    const deadline = Date.now() + readinessTimeoutMs;
    while (true) {
      if (record.exited) {
        throw new Error("OpenCode server exited before becoming ready.");
      }
      if (await authenticatedReady(record, deadline)) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(pollMs, remainingMs));
    }
    if (record.exited) {
      throw new Error("OpenCode server exited before becoming ready.");
    }
    throw new Error("OpenCode server did not become ready in time.");
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

    state = "starting";
    let configDirectory = "";
    let record = null;
    try {
      const port = await allocatePort();
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
        throw new Error("OpenCode loopback port allocator returned an invalid port.");
      }
      configDirectory = await createConfigDirectory();
      if (typeof configDirectory !== "string" || !path.isAbsolute(configDirectory)) {
        throw new Error("OpenCode config directory factory returned an invalid path.");
      }
      const password = randomPassword();
      if (typeof password !== "string" || !password) {
        throw new Error("OpenCode password generator returned an invalid credential.");
      }
      const authorization = basicAuthorization(SERVER_USERNAME, password);
      const baseUrl = `http://${LOOPBACK_HOSTNAME}:${port}`;
      const child = spawnImpl(command, [
        "serve",
        "--pure",
        "--hostname",
        LOOPBACK_HOSTNAME,
        "--port",
        String(port),
      ], {
        cwd,
        env: childEnvironment(env, configDirectory, password),
        shell: false,
        stdio: "ignore",
      });
      if (!child || typeof child !== "object") {
        throw new Error("OpenCode spawn did not return a child process.");
      }

      const handle = Object.freeze({ process: child });
      record = {
        authorization,
        baseUrl,
        child,
        cleanupPromise: null,
        client: null,
        configDirectory,
        directory: cwd,
        exited: false,
        handle,
        killRequested: false,
        onChildExit: null,
        onExit,
        password,
      };
      records.set(handle, record);
      record.onChildExit = () => {
        record.exited = true;
        void cleanup(record, { notify: true }).catch(() => {
          state = "failed";
        });
      };
      child.once?.("exit", record.onChildExit);
      active = record;

      await waitUntilReady(record);
      if (record.exited) {
        throw new Error("OpenCode server exited before becoming ready.");
      }
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
