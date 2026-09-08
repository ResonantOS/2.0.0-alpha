import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as transport from "./web-transport";

const baseUrl = "http://127.0.0.1:47773";
const diagnostics = "provider_diagnostics";
const chat = "provider_service_chat_completion";
const capabilityHeader = "X-ResonantOS-Bridge-Capability-Token";
const capabilityError = "Bridge route requires provider-diagnostics-read capability.";
const issuedTokens = {
  "provider-diagnostics-read": "diagnostics-token-test",
  "provider-model-invoke": "model-token-test",
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
    expect(transport.WEB_TRANSPORT_CAPABILITIES).toEqual(["provider-diagnostics-read", "provider-model-invoke"]);
    const routes = transport.__webTransportRoutesForTests();
    expect(transport.WEB_TRANSPORT_CAPABILITIES).toEqual([...new Set(routes.map((route) => route.capability))].sort());
    expect(routes).toEqual([
      { command: diagnostics, method: "GET", path: "/providers/status", capability: "provider-diagnostics-read" },
      { command: chat, method: "POST", path: "/augmentor/chat", capability: "provider-model-invoke" },
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

  it.each(["capabilityBootstrapToken", "bridgeToken", "bridgeUrl"] as const)("D13 re-bootstraps only when config key %s changes", async (key) => {
    await transport.webInvoke(diagnostics);
    await transport.webInvoke(diagnostics);
    expect(bootstrapCalls()).toHaveLength(1);
    globals.__RESONANTOS_BRIDGE_CONFIG__ = { ...config, [key]: key === "bridgeUrl" ? "http://127.0.0.1:47774" : "changed-test-token" };
    await transport.webInvoke(diagnostics);
    await transport.webInvoke(diagnostics);
    expect(bootstrapCalls()).toHaveLength(2);
    expect(routeCalls()).toHaveLength(4);
    if (key === "bridgeUrl") expect(bootstrapCalls()[1][0]).toBe("http://127.0.0.1:47774/api/capability-tokens");
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
