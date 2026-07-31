// Shared certification fixtures for issue #223: Agent Control safe
// click/type/scroll certification. Loads the static fixture page into jsdom,
// evaluates the real content.js safety layer, and exposes a certified
// control-step executor whose page actions run against that layer.
//
// The runner-level certification tests in agent-control-runner.test.mjs and
// the executor-level tests in control-step-executor.test.mjs share this module
// so the focused test command stays:
//   node --test browser-first/test/control-step-executor.test.mjs browser-first/test/agent-control-runner.test.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

import { createControlStepExecutor } from "../resonantos-side-panel-extension/src/lib/control-step-executor.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const ext = (...p) => path.join(repoRoot, "browser-first", "resonantos-side-panel-extension", "src", ...p);
const fixturePath = path.join(import.meta.dirname, "fixtures", "agent-control-certification", "agent-control-certification-page.html");

const contentScripts = [
  ext("lib", "control-overlay.js"),
  ext("lib", "content-field-safety.js"),
  ext("lib", "content-inline-actions.js"),
  ext("lib", "content-control-refs.js"),
  ext("content.js")
];

export const certificationFixture = {
  pageUrl: "https://certification.test/",
  fixturePath
};

// Builds a jsdom instance of the certification fixture page with the real
// content.js safety layer running inside it.
export async function loadCertificationPage() {
  const html = await readFile(fixturePath, "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: certificationFixture.pageUrl, pretendToBeVisual: true });
  const win = dom.window;
  let listener = null;
  win.chrome = {
    runtime: {
      onMessage: { addListener(cb) { listener = cb; } },
      sendMessage: () => Promise.resolve()
    },
    storage: { onChanged: { addListener() {} } }
  };
  win.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  win.__resonantosControlDwellMs = 0;
  for (const scriptPath of contentScripts) win.eval(await readFile(scriptPath, "utf8"));
  if (typeof listener !== "function") throw new Error("content.js should register a message listener on the certification fixture");
  // jsdom has no layout engine; stub the scrolling surface so scrollPage's
  // window.scrollBy/scrollY contract stays observable.
  const scrollHeight = win.document.documentElement.scrollHeight || 6000;
  Object.defineProperty(win.document.documentElement, "scrollHeight", { configurable: true, get: () => scrollHeight });
  win.scrollY = 0;
  win.scrollBy = ({ top = 0 }) => {
    win.scrollY = Math.max(0, Math.min(scrollHeight - win.innerHeight, win.scrollY + top));
    win.dispatchEvent(new win.Event("scroll"));
    return undefined;
  };
  const send = (message) => new Promise((resolve) => {
    listener({ channel: "resonantos.browser_first.content", ...message }, {}, resolve);
  });
  return { dom, win, send };
}

// Builds a certified control-step executor: the executor's page-action
// dependencies are wired to the real content.js safety layer inside the
// fixture page instead of stubs, so step results certify page-side behavior.
export function createCertifiedExecutor({ win, send }) {
  const events = [];
  let controlledTabId = 1;
  const executor = createControlStepExecutor({
    addMessage: async (role, content) => events.push(["message", role, content]),
    chrome: {
      tabs: {
        get: async (id) => ({ id, active: id === 1, title: "Certification Fixture", url: certificationFixture.pageUrl }),
        query: async () => [{ id: 1, active: true, title: "Certification Fixture", url: certificationFixture.pageUrl }],
        update: async (id, patch) => events.push(["tab-update", id, patch])
      }
    },
    clickActivePageText: async ({ text, ref, userApproved }) => {
      const result = await send({ type: "click_text", text, ref, userApproved: Boolean(userApproved) });
      events.push(["click", text ?? ref, result]);
      return result;
    },
    detectActivePageForms: async () => send({ type: "detect_forms" }),
    getControlledTabId: () => controlledTabId,
    isReadableBrowserTab: (tab) => /^https?:\/\//i.test(String(tab?.url ?? "")),
    openBrowserUrl: async (target) => ({ ok: true, action: "open", url: target }),
    scrollActivePage: async ({ direction }) => {
      const result = await send({ type: "scroll_page", direction });
      events.push(["scroll", direction, result]);
      return result;
    },
    searchBrowser: async () => ({ ok: true }),
    setActivity: () => undefined,
    setContextMeter: () => undefined,
    setControlledTabId: (id) => { controlledTabId = id; },
    setLastSnapshot: () => undefined,
    sleep: async () => undefined,
    summarizeSnapshot: async () => ({ ok: true, snapshot: { title: "Certification Fixture", url: certificationFixture.pageUrl } }),
    typeIntoActivePage: async ({ text, field, ref, submit, userApproved }) => {
      const result = await send({ type: "type_text", text, field, ref, submit, userApproved: Boolean(userApproved) });
      events.push(["type", field ?? ref, result]);
      return result;
    }
  });
  return { events, executor };
}
