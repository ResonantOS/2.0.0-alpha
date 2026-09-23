import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as transport from "./web-transport";
import { createHarnessClient } from "./harness-client";
import { HARNESS_PUBLIC_ERROR_MESSAGES } from "./contracts";

const baseUrl = "http://127.0.0.1:47773";
const diagnostics = "provider_diagnostics";
const chat = "provider_service_chat_completion";
const capabilityHeader = "X-ResonantOS-Bridge-Capability-Token";
const capabilityError = "Bridge route requires provider-diagnostics-read capability.";
const issuedTokens = {
  "provider-diagnostics-read": "diagnostics-token-test",
  "provider-model-invoke": "model-token-test",
  "addon-runtime-read": "harness-read-token-test",
  "addon-runtime-control": "harness-control-token-test",
};
const secrets = ["bridge-token-test", "bootstrap-token-test", ...Object.values(issuedTokens), "fresh-token-test"];
type Config = { bridgeUrl?: string; httpsBridgeUrl?: string; bridgeToken?: string; capabilityBootstrapToken?: string };
const globals = globalThis as typeof globalThis & { __RESONANTOS_BRIDGE_CONFIG__?: Config };
let config: Config;
const fetchMock = vi.fn<typeof fetch>();
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const bootstrap = (tokens: unknown = issuedTokens) => response({ ok: true, capabilityTokens: tokens });
const calls = () => fetchMock.mock.calls;
const bootstrapCalls = () => calls().filter(([url]) => String(url).endsWith("/api/capability-tokens"));
const routeCalls = () => calls().filter(([url]) => !String(url).endsWith("/api/capability-tokens"));
const headers = (call: (typeof fetchMock.mock.calls)[number]) => new Headers(call[1]?.headers);
const paths = () => calls().map(([url]) => new URL(String(url)).pathname);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

async function expectSafeError(promise: Promise<unknown>, message: string) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
  for (const secret of secrets) expect((error as Error).message).not.toContain(secret);
}

beforeEach(() => {
  config = { bridgeUrl: baseUrl, bridgeToken: "bridge-token-test", capabilityBootstrapToken: "bootstrap-token-test" };
  vi.stubGlobal("__RESONANTOS_BRIDGE_CONFIG__", config);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  transport.__resetWebTransportForTests();
  fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens")
    ? bootstrap() : response({ ok: true }));
});
afterEach(() => vi.unstubAllGlobals());

