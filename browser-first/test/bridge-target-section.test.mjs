import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { renderBridgeTargetSection } from "../resonantos-side-panel-extension/src/lib/settings/bridge-target-section.js";
import { createBridgeClient, initCapabilityTokens, resolveBridgeConfig, validateBridgeTargetUrl, __resetCapabilityTokensForTests } from "../resonantos-side-panel-extension/src/lib/bridge-client.js";
import { redactTraceText } from "../resonantos-side-panel-extension/src/lib/trace-redaction.js";

const key = "bridgeTargetOverride";
// Synthetic operational credentials deliberately matched by the shared redactor.
const bridgeToken = "Bearer synthetic-bridge-fixture";
const capabilityBootstrapToken = "token=synthetic-bootstrap-fixture";
const generated = { bridgeUrl: "http://127.0.0.1:47773", bridgeToken: "generated-fixture", capabilityBootstrapToken: "generated-bootstrap-fixture" };
const policyError = "Bridge URL must be an absolute HTTP(S) URL without userinfo, query, or fragment. Conservative secret detection may reject a benign host or path; choose another endpoint.";
const legacyWarning = "Saved override needs correction. It is retained locally but will not be used. Save a valid replacement or choose Use generated.";

async function until(predicate, message) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

async function setup(t, override, { useGenerated = true } = {}) {
  const dom = new JSDOM("<main></main>");
  const keys = ["document", "chrome", "fetch", "__RESONANTOS_BRIDGE_CONFIG__"];
  const previous = keys.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  t.after(() => {
    __resetCapabilityTokensForTests();
    dom.window.close();
    keys.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]);
      else delete globalThis[name];
    });
  });
  const stored = override === undefined ? {} : { [key]: structuredClone(override) };
  const writes = [], removals = [], calls = [];
  globalThis.document = dom.window.document;
  globalThis.chrome = { storage: { local: {
    get: async () => structuredClone(stored),
    set: async (payload) => { writes.push(structuredClone(payload)); Object.assign(stored, structuredClone(payload)); },
    remove: async (names) => { removals.push(names); for (const name of names) delete stored[name]; },
  } } };
  globalThis.__RESONANTOS_BRIDGE_CONFIG__ = useGenerated ? generated : undefined;
  globalThis.fetch = async (target, options = {}) => {
    calls.push({ target, ...options });
    return { ok: true, status: 200, json: async () => ({ ok: true, service: "resonantos-bridge" }) };
  };
  const root = document.querySelector("main");
  renderBridgeTargetSection(root);
  await until(() => root.querySelector(".settings-health-grid").children[2].querySelector("strong").textContent === "Online", "initial probe completes");
  const status = () => root.querySelector(".settings-status").textContent;
  const field = (name, value) => { root.querySelector(`[name="${name}"]`).value = value; };
  const click = async (label) => {
    [...root.querySelectorAll("button")].find((button) => button.textContent === label).click();
    await delay(0);
  };
  return { root, stored, writes, removals, calls, status, field, click };
}

for (const url of ["http://bridge.test:47773", "https://bridge.test/ordinary/path", "https://bridge.test/ordinary/path/", "http://127.0.0.1:47773/", "HTTPS://Bridge.test:443/path", "https://bridge.test/100%/ready", "https://bridge.test/100%25/ready", "https://bridge.test/caf%C3%A9"]) {
  test(`save preserves exact URL and three-field payload: ${url}`, async (t) => {
    const ui = await setup(t);
    ui.field("bridge-url", `  ${url}  `);
    ui.field("bridge-token", `  ${bridgeToken}  `);
    ui.field("bridge-capability-bootstrap-token", `  ${capabilityBootstrapToken}  `);
    const extra = document.createElement("input");
    extra.name = "unrelated"; extra.value = "must-not-persist";
    ui.root.querySelector("form").append(extra);
    await ui.click("Save override");
    await until(() => ui.writes.length === 1, "one override storage write");
    assert.deepEqual(ui.writes, [{ [key]: { bridgeUrl: url, bridgeToken, capabilityBootstrapToken } }]);
    assert.notEqual(redactTraceText(bridgeToken), bridgeToken);
    assert.notEqual(redactTraceText(capabilityBootstrapToken), capabilityBootstrapToken);
    // Authenticate through the real client using a fresh read of saved storage.
    const saved = await resolveBridgeConfig();
    await initCapabilityTokens(saved);
    await createBridgeClient(saved)("/status");
    const bootstrap = ui.calls.find((call) => call.target === `${url}/api/capability-tokens`);
    assert.ok(bootstrap, "bootstrap request uses saved endpoint");
    assert.equal(bootstrap.headers["X-ResonantOS-Bridge-Token"], bridgeToken);
    assert.equal(bootstrap.headers["X-ResonantOS-Capability-Bootstrap-Token"], capabilityBootstrapToken);
    assert.equal(ui.calls.at(-1).headers["X-ResonantOS-Bridge-Token"], bridgeToken);
    assert.equal(ui.calls.at(-1).body, undefined);
    const body = JSON.parse(bootstrap.body);
    assert.deepEqual(Object.keys(body), ["capabilities"]);
    assert.ok(Array.isArray(body.capabilities) && body.capabilities.length > 0);
    assert.ok(!bootstrap.body.includes(bridgeToken) && !bootstrap.body.includes(capabilityBootstrapToken));
  });
}

