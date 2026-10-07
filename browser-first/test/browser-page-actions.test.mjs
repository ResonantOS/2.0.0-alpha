import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import { normalizeBrowserUrl } from "../resonantos-side-panel-extension/src/lib/browser-command-parser.js";
import { createBrowserPageActions } from "../resonantos-side-panel-extension/src/lib/browser-page-actions.js";

const openAiLikeUrlSecret = ["sk", "live", "URL", "SECRET"].join("-");

function createHarness(overrides = {}) {
  const events = [];
  let controlledTabId = overrides.controlledTabId ?? 1;
  let lastSnapshot = overrides.lastSnapshot ?? null;
  let sendMessageCalls = 0;
  const tabs = overrides.tabs ?? [{ id: 1, active: true, title: "Example", url: "https://example.test/" }];
  const chrome = {
    tabs: {
      create: async (payload) => {
        events.push(["tab.create", payload]);
        return { id: 2, active: true, title: "", url: payload.url };
      },
      get: async (tabId) => tabs.find((tab) => tab.id === tabId) ?? null,
      query: async () => tabs,
      reload: async (tabId) => events.push(["tab.reload", tabId]),
      sendMessage: async (tabId, message, options) => {
        sendMessageCalls += 1;
        events.push(["sendMessage", message.type, options?.frameId]);
        if (overrides.sendMessage) return overrides.sendMessage(sendMessageCalls, message, options, tabId);
        return { ok: true, snapshot: { title: "Frame", url: "https://example.test/", text: "hello world", frame: { isTop: true } } };
      },
      update: async (tabId, payload) => {
        events.push(["tab.update", tabId, payload]);
        return { id: tabId, ...payload };
      }
    },
    runtime: overrides.activeTabContext ? {
      sendMessage: async (message) => {
        events.push(["runtime.sendMessage", message]);
        return overrides.activeTabContext(message);
      }
    } : undefined,
    scripting: overrides.scripting ?? {
      executeScript: async (payload) => events.push(["inject", payload])
    },
    webNavigation: {
      getAllFrames: async () => overrides.frames ?? [{ frameId: 0 }]
    }
  };

  const actions = createBrowserPageActions({
    addMessage: async (role, content) => events.push(["message", role, content]),
    bridgeRequest: async (route, options) => {
      events.push(["bridge", route, options]);
      if (overrides.bridgeRequest) return overrides.bridgeRequest(route, options);
      return overrides.bridgeResponse ?? { items: [{ title: "Headline", source: "Source" }] };
    },
    chrome,
    getControlledTabId: () => controlledTabId,
    getModel: () => overrides.model ?? "MiniMax-M3",
    getThinkingDepth: () => overrides.thinkingDepth ?? "minimal",
    getLastSnapshot: () => lastSnapshot,
    isReadableBrowserTab: (tab) => typeof tab?.url === "string" && /^https?:\/\//i.test(tab.url),
    normalizeBrowserUrl,
    now: overrides.now,
    permissionForUrl: overrides.permissionForUrl ?? (async () => overrides.permission ?? "ask-before-action"),
    renderSitePermissionPanel: async (tab) => events.push(["site-panel", tab?.id ?? null]),
    setActivity: (phase, label, detail) => events.push(["activity", phase, label, detail]),
    setContextMeter: (snapshot) => events.push(["context", snapshot?.title ?? null]),
    setControlledTabId: (tabId) => {
      controlledTabId = tabId;
      events.push(["controlled", tabId]);
    },
    setLastSnapshot: (snapshot) => {
      lastSnapshot = snapshot;
      events.push(["snapshot", snapshot?.title ?? null]);
    },
    setReadButtonTitle: (title) => events.push(["read-title", title]),
    setStatus: (status) => events.push(["status", status]),
    siteKeyForUrl: (url) => new URL(url).host,
    sleep: async () => undefined
  });

  return {
    actions,
    events,
    getControlledTabId: () => controlledTabId,
    getLastSnapshot: () => lastSnapshot
  };
}

test("browser page actions open URLs in the controlled readable tab", async () => {
  const harness = createHarness();

  const result = await harness.actions.openBrowserUrl("resonantos.com");

  assert.deepEqual(result, { ok: true, action: "open", url: "https://resonantos.com/" });
  assert.equal(harness.getControlledTabId(), 1);
  assert.ok(harness.events.some((event) => event[0] === "tab.update" && event[2].url === "https://resonantos.com/"));
  assert.ok(harness.events.some((event) => event[0] === "message" && /Opened https:\/\/resonantos.com\//.test(event[2])));
});

test("browser page actions open news search and report retrieved headlines", async () => {
  const harness = createHarness({
    bridgeResponse: {
      items: [
        { title: "Global markets react to AI infrastructure buildout", source: "Reuters" },
        { title: "Climate summit announces new grid agreement", source: "AP" }
      ]
    }
  });

  const result = await harness.actions.searchBrowser({ action: "news", query: "important world news today" });

  assert.equal(result.ok, true);
  assert.equal(result.action, "news");
  assert.match(result.url, /^https:\/\/www\.bing\.com\/news\/search\?/);
  assert.ok(harness.events.some((event) => event[0] === "tab.update" && /bing\.com\/news\/search/.test(event[2].url)));
  assert.ok(harness.events.some((event) =>
    event[0] === "bridge" &&
    event[1] === "/web/news" &&
    event[2].body.query === "important world news today"
  ));
  assert.ok(harness.events.some((event) =>
    event[0] === "message" &&
    /Opened news search/.test(event[2]) &&
    /Global markets react/.test(event[2]) &&
    /Climate summit announces/.test(event[2])
  ));
});

test("browser page actions still opens news search when headline extraction fails", async () => {
  const harness = createHarness({
    bridgeRequest: () => {
      throw new Error("provider unavailable");
    }
  });

  const result = await harness.actions.searchBrowser({ action: "news", query: "latest AI news" });

  assert.equal(result.ok, true);
  assert.ok(harness.events.some((event) => event[0] === "tab.update" && /bing\.com\/news\/search/.test(event[2].url)));
  assert.ok(harness.events.some((event) =>
    event[0] === "message" &&
    /I opened the news search, but headline extraction failed: provider unavailable/.test(event[2])
  ));
});

test("browser page actions merge frame snapshots when reading the active page", async () => {
  const harness = createHarness({
    frames: [{ frameId: 0 }, { frameId: 7 }],
    sendMessage: (_call, _message, options) => ({
      ok: true,
      snapshot: {
        title: options.frameId === 0 ? "Top" : "Child",
        url: "https://example.test/",
        text: options.frameId === 0 ? "top text" : "child text",
        links: [{ text: "Link" }],
        controls: [{ text: "Button" }],
        fields: [{ label: "Email" }],
        frame: { isTop: options.frameId === 0 }
      }
    })
  });

  const result = await harness.actions.readActivePage({ announce: false });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.title, "Top");
  assert.match(result.snapshot.text, /top text/);
  assert.match(result.snapshot.text, /child text/);
  assert.equal(result.snapshot.frames.length, 2);
  assert.equal(harness.getLastSnapshot().title, "Top");
});

test("browser page actions hydrates cached active-tab context from background snapshot store", async () => {
  const harness = createHarness({
    activeTabContext: () => ({
      ok: true,
      snapshot: {
        tabId: 1,
        title: "Cached Active Tab",
        url: "https://example.test/",
        text: "cached page context"
      }
    })
  });

  await harness.actions.readActivePage({ announce: false });

  assert.ok(harness.events.some((event) => event[0] === "runtime.sendMessage" && event[1].type === "active_tab_context"));
  assert.ok(harness.events.some((event) => event[0] === "snapshot" && event[1] === "Cached Active Tab"));
  assert.ok(harness.events.some((event) => event[0] === "context" && event[1] === "Cached Active Tab"));
});

test("browser page actions clears stale page context when active tab changes", async () => {
  const harness = createHarness({
    lastSnapshot: {
      tabId: 9,
      title: "Old Tab",
      url: "https://old.example/",
      text: "stale"
    },
    activeTabContext: () => ({
      ok: true,
      snapshot: {
        tabId: 9,
        title: "Old Tab",
        url: "https://old.example/",
        text: "stale"
      }
    })
  });

  await harness.actions.readActivePage({ announce: false });

  assert.ok(harness.events.some((event) => event[0] === "snapshot" && event[1] === null));
  assert.ok(harness.events.some((event) => event[0] === "context" && event[1] === null));
});

test("browser page actions rejects cached tab context without tab identity or URL", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "Malformed Cached Snapshot",
      text: "no tab or URL identity"
    },
    activeTabContext: () => ({
      ok: true,
      snapshot: {
        title: "Malformed Cached Snapshot",
        text: "no tab or URL identity"
      }
    })
  });

  await harness.actions.readActivePage({ announce: false });

  assert.ok(harness.events.some((event) => event[0] === "snapshot" && event[1] === null));
  assert.ok(harness.events.some((event) => event[0] === "context" && event[1] === null));
});

