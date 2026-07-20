import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderAddOnsWorkspace } from "../resonantos-side-panel-extension/src/lib/main-workspace-addons.js";

test("add-ons workspace renders registry status and governed open actions", async () => {
  const dom = new JSDOM(`<main id="root"></main>`, { url: "https://example.test/" });
  globalThis.document = dom.window.document;
  const container = dom.window.document.querySelector("#root");
  const opened = [];
  const providerHandoffs = [];
  const calls = [];
  let draftStatus = "draft-only";
  let hermesExecution = false;
  let hermesStatus = "queued";
  let hermesResultArtifactPath = "";
  let openCodeExecution = false;
  let openCodeStatus = "queued";
  let openCodeResultArtifactPath = "";
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options.body ?? null]);
    if (route === "/addons/status") {
      return {
        addons: [
          {
            id: "addon.hermes",
            name: "Hermes",
            available: true,
            mode: "delegation-addon",
            trust: "add-on agent",
            requestedCapabilities: ["agent-delegation", "network", "notifications"],
            grantedCapabilities: ["agent-delegation"],
            deniedCapabilities: ["network"],
            execution: { localCliExecution: hermesExecution }
          },
          {
            id: "addon.opencode",
            name: "OpenCode",
            available: false,
            mode: "coding-addon",
            trust: "add-on agent",
            requestedCapabilities: ["agent-delegation", "filesystem-scoped", "shell", "providers"],
            grantedCapabilities: ["agent-delegation"],
            deniedCapabilities: openCodeExecution ? [] : ["shell"],
            execution: { localCliExecution: openCodeExecution }
          },
          {
            id: "addon.living-archive",
            name: "Living Archive",
            available: true,
            mode: "memory-system",
            trust: "host-mediated memory provider",
            requestedCapabilities: ["archive-read", "archive-intake-write", "archive-knowledge-write"],
            grantedCapabilities: ["archive-read", "archive-intake-write"],
            deniedCapabilities: ["archive-knowledge-write"]
          },
          {
            id: "addon.email",
            name: "Email",
            available: true,
            mode: "draft-only-communication-addon",
            trust: "host-mediated draft provider",
            requestedCapabilities: ["communication-draft", "provider-handoff", "external-send"],
            grantedCapabilities: ["communication-draft", "provider-handoff"],
            deniedCapabilities: ["external-send"]
          },
          {
            id: "addon.calendar",
            name: "Calendar",
            available: true,
            mode: "draft-only-scheduling-addon",
            trust: "host-mediated draft provider",
            requestedCapabilities: ["calendar-draft", "provider-handoff", "external-schedule"],
            grantedCapabilities: ["calendar-draft", "provider-handoff"],
            deniedCapabilities: ["external-schedule"]
          }
        ]
      };
    }
    if (route === "/addons/execution-settings") {
      assert.equal(options.capability, "addon-execution-settings-write");
      if (options.body.addon === "hermes") {
        hermesExecution = Boolean(options.body.localCliExecution);
      }
      if (options.body.addon === "opencode") {
        openCodeExecution = Boolean(options.body.localCliExecution);
      }
      return {
        addon: options.body.addon,
        status: options.body.localCliExecution ? "enabled" : "disabled"
      };
    }
    if (route === "/addons/draft/list") {
      return {
        drafts: [{
          id: "email-draft-a",
          intent: "Project update",
          path: "BrowserFirst/AddOnDrafts/email/email-draft-a.md",
          status: draftStatus,
          target: "email",
          updatedAt: "2026-05-29T10:00:00.000Z"
        }]
      };
    }
    if (route === "/addons/delegate/list") {
      return {
        delegations: [
          {
            id: "hermes-1",
            contextExcerpt: "Goal coordinate task across add-on agents.",
            hasContextPacket: true,
            mission: "Coordinate a bounded Hermes delegation.",
            path: "BrowserFirst/Delegations/hermes/hermes-1.md",
            resultArtifactPath: hermesResultArtifactPath,
            resultExcerpt: hermesResultArtifactPath ? "Hermes completed deterministic result." : "",
            sourceControlRunId: "",
            sourceKind: "resonantos-chat",
            status: hermesStatus,
            target: "hermes",
            updatedAt: "2026-05-29T10:01:00.000Z"
          },
          {
            id: "opencode-1",
            contextExcerpt: "Coding scope browser-first tests.",
            hasContextPacket: true,
            mission: "Inspect browser-first tests and return verification evidence.",
            path: "BrowserFirst/Delegations/opencode/opencode-1.md",
            resultArtifactPath: openCodeResultArtifactPath,
            resultExcerpt: openCodeResultArtifactPath ? "OpenCode completed deterministic result." : "",
            sourceControlRunId: "",
            sourceKind: "resonantos-chat",
            status: openCodeStatus,
            target: "opencode",
            updatedAt: "2026-05-29T10:00:30.000Z"
          },
          {
            id: "engineer-1",
            contextExcerpt: "Goal find a booking slot. Blocked step Submit. Public submit requires approval.",
            hasContextPacket: true,
            mission: "Investigate blocked browser-control task.",
            path: "BrowserFirst/Delegations/engineer/engineer-1.md",
            sourceControlRunId: "job-1",
            sourceKind: "browser-control-blocker",
            status: "queued",
            target: "engineer",
            updatedAt: "2026-05-29T10:00:00.000Z"
          }
        ]
      };
    }
    if (route === "/hermes/delegation/start") {
      assert.equal(options.body.path, "BrowserFirst/Delegations/hermes/hermes-1.md");
      hermesStatus = "completed";
      hermesResultArtifactPath = "BrowserFirst/DelegationArtifacts/hermes/hermes-1-result.md";
      return {
        id: "hermes-1",
        path: options.body.path,
        resultArtifactPath: hermesResultArtifactPath,
        status: hermesStatus
      };
    }
    if (route === "/hermes/delegation/artifact") {
      assert.equal(options.body.path, "BrowserFirst/Delegations/hermes/hermes-1.md");
      return {
        content: "# Hermes Result\n\n## Final Summary\nHermes completed deterministic result.",
        finalSummary: "Hermes completed deterministic result.",
        path: hermesResultArtifactPath
      };
    }
    if (route === "/hermes/delegation/cancel") {
      hermesStatus = "cancelled";
      return { id: "hermes-1", path: options.body.path, status: hermesStatus };
    }
    if (route === "/opencode/delegation/start") {
      assert.equal(options.body.path, "BrowserFirst/Delegations/opencode/opencode-1.md");
      openCodeStatus = "completed";
      openCodeResultArtifactPath = "BrowserFirst/DelegationArtifacts/opencode/opencode-1-result.md";
      return {
        id: "opencode-1",
        path: options.body.path,
        resultArtifactPath: openCodeResultArtifactPath,
        status: openCodeStatus
      };
    }
    if (route === "/opencode/delegation/artifact") {
      assert.equal(options.body.path, "BrowserFirst/Delegations/opencode/opencode-1.md");
      return {
        content: "# OpenCode Result\n\n## Final Summary\nOpenCode completed deterministic result.",
        finalSummary: "OpenCode completed deterministic result.",
        path: openCodeResultArtifactPath
      };
    }
    if (route === "/opencode/delegation/cancel") {
      openCodeStatus = "cancelled";
      return { id: "opencode-1", path: options.body.path, status: openCodeStatus };
    }
    if (route === "/addons/draft/transition") {
      draftStatus = options.body.status;
      return { id: "email-draft-a", status: draftStatus };
    }
    if (route === "/addons/draft/handoff") {
      return {
        handoff: {
          action: "manual-review-compose",
          boundary: "Opens a Gmail compose draft for human review. ResonantOS does not send the email.",
          provider: options.body.provider,
          target: "email",
          url: "https://mail.google.com/mail/?view=cm&fs=1&su=Project+update&body=Ready"
        },
        id: "email-draft-a",
        status: draftStatus
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  renderAddOnsWorkspace({
    container,
    bridgeRequest,
    onOpenProviderHandoff: (handoff, draft) => providerHandoffs.push([handoff, draft.id]),
    onOpenWorkspace: (workspaceId) => opened.push(workspaceId)
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls.map((call) => call[0]), ["/addons/status", "/addons/delegate/list", "/addons/draft/list"]);
  assert.match(container.textContent, /Replaceable capabilities, explicit trust/);
  assert.match(container.textContent, /5 add-ons visible/);
  assert.match(container.textContent, /Hermes/);
  assert.match(container.textContent, /OpenCode/);
  assert.match(container.textContent, /Living Archive/);
  assert.match(container.textContent, /Email/);
  assert.match(container.textContent, /Calendar/);
  assert.match(container.textContent, /not trusted core agents/i);
  assert.match(container.textContent, /Direct trusted wiki writes remain blocked/);
  assert.match(container.textContent, /Sending and scheduling remain human-approval gated/);
  assert.match(container.textContent, /Grantedagent-delegation/);
  assert.match(container.textContent, /Needs reviewnotifications/);
  assert.match(container.textContent, /Deniednetwork/);
  assert.match(container.textContent, /archive-knowledge-write/);
  assert.match(container.textContent, /Local CLI execution disabled/);
  assert.match(container.textContent, /Draft approval/);
  assert.match(container.textContent, /Delegation packets/);
  assert.match(container.textContent, /Agent handoffs/);
  assert.match(container.textContent, /engineer-1/);
  assert.match(container.textContent, /browser-control-blocker · control run job-1/);
  assert.match(container.textContent, /Context packet: Goal find a booking slot/);
  assert.match(container.textContent, /3 delegation packets recorded/);
  assert.match(container.textContent, /Hermes · hermes-1/);
  assert.match(container.textContent, /Coordinate a bounded Hermes delegation/);
  assert.match(container.textContent, /OpenCode · opencode-1/);
  assert.match(container.textContent, /Inspect browser-first tests/);
  assert.match(container.textContent, /Project update/);
  assert.match(container.textContent, /provider draft surfaces for human review only/);
  const buttons = [...container.querySelectorAll(".addon-card > .addon-card-actions button")];
  assert.equal(buttons.length, 3);
  assert.equal(buttons.find((button) => /OpenCode/.test(button.textContent)).disabled, true);
  buttons.find((button) => /Hermes/.test(button.textContent)).click();
  buttons.find((button) => /Living Archive/.test(button.textContent)).click();
  assert.deepEqual(opened, ["hermes", "memory"]);

  const enableHermes = [...container.querySelectorAll(".addon-execution-panel button")]
    .find((button) => /Enable local execution/.test(button.textContent));
  assert.equal(enableHermes.disabled, false);
  enableHermes.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.some((call) =>
    call[0] === "/addons/execution-settings" &&
    call[1].addon === "hermes" &&
    call[1].localCliExecution === true
  ));
  assert.match(container.textContent, /Local CLI execution enabled/);
  assert.match(container.textContent, /Disable local execution/);

  const startHermes = [...container.querySelectorAll(".addon-delegation-card button")]
    .find((button) => /Start Hermes/.test(button.textContent));
  assert.equal(startHermes.disabled, false);
  startHermes.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.some((call) => call[0] === "/hermes/delegation/start"));
  assert.match(container.textContent, /Hermes completed deterministic result/);

  const readHermes = [...container.querySelectorAll(".addon-delegation-card button")]
    .find((button) => /Read Result/.test(button.textContent));
  assert.equal(readHermes.disabled, false);
  readHermes.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.some((call) => call[0] === "/hermes/delegation/artifact"));
  assert.match(container.textContent, /Hermes result · hermes-1/);

  const startOpenCode = [...container.querySelectorAll(".addon-delegation-card button")]
    .find((button) => /Start OpenCode/.test(button.textContent));
  assert.equal(startOpenCode.disabled, false);
  startOpenCode.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.some((call) => call[0] === "/opencode/delegation/start"));
  assert.match(container.textContent, /OpenCode completed deterministic result/);

  const readOpenCode = [...container.querySelectorAll(".addon-delegation-card button")]
    .filter((button) => /Read Result/.test(button.textContent))
    .at(-1);
  assert.equal(readOpenCode.disabled, false);
  readOpenCode.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.some((call) => call[0] === "/opencode/delegation/artifact"));
  assert.match(container.textContent, /OpenCode result · opencode-1/);

  container.querySelector(".addon-draft-card button").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.some((call) => call[0] === "/addons/draft/transition" && call[1].status === "approved-for-manual-send"));
  assert.match(container.textContent, /approved-for-manual-send/);

  const handoffButton = [...container.querySelectorAll(".addon-draft-card button")].find((button) => /Gmail/.test(button.textContent));
  assert.equal(handoffButton.disabled, false);
  handoffButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.some((call) => call[0] === "/addons/draft/handoff" && call[1].provider === "gmail"));
  assert.equal(providerHandoffs[0][0].provider, "gmail");
  assert.equal(providerHandoffs[0][1], "email-draft-a");
});

