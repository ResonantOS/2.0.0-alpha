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
    }),
    result: (payload) => payload.reply,
  },
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
    headers,
    body: route.method === "POST" ? JSON.stringify(route.body ? route.body(args) : args) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (response.status === 403 && payload.ok === false && typeof payload.error === "string" &&
      /^Bridge route requires .+ capability\.$/.test(payload.error) && !retried) {
    // A late response must not discard a newer bootstrap from another command.
    if (bootstrapState?.promise === tokenPromise) {
      bootstrapState = null;
    }
    return performInvoke<T>(command, args, { retried: true });
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Bridge request failed for ${command}.`);
  }
  return (route.result ? route.result(payload) : payload) as T;
};