test("browser page actions never announce raw query or hash secrets from page URLs", async () => {
  const harness = createHarness({
    sendMessage: () => ({
      ok: true,
      snapshot: {
        title: "Leaky Page",
        url: `https://example.test/path?token=${openAiLikeUrlSecret}#card-4111222233334444`,
        text: "safe visible text",
        links: [{ text: "checkout", href: "https://example.test/pay?session=secret#card-4111222233334444" }],
        frame: { isTop: true, referrer: "https://referrer.test/?token=secret#frag" }
      }
    })
  });

  const result = await harness.actions.readActivePage();

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.url, "https://example.test/path");
  assert.equal(result.snapshot.links[0].href, "https://example.test/pay");
  assert.equal(result.snapshot.frame.referrer, "https://referrer.test/");
  const transcript = harness.events
    .filter((event) => event[0] === "message")
    .map((event) => event[2])
    .join("\n");
  assert.match(transcript, /https:\/\/example\.test\/path/);
  assert.equal(transcript.includes(openAiLikeUrlSecret), false);
  assert.doesNotMatch(transcript, /token=|4111222233334444|#card/);
});

test("browser page actions inject content script after missing receiver failure", async () => {
  const harness = createHarness({
    sendMessage: (call) => call === 1
      ? { ok: false, error: "Could not establish connection. Receiving end does not exist." }
      : { ok: true, clickedText: "Continue" }
  });

  const result = await harness.actions.clickActivePageText({ text: "Continue" });

  assert.equal(result.ok, true);
  assert.ok(harness.events.some((event) => event[0] === "inject"));
  assert.ok(harness.events.some((event) => event[0] === "message" && /Clicked "Continue"/.test(event[2])));
});

test("browser page actions route Resonator commands to the active page", async () => {
  let sent = null;
  const harness = createHarness({
    permission: "read-only",
    sendMessage: (_call, message) => {
      sent = message;
      return { ok: true, action: message.action, result: { ok: true } };
    }
  });

  const result = await harness.actions.runResonatorCommand("highlight", "#target");

  assert.equal(result.ok, true);
  assert.equal(sent.type, "resonator");
  assert.equal(sent.action, "highlight");
  assert.deepEqual(sent.payload, { selector: "#target", label: "" });
  assert.ok(harness.events.some((event) => event[0] === "message" && /Resonator highlight displayed/.test(event[2])));
});

test("browser page actions respect read-only site permission for mutations", async () => {
  const harness = createHarness({ permission: "read-only" });

  const result = await harness.actions.typeIntoActivePage({ text: "secret" });

  assert.equal(result.ok, false);
  assert.match(result.error, /read-only/);
  assert.ok(harness.events.some((event) => event[0] === "status" && event[1] === "Page action failed"));
});

test("browser page actions still send control overlay updates under read-only permission", async () => {
  const harness = createHarness({
    permission: "read-only",
    frames: [{ frameId: 0 }, { frameId: 7 }],
  });

  const result = await harness.actions.setPageControlOverlay(true, "reading", "reading");

  assert.equal(result.ok, true);
  assert.ok(harness.events.some((event) => event[0] === "sendMessage" && event[1] === "control_overlay"));
  assert.deepEqual(
    harness.events.filter((event) => event[0] === "sendMessage" && event[1] === "control_overlay").map((event) => event[2]),
    [0],
  );
});

test("browser page actions summarize existing snapshots without rereading", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "Cached",
      url: "https://example.test/cached",
      text: "one two three",
      links: [{ text: "A" }]
    }
  });

  const result = await harness.actions.summarizeSnapshot();

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.title, "Cached");
  assert.ok(harness.events.some((event) => event[0] === "message" && /I can read this page/.test(event[2])));
  assert.ok(harness.events.some((event) => event[0] === "message" && /What is visible now: one two three/.test(event[2])));
  assert.equal(harness.events.some((event) => event[0] === "sendMessage"), false);
});