describe("web-mode capability transport", () => {
  it("D1 bootstraps once and reuses scoped diagnostics tokens", async () => {
    await transport.webInvoke(diagnostics);
    await transport.webInvoke(diagnostics);
    expect(bootstrapCalls()).toHaveLength(1);
    const call = bootstrapCalls()[0];
    expect(call[0]).toBe(`${baseUrl}/api/capability-tokens`);
    expect(call[1]?.method).toBe("POST");
    expect(Object.fromEntries(headers(call))).toEqual({
      "content-type": "application/json",
      "x-resonantos-bridge-token": "bridge-token-test",
      "x-resonantos-capability-bootstrap-token": "bootstrap-token-test",
    });
    expect(JSON.parse(String(call[1]?.body))).toEqual({ capabilities: transport.WEB_TRANSPORT_CAPABILITIES });
    expect(routeCalls()).toHaveLength(2);
    for (const route of routeCalls()) {
      expect(headers(route).get(capabilityHeader)).toBe(issuedTokens["provider-diagnostics-read"]);
      expect(headers(route).get("X-ResonantOS-Bridge-Token")).toBe("bridge-token-test");
    }
  });

  it("D2 D17 preserves chat mapping and uses only the model token", async () => {
    const args = { model: "test-model", reasoningEffort: "high", systemPrompt: "test prompt", messages: [{ role: "user", content: "hi" }] };
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens")
      ? bootstrap() : response({ ok: true, reply: "test reply" }));
    expect(await transport.webInvoke(chat, args)).toBe("test reply");
    const call = routeCalls()[0];
    expect(headers(call).get(capabilityHeader)).toBe(issuedTokens["provider-model-invoke"]);
    expect(headers(call).get("Content-Type")).toBe("application/json");
    expect(call[0]).toBe(`${baseUrl}/augmentor/chat`);
    expect(call[1]?.method).toBe("POST");
    expect(JSON.parse(String(call[1]?.body))).toEqual({ workload: "augmentor-chat", surface: "react-shell", model: args.model, thinkingDepth: "high", systemPrompt: args.systemPrompt, messages: args.messages });
  });

  it("D3 D7 omits bootstrap without its secret and throws the bridge error verbatim", async () => {
    delete config.capabilityBootstrapToken;
    fetchMock.mockImplementation(async () => response({ ok: false, error: capabilityError }, 403));
    await expectSafeError(transport.webInvoke(diagnostics), capabilityError);
    expect(bootstrapCalls()).toHaveLength(0);
    for (const call of routeCalls()) expect(headers(call).has(capabilityHeader)).toBe(false);
    expect(routeCalls()).toHaveLength(2);
  });

  it("D4 D18 does not cache a 500 bootstrap or expose its failure details", async () => {
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens")
      ? response({ ok: false, error: secrets.join(" ") }, 500)
      : response({ ok: false, error: "Provider unavailable." }, 500));
    await expectSafeError(transport.webInvoke(diagnostics), "Provider unavailable.");
    await expectSafeError(transport.webInvoke(diagnostics), "Provider unavailable.");
    expect(bootstrapCalls()).toHaveLength(2);
    expect(routeCalls()).toHaveLength(2);
    for (const call of routeCalls()) expect(headers(call).has(capabilityHeader)).toBe(false);
  });

  it("D5 recovers capability-token rotation with one bootstrap and route retry", async () => {
    fetchMock.mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(response({ ok: false, error: capabilityError }, 403))
      .mockResolvedValueOnce(bootstrap({ "provider-diagnostics-read": "fresh-token-test" }))
      .mockResolvedValueOnce(response({ ok: true, status: "ready" }));
    expect(await transport.webInvoke(diagnostics)).toEqual({ ok: true, status: "ready" });
    expect(paths()).toEqual(["/api/capability-tokens", "/providers/status", "/api/capability-tokens", "/providers/status"]);
    expect(headers(routeCalls()[0]).get(capabilityHeader)).toBe(issuedTokens["provider-diagnostics-read"]);
    expect(headers(routeCalls()[1]).get(capabilityHeader)).toBe("fresh-token-test");
  });

  it("D6 D7 stops after the second capability 403 without leaking any token", async () => {
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens")
      ? bootstrap() : response({ ok: false, error: capabilityError }, 403));
    await expectSafeError(transport.webInvoke(diagnostics), capabilityError);
    expect(bootstrapCalls()).toHaveLength(2);
    expect(routeCalls()).toHaveLength(2);
  });

  it("D8 rejects an unknown command before any network access", async () => {
    await expectSafeError(transport.webInvoke("x"), "Runtime command 'x' is not available in the browser-first Chrome extension alpha.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("D9 derives sorted unique capabilities from a copied route map", () => {
    expect(transport.WEB_TRANSPORT_CAPABILITIES).toEqual(["addon-runtime-control", "addon-runtime-read", "provider-diagnostics-read", "provider-model-invoke"]);
    const routes = transport.__webTransportRoutesForTests();
    expect(transport.WEB_TRANSPORT_CAPABILITIES).toEqual([...new Set(routes.map((route) => route.capability))].sort());
    expect(routes).toEqual([
      { command: diagnostics, method: "GET", path: "/providers/status", capability: "provider-diagnostics-read" },
      { command: chat, method: "POST", path: "/augmentor/chat", capability: "provider-model-invoke" },
      ...harnessRoutes.map(([command, method, path, capability]) => ({ command, method, path, capability })),
    ]);
    routes[0].capability = "changed-copy";
    expect(transport.__webTransportRoutesForTests()[0].capability).toBe("provider-diagnostics-read");
  });

  it("D10 shares an in-flight bootstrap between concurrent commands", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens") ? pending.promise : response({ ok: true }));
    const first = transport.webInvoke(diagnostics);
    const second = transport.webInvoke(diagnostics);
    await vi.waitFor(() => expect(bootstrapCalls()).toHaveLength(1));
    expect(routeCalls()).toHaveLength(0);
    pending.resolve(bootstrap());
    await Promise.all([first, second]);
    expect(bootstrapCalls()).toHaveLength(1);
    expect(routeCalls()).toHaveLength(2);
    for (const call of routeCalls()) expect(headers(call).get(capabilityHeader)).toBe(issuedTokens["provider-diagnostics-read"]);
  });

  it("D11 does not bootstrap when only the bootstrap secret is present", async () => {
    delete config.bridgeToken;
    await transport.webInvoke(diagnostics);
    expect(bootstrapCalls()).toHaveLength(0);
    expect(routeCalls()).toHaveLength(1);
    expect(headers(routeCalls()[0]).has(capabilityHeader)).toBe(false);
    expect(headers(routeCalls()[0]).has("X-ResonantOS-Bridge-Token")).toBe(false);
  });

  it.each(["", 42])("D12 filters extraneous and invalid capability tokens (%j)", async (invalid) => {
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens")
      ? bootstrap({ ...issuedTokens, "provider-model-invoke": invalid, "extra-capability": "extra-token-test" }) : response({ ok: true }));
    await transport.webInvoke(diagnostics);
    await transport.webInvoke(chat);
    expect(headers(routeCalls()[0]).get(capabilityHeader)).toBe(issuedTokens["provider-diagnostics-read"]);
    expect(headers(routeCalls()[1]).has(capabilityHeader)).toBe(false);
    for (const call of routeCalls()) expect([...headers(call).values()]).not.toContain("extra-token-test");
    expect(bootstrapCalls()).toHaveLength(1);
  });

  it.each(["capabilityBootstrapToken", "bridgeToken", "bridgeUrl", "httpsBridgeUrl"] as const)("D13 re-bootstraps only when config key %s changes", async (key) => {
    await transport.webInvoke(diagnostics);
    await transport.webInvoke(diagnostics);
    expect(bootstrapCalls()).toHaveLength(1);
    globals.__RESONANTOS_BRIDGE_CONFIG__ = { ...config, [key]: key === "bridgeUrl" ? "http://127.0.0.1:47774" : key === "httpsBridgeUrl" ? "https://127.0.0.1:47775" : "changed-test-token" };
    await transport.webInvoke(diagnostics);
    await transport.webInvoke(diagnostics);
    expect(bootstrapCalls()).toHaveLength(2);
    expect(routeCalls()).toHaveLength(4);
    if (key === "bridgeUrl") expect(bootstrapCalls()[1][0]).toBe("http://127.0.0.1:47774/api/capability-tokens");
    else if (key === "httpsBridgeUrl") expect(bootstrapCalls()[1][0]).toBe("https://127.0.0.1:47775/api/capability-tokens");
    else expect(headers(bootstrapCalls()[1]).get(key === "bridgeToken" ? "X-ResonantOS-Bridge-Token" : "X-ResonantOS-Capability-Bootstrap-Token")).toBe("changed-test-token");
  });

  it.each(["rejection", "ok false", "non-JSON", "missing tokens", "array tokens", "null tokens", "null payload", "truthy ok"])("D14 D18 does not cache malformed bootstrap: %s", async (mode) => {
    fetchMock.mockImplementation(async (url) => {
      if (!String(url).endsWith("/api/capability-tokens")) return response({ ok: false, error: "Provider unavailable." }, 500);
      switch (mode) {
        case "rejection": throw new Error(secrets.join(" "));
        case "ok false": return response({ ok: false, capabilityTokens: issuedTokens });
        case "non-JSON": return new Response("not json");
        case "missing tokens": return response({ ok: true });
        case "array tokens": return bootstrap([]);
        case "null tokens": return bootstrap(null);
        case "null payload": return response(null);
        default: return response({ ok: "true", capabilityTokens: issuedTokens });
      }
    });
    await expectSafeError(transport.webInvoke(diagnostics), "Provider unavailable.");
    await expectSafeError(transport.webInvoke(diagnostics), "Provider unavailable.");
    expect(bootstrapCalls()).toHaveLength(2);
    expect(routeCalls()).toHaveLength(2);
    for (const call of routeCalls()) expect(headers(call).has(capabilityHeader)).toBe(false);
  });

  it.each([
    [401, "Unauthorized browser-first bridge request."],
    [401, capabilityError],
    [403, "Bridge client IP not allowed."],
    [403, "Client IP not allowlisted for browser-first bridge."],
    [403, `prefix ${capabilityError}`],
    [403, `${capabilityError} suffix`],
  ])("D15 D16 D18 does not retry unrelated denial %s %s", async (status, error) => {
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens")
      ? bootstrap() : response({ ok: false, error }, Number(status)));
    await expectSafeError(transport.webInvoke(diagnostics), String(error));
    expect(bootstrapCalls()).toHaveLength(1);
    expect(routeCalls()).toHaveLength(1);
  });

  it("D16b does not retry a capability 403 whose body lacks ok:false", async () => {
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens")
      ? bootstrap() : response({ error: capabilityError }, 403));
    await expectSafeError(transport.webInvoke(diagnostics), capabilityError);
    expect(bootstrapCalls()).toHaveLength(1);
    expect(routeCalls()).toHaveLength(1);
  });

  it("D18b fallback error text carries no token when the bridge answers without a body", async () => {
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens")
      ? bootstrap() : new Response("", { status: 500 }));
    await expectSafeError(transport.webInvoke(diagnostics), `Bridge request failed for ${diagnostics}.`);
  });

  it("A3b module never logs", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./web-transport.ts", import.meta.url), "utf8");
    expect(/console\./.test(source)).toBe(false);
  });

  it("D17 preserves GET payload mapping without body or Content-Type", async () => {
    expect(await transport.webInvoke(diagnostics)).toEqual({ ok: true });
    const call = routeCalls()[0];
    expect(call[1]?.method).toBe("GET");
    expect(call[1]?.body).toBeUndefined();
    expect(headers(call).has("Content-Type")).toBe(false);
  });

  it("A4 keeps a newer bootstrap when an older concurrent request gets a 403", async () => {
    const staleResponse = deferred<Response>();
    let routeCount = 0;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/api/capability-tokens")) return bootstrap({ "provider-diagnostics-read": bootstrapCalls().length === 1 ? issuedTokens["provider-diagnostics-read"] : "fresh-token-test" });
      routeCount += 1;
      if (routeCount === 1) return staleResponse.promise;
      if (routeCount === 2) return response({ ok: false, error: capabilityError }, 403);
      return response({ ok: true });
    });
    const first = transport.webInvoke(diagnostics);
    await vi.waitFor(() => expect(routeCalls()).toHaveLength(1));
    await transport.webInvoke(diagnostics);
    staleResponse.resolve(response({ ok: false, error: capabilityError }, 403));
    await first;
    expect(bootstrapCalls()).toHaveLength(2);
    expect(routeCalls()).toHaveLength(4);
    expect(headers(routeCalls()[3]).get(capabilityHeader)).toBe("fresh-token-test");
  });

  it("A3 keeps a newer memo when an older bootstrap fails", async () => {
    const oldBootstrap = deferred<Response>();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/api/capability-tokens")) return bootstrapCalls().length === 1 ? oldBootstrap.promise : bootstrap();
      return response({ ok: true });
    });
    const old = transport.webInvoke(diagnostics);
    await vi.waitFor(() => expect(bootstrapCalls()).toHaveLength(1));
    globals.__RESONANTOS_BRIDGE_CONFIG__ = { ...config, capabilityBootstrapToken: "changed-test-token" };
    await transport.webInvoke(diagnostics);
    oldBootstrap.resolve(response({ ok: false }, 500));
    await old;
    await transport.webInvoke(diagnostics);
    expect(bootstrapCalls()).toHaveLength(2);
    expect(headers(routeCalls()[2]).get(capabilityHeader)).toBe(issuedTokens["provider-diagnostics-read"]);
  });
});

 it("forwards structured context separately from prompt and messages", async () => {
  const contextSources = [{ source: "living-archive", kind: "page", title: "title", path: "path", text: "SECRET" }];
  const args = { model: "test", reasoningEffort: "high", systemPrompt: "trusted", messages: [{ role: "user", content: "hello" }], contextSources };
  await transport.webInvoke(chat, args);
  expect(routeCalls()).toHaveLength(1);
  expect(JSON.parse(String(routeCalls()[0][1]?.body))).toEqual({ workload: "augmentor-chat", surface: "react-shell", model: "test", thinkingDepth: "high", systemPrompt: "trusted", messages: args.messages, contextSources });
 });