const encodedSeparatorCases = [
  ["encoded question mark with arbitrary parameter", "https://bridge.test/bridge%3Ffoo%3Dbar"],
  ["encoded question mark without equals", "https://bridge.test/bridge%3Fabc"],
  ["encoded hash", "https://bridge.test/bridge%23anything"],
  ["double encoding", "https://bridge.test/bridge%253Ftoken%253Dabc"],
  ["mixed-case encoding", "https://bridge.test/bridge%3ffoo%3dbar"],
  ["mixed-case nested encoding", "https://bridge.test/bridge%25%33%66abc"],
  ["encoded ampersand", "https://bridge.test/bridge%26foo%3Dbar"],
  ["literal ampersand", "https://bridge.test/bridge&foo=bar"],
  ["encoded host separator", "https://bridge%26foo.test/bridge"],
  ["literal percent beside encoded separator", "https://bridge.test/100%/bridge%3Fabc"],
  ["encoded NUL", "https://bridge.test/bridge%00abc"],
  ["encoded C1 control", "https://bridge.test/bridge%C2%85abc"],
  ["nested encoded newline", "https://bridge.test/bridge%250Aabc"],
  ...["3F", "3f", "23", "26"].flatMap((separator) => [2, 8, 16, 32].map((depth) => [
    `separator ${separator} at depth ${depth}`, `https://bridge.test/bridge%${"25".repeat(depth - 1)}${separator}abc`,
  ])),
];
for (const [label, url] of encodedSeparatorCases) {
  test(`URL policy rejects ${label}`, () => {
    assert.deepEqual(validateBridgeTargetUrl(url), { ok: false, error: policyError }, "separator/control must be rejected with a value-free error");
  });
}

const controlCharacters = [
  ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)),
  ...Array.from({ length: 33 }, (_, code) => String.fromCharCode(127 + code)),
  "\u2028", "\u2029",
];
for (const control of controlCharacters) {
  test(`URL policy rejects control U+${control.charCodeAt(0).toString(16).padStart(4, "0")} anywhere before trimming`, () => {
    for (const url of [`${control}https://bridge.test/bridge`, `https://bridge.test/bridge${control}abc`, `https://bridge.test/bridge${control}`]) {
      assert.deepEqual(validateBridgeTargetUrl(url), { ok: false, error: policyError }, "control characters must be rejected before URL parsing or trimming");
    }
  });
}

