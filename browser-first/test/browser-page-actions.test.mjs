import assert from "node:assert/strict";
import test from "node:test";

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
    permissionForUrl: async () => overrides.permission ?? "ask-before-action",
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

test("browser page actions save multi-tab research trail to reviewed intake", async () => {
  const harness = createHarness({
    controlledTabId: 1,
    tabs: [
      { id: 1, active: true, title: "Alpha", url: "https://alpha.test/" },
      { id: 2, active: false, title: "Beta", url: "https://beta.test/" },
      { id: 3, active: false, title: "Side Panel", url: "chrome-extension://abc/panel.html" }
    ],
    sendMessage: (_call, message, _options, tabId) => {
      if (message.type !== "read_page") return { ok: false, error: "unexpected" };
      return {
        ok: true,
        snapshot: {
          title: tabId === 1 ? "Alpha" : "Beta",
          url: tabId === 1 ? "https://alpha.test/" : "https://beta.test/",
          text: tabId === 1 ? "Alpha research source text." : "Beta research source text.",
          links: [{ text: "Source", href: `https://${tabId === 1 ? "alpha" : "beta"}.test/source` }],
          controls: [],
          fields: [],
          frame: { isTop: true }
        }
      };
    },
    bridgeRequest: async (route) => route === "/archive/intake"
      ? { path: "INTAKE/browser/research-trail.md", bytes: 300 }
      : { path: "REVIEW/requests/research-trail.md", status: "pending" }
  });

  const result = await harness.actions.saveResearchTrailToArchive("trail ResonantOS market research");

  assert.equal(result.ok, true);
  assert.equal(result.pages, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.path, "INTAKE/browser/research-trail.md");
  assert.equal(result.reviewRequestPath, "REVIEW/requests/research-trail.md");
  const bridgeCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/intake");
  assert.equal(bridgeCall[2].body.origin, "browser-research-trail");
  assert.equal(bridgeCall[2].body.title, "Research Trail: ResonantOS market research");
  assert.match(bridgeCall[2].body.content, /Page 1: Alpha/);
  assert.match(bridgeCall[2].body.content, /Page 2: Beta/);
  assert.match(bridgeCall[2].body.content, /source material until the Living Archive review/);
  const reviewCall = harness.events.find((event) => event[0] === "bridge" && event[1] === "/archive/review/request");
  assert.equal(reviewCall[2].body.path, "INTAKE/browser/research-trail.md");
  assert.match(reviewCall[2].body.reason, /multi-page browser research trail/);
  assert.ok(harness.events.some((event) =>
    event[0] === "message" &&
    /2-page browser research trail/.test(event[2]) &&
    /Next: open Living Archive > Review Queue/.test(event[2])
  ));
});

test("browser page actions report when research trail has no readable tabs", async () => {
  const harness = createHarness({
    tabs: [{ id: 1, active: true, title: "Extension", url: "chrome-extension://abc/panel.html" }]
  });

  const result = await harness.actions.saveResearchTrailToArchive("trail");

  assert.equal(result.ok, false);
  assert.match(result.error, /No readable browser tabs/);
  assert.ok(harness.events.some((event) => event[0] === "message" && /No readable browser tabs/.test(event[2])));
});
