// DOM-layer security proof for the dev-only external-agent-runtimes panel.
//
// The service tests (dev-external-agent-runtimes-panel.test.mjs) prove the
// payload and injection are well-formed; the HTTP tests
// (dev-external-agent-runtimes-panel-http.test.mjs) prove auth, routing, and
// headers on the wire. Neither executes the document. This file loads the
// REAL served HTML — produced by the actual route handler, never re-rendered
// here — into jsdom with scripts enabled and proves the browser contract:
//
//   1. Cards render from the server-injected data block.
//   2. Markup-breakout payloads (</script><script>…) stay inert data: nothing
//      executes and no elements are created from manifest strings.
//   3. Event-handler strings in whitelisted fields render as inert text,
//      never as attributes.
//   4. A corrupt data block renders an honest error state (no blank page).
//   5. U+2028/U+2029 survive into the rendered DOM unchanged.
//   6. Rendering performs no network requests and references no external
//      resources (the document is fully self-contained).
//   7. The template never uses innerHTML (source pin).
//
// Convention: jsdom per side-panel-dom.test.mjs; real HTML from the real
// handler; no rendering reimplementation inside the test.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createDevExternalAgentRuntimesPanelService } from "../host/dev-external-agent-runtimes-panel.mjs";

const PANEL_TEMPLATE_PATH = new URL("../dev/external-agent-runtimes-panel.html", import.meta.url);

const DEEPSEEK_MANIFEST = {
  id: "addon.deepseek-harness",
  name: "DeepSeek Harness",
  version: "0.1.0",
  runtimeType: "agent-addon",
  service: { entrypoint: "http://127.0.0.1:3080" },
  requestedCapabilities: [{ capability: "providers" }, { capability: "agent-delegation" }],
  tools: [{ name: "deepseek_harness.status" }, { name: "deepseek_harness.run_task" }],
};

// Served HTML straight from the real HTML route handler: the same injection,
// escaping, and template the bridge serves. `manifests` maps file name to
// manifest object.
async function servePanelHtml(manifests) {
  const repoRoot = await mkdtemp(join(tmpdir(), "panel-dom-"));
  try {
    await mkdir(join(repoRoot, "examples", "addons"), { recursive: true });
    for (const [fileName, manifest] of Object.entries(manifests)) {
      await writeFile(join(repoRoot, "examples", "addons", fileName), JSON.stringify(manifest));
    }
    const { devPanelRoutes } = createDevExternalAgentRuntimesPanelService({ repoRoot });
    const htmlRoute = devPanelRoutes.find((route) => route.path === "/dev/external-agent-runtimes/");
    return (await htmlRoute.handler({}, {})).__html;
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

// Parse the served document with scripts enabled, with network tripwires
// installed before any script runs. Returns { window, networkCalls }.
function renderServed(html) {
  const networkCalls = [];
  const tripwire = (kind) => {
    networkCalls.push(kind);
    throw new Error(`panel must not touch the network (${kind})`);
  };
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = () => tripwire("fetch");
      window.XMLHttpRequest = function XMLHttpRequest() { tripwire("XMLHttpRequest"); };
      window.WebSocket = function WebSocket() { tripwire("WebSocket"); };
      window.EventSource = function EventSource() { tripwire("EventSource"); };
      Object.defineProperty(window.navigator, "sendBeacon", {
        value: () => tripwire("sendBeacon"),
        configurable: true,
      });
    },
  });
  return { window: dom.window, networkCalls };
}

test("renders manifest cards from the server-injected data block", async () => {
  const html = await servePanelHtml({
    "addon.deepseek-harness.json": DEEPSEEK_MANIFEST,
    "reference-memory.json": {
      id: "reference-memory",
      name: "Reference Memory",
      version: "0.1.0",
      runtimeType: "local-service",
      requestedCapabilities: [{ capability: "memory-provider" }],
      tools: [{ name: "memory.search" }],
    },
  });
  const { window } = renderServed(html);
  const document = window.document;

  const cards = [...document.querySelectorAll(".addon")];
  assert.equal(cards.length, 2, "one card per manifest");
  assert.equal(cards[0].querySelector("h2").textContent, "DeepSeek Harness");
  assert.match(cards[0].querySelector(".file").textContent, /addon\.deepseek-harness\.json · v0\.1\.0/);
  const deepseekText = cards[0].textContent;
  assert.match(deepseekText, /agent-addon/);
  assert.match(deepseekText, /deepseek_harness\.status, deepseek_harness\.run_task/);
  // §3 trigger: providers + agent-delegation.
  assert.match(deepseekText, /providers \+ agent-delegation/);
  assert.match(document.getElementById("meta").textContent, /2 addon\(s\)/);
  // No error state in the honest path.
  assert.equal(document.querySelector(".err"), null);
});