const invalidUrls = [
  "", "http://", "http://[invalid", "bridge.test", "ftp://bridge.test", "https://operator:password@bridge.test", "https://@bridge.test",
  "https://bridge.test/path?token=fixture", "https://bridge.test/path?", "https://bridge.test/path#fragment", "https://bridge.test/path#",
  `https://bridge.test/${"a".repeat(32)}`, `https://${"a".repeat(32)}.test/path`,
  "https://bridge.test/token=fixture", "https://bridge.test/path%3Ftoken%3Dfixture",
  "https:////@bridge.test",
  ...encodedSeparatorCases.map(([, url]) => url),
  "https://bridge.test/bridge\0abc", "https://bridge.test/bridge\u0085abc", "\thttps://bridge.test/bridge\t",
];
for (const [index, url] of invalidUrls.entries()) {
  test(`invalid URL ${index + 1} cannot save or probe and yields a value-free error`, async (t) => {
    const ui = await setup(t);
    ui.field("bridge-url", url);
    ui.field("bridge-token", bridgeToken);
    const before = ui.calls.length;
    await ui.click("Save override");
    assert.deepEqual(ui.writes, [], "rejected URL must produce zero storage writes");
    assert.equal(ui.status(), policyError);
    await ui.click("Test connection");
    assert.equal(ui.calls.length, before, "rejected URL must produce zero probes");
    assert.equal(ui.status(), policyError);
    assert.match(ui.root.querySelector(".settings-bridge-target-form").parentElement.textContent, /[Cc]onservative.*benign/);
  });
}

const legacyUrls = [
  "https://legacy.test/?token=old-fixture", "https://legacy.test/bridge%253Ffoo%253Dbar",
  "https://legacy.test/bridge\0abc", "\nhttps://legacy.test/bridge\n",
];
for (const [legacyUrl, useGenerated] of legacyUrls.flatMap((url) => [[url, true], [url, false]])) {
  test(`invalid legacy override ${JSON.stringify(legacyUrl)} retains storage and uses only ${useGenerated ? "generated" : "default"} credentials`, async (t) => {
    const legacy = { bridgeUrl: legacyUrl, bridgeToken, capabilityBootstrapToken };
    const ui = await setup(t, legacy, { useGenerated });
    const resolved = await resolveBridgeConfig();
    assert.deepEqual(resolved, {
      bridgeUrl: generated.bridgeUrl,
      bridgeToken: useGenerated ? generated.bridgeToken : "",
      capabilityBootstrapToken: useGenerated ? generated.capabilityBootstrapToken : "",
      bridgeCapabilityTokens: {}, source: useGenerated ? "generated" : "default",
    });
    await initCapabilityTokens(resolved);
    await createBridgeClient(resolved)("/status");
    assert.ok(ui.calls.length > 0);
    for (const call of ui.calls) {
      assert.ok(!call.target.includes("legacy.test"), "invalid legacy endpoint is never probed");
      assert.equal(call.headers["X-ResonantOS-Bridge-Token"], useGenerated ? generated.bridgeToken : undefined);
      assert.notEqual(call.headers["X-ResonantOS-Capability-Bootstrap-Token"], capabilityBootstrapToken);
    }
    assert.deepEqual(ui.stored, { [key]: legacy });
    assert.deepEqual(ui.writes, []);
    assert.deepEqual(ui.removals, []);
    assert.equal(ui.status(), legacyWarning);
    assert.ok(!ui.root.textContent.includes(legacy.bridgeUrl));
    for (const input of ui.root.querySelectorAll("input")) {
      assert.ok(![legacy.bridgeUrl, bridgeToken, capabilityBootstrapToken].includes(input.value));
    }
    await ui.click("Test connection");
    assert.equal(ui.status(), legacyWarning, "fallback probe must not hide correction warning");
    ui.field("bridge-url", "https://repaired.test/bridge");
    ui.field("bridge-token", bridgeToken);
    ui.field("bridge-capability-bootstrap-token", capabilityBootstrapToken);
    await ui.click("Save override");
    await until(() => ui.writes.length === 1 && ui.status() !== legacyWarning, "repair replaces legacy record and clears warning");
    assert.deepEqual(ui.stored, { [key]: { bridgeUrl: "https://repaired.test/bridge", bridgeToken, capabilityBootstrapToken } });
    await ui.click("Use generated");
    assert.deepEqual(ui.stored, {});
    assert.deepEqual(ui.removals, [[key]]);
  });
}

test("Use generated explicitly clears an invalid legacy record", async (t) => {
  const ui = await setup(t, { bridgeUrl: "http://", bridgeToken, capabilityBootstrapToken });
  assert.equal(ui.status(), legacyWarning);
  await ui.click("Use generated");
  assert.deepEqual(ui.removals, [[key]]);
  assert.deepEqual(ui.stored, {});
  assert.notEqual(ui.status(), legacyWarning);
});
