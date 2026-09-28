import { HARNESS_PUBLIC_ERROR_MESSAGES, type HarnessEvent, type HarnessProvenance, type HarnessPublicErrorCode } from "./contracts";

type BridgeConfig = {
  bridgeUrl?: string;
  httpsBridgeUrl?: string;
  bridgeToken?: string;
  capabilityBootstrapToken?: string;
};

type CommandRoute = {
  method: "GET" | "POST";
  path: string;
  capability: string;
  body?: (args: Record<string, unknown>) => unknown;
  result?: (payload: Record<string, unknown>) => unknown;
  stream?: boolean;
};

const commandRouteMap: Record<string, CommandRoute> = {
  provider_diagnostics: { method: "GET", path: "/providers/status", capability: "provider-diagnostics-read" },
  provider_service_chat_completion: {
    method: "POST",
    path: "/augmentor/chat",
    capability: "provider-model-invoke",
    body: (args) => ({
      workload: "augmentor-chat",
      surface: "react-shell",
      model: args.model,
      thinkingDepth: args.reasoningEffort,
      systemPrompt: args.systemPrompt,
      messages: args.messages,
      ...(args.contextSources === undefined ? {} : { contextSources: args.contextSources }),
    }),
    result: (payload) => payload.reply,
  },
  harness_registry: { method: "GET", path: "/addons/registry", capability: "addon-runtime-read" },
  harness_install: { method: "POST", path: "/addons/install", capability: "addon-runtime-control" },
  harness_grants: { method: "POST", path: "/addons/grants", capability: "addon-runtime-control" },
  harness_enabled: { method: "POST", path: "/addons/enabled", capability: "addon-runtime-control" },
  harness_remove: { method: "POST", path: "/addons/remove", capability: "addon-runtime-control" },
  harness_assign_slot: { method: "POST", path: "/addons/slots/assign", capability: "addon-runtime-control" },
  harness_session: { method: "POST", path: "/agent/session", capability: "addon-runtime-control" },
  harness_turn: { method: "POST", path: "/agent/turn", capability: "addon-runtime-control" },
  harness_dispose: { method: "POST", path: "/agent/dispose", capability: "addon-runtime-control" },
  harness_cancel: { method: "POST", path: "/agent/cancel", capability: "addon-runtime-control" },
  harness_events: { method: "GET", path: "/agent/events", capability: "addon-runtime-read", stream: true },
  harness_history: { method: "POST", path: "/agent/history", capability: "addon-runtime-read" },
  harness_status: { method: "POST", path: "/agent/status", capability: "addon-runtime-read" },
  harness_select_model: { method: "POST", path: "/agent/select-model", capability: "addon-runtime-control" },
};

export const WEB_TRANSPORT_CAPABILITIES: readonly string[] = [...new Set(
  Object.values(commandRouteMap).map((route) => route.capability),
)].sort();

let bootstrapState: { key: string; promise: Promise<Record<string, string>> } | null = null;

const bootstrapKey = (config: BridgeConfig, baseUrl: string): string =>
  JSON.stringify([baseUrl, config.bridgeToken ?? "", config.capabilityBootstrapToken ?? ""]);