test("browser page actions save current page to archive intake", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "Saved Page",
      url: "https://example.test/page",
      text: "Important page text for the archive.",
      links: [{ text: "Source", href: "https://example.test/source" }],
      controls: [],
      fields: []
    },
    bridgeRequest: async (route) => route === "/archive/intake"
      ? { path: "INTAKE/browser/saved-page.md", bytes: 100 }
      : { path: "REVIEW/requests/saved-page.md", status: "pending" }
  });

  const result = await harness.actions.saveCurrentPageToArchive();

  assert.equal(result.ok, true);
  assert.equal(result.path, "INTAKE/browser/saved-page.md");
  assert.equal(result.reviewRequestPath, "REVIEW/requests/saved-page.md");
  const bridgeCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/intake");
  assert.equal(bridgeCall[2].body.origin, "browser-current-page");
  assert.equal(bridgeCall[2].body.url, "https://example.test/page");
  assert.match(bridgeCall[2].body.content, /Important page text/);
  const reviewCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/review/request");
  assert.equal(reviewCall[2].body.path, "INTAKE/browser/saved-page.md");
  assert.ok(harness.events.some((event) =>
    event[0] === "message" &&
    /Saved this page/.test(event[2]) &&
    /Next: open Living Archive > Review Queue/.test(event[2])
  ));
  assert.equal(harness.events.some((event) => event[0] === "message" && /INTAKE\/browser|REVIEW\/requests/.test(event[2])), false);
});

test("browser page actions save selected text to archive intake", async () => {
  const harness = createHarness({
    sendMessage: (_call, message) => message.type === "get_selection"
      ? { ok: true, title: "Selection Page", url: "https://example.test/selection", selection: { text: "Selected passage" } }
      : { ok: false, error: "unexpected" },
    bridgeRequest: async (route) => route === "/archive/intake"
      ? { path: "INTAKE/browser/selection.md", bytes: 80 }
      : { path: "REVIEW/requests/selection.md", status: "pending" }
  });

  const result = await harness.actions.saveSelectionToArchive();

  assert.equal(result.ok, true);
  assert.equal(result.path, "INTAKE/browser/selection.md");
  assert.equal(result.reviewRequestPath, "REVIEW/requests/selection.md");
  const bridgeCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/intake");
  assert.equal(bridgeCall[2].body.origin, "browser-selection");
  assert.equal(bridgeCall[2].body.url, "https://example.test/selection");
  assert.match(bridgeCall[2].body.content, /Selected passage/);
  const reviewCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/review/request");
  assert.equal(reviewCall[2].body.path, "INTAKE/browser/selection.md");
  assert.ok(harness.events.some((event) =>
    event[0] === "message" &&
    /Saved the selected text/.test(event[2]) &&
    /Next: open Living Archive > Review Queue/.test(event[2])
  ));
  assert.equal(harness.events.some((event) => event[0] === "message" && /INTAKE\/browser|REVIEW\/requests/.test(event[2])), false);
});

test("browser page actions detect Phantom wallet state without requesting access", async () => {
  const harness = createHarness({
    scripting: {
      executeScript: async (payload) => {
        harness.events.push(["wallet-probe", payload.world, payload.target]);
        return [{
          result: {
            phantomSolana: {
              detected: true,
              isConnected: true,
              isPhantom: true,
              publicKeyPreview: "9abc...wxyz"
            },
            source: "main-world-probe"
          }
        }];
      }
    }
  });

  const result = await harness.actions.detectWalletState();

  assert.equal(result.ok, true);
  assert.equal(result.state.detected, true);
  assert.equal(result.state.detectionOnly, true);
  assert.equal(result.state.providers.phantomSolana.isConnected, true);
  assert.ok(harness.events.some((event) => event[0] === "wallet-probe" && event[1] === "MAIN"));
  const message = harness.events.find((event) => event[0] === "message" && /Wallet status/.test(event[2]))?.[2] ?? "";
  assert.match(message, /Phantom Solana: connected/);
  assert.match(message, /read-only detection/);
  assert.doesNotMatch(message, /connect\(|signMessage|signTransaction|signAndSendTransaction/i);
});

test("browser page actions block wallet status detection on blocked sites", async () => {
  const harness = createHarness({ permission: "blocked" });

  const result = await harness.actions.detectWalletState();

  assert.equal(result.ok, false);
  assert.match(result.error, /blocked/);
  assert.equal(harness.events.some((event) => event[0] === "inject" || event[0] === "wallet-probe"), false);
});

test("browser page actions prepare DAO workflow guidance without wallet automation", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "DAO Vote",
      url: "https://dao.example/vote",
      text: "Vote on proposal 12. Quorum threshold is 4%. Treasury transfer is 10 SOL. Deadline closes Friday.",
      controls: [
        { ref: "r1", text: "Connect Wallet", tagName: "button" },
        { ref: "r2", text: "Vote For", tagName: "button" },
        { ref: "r3", text: "Open details", tagName: "button" },
        { ref: "r4", text: "Execute Proposal", tagName: "button" },
        { ref: "r5", text: "Abstain", tagName: "button" }
      ],
      fields: [
        { ref: "f1", label: "Delegate vote reason", kind: "document-edit" },
        { ref: "f2", label: "Treasury recipient", kind: "text" }
      ]
    }
  });

  const result = await harness.actions.prepareDaoWorkflowGuidance("review proposal 12");

  assert.equal(result.ok, true);
  assert.equal(result.controls, 4);
  assert.equal(result.fields, 2);
  const message = harness.events.find((event) => event[0] === "message" && /DAO workflow helper/.test(event[2]))?.[2] ?? "";
  assert.match(message, /Goal: review proposal 12/);
  assert.match(message, /Connect Wallet · ref r1/);
  assert.match(message, /Vote For · ref r2/);
  assert.match(message, /Execute Proposal · ref r4/);
  assert.match(message, /Abstain · ref r5/);
  assert.match(message, /Treasury recipient · ref f2/);
  assert.match(message, /\/wallet status/);
  assert.match(message, /Risk checklist:/);
  assert.match(message, /proposal id\/title, voting choice, quorum\/threshold, treasury or token amounts/);
  assert.match(message, /Human completes wallet connect, signature, vote, transaction, or public submission manually/);
  assert.match(message, /will not click wallet connect, sign, vote, submit, transfer, or transaction confirmation/);
});

