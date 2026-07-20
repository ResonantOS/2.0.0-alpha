import {
  parseDraftAddonCommand,
} from "./app-command-handlers.js";
import {
  normalizeBrowserUrl,
  parseAmazonShoppingTask,
  parseNaturalBrowserIntent
} from "./browser-command-parser.js";
import { delegationTargetLabel, startDelegationLifecycle } from "./delegation-lifecycle.js";
import { buildDelegationStatusMessage } from "./delegation-status.js";
import { buildHermesRuntimeStatusMessage } from "./addon-runtime-status.js";
import {
  pageContextForSnapshot,
  runtimeContextForAttachments
} from "./chat-turn-controller.js";
import { runReviewableCapture } from "./main-workspace-review-handoff.js";
import {
  mainWorkspaceRequestMessage,
  regenerationMessage
} from "./runtime-error-messages.js";
import {
  parseDaoSlashCommand,
  parseDraftSlashCommand,
  parseHermesSlashCommand,
  parseMemorySlashCommand,
  parseOpenCodeSlashCommand,
  parseControlSlashCommand,
  planMainWorkspacePrompt
} from "./main-workspace-prompt-router.js";

const assistantTextFromResponse = (response) => String(response?.content ?? response?.reply ?? "").trim();

const providerMessagesFromHistory = (messages, limit = 18) => messages
  .filter((message) => ["user", "assistant"].includes(message.role))
  .slice(-limit)
  .map((message) => ({ role: message.role, content: message.content }));

const formatList = (items, fallback = "None detected") => {
  const values = Array.isArray(items) ? items.map((item) => {
    if (typeof item === "string") return item;
    const label = String(item?.label ?? item?.name ?? item?.id ?? "").trim();
    const detail = String(item?.detail ?? item?.reason ?? "").trim();
    const count = Number.isFinite(Number(item?.count)) ? ` (${Number(item.count)})` : "";
    return [label ? `${label}${count}` : "", detail].filter(Boolean).join(" - ");
  }).filter(Boolean) : [];
  return values.length ? values.join(", ") : fallback;
};

const formatWorkspaceInspectionMessage = (report) => [
  "Workspace inspection completed.",
  `Project: ${[report?.project?.name, report?.project?.version].filter(Boolean).join(" ") || "ResonantOS workspace"}`,
  `Languages: ${formatList(report?.languages)}`,
  `Frameworks: ${formatList(report?.frameworks)}`,
  `Runtimes: ${formatList(report?.runtimes)}`,
  `Package managers: ${formatList(report?.packageManagers)}`,
  `Evidence: ${formatList(report?.evidence, "Metadata scan completed")}`,
  "Boundary: read-only workspace metadata scan. No OpenCode/Hermes delegation, shell execution, provider secrets, wallet actions, or trusted memory writes were used."
].join("\n");