const ensureCapabilityTokens = (config: BridgeConfig, baseUrl: string): Promise<Record<string, string>> => {
  if (!config.bridgeToken || !config.capabilityBootstrapToken) {
    return Promise.resolve({});
  }
  const key = bootstrapKey(config, baseUrl);
  if (bootstrapState?.key === key) {
    return bootstrapState.promise;
  }

  // Defer the request until the in-flight promise has been published to all callers.
  const promise: Promise<Record<string, string>> = Promise.resolve().then(async () => {
    try {
      const response = await fetch(`${baseUrl}/api/capability-tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ResonantOS-Bridge-Token": config.bridgeToken!,
          "X-ResonantOS-Capability-Bootstrap-Token": config.capabilityBootstrapToken!,
        },
        body: JSON.stringify({ capabilities: WEB_TRANSPORT_CAPABILITIES }),
      });
      const payload = await response.json();
      const tokens: unknown = payload?.capabilityTokens;
      if (response.ok && payload?.ok === true && tokens !== null && typeof tokens === "object" &&
          (Object.getPrototypeOf(tokens) === Object.prototype || Object.getPrototypeOf(tokens) === null)) {
        return Object.fromEntries(Object.entries(tokens).filter(([capability, token]) =>
          WEB_TRANSPORT_CAPABILITIES.includes(capability) && typeof token === "string" && token.length > 0,
        ));
      }
    } catch {
      // Bootstrap failures fall through to the route's existing error handling.
    }
    if (bootstrapState?.promise === promise) {
      bootstrapState = null;
    }
    return {};
  });
  bootstrapState = { key, promise };
  return promise;
};

export const __resetWebTransportForTests = (): void => { bootstrapState = null; };

export const __webTransportRoutesForTests = (): ReadonlyArray<{
  command: string; method: string; path: string; capability: string;
}> => Object.entries(commandRouteMap).map(([command, { method, path, capability }]) =>
  ({ command, method, path, capability }),
);

const bridgeConfig = (): BridgeConfig => {
  if (typeof globalThis === "undefined") {
    return {};
  }
  return (globalThis as typeof globalThis & { __RESONANTOS_BRIDGE_CONFIG__?: BridgeConfig }).__RESONANTOS_BRIDGE_CONFIG__ ?? {};
};

const bridgeBaseUrl = (): string => {
  const config = bridgeConfig();
  const url = config.httpsBridgeUrl || config.bridgeUrl;
  if (!url) {
    throw new Error("Browser-first bridge is not configured. Start it with `npm run browser-first:bridge`.");
  }
  return url.replace(/\/+$/, "");
};

export const isWebMode = (): boolean => true;

export const webInvoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
  return performInvoke<T>(command, args, { retried: false });
};

const performInvoke = async <T>(
  command: string,
  args: Record<string, unknown>,
  { retried }: { retried: boolean },
): Promise<T> => {
  const route = commandRouteMap[command];
  if (!route) {
    throw new Error(`Runtime command '${command}' is not available in the browser-first Chrome extension alpha.`);
  }

  if (route.stream) throw new Error("Use webHarnessEvents to read harness events.");
  const config = bridgeConfig();
  const baseUrl = bridgeBaseUrl();
  const tokenPromise = ensureCapabilityTokens(config, baseUrl);
  const tokens = await tokenPromise;
  const headers: Record<string, string> = {};
  if (config.bridgeToken) {
    headers["X-ResonantOS-Bridge-Token"] = config.bridgeToken;
  }
  if (route.method === "POST") {
    headers["Content-Type"] = "application/json";
  }
  if (typeof tokens[route.capability] === "string" && tokens[route.capability].length > 0) {
    headers["X-ResonantOS-Bridge-Capability-Token"] = tokens[route.capability];
  }

  const response = await fetch(`${baseUrl}${route.path}`, {
    method: route.method,
    ...(command.startsWith("harness_") ? { redirect: "error" as const } : {}),
    headers,
    body: route.method === "POST" ? JSON.stringify(route.body ? route.body(args) : args) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string } & T;
  if (response.status === 403 && payload.ok === false && typeof payload.error === "string" &&
      /^Bridge route requires .+ capability\.$/.test(payload.error) && !retried) {
    // A late response must not discard a newer bootstrap from another command.
    if (bootstrapState?.promise === tokenPromise) {
      bootstrapState = null;
    }
    return performInvoke<T>(command, args, { retried: true });
  }
  if (command.startsWith("harness_") && response.status === 403 && payload.ok === false &&
      payload.code === "permission-denied" && !retried) {
    // The host deliberately uses the same error for capability and governance
    // denials. Retry only when bootstrap proves the route token has changed.
    if (bootstrapState?.promise === tokenPromise) bootstrapState = null;
    const fresh = await ensureCapabilityTokens(config, baseUrl);
    if (fresh[route.capability] && fresh[route.capability] !== tokens[route.capability]) {
      return performInvoke<T>(command, args, { retried: true });
    }
  }
  if (!response.ok || payload.ok === false) {
    if (command.startsWith("harness_")) throw harnessResponseError(payload);
    throw new Error(payload.error || `Bridge request failed for ${command}.`);
  }
  if (command.startsWith("harness_")) {
    const { ok: _ok, ...result } = payload;
    return result as T;
  }
  return (route.result ? route.result(payload) : payload) as T;
};

export type HarnessSession = Pick<HarnessProvenance, "addonId" | "sessionId" | "bootEpoch" | "generation">;
export type HarnessStreamOptions = { signal?: AbortSignal };

const harnessResponseError = (payload: { code?: string; error?: string }) => {
  const code = payload.code && Object.hasOwn(HARNESS_PUBLIC_ERROR_MESSAGES, payload.code)
    ? payload.code as HarnessPublicErrorCode : "runtime-unavailable";
  return Object.assign(new Error(HARNESS_PUBLIC_ERROR_MESSAGES[code]), { code });
};

const invalidEvent = () => harnessResponseError({ code: "invalid-event" });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const eventId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);

function parseHarnessEvent(value: unknown): HarnessEvent {
  if (!record(value) || !exactKeys(value, ["addonId", "sessionId", "turnId", "bootEpoch", "generation", "sequence", "type", "data"]) ||
      !["addonId", "sessionId", "turnId", "bootEpoch"].every(key => eventId(value[key])) ||
      !/^addon\.[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(String(value.addonId)) ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 0 ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !record(value.data)) throw invalidEvent();
  const data = value.data;
  switch (value.type) {
    case "delta": case "final":
      if (!exactKeys(data, ["text"]) || typeof data.text !== "string" ||
          new TextEncoder().encode(data.text).byteLength > 65_536) throw invalidEvent();
      break;
    case "status":
      if (!exactKeys(data, ["status"]) || !["starting", "running", "idle", "unavailable"].includes(String(data.status))) throw invalidEvent();
      break;
    case "cancelled":
      if (!exactKeys(data, [])) throw invalidEvent();
      break;
    case "error":
      if (!exactKeys(data, ["code", "message"]) || typeof data.code !== "string" || !Object.hasOwn(HARNESS_PUBLIC_ERROR_MESSAGES, data.code) ||
          data.message !== HARNESS_PUBLIC_ERROR_MESSAGES[data.code as HarnessPublicErrorCode]) throw invalidEvent();
      break;
    default: throw invalidEvent();
  }
  return value as unknown as HarnessEvent;
}

// Fetch is required: EventSource cannot attach the bridge's scoped headers.
// The query contains only public session provenance, never authentication.
export async function* webHarnessEvents(
  session: HarnessSession, { signal }: HarnessStreamOptions = {},
): AsyncGenerator<HarnessEvent> {
  const config = bridgeConfig();
  const baseUrl = bridgeBaseUrl();
  const route = commandRouteMap.harness_events;
  const tokens = await ensureCapabilityTokens(config, baseUrl);
  signal?.throwIfAborted();
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (config.bridgeToken) headers["X-ResonantOS-Bridge-Token"] = config.bridgeToken;
  if (tokens[route.capability]) headers["X-ResonantOS-Bridge-Capability-Token"] = tokens[route.capability];
  const query = new URLSearchParams({ addonId: session.addonId, sessionId: session.sessionId,
    bootEpoch: session.bootEpoch, generation: String(session.generation) });
  const response = await fetch(`${baseUrl}${route.path}?${query}`, { method: "GET", headers, signal, redirect: "error" });
  if (!response.ok) throw harnessResponseError(await response.json().catch(() => ({})));
  if (!response.body) throw harnessResponseError({});
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (frame.length > 262144) throw invalidEvent();
        let eventName = "";
        const data: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
        }
        if (!data.length) continue;
        let payload: unknown;
        try { payload = JSON.parse(data.join("\n")); } catch { throw invalidEvent(); }
        if (eventName === "harness.close") {
          if (!record(payload) || payload.sessionId !== session.sessionId) throw invalidEvent();
          throw harnessResponseError(payload);
        }
        yield parseHarnessEvent(payload);
      }
      if (buffer.length > 262144) throw invalidEvent();
      if (done) {
        if (buffer.trim()) throw invalidEvent();
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