test("browser page actions save wallet and DAO audit evidence to reviewed intake", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "DAO Vote",
      url: "https://dao.example/vote",
      text: "Vote on proposal 12. Quorum threshold is 4%. Treasury transfer is 10 SOL. Deadline closes Friday.",
      controls: [
        { ref: "r1", text: "Connect Wallet", tagName: "button" },
        { ref: "r2", text: "Vote For", tagName: "button" },
        { ref: "r3", text: "Open details", tagName: "button" },
        { ref: "r4", text: "Queue Transaction", tagName: "button" },
        { ref: "r5", text: "Against", tagName: "button" }
      ],
      fields: [
        { ref: "f1", label: "Delegate vote reason", kind: "document-edit" },
        { ref: "f2", label: "Treasury recipient", kind: "text" }
      ]
    },
    bridgeRequest: async (route) => route === "/archive/intake"
      ? { path: "INTAKE/browser/wallet-dao-audit.md", bytes: 120 }
      : { path: "REVIEW/requests/wallet-dao-audit.md", status: "pending" },
    scripting: {
      executeScript: async (payload) => {
        harness.events.push(["wallet-probe", payload.world, payload.target]);
        return [{
          result: {
            phantomSolana: {
              detected: true,
              isConnected: false,
              isPhantom: true,
              publicKeyPreview: ""
            },
            source: "main-world-probe"
          }
        }];
      }
    }
  });

  const result = await harness.actions.saveWalletDaoAuditToArchive("review proposal 12");

  assert.equal(result.ok, true);
  assert.equal(result.path, "INTAKE/browser/wallet-dao-audit.md");
  assert.equal(result.reviewRequestPath, "REVIEW/requests/wallet-dao-audit.md");
  assert.equal(result.controls, 4);
  assert.equal(result.fields, 2);
  const bridgeCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/intake");
  assert.equal(bridgeCall[2].body.origin, "browser-wallet-dao-audit");
  assert.equal(bridgeCall[2].body.url, "https://dao.example/vote");
  assert.equal(bridgeCall[2].body.metadata.walletDetected, true);
  assert.deepEqual(bridgeCall[2].body.metadata.walletProviders, ["phantomSolana"]);
  assert.match(bridgeCall[2].body.content, /Wallet \/ DAO Audit/);
  assert.match(bridgeCall[2].body.content, /Phantom Solana: available, not connected/);
  assert.match(bridgeCall[2].body.content, /Connect Wallet · ref r1/);
  assert.match(bridgeCall[2].body.content, /Vote For · ref r2/);
  assert.match(bridgeCall[2].body.content, /Queue Transaction · ref r4/);
  assert.match(bridgeCall[2].body.content, /Against · ref r5/);
  assert.match(bridgeCall[2].body.content, /Treasury recipient · ref f2/);
  assert.match(bridgeCall[2].body.content, /## DAO Risk Checklist/);
  assert.match(bridgeCall[2].body.content, /quorum: Quorum threshold is 4%/);
  assert.match(bridgeCall[2].body.content, /treasury: Treasury transfer is 10 SOL/);
  assert.match(bridgeCall[2].body.content, /deadline: Deadline closes Friday/);
  assert.match(bridgeCall[2].body.content, /ResonantOS did not request wallet connection/);
  assert.doesNotMatch(bridgeCall[2].body.content, /connect\(|signMessage|signTransaction|signAndSendTransaction/i);
  const reviewCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/review/request");
  assert.equal(reviewCall[2].body.path, "INTAKE/browser/wallet-dao-audit.md");
  assert.match(reviewCall[2].body.reason, /wallet\/DAO browser evidence/i);
  assert.ok(harness.events.some((event) => event[0] === "message" && /Saved a wallet\/DAO audit/.test(event[2])));
});

test("browser page actions summarize current page into reviewed archive intake", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "Summary Page",
      url: "https://example.test/summary",
      text: "This page explains ResonantOS browser-first memory. It keeps source provenance visible.",
      links: [{ text: "Memory", href: "https://example.test/memory" }],
      controls: [],
      fields: []
    },
    bridgeRequest: async (route, options) => {
      if (route === "/augmentor/chat") {
        assert.equal(options.body.model, "MiniMax-M3");
        assert.equal(options.body.surface, "archive-intake");
        assert.match(options.body.pageContext, /Summary Page/);
        return { reply: "## Summary\nThe page explains browser-first memory.", model: "MiniMax-M3" };
      }
      if (route === "/archive/intake") return { path: "INTAKE/browser/summary.md", bytes: 120 };
      return { path: "REVIEW/requests/summary.md", status: "pending" };
    }
  });

  const result = await harness.actions.summarizeCurrentPageToArchive();

  assert.equal(result.ok, true);
  assert.equal(result.path, "INTAKE/browser/summary.md");
  assert.equal(result.reviewRequestPath, "REVIEW/requests/summary.md");
  assert.equal(result.fallback, false);
  const bridgeCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/intake");
  assert.equal(bridgeCall[2].body.origin, "browser-page-summary");
  assert.equal(bridgeCall[2].body.url, "https://example.test/summary");
  assert.match(bridgeCall[2].body.content, /## AI Summary/);
  assert.match(bridgeCall[2].body.content, /fallback summary: no/);
  const reviewCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/review/request");
  assert.equal(reviewCall[2].body.path, "INTAKE/browser/summary.md");
  assert.match(reviewCall[2].body.reason, /Verify this browser page summary/);
  assert.ok(harness.events.some((event) =>
    event[0] === "message" &&
    /Summarized this page into Living Archive intake/.test(event[2]) &&
    /Next: open Living Archive > Review Queue/.test(event[2])
  ));
});

test("browser page actions create deterministic summary intake when provider fails", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "Fallback Page",
      url: "https://example.test/fallback",
      text: "First fact. Second fact. Third fact.",
      links: [],
      controls: [],
      fields: []
    },
    bridgeRequest: async (route) => {
      if (route === "/augmentor/chat") throw new Error("provider offline");
      if (route === "/archive/intake") return { path: "INTAKE/browser/fallback.md", bytes: 120 };
      return { path: "REVIEW/requests/fallback.md", status: "pending" };
    }
  });

  const result = await harness.actions.summarizeCurrentPageToArchive();

  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  const bridgeCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/intake");
  assert.match(bridgeCall[2].body.content, /fallback summary: yes/);
  assert.match(bridgeCall[2].body.content, /Provider summary failed/);
  assert.match(bridgeCall[2].body.content, /First fact/);
});

test("browser page actions summarize with an unknown template id falls back to the default prompt and title end-to-end", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "Fallback Page",
      url: "https://example.test/fallback",
      text: "Readable text.",
      links: [],
      controls: [],
      fields: []
    },
    bridgeRequest: async (route) => {
      if (route === "/augmentor/chat") return { reply: "A summary.", model: "MiniMax-M3" };
      if (route === "/archive/intake") return { path: "INTAKE/browser/fallback.md", bytes: 40 };
      return { path: "REVIEW/requests/fallback.md", status: "pending" };
    }
  });

  const result = await harness.actions.summarizeCurrentPageToArchive("no-such-template");

  assert.equal(result.ok, true);
  const chatCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/augmentor/chat");
  // Byte-for-byte the pre-existing default prompt: no provenance line, no page text.
  assert.equal(chatCall[2].body.messages[0].content, [
    "Summarize this browser page for Living Archive intake.",
    "Return concise markdown with:",
    "- What this page is",
    "- Key facts visible in the page",
    "- Why it may matter",
    "- Questions or uncertainties for review",
    "- Suggested wiki entities/concepts to consider"
  ].join("\n"));
  const intakeCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/intake");
  assert.equal(intakeCall[2].body.title, "Summary: Fallback Page");
});