test("add-ons workspace reports bridge failures without exposing secrets", async () => {
  const dom = new JSDOM(`<main id="root"></main>`, { url: "https://example.test/" });
  globalThis.document = dom.window.document;
  const container = dom.window.document.querySelector("#root");

  renderAddOnsWorkspace({
    container,
    bridgeRequest: async () => {
      throw new Error("host unavailable token=abc123 sk-settings-secret");
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(container.textContent, /Add-on registry unavailable: host unavailable/);
  assert.match(container.textContent, /Delegation review unavailable: host unavailable/);
  assert.match(container.textContent, /Draft review unavailable: host unavailable/);
  assert.equal(container.querySelector(".addons-status").dataset.tone, "error");
  assert.doesNotMatch(container.textContent, /abc123|sk-settings-secret/i);
});

test("add-ons workspace replaces raw bridge fetch failures with setup guidance", async () => {
  const dom = new JSDOM(`<main id="root"></main>`, { url: "https://example.test/" });
  globalThis.document = dom.window.document;
  const container = dom.window.document.querySelector("#root");

  renderAddOnsWorkspace({
    container,
    bridgeRequest: async () => {
      throw new TypeError("Failed to fetch");
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(container.textContent, /Add-on registry unavailable: ResonantOS bridge is unreachable/);
  assert.match(container.textContent, /Delegation review unavailable: ResonantOS bridge is unreachable/);
  assert.match(container.textContent, /Draft review unavailable: ResonantOS bridge is unreachable/);
  assert.match(container.textContent, /Settings > Bridge Target/);
  assert.doesNotMatch(container.textContent, /Failed to fetch/);
});