export function createMainWorkspaceActionController({
  addMessage,
  bridgeRequest,
  // Optional getter for late-bound bridge clients. The extension's
  // rebind chain sets the module-level `bridgeRequest` *after* this
  // controller is constructed, so passing a value here captures a
  // stale `null`. Callers that pass a getter get the current value
  // on every call. When both are present, the getter wins.
  getBridgeRequest,
  browserPageActions,
  chatSessionStore,
  chromeApi,
  commandInput,
  composerController,
  composerNotice,
  getBusy,
  getLastSnapshot = () => null,
  getModel,
  getPersonalizationSettings,
  getThinkingDepth,
  openMemoryReviewQueue,
  openSidebar,
  persistActiveWorkspace,
  renderAll,
  setActiveWorkspace,
  setComposerBusy,
  setPendingWorkspaceAction,
  updateConnectionLine
}) {
  // Resolve the bridgeRequest at call time. Falls back to the
  // captured value if no getter is provided (legacy callers).
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  let activeChatAbortController = null;

  async function handoffToBrowserControl(prompt) {
    const controlGoal = parseControlSlashCommand(prompt);
    const goal = controlGoal !== null ? controlGoal : prompt;
    const amazon = parseAmazonShoppingTask(goal);
    const browserIntent = parseNaturalBrowserIntent(goal);
    const target = amazon?.url || browserIntent?.target || "";
    await chromeApi.storage.local.set({
      augmentorPendingSidebarPrompt: {
        prompt: `/control ${goal}`.trim(),
        createdAt: new Date().toISOString()
      }
    });
    await addMessage("system", "Moving this task into browser control mode. Augmentor will continue from the sidebar while the page stays in the main browser workspace.");
    const targetUrl = target ? normalizeBrowserUrl(target) : "";
    const handoff = await chromeApi.runtime?.sendMessage?.({
      channel: "resonantos.browser_first",
      type: "browser_control_handoff",
      targetUrl
    }).catch(() => null);
    if (handoff?.ok) {
      return;
    }
    if (targetUrl) {
      await chromeApi.tabs.update({ url: targetUrl }).catch(() => undefined);
    }
    await openSidebar();
  }

  async function runChatTurn(prompt) {
    activeChatAbortController = new AbortController();
    updateConnectionLine("Thinking");
    try {
      const attachments = typeof chatSessionStore.getAttachments === "function"
        ? chatSessionStore.getAttachments()
        : [];
      const response = await bridge()("/augmentor/chat", {
        method: "POST",
        signal: activeChatAbortController.signal,
        body: {
          model: getModel(),
          surface: "main-workspace",
          workload: "augmentor-chat",
          thinkingDepth: getThinkingDepth(),
          systemPrompt: getPersonalizationSettings()?.augmentor?.systemPrompt ?? "",
          pageContext: pageContextForSnapshot(getLastSnapshot()),
          runtimeContext: runtimeContextForAttachments(attachments),
          messages: providerMessagesFromHistory(chatSessionStore.getMessages())
        }
      });
      await addMessage("assistant", assistantTextFromResponse(response) || "No response was returned.", {
        usage: response?.usage ?? null
      });
      // Make a route fallback visible on the main-workspace surface too, matching
      // the side panel: a preferred model was unavailable and another answered.
      if (response?.routeFallback && response?.routeNotice) {
        await addMessage("system", response.routeNotice);
      }
      updateConnectionLine("Ready");
    } catch (error) {
      if (error?.name === "AbortError") {
        updateConnectionLine("Stopped");
        await addMessage("system", "Response stopped by the human before a reply was returned.");
        return;
      }
      throw error;
    } finally {
      activeChatAbortController = null;
    }
  }

  async function runHermesDelegation(prompt) {
    const mission = parseHermesSlashCommand(prompt);
    if (/^(?:status|health|runtime)$/i.test(mission)) {
      updateConnectionLine("Checking Hermes");
      await addMessage("system", await buildHermesRuntimeStatusMessage({ bridgeRequest: bridge() }));
      updateConnectionLine("Ready");
      return;
    }
    if (!mission) {
      setActiveWorkspace("hermes", { persist: true });
      renderAll();
      await addMessage("system", "Opened Hermes workspace. Use `/hermes <mission>` when you want Augmentor to create a governed delegation packet.");
      return;
    }
    if (mission.length < 8) {
      await addMessage("system", "Use `/hermes <mission>` with a clear mission to create a governed Hermes delegation packet.");
      return;
    }
    updateConnectionLine("Delegating");
    const result = await bridge()("/addons/delegate", {
      method: "POST",
      body: { target: "hermes", mission }
    });
    const lifecycle = await startDelegationLifecycle(result, { bridgeRequest: bridge() });
    await addMessage("system", `Delegation queued for Hermes: ${result.id}\n${result.path}${lifecycle}`);
    updateConnectionLine("Ready");
  }

  async function runNaturalDelegation(intent) {
    if (!intent || intent.missingTarget) {
      await addMessage(
        "system",
        "I can delegate through the ResonantOS agent control layer. Choose Hermes for general agent work, OpenCode for coding, or Resonant Engineer for system repair."
      );
      return;
    }
    if (intent.mission.length < 8) {
      await addMessage("system", `Give ${delegationTargetLabel(intent.target)} a concrete mission before I create the delegation packet.`);
      return;
    }
    updateConnectionLine(`Delegating to ${delegationTargetLabel(intent.target)}`);
    const result = await bridge()("/addons/delegate", {
      method: "POST",
      body: { target: intent.target, mission: intent.mission }
    });
    const lifecycle = await startDelegationLifecycle(result, { bridgeRequest: bridge() });
    await addMessage(
      "system",
      [
        `Delegation queued for ${delegationTargetLabel(result.target)}: ${result.id}`,
        result.path,
        "Boundary: the add-on receives a governed task packet. ResonantOS keeps provider secrets, wallet actions, and trusted memory writes mediated.",
        lifecycle
      ].join("\n")
    );
    updateConnectionLine("Ready");
  }

  async function runDelegationsCommand(filter = "") {
    updateConnectionLine("Checking delegations");
    const message = await buildDelegationStatusMessage({ bridgeRequest: bridge(), filter, limit: 6 });
    await addMessage("system", message);
    updateConnectionLine("Ready");
  }

  async function runWorkspaceInspectionCommand() {
    updateConnectionLine("Inspecting workspace");
    const result = await bridge()("/workspace/inspect", { method: "GET" });
    await addMessage("system", formatWorkspaceInspectionMessage(result));
    updateConnectionLine("Ready");
  }

  async function runMemoryCommand(prompt) {
    const query = parseMemorySlashCommand(prompt);
    setActiveWorkspace("memory", { persist: true });
    setPendingWorkspaceAction(query ? { workspace: "memory", query } : null);
    renderAll();
    await chatSessionStore.addMessage(
      "system",
      query
        ? `Opened Living Archive and searched AI Memory for: ${query}`
        : "Opened Living Archive workspace. Use `/memory <query>` to search AI Memory directly.",
      { persist: true }
    );
  }

  async function runOpenCodeCommand(prompt) {
    const mission = parseOpenCodeSlashCommand(prompt);
    setActiveWorkspace("opencode", { persist: true });
    setPendingWorkspaceAction(mission ? { workspace: "opencode", mission } : null);
    renderAll();
    await chatSessionStore.addMessage(
      "system",
      mission
        ? `Opened OpenCode and created a governed delegation for: ${mission}`
        : "Opened OpenCode workspace. Use `/opencode <mission>` to create a governed coding handoff.",
      { persist: true }
    );
  }

  async function runDraftAddonCommand(prompt) {
    const command = parseDraftSlashCommand(prompt);
    if (!command) return false;
    const draft = parseDraftAddonCommand(command.target, command.body);
    if (!draft) {
      await addMessage(
        "system",
        `Use \`/${command.target} <intent> | body: <draft text>\`. ${command.target === "email" ? "Sending" : "Scheduling"} remains human-approval gated.`
      );
      return true;
    }
    updateConnectionLine("Drafting");
    const result = await bridge()("/addons/draft", {
      method: "POST",
      body: draft
    });
    await addMessage(
      "system",
      `${draft.target === "email" ? "Email" : "Calendar"} draft created: ${result.id}\n${result.path}\n${draft.target === "email" ? "Sending email" : "Scheduling calendar events"} is not automated from chat. Review and approve through the add-on approval flow.`
    );
    updateConnectionLine("Ready");
    return true;
  }

  async function runWalletStatusCommand() {
    const result = await browserPageActions.detectWalletState({ announce: true });
    if (!result?.ok) {
      updateConnectionLine("Wallet status unavailable");
    }
  }

  async function runDaoWorkflowCommand(prompt) {
    const command = parseDaoSlashCommand(prompt);
    if (command?.action === "audit") {
      await browserPageActions.saveWalletDaoAuditToArchive(command.goal);
      return;
    }
    await browserPageActions.prepareDaoWorkflowGuidance(command?.goal ?? "");
  }

  async function runIntakeCommand(command) {
    const reviewOptions = { noticeContainer: composerNotice, onOpenReviewQueue: openMemoryReviewQueue };
    if (command?.action === "selection") {
      await runReviewableCapture(() => browserPageActions.saveSelectionToArchive(), reviewOptions);
      return;
    }
    if (command?.action === "summary") {
      await runReviewableCapture(() => browserPageActions.summarizeCurrentPageToArchive(), reviewOptions);
      return;
    }
    if (command?.action === "trail") {
      await runReviewableCapture(() => browserPageActions.saveResearchTrailToArchive(command.body), reviewOptions);
      return;
    }
    await runReviewableCapture(() => browserPageActions.saveCurrentPageToArchive(), reviewOptions);
  }

  async function runPrompt(prompt) {
    const promptPlan = planMainWorkspacePrompt(prompt);
    if (promptPlan.action === "memory") {
      await runMemoryCommand(prompt);
    } else if (promptPlan.action === "opencode") {
      await runOpenCodeCommand(prompt);
    } else if (promptPlan.action === "hermes") {
      await runHermesDelegation(prompt);
    } else if (promptPlan.action === "delegate") {
      await runNaturalDelegation(promptPlan.intent);
    } else if (promptPlan.action === "delegations") {
      await runDelegationsCommand(promptPlan.filter);
    } else if (promptPlan.action === "workspace-inspection") {
      await runWorkspaceInspectionCommand();
    } else if (promptPlan.action === "wallet") {
      const command = promptPlan.command;
      if (command?.action === "audit") {
        await browserPageActions.saveWalletDaoAuditToArchive(command.goal);
      } else {
        await runWalletStatusCommand();
      }
    } else if (promptPlan.action === "dao") {
      await runDaoWorkflowCommand(prompt);
    } else if (promptPlan.action === "intake") {
      await runIntakeCommand(promptPlan.command);
    } else if (promptPlan.action === "draft" && await runDraftAddonCommand(prompt)) {
      // Draft-only communication/scheduling packets are handled locally.
    } else if (promptPlan.action === "control") {
      await handoffToBrowserControl(prompt);
    } else {
      await runChatTurn(prompt);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (getBusy()) return;
    const prompt = commandInput.value.trim();
    if (!prompt) return;
    setComposerBusy(true);
    try {
      await addMessage("user", prompt);
      commandInput.value = "";
      composerController.resetUndoStack("");
      await runPrompt(prompt);
    } catch (error) {
      await addMessage("system", mainWorkspaceRequestMessage(error));
      updateConnectionLine("Failed");
    } finally {
      setComposerBusy(false);
    }
  }

  async function regenerate(prompt) {
    if (getBusy()) return;
    setComposerBusy(true);
    try {
      await runChatTurn(prompt);
    } catch (error) {
      await addMessage("system", regenerationMessage(error));
      updateConnectionLine("Failed");
    } finally {
      setComposerBusy(false);
    }
  }

  function abortActiveChat() {
    activeChatAbortController?.abort();
  }

  return {
    abortActiveChat,
    handleSubmit,
    regenerate,
    runChatTurn,
    runPrompt
  };
}