test("browser page actions summarize current page with a chosen template sends the template prompt and labels the intake", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "Template Page",
      url: "https://example.test/template",
      text: "The page argues for quantum-resistant cryptography and notes some migration risks.",
      links: [],
      controls: [],
      fields: []
    },
    bridgeRequest: async (route) => {
      if (route === "/augmentor/chat") return { reply: "## TL;DR\nA page about cryptography migration.", model: "MiniMax-M3" };
      if (route === "/archive/intake") return { path: "INTAKE/browser/template.md", bytes: 120 };
      return { path: "REVIEW/requests/template.md", status: "pending" };
    }
  });

  const result = await harness.actions.summarizeCurrentPageToArchive("tldr");

  assert.equal(result.ok, true);
  assert.equal(result.reviewRequestPath, "REVIEW/requests/template.md");
  // The template prompt contract drove the user message: TL;DR marker + source grounding (title + url).
  const chatCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/augmentor/chat");
  assert.match(chatCall[2].body.messages[0].content, /TL;DR/);
  assert.match(chatCall[2].body.messages[0].content, /Template Page/);
  assert.match(chatCall[2].body.messages[0].content, /https:\/\/example\.test\/template/);
  // The intake is labelled with the template so a reviewer can see the shape.
  const intakeCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/intake");
  assert.equal(intakeCall[2].body.title, "Summary (TL;DR): Template Page");
  assert.equal(intakeCall[2].body.origin, "browser-page-summary");
  // No trusted write: every summary still hands off to review.
  const reviewCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/review/request");
  assert.equal(reviewCall[2].body.path, "INTAKE/browser/template.md");
});

test("browser page actions surface unsupported content for a media-only page with a structured template", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "Media Only",
      url: "https://example.test/media",
      text: "\n\n\n",
      links: [],
      controls: [],
      fields: []
    },
    bridgeRequest: async (route) => {
      if (route === "/augmentor/chat") return { reply: "should not be called", model: "MiniMax-M3" };
      if (route === "/archive/intake") return { path: "INTAKE/browser/media.md", bytes: 120 };
      return { path: "REVIEW/requests/media.md", status: "pending" };
    }
  });

  const result = await harness.actions.summarizeCurrentPageToArchive("tldr");

  assert.equal(result.ok, false);
  assert.match(result.error, /No readable page content for the TL;DR template/);
  // Skipped/unsupported content is visible to the user.
  assert.ok(harness.events.some((event) => event[0] === "message" && /no readable text/i.test(event[2]) && /TL;DR/i.test(event[2])));
  // No trusted write occurs for unsupported content: the chat model and the
  // archive intake are never touched, so no review handoff starts.
  assert.equal(harness.events.some((event) => event[0] === "bridge" && event[1] === "/augmentor/chat"), false);
  assert.equal(harness.events.some((event) => event[0] === "bridge" && event[1] === "/archive/intake"), false);
});

const trailTime = "2026-10-07T14:00:00.000Z";
const trailSavedPath = "INTAKE/browser/research-trail.md";
const trailReviewPath = "REVIEW/requests/research-trail.md";
const trailArchiveResponse = async (route) => route === "/archive/intake"
  ? { path: trailSavedPath, bytes: 300 }
  : { path: trailReviewPath, status: "pending" };

test("browser page actions save multi-tab research trail to reviewed intake", async () => {
  const times = ["2026-10-07T14:00:00.000Z", "2026-10-07T14:00:01.000Z"];
  let clockCalls = 0;
  const harness = createHarness({
    controlledTabId: 1,
    now: () => new Date(times[clockCalls++]),
    lastSnapshot: { title: "Stale", url: "https://stale.test/", text: "cached stale content" },
    tabs: [
      { id: 1, active: true, title: "Alpha", url: "https://alpha.test/?token=query-value#part" },
      { id: 2, active: false, title: "Beta", url: "https://beta.test/" },
      { id: 3, active: false, title: "Private extension title", url: "chrome-extension://abc/private-panel.html" }
    ],
    sendMessage: (_call, message, _options, tabId) => {
      assert.equal(message.type, "read_page");
      return {
        ok: true,
        snapshot: {
          title: tabId === 1 ? "Alpha" : "Beta",
          url: tabId === 1 ? "https://alpha.test/?token=query-value#part" : "https://beta.test/",
          text: tabId === 1 ? "Alpha research source text." : "Beta research source text.",
          links: [{ text: "Source", href: `https://${tabId === 1 ? "alpha" : "beta"}.test/source` }],
          controls: [], fields: [], frame: { isTop: true }
        }
      };
    },
    bridgeRequest: async (route) => route === "/archive/intake"
      ? { path: "INTAKE/browser/research-trail.md", bytes: 300 }
      : { path: "REVIEW/requests/research-trail.md", status: "pending" }
  });
  const result = await harness.actions.saveResearchTrailToArchive("ResonantOS market research");
  assert.equal(result.ok, true);
  assert.equal(result.pages, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.notCaptured, 1);
  assert.equal(result.reviewQueued, true);
  assert.equal(result.path, "INTAKE/browser/research-trail.md");
  assert.equal(result.reviewRequestPath, "REVIEW/requests/research-trail.md");
  assert.equal(clockCalls, 2);
  assert.equal(harness.events.filter((event) => event[0] === "sendMessage" && event[1] === "read_page").length, 2);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  const intake = calls[0][2];
  assert.equal(intake.method, "POST");
  assert.equal(intake.body.origin, "browser-research-trail");
  assert.equal(intake.body.title, "Research Trail: ResonantOS market research");
  assert.equal(intake.body.url, "https://alpha.test/");
  assert.match(intake.body.content, /- research question: ResonantOS market research/);
  assert.match(intake.body.content, /### 1\. Alpha/);
  assert.match(intake.body.content, /### 2\. Beta/);
  for (const time of times) assert.ok(intake.body.content.includes(`- captured at: ${time}`));
  assert.match(intake.body.content, /- Non-web tabs not captured: 1/);
  assert.doesNotMatch(intake.body.content, /Stale|cached stale content|query-value|Private extension title|private-panel/);
  assert.ok(intake.body.content.endsWith("Raw source material, queued for review. Nothing was written to trusted memory."));
  assert.equal(calls[1][2].method, "POST");
  assert.equal(calls[1][2].body.path, result.path);
  assert.match(calls[1][2].body.reason, /multi-page browser research trail/);
  assert.ok(harness.events.some((event) => event[0] === "message" &&
    event[2].includes("Saved a 2-page trail; 0 tabs skipped") &&
    event[2].includes(result.path) && event[2].includes("queued for review") &&
    event[2].includes("Next: open Living Archive > Review Queue")));
});

test("browser page actions report when research trail has no readable tabs", async () => {
  let clockCalls = 0;
  const harness = createHarness({
    now: () => { clockCalls += 1; return new Date("2026-10-07T14:00:00.000Z"); },
    tabs: [{ id: 1, active: true, title: "Extension", url: "chrome-extension://abc/panel.html" }]
  });
  const result = await harness.actions.saveResearchTrailToArchive("");
  assert.equal(result.ok, false);
  assert.equal(result.error, "No readable browser tabs available.");
  assert.equal(clockCalls, 0);
  assert.equal(harness.events.some((event) => event[0] === "sendMessage"), false);
  assert.deepEqual(harness.events.filter((event) => event[0] === "bridge").map((event) => event[1]), []);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2] ===
    "No readable browser tabs are available for a research trail. Open one or more normal web pages first."));
});