const harnessRoutes = [
  ["harness_registry", "GET", "/addons/registry", "addon-runtime-read"],
  ["harness_install", "POST", "/addons/install", "addon-runtime-control"],
  ["harness_grants", "POST", "/addons/grants", "addon-runtime-control"],
  ["harness_remove", "POST", "/addons/remove", "addon-runtime-control"],
  ["harness_assign_slot", "POST", "/addons/slots/assign", "addon-runtime-control"],
  ["harness_session", "POST", "/agent/session", "addon-runtime-control"],
  ["harness_turn", "POST", "/agent/turn", "addon-runtime-control"],
  ["harness_cancel", "POST", "/agent/cancel", "addon-runtime-control"],
  ["harness_events", "GET", "/agent/events", "addon-runtime-read"],
  ["harness_history", "POST", "/agent/history", "addon-runtime-read"],
  ["harness_status", "POST", "/agent/status", "addon-runtime-read"],
  ["harness_select_model", "POST", "/agent/select-model", "addon-runtime-control"],
];
const session = { addonId: "addon.demo", sessionId: "session-1", bootEpoch: "boot-1", generation: 2 };

describe("harness transport", () => {
  it("commands use scoped headers and never persist or put credentials in URLs", async () => {
    const storage = vi.fn();
    vi.stubGlobal("localStorage", { setItem: storage });
    vi.stubGlobal("sessionStorage", { setItem: storage });
    const database = vi.fn();
    vi.stubGlobal("indexedDB", { open: database });
    const log = vi.spyOn(console, "log");
    try {
      for (const [command, method, path, capability] of harnessRoutes.filter(([name]) => name !== "harness_events")) {
        const args = { addonId: "addon.demo", expectedRevision: 7 };
        await transport.webInvoke(command, args);
        const call = routeCalls().at(-1)!;
        expect(call[0]).toBe(`${baseUrl}${path}`);
        expect(call[1]?.method).toBe(method);
        expect(headers(call).get(capabilityHeader)).toBe(issuedTokens[capability as keyof typeof issuedTokens]);
        expect(headers(call).get("X-ResonantOS-Bridge-Token")).toBe("bridge-token-test");
        expect(call[1]?.body).toBe(method === "POST" ? JSON.stringify(args) : undefined);
        expect(call[1]?.redirect).toBe("error");
      }
      expect(storage).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("reads split UTF-8 SSE with header authentication and cancels the reader on early exit", async () => {
    const storage = vi.fn();
    vi.stubGlobal("localStorage", { setItem: storage });
    vi.stubGlobal("sessionStorage", { setItem: storage });
    const database = vi.fn();
    vi.stubGlobal("indexedDB", { open: database });
    const event = { ...session, turnId: "turn-1", sequence: 1, type: "delta", data: { text: "héllo" } };
    const bytes = new TextEncoder().encode(`: heartbeat\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
    const cancel = vi.fn();
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens") ? bootstrap() :
      new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      }, cancel }), { headers: { "Content-Type": "text/event-stream" } }));
    const abort = new AbortController();
    for await (const frame of transport.webHarnessEvents(session, { signal: abort.signal })) {
      expect(frame).toEqual(event);
      break;
    }
    const call = routeCalls()[0];
    expect(new URL(String(call[0])).pathname).toBe("/agent/events");
    expect(Object.fromEntries(new URL(String(call[0])).searchParams)).toEqual({ ...session, generation: "2" });
    for (const secret of secrets) expect(String(call[0])).not.toContain(secret);
    expect(headers(call).get(capabilityHeader)).toBe(issuedTokens["addon-runtime-read"]);
    expect(headers(call).get("X-ResonantOS-Bridge-Token")).toBe("bridge-token-test");
    expect(call[1]?.signal).toBe(abort.signal);
    expect(call[1]?.redirect).toBe("error");
    expect(cancel).toHaveBeenCalledOnce();
    expect(storage).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });

  it("preserves public harness HTTP and terminal SSE errors without retry", async () => {
    const error = { code: "ownership-conflict", error: "Runtime ownership changed." };
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/capability-tokens") ? bootstrap() : response({ ok: false, ...error }, 409));
    await expect(transport.webInvoke("harness_assign_slot")).rejects.toMatchObject({ code: error.code, message: error.error });
    expect(routeCalls()).toHaveLength(1);
    await expect((async () => { for await (const _ of transport.webHarnessEvents(session)) { /* empty */ } })())
      .rejects.toMatchObject({ code: error.code, message: error.error });
    fetchMock.mockImplementation(async () => new Response(`event: harness.close\ndata: ${JSON.stringify({ sessionId: session.sessionId, ...error })}\n\n`));
    await expect((async () => { for await (const _ of transport.webHarnessEvents(session)) { /* empty */ } })())
      .rejects.toMatchObject({ code: error.code, message: error.error });
  });
});


describe("harness review regressions", () => {
  const frame = { ...session, turnId: "turn-1", sequence: 1, type: "delta", data: { text: "hello" } };
  const collect = async () => {
    const frames = [];
    for await (const item of transport.webHarnessEvents(session)) frames.push(item);
    return frames;
  };

  it("composes the default client with the bridge envelope without projecting ok", async () => {
    const projected = { bootEpoch: "boot-1", revision: 1, governanceActivated: true,
      candidates: [], installations: {}, slots: {} };
    fetchMock.mockImplementation(async url => String(url).endsWith("/api/capability-tokens")
      ? bootstrap() : response({ ok: true, ...projected }));
    const client = createHarnessClient();
    expect(await client.refresh()).toEqual(projected);
    expect(client.getSnapshot()).toEqual(projected);
  });

  it.each([
    { ...frame, extra: "unexpected" },
    { ...frame, data: { text: "hello", extra: "unexpected" } },
    { ...frame, type: "cancelled", data: { text: "unexpected" } },
    { ...frame, type: "status", data: { status: "running", extra: true } },
    { ...frame, type: "error", data: { code: "permission-denied", message: HARNESS_PUBLIC_ERROR_MESSAGES["permission-denied"], extra: true } },
    { ...frame, sessionId: "" },
    { ...frame, addonId: "not-an-addon" },
    { ...frame, data: { text: "é".repeat(32769) } },
  ])("rejects frames outside the host event schema (%#)", async invalid => {
    fetchMock.mockImplementation(async url => String(url).endsWith("/api/capability-tokens")
      ? bootstrap() : new Response(`data: ${JSON.stringify(invalid)}\n\n`));
    await expect(collect()).rejects.toMatchObject({ code: "invalid-event" });
  });

  it("accepts every host event type with exact public error messages", async () => {
    const frames = [frame, { ...frame, type: "final" }, { ...frame, type: "cancelled", data: {} },
      { ...frame, type: "status", data: { status: "running" } },
      ...Object.entries(HARNESS_PUBLIC_ERROR_MESSAGES).map(([code, message]) => ({ ...frame, type: "error", data: { code, message } }))];
    fetchMock.mockImplementation(async url => String(url).endsWith("/api/capability-tokens")
      ? bootstrap() : new Response(frames.map(item => `data: ${JSON.stringify(item)}\n\n`).join("")));
    expect(await collect()).toEqual(frames);
  });

  it("recovers a harness capability rotation with one retry only after the token changes", async () => {
    fetchMock.mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(response({ ok: false, code: "permission-denied", error: HARNESS_PUBLIC_ERROR_MESSAGES["permission-denied"] }, 403))
      .mockResolvedValueOnce(bootstrap({ ...issuedTokens, "addon-runtime-control": "fresh-token-test" }))
      .mockResolvedValueOnce(response({ ok: true, turnId: "turn-1" }));
    expect(await transport.webInvoke("harness_turn", { session, input: {} })).toEqual({ turnId: "turn-1" });
    expect(bootstrapCalls()).toHaveLength(2);
    expect(routeCalls()).toHaveLength(2);
    expect(headers(routeCalls()[1]).get(capabilityHeader)).toBe("fresh-token-test");
  });

  it("does not replay a harness denial when the scoped token did not change", async () => {
    fetchMock.mockImplementation(async url => String(url).endsWith("/api/capability-tokens")
      ? bootstrap() : response({ ok: false, code: "permission-denied", error: HARNESS_PUBLIC_ERROR_MESSAGES["permission-denied"] }, 403));
    await expect(transport.webInvoke("harness_turn")).rejects.toMatchObject({ code: "permission-denied" });
    expect(bootstrapCalls()).toHaveLength(2);
    expect(routeCalls()).toHaveLength(1);
  });
});
