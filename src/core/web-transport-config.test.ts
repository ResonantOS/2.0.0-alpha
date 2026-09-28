import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetWebTransportForTests, webInvoke, WEB_TRANSPORT_CAPABILITIES } from "./web-transport";

const fetchMock = vi.fn<typeof fetch>();
const globals = globalThis as typeof globalThis & { __RESONANTOS_BRIDGE_CONFIG__?: object };
let originalConfig: PropertyDescriptor | undefined;
beforeEach(() => {
  originalConfig = Object.getOwnPropertyDescriptor(globalThis, "__RESONANTOS_BRIDGE_CONFIG__");
  __resetWebTransportForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  __resetWebTransportForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (originalConfig) Object.defineProperty(globalThis, "__RESONANTOS_BRIDGE_CONFIG__", originalConfig);
  else delete globals.__RESONANTOS_BRIDGE_CONFIG__;
});

it("missing delivered config retains the existing no-config error", async () => {
  delete globals.__RESONANTOS_BRIDGE_CONFIG__;
  await expect(webInvoke("provider_diagnostics")).rejects.toThrow(
    "Browser-first bridge is not configured. Start it with `npm run browser-first:bridge`.");
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

it("delivered three-field config bootstraps before diagnostics", async () => {
  const canary = () => `synthetic-${randomBytes(24).toString("hex")}`;
  const config = Object.freeze({ bridgeUrl: "http://127.0.0.1:49152", bridgeToken: canary(), capabilityBootstrapToken: canary() });
  const routeToken = canary();
  globals.__RESONANTOS_BRIDGE_CONFIG__ = config;
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, capabilityTokens: { "provider-diagnostics-read": routeToken } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  expect(await webInvoke("provider_diagnostics")).toEqual({ ok: true });
  expect(fetchMock.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method])).toEqual([
    ["/api/capability-tokens", "POST"], ["/providers/status", "GET"],
  ]);
  const first = fetchMock.mock.calls[0], second = fetchMock.mock.calls[1];
  const bootstrapHeaders = new Headers(first[1]?.headers), routeHeaders = new Headers(second[1]?.headers);
  expect(bootstrapHeaders.get("X-ResonantOS-Bridge-Token") === config.bridgeToken).toBe(true);
  expect(bootstrapHeaders.get("X-ResonantOS-Capability-Bootstrap-Token") === config.capabilityBootstrapToken).toBe(true);
  expect(JSON.parse(String(first[1]?.body))).toEqual({ capabilities: WEB_TRANSPORT_CAPABILITIES });
  expect(routeHeaders.get("X-ResonantOS-Bridge-Token") === config.bridgeToken).toBe(true);
  expect(routeHeaders.get("X-ResonantOS-Bridge-Capability-Token") === routeToken).toBe(true);
  expect(routeHeaders.has("X-ResonantOS-Capability-Bootstrap-Token")).toBe(false);
  expect(fetchMock.mock.calls.every(([url]) => new URL(String(url)).origin === config.bridgeUrl)).toBe(true);
  expect(Object.keys(config)).toEqual(["bridgeUrl", "bridgeToken", "capabilityBootstrapToken"]);
});