test("page understanding fixtures: the REAL content.js read_page extracts the expected context", async () => {
  // #218: prove extraction through the real content-mediation layer, not
  // jsdom's own textContent — same loading pattern as the #223 certification
  // fixtures: eval the real content scripts into the fixture page and route
  // read_page through the actual chrome.runtime.onMessage listener.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { JSDOM } = await import("jsdom");
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const ext = (...p2) => path.join(repoRoot, "browser-first", "resonantos-side-panel-extension", "src", ...p2);
  const contentScripts = [
    ext("lib", "control-overlay.js"),
    ext("lib", "content-field-safety.js"),
    ext("lib", "content-inline-actions.js"),
    ext("lib", "content-control-refs.js"),
    ext("content.js")
  ];
  async function readPageThroughRealLayer(fixtureRel) {
    const html = await readFile(path.join(repoRoot, fixtureRel), "utf8");
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://fixtures.test/" + fixtureRel, pretendToBeVisual: true });
    const win = dom.window;
    let listener = null;
    win.chrome = {
      runtime: { onMessage: { addListener(cb) { listener = cb; } }, sendMessage: () => Promise.resolve() },
      storage: { onChanged: { addListener() {} } }
    };
    win.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
    for (const scriptPath of contentScripts) win.eval(await readFile(scriptPath, "utf8"));
    assert.equal(typeof listener, "function", "content.js must register its message listener on " + fixtureRel);
    const snapshot = await new Promise((resolve) => {
      listener({ channel: "resonantos.browser_first.content", type: "read_page" }, {}, resolve);
    });
    return snapshot;
  }

  const article = await readPageThroughRealLayer("browser-first/test/fixtures/pages/article.html");
  assert.equal(article.ok, true);
  assert.match(article.snapshot.title, /Quantum Computing Breakthrough/);
  assert.match(article.snapshot.text, /256-qubit processor/, "real extractor must surface the article body");
  assert.match(article.snapshot.text, /Error rates are below 0.1%/);

  const pdfLike = await readPageThroughRealLayer("browser-first/test/fixtures/pages/pdf-like.html");
  assert.equal(pdfLike.ok, true);
  assert.match(pdfLike.snapshot.title, /Annual Report 2025/);
  assert.match(pdfLike.snapshot.text, /Revenue: \$2.34B/, "dense report text must survive extraction");

  const mediaOnly = await readPageThroughRealLayer("browser-first/test/fixtures/pages/media-only.html");
  assert.equal(mediaOnly.ok, true);
  assert.match(mediaOnly.snapshot.title, /Product Gallery/);
  const visible = String(mediaOnly.snapshot.text ?? "").trim();
  assert.ok(visible.length < 40, "media-only page yields no substantial visible text (got: " + visible.slice(0, 60) + ")");
});

for (const action of ["typeIntoActivePage", "clickActivePageText"]) {
  test(`D3: ${action} refusal is presented as a human handoff`, async () => {
    const reason = "This control was not recognised, so a human performs it on the page.";
    const harness = createHarness({
      sendMessage: () => ({ ok: false, approvalRequired: true, deniedToAutomation: true, humanHandoff: true, error: reason })
    });
    const result = await harness.actions[action]({ text: "Topic", field: "Topic", userApproved: true });
    assert.equal(result.humanHandoff, true);
    assert.ok(harness.events.some((event) => event[0] === "status" && event[1] === "Human action required"));
    assert.ok(harness.events.some((event) => event[0] === "message" && event[2] === `Human action required: ${reason}`));
    assert.ok(harness.events.some((event) => event[0] === "activity" && event[1] === "waiting-for-human"));
    assert.equal(harness.events.some((event) => event[0] === "status" && event[1] === "Page action failed"), false);
  });
}


test('recovery injection loads redaction immediately before context, plugins and resonator', async () => {
  const harness = createHarness({ sendMessage: (calls) => {
    if (calls === 1) throw new Error('Receiving end does not exist.');
    return { ok: true, snapshot: { title: 'Example', url: 'https://example.test/', text: 'hello' } };
  } });
  await harness.actions.readActivePage({ announce: false });
  const injections = harness.events.filter(([name]) => name === 'inject');
  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0][1].target, { tabId: 1 });
  assert.deepEqual(injections[0][1].files.slice(0, 4), [
    'src/lib/trace-redaction-core.js', 'src/lib/resonant-context.js',
    'src/lib/context-plugins.js', 'src/lib/resonator.js'
  ]);
});


test("capture is refused when site permissions cannot be read, even with includeBlocked", async () => {
  const harness = createHarness({ permissionForUrl: async () => { throw new Error("storage offline"); } });
  const tab = { id: 1, url: "https://example.test/" };
  for (const includeBlocked of [false, true]) {
    assert.deepEqual(await harness.actions.readSpecificTabPage(tab, { includeBlocked }), {
      ok: false, tab, error: "Site permissions could not be read; capture refused."
    });
  }
  assert.equal(harness.events.some(([type]) => ["sendMessage", "inject"].includes(type)), false);
});

test("a blocked site is still refused", async () => {
  const harness = createHarness({ permission: "blocked" });
  const tab = { id: 1, url: "https://example.test/" };
  assert.deepEqual(await harness.actions.readSpecificTabPage(tab), {
    ok: false, tab, error: "Assistant is blocked on example.test."
  });
  assert.equal(harness.events.some(([type]) => ["sendMessage", "inject"].includes(type)), false);
});

