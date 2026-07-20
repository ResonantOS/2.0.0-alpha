type BridgeConfig = {
  bridgeUrl?: string;
  httpsBridgeUrl?: string;
  bridgeToken?: string;
};

type CommandRoute = {
  method: "GET" | "POST";
  path: string;
  body?: (args: Record<string, unknown>) => unknown;
  result?: (payload: Record<string, unknown>) => unknown;
};

const commandRouteMap: Record<string, CommandRoute> = {
  provider_diagnostics: { method: "GET", path: "/providers/status" },
  provider_service_chat_completion: {
    method: "POST",
    path: "/augmentor/chat",
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
  const route = commandRouteMap[command];
  if (!route) {
    throw new Error(`Runtime command '${command}' is not available in the browser-first Chrome extension alpha.`);
  }

  const config = bridgeConfig();
  const headers: Record<string, string> = {};
  if (config.bridgeToken) {
    headers["X-ResonantOS-Bridge-Token"] = config.bridgeToken;
  }
  if (route.method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${bridgeBaseUrl()}${route.path}`, {
    method: route.method,
    headers,
    body: route.method === "POST" ? JSON.stringify(route.body ? route.body(args) : args) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Bridge request failed for ${command}.`);
  }
  return (route.result ? route.result(payload) : payload) as T;
};