test("markup-breakout payloads stay inert data — nothing executes, no elements created", async () => {
  const html = await servePanelHtml({
    "evil.json": {
      ...DEEPSEEK_MANIFEST,
      id: "evil</script><script>window.__pwned = true</script>",
      name: "evil",
    },
  });
  const { window } = renderServed(html);
  const document = window.document;

  // The breakout script never executed.
  assert.equal(window.__pwned, undefined, "a manifest string must never execute");
  // The document still holds exactly its two static inline scripts (data
  // block + render script): no script element was created from manifest data.
  assert.equal(document.querySelectorAll("script").length, 2);
  assert.equal(document.querySelector("img"), null);
  // The hostile id string rendered as literal text inside the card (the id
  // row) — visible as data, never parsed as markup.
  assert.match(document.querySelector(".addon").textContent, /evil<\/script><script>window\.__pwned = true<\/script>/);
});

test("event-handler strings in whitelisted fields render as inert text, never attributes", async () => {
  const hostileName = 'x" onmouseover="alert(1)';
  const html = await servePanelHtml({
    "handler.json": { ...DEEPSEEK_MANIFEST, id: "addon.handler", name: hostileName },
  });
  const { window } = renderServed(html);
  const document = window.document;

  const heading = document.querySelector(".addon h2");
  assert.equal(heading.textContent, hostileName, "the string renders verbatim as text");
  // No element anywhere in the document carries an event-handler attribute.
  const withHandler = [...document.querySelectorAll("*")].filter((el) =>
    [...el.attributes].some((attr) => /^on/i.test(attr.name)),
  );
  assert.deepEqual(withHandler, [], "no element may carry an on* attribute");
});

test("a corrupt data block renders an honest error state instead of a blank page", async () => {
  const served = await servePanelHtml({ "addon.deepseek-harness.json": DEEPSEEK_MANIFEST });
  // Break the injected JSON after the fact (a truncated write, a bad edit to
  // the template contract): the render script must surface the failure.
  const corrupted = served.replace(
    /(<script type="application\/json" id="panel-data">)[\s\S]*?(<\/script>)/,
    "$1{ broken json $2",
  );
  assert.notEqual(corrupted, served, "the corruption must actually apply");
  const { window } = renderServed(corrupted);
  const document = window.document;

  const err = document.querySelector(".err");
  assert.ok(err, "an error element is shown");
  assert.match(err.textContent, /panel data failed to parse/);
  assert.equal(document.querySelectorAll(".addon").length, 0, "no half-rendered cards");
});

test("U+2028/U+2029 survive into the rendered DOM unchanged", async () => {
  const separatedName = "evil\u2028name\u2029";
  const html = await servePanelHtml({
    "separators.json": { ...DEEPSEEK_MANIFEST, id: "addon.separators", name: separatedName },
  });
  const { window } = renderServed(html);
  assert.equal(window.document.querySelector(".addon h2").textContent, separatedName);
});

test("rendering performs no network requests and references no external resources", async () => {
  const html = await servePanelHtml({ "addon.deepseek-harness.json": DEEPSEEK_MANIFEST });
  const { window, networkCalls } = renderServed(html);
  const document = window.document;

  assert.deepEqual(networkCalls, [], "no fetch/XHR/WebSocket/EventSource/beacon during render");
  // No external resource references at all: the panel is one self-contained
  // document (its CSP — asserted at the HTTP layer — locks this in).
  assert.deepEqual([...document.querySelectorAll("[src]")], [], "no src attributes");
  assert.deepEqual([...document.querySelectorAll("script[src], link[href], img, iframe, object, embed")], []);
  // The only scripts are the two static inline blocks.
  for (const script of document.querySelectorAll("script")) {
    assert.equal(script.src, "", "scripts are inline");
  }
});

test("panel template never writes markup from data (no innerHTML-class sinks)", async () => {
  const source = await readFile(PANEL_TEMPLATE_PATH, "utf8");
  // Pin the absence of markup-sink USAGE (the word may legitimately appear in
  // comments): assignments to innerHTML/outerHTML and insertAdjacentHTML.
  assert.doesNotMatch(source, /\.\s*(innerHTML|outerHTML)\s*=[^=]/, "untrusted values must go through textContent only");
  assert.doesNotMatch(source, /insertAdjacentHTML\s*\(/, "untrusted values must go through textContent only");
});