test("content actions refuse unreadable site permissions", async () => {
  const harness = createHarness({ permissionForUrl: async () => { throw new Error("storage offline"); } });
  assert.deepEqual(await harness.actions.sendContentAction({ type: "click" }), {
    ok: false, error: "Site permissions could not be read; capture refused."
  });
  assert.equal(harness.events.some(([type]) => ["sendMessage", "inject", "tab.reload"].includes(type)), false);
});

test("wallet detection refuses unreadable site permissions", async () => {
  const harness = createHarness({ permissionForUrl: async () => { throw new Error("storage offline"); } });
  for (const announce of [false, true]) {
    assert.deepEqual(await harness.actions.detectWalletState({ announce }), {
      ok: false, error: "Site permissions could not be read; capture refused."
    });
  }
  assert.equal(harness.events.filter(([type]) => type === "message").length, 1);
  assert.ok(harness.events.some(([type, role, message]) => type === "message" && message === "Site permissions could not be read; capture refused."));
  assert.equal(harness.events.some(([type]) => ["sendMessage", "inject"].includes(type)), false);
});

for (const field of ["text", "link text"]) {
  test(`archive summary #510 delta sanitizes ${field} before the model request`, async () => {
    const token = "bearer-token-value-0123456789";
    const header = `Authorization: Bearer ${token}`;
    const harness = createHarness({
      lastSnapshot: {
        title: "Summary Page", url: "https://example.test/summary",
        text: field === "text" ? header : "Readable page text.",
        links: [{ text: field === "link text" ? header : "Memory", href: "https://example.test/memory" }],
        controls: [], fields: []
      },
      bridgeRequest: async (route) => route === "/augmentor/chat"
        ? { reply: "A summary.", model: "MiniMax-M3" }
        : { path: "INTAKE/browser/summary.md", status: "pending" }
    });
    const result = await harness.actions.summarizeCurrentPageToArchive();
    assert.equal(result.ok, true);
    const call = harness.events.find((event) => event[0] === "bridge" && event[1] === "/augmentor/chat");
    assert.ok(call, "model request must be recorded");
    assert.equal(call[2].body.pageContext.includes(token), false);
    assert.match(call[2].body.pageContext, /Authorization: Bearer \[redacted\]/);
  });
}

test("archive summary #510 delta sanitizes the opt-in template prompt too", async () => {
  const token = "bearer-token-value-0123456789";
  const harness = createHarness({
    lastSnapshot: {
      title: "Summary Page", url: "https://example.test/summary",
      text: `Readable page text.\nAuthorization: Bearer ${token}\nMore readable text.`,
      links: [], controls: [], fields: []
    },
    bridgeRequest: async (route) => route === "/augmentor/chat"
      ? { reply: "A summary.", model: "MiniMax-M3" }
      : { path: "INTAKE/browser/summary.md", status: "pending" }
  });
  const result = await harness.actions.summarizeCurrentPageToArchive("tldr");
  assert.equal(result.ok, true);
  const call = harness.events.find((event) => event[0] === "bridge" && event[1] === "/augmentor/chat");
  assert.ok(call, "model request must be recorded");
  const prompt = call[2].body.messages[0].content;
  assert.match(prompt, /## Page text/, "the tldr template appends the page excerpt to the prompt");
  assert.equal(prompt.includes(token), false, "the excerpt must be sanitized");
  assert.match(prompt, /Authorization: Bearer \[redacted\]/);
  assert.equal(call[2].body.pageContext.includes(token), false);
});

test("archive summary #510 delta strips credentials from the url, title and link hrefs it sends to the model", async () => {
  const token = "bearer-token-value-0123456789";
  const harness = createHarness({
    lastSnapshot: {
      title: `Console — Authorization: Bearer ${token}`,
      url: `https://example.test/console?access_token=${token}`,
      text: "Readable page text.",
      links: [{ text: "Memory", href: `https://user:pass${token}@example.test/memory?auth=${token}#frag` }],
      controls: [], fields: []
    },
    bridgeRequest: async (route) => route === "/augmentor/chat"
      ? { reply: "A summary.", model: "MiniMax-M3" }
      : { path: "INTAKE/browser/summary.md", status: "pending" }
  });
  const result = await harness.actions.summarizeCurrentPageToArchive("tldr");
  assert.equal(result.ok, true);
  const call = harness.events.find((event) => event[0] === "bridge" && event[1] === "/augmentor/chat");
  assert.ok(call, "model request must be recorded");
  const sent = `${call[2].body.pageContext}\n${call[2].body.messages[0].content}`;
  assert.equal(sent.includes(token), false, "no token in anything sent to the model");
  assert.equal(sent.includes("user:pass"), false, "no userinfo in link hrefs");
  assert.match(sent, /https:\/\/example\.test\/console/, "the page url survives without its query");
  assert.match(sent, /https:\/\/example\.test\/memory/, "the link survives without userinfo, query or hash");
});

test("research trail every read fails with counts by reason and no archive calls", async () => {
  const harness = createHarness({
    now: () => new Date(trailTime),
    tabs: [
      { id: 1, title: "Blocked private", url: "https://blocked.test/private" },
      { id: 2, title: "Unknown private", url: "https://unknown.test/private" },
      { id: 3, title: "Failed", url: "https://failed.test/" },
      { id: 4, title: "Non-web private", url: "chrome://settings/" }
    ],
    permissionForUrl: async (url) => {
      if (url.includes("blocked.test")) return "blocked";
      if (url.includes("unknown.test")) throw new Error("storage unavailable");
      return "ask-before-action";
    },
    sendMessage: () => ({ ok: false, error: "frame unavailable" })
  });
  const result = await harness.actions.saveResearchTrailToArchive("evidence");
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 3);
  assert.deepEqual({ blocked: result.blocked, failed: result.failed }, { blocked: 2, failed: 1 });
  assert.doesNotMatch(JSON.stringify(result), /private|https?:/i, "the failure result carries counts, never tab titles or addresses");
  assert.deepEqual(harness.events.filter((event) => event[0] === "bridge").map((event) => event[1]), []);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2] ===
    "No readable browser tabs are available for a research trail. Open one or more normal web pages first.\n\nBlocked: 2; failed: 1; over the 8-tab limit: 0; non-web: 1."));
});

test("research trail some reads fail but a graded trail is saved and queued", async () => {
  const harness = createHarness({
    now: () => new Date(trailTime),
    tabs: [
      { id: 1, title: "Readable", url: "https://example.test/" },
      { id: 2, title: "Failed source", url: "https://failed.test/article?token=query-value#fragment" }
    ],
    sendMessage: (_call, _message, _options, tabId) => tabId === 1
      ? { ok: true, snapshot: { title: "Readable", url: "https://example.test/", text: "source text", frame: { isTop: true } } }
      : { ok: false, error: "frame unavailable" },
    bridgeRequest: trailArchiveResponse
  });
  const result = await harness.actions.saveResearchTrailToArchive("Which evidence?");
  assert.equal(result.ok, true);
  assert.equal(result.reviewQueued, true);
  assert.equal(result.pages, 1);
  assert.equal(result.skipped, 1);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  assert.ok(calls[0][2].body.content.includes("- Could not read: Failed source — https://failed.test/article — No readable frame returned page context."));
  assert.doesNotMatch(calls[0][2].body.content, /query-value|#fragment/);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2].startsWith("Saved a 1-page trail; 1 tabs skipped\n")));
});

test("research trail treats unreadable site permission as blocked and never reads that tab", async () => {
  const attemptedTabs = [];
  const harness = createHarness({
    now: () => new Date(trailTime),
    tabs: [
      { id: 1, title: "Readable", url: "https://example.test/" },
      { id: 2, title: "Unknown secret title", url: "https://unknown.test/private-unknown?token=query-value" },
      { id: 3, title: "Blocked secret title", url: "https://blocked.test/private-blocked" }
    ],
    permissionForUrl: async (url) => {
      if (url.includes("unknown.test")) throw new Error("storage unavailable");
      return url.includes("blocked.test") ? "blocked" : "ask-before-action";
    },
    sendMessage: (_call, _message, _options, tabId) => {
      attemptedTabs.push(tabId);
      return { ok: true, snapshot: { title: "Readable", url: "https://example.test/", text: "source text", frame: { isTop: true } } };
    },
    bridgeRequest: trailArchiveResponse
  });
  const result = await harness.actions.saveResearchTrailToArchive("permissions");
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 2);
  assert.deepEqual(attemptedTabs, [1]);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  const content = calls[0][2].body.content;
  assert.ok(content.includes("- Site permissions could not be read: unknown.test"));
  assert.ok(content.includes("- Blocked by your site permission: blocked.test"));
  assert.doesNotMatch(content, /Unknown secret title|Blocked secret title|private-unknown|private-blocked|query-value|capture refused/);
});

test("research trail captures only eight readable tabs and lists every over-limit tab", async () => {
  const attemptedTabs = [];
  let clockCalls = 0;
  const tabs = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, title: `Source ${i + 1}`, url: `https://source${i + 1}.test/article?token=query-value#fragment`
  }));
  const harness = createHarness({
    tabs: [{ id: 99, title: "Private non-web", url: "chrome://settings/private" }, ...tabs],
    now: () => { clockCalls += 1; return new Date(trailTime); },
    sendMessage: (_call, _message, _options, tabId) => {
      attemptedTabs.push(tabId);
      return { ok: true, snapshot: { ...tabs[tabId - 1], text: "source text", frame: { isTop: true } } };
    },
    bridgeRequest: trailArchiveResponse
  });
  const result = await harness.actions.saveResearchTrailToArchive("coverage");
  assert.equal(result.ok, true);
  assert.equal(result.pages, 8);
  assert.equal(result.skipped, 0);
  assert.equal(result.notCaptured, 3);
  assert.equal(clockCalls, 8);
  assert.deepEqual(attemptedTabs, [1, 2, 3, 4, 5, 6, 7, 8]);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  const content = calls[0][2].body.content;
  assert.ok(content.includes("sources captured: 8 · skipped: 0 · not captured: 3"));
  assert.ok(content.includes("- Over the 8-tab limit: Source 9 — https://source9.test/article"));
  assert.ok(content.includes("- Over the 8-tab limit: Source 10 — https://source10.test/article"));
  assert.ok(content.includes("- Non-web tabs not captured: 1"));
  assert.doesNotMatch(content, /Private non-web|settings\/private|query-value|#fragment/);
});

test("research trail intake failure reports nothing saved and never requests review", async () => {
  const harness = createHarness({
    now: () => new Date(trailTime),
    bridgeRequest: async () => { throw new Error("disk unavailable"); }
  });
  const result = await harness.actions.saveResearchTrailToArchive("evidence");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Could not save the research trail: disk unavailable. Nothing was saved.");
  assert.equal(result.path, undefined);
  assert.deepEqual(harness.events.filter((event) => event[0] === "bridge").map((event) => event[1]), ["/archive/intake"]);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2] === result.error));
});

test("research trail review failure preserves saved path and returns reviewQueued false", async () => {
  const harness = createHarness({
    now: () => new Date(trailTime),
    bridgeRequest: async (route) => {
      if (route === "/archive/intake") return { path: trailSavedPath, bytes: 300 };
      throw new Error("review unavailable");
    }
  });
  const result = await harness.actions.saveResearchTrailToArchive("evidence");
  assert.equal(result.ok, true);
  assert.equal(result.path, trailSavedPath);
  assert.equal(result.reviewQueued, false);
  assert.equal(result.reviewRequestPath, undefined);
  assert.equal(result.pages, 1);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  assert.equal(calls[1][2].body.path, trailSavedPath);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2] ===
    `Saved to ${trailSavedPath}, but it could not be queued for review; ask again with \`/trail\` or queue it from the archive.`));
  assert.equal(harness.events.some((event) => event[0] === "message" && event[2].includes("Nothing was saved.")), false);
});

test("research trail without question saves Browser research trail with none given", async () => {
  const harness = createHarness({ now: () => new Date(trailTime), bridgeRequest: trailArchiveResponse });
  // The router turns '/trail' into saveIntake('trail'), which calls this action.
  const result = await harness.actions.saveResearchTrailToArchive("");
  assert.equal(result.ok, true);
  assert.equal(result.reviewQueued, true);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  assert.equal(calls[0][2].body.title, "Browser research trail");
  assert.ok(calls[0][2].body.content.startsWith("# Browser research trail\n- research question: none given\n"));
});


test("research trail records a bare question exactly as typed, including a leading 'research'", async () => {
  const harness = createHarness({
    tabs: [{ id: 1, title: "Alpha", url: "https://alpha.test/" }],
    bridgeRequest: async (route) => route === "/archive/intake"
      ? { path: "INTAKE/browser/research-trail.md", status: "pending" }
      : { path: "REVIEW/requests/research-trail.md", status: "pending" }
  });
  await harness.actions.saveResearchTrailToArchive("research methods for coral reefs");
  const intake = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/intake");
  assert.ok(intake, "intake must be called");
  assert.match(intake[2].body.content, /- research question: research methods for coral reefs\n/);
  assert.equal(intake[2].body.title, "Research Trail: research methods for coral reefs");
});
