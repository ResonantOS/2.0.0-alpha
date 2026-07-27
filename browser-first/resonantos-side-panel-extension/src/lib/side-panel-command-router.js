import { parseNaturalDelegationIntent } from "./app-command-handlers.js";
import {
  parseAutonomousBrowserActionIntent,
  parseBrowserNavigationTaskIntent,
  parseClickIntent,
  parseControlContinuationIntent,
  parseControlIntent,
  parseFormsIntent,
  parseNaturalBrowserIntent,
  parseNaturalSearchIntent,
  parseReadPageIntent,
  parseScrollIntent,
  parseStructuredPageEditIntent,
  parseSummarizePageIntent,
  parseTypeIntent
} from "./browser-command-parser.js";

export function createSidePanelCommandRouter(handlers) {
  async function respondToCommand(value) {
    await handlers.bindMentionedTab(value);
    const slash = /^\/\s*([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(value.trim());
    if (slash) {
      const name = slash[1].toLowerCase();
      const body = (slash[2] ?? "").trim();
      if (name === "goal") return handlers.runGoalCommand(body);
      if (name === "hermes" && /^(?:status|health|runtime)?$/i.test(body)) return handlers.runHermesStatusCommand();
      if (name === "hermes") return handlers.runDelegateCommand(`hermes ${body}`);
      if (name === "email") return handlers.runDraftAddonCommand("email", body);
      if (name === "calendar") return handlers.runDraftAddonCommand("calendar", body);
      if (name === "delegate") return handlers.runDelegateCommand(body);
      if (name === "delegations" || name === "handoffs") return handlers.runDelegationsCommand(body);
      if (name === "status") return handlers.runStatusCommand();
      if (name === "site") return handlers.runSitePermissionCommand(body);
      if (name === "memory") return handlers.runMemorySearchCommand(body);
      if (name === "history") return handlers.runHistorySearchCommand(body);
      if (name === "wallet" && /^audit\b/i.test(body)) {
        return handlers.saveWalletDaoAuditToArchive(body.replace(/^audit\b/i, "").trim());
      }
      if (name === "wallet") return handlers.runWalletStatusCommand(body);
      if (name === "capabilities" || name === "permissions") return handlers.runCapabilitiesCommand();
      if (name === "jobs") return handlers.runJobsCommand(body);
      if (name === "pause") return handlers.pauseBrowserJob(body);
      if (name === "resume") return handlers.resumeBrowserJob(body);
      if (name === "continue") return handlers.continueBrowserJob(body);
      if (name === "report") return handlers.reportBrowserJob(body);
      if (name === "cancel") return handlers.cancelBrowserJob(body);
      if (name === "approve-control") return handlers.approveControlPreflight(body);
      if (name === "allow-control-once") return handlers.allowControlPreflightOnceForTaskClass(body);
      if (name === "deny-control") return handlers.denyControlPreflight(body);
      if (["arrow", "clear", "highlight", "spotlight", "step"].includes(name)) {
        return handlers.runResonatorCommand(name, body);
      }
      if (name === "browser") return handlers.runBrowserCommand(body);
      if (name === "control") return handlers.runControlCommand(body);
      if (name === "save" || name === "archive" || name === "intake") return handlers.saveIntake(body);
      if (name === "trail" || name === "researchtrail") return handlers.saveIntake(`trail ${body}`.trim());
      if (name === "dao" && /^audit\b/i.test(body)) {
        return handlers.saveWalletDaoAuditToArchive(body.replace(/^audit\b/i, "").trim());
      }
      if (name === "dao") return handlers.prepareDaoWorkflowGuidance(body);
    }

    // "try again" / "continue" / "retry" after a resumed run continues that run
    // instead of falling to chat and demanding /control. Gated on there being a
    // resumable run so a stray "continue" in pure chat still reaches the model.
    if (parseControlContinuationIntent(value) && handlers.hasResumableControlRun?.()) {
      return handlers.continueBrowserJob("");
    }

    const controlIntent = parseControlIntent(value);
    if (controlIntent) return handlers.runControlCommand(controlIntent.goal);

    // Compound "go to <site> and <act>" tasks route to agent control before the
    // single-action fast paths can swallow the "<act>" half against the wrong page.
    const navigationTaskIntent = parseBrowserNavigationTaskIntent(value);
    if (navigationTaskIntent) return handlers.runControlCommand(navigationTaskIntent.goal);

    const delegationIntent = parseNaturalDelegationIntent(value);
    if (delegationIntent) {
      if (typeof handlers.runNaturalDelegationCommand === "function") {
        return handlers.runNaturalDelegationCommand(delegationIntent);
      }
      if (!delegationIntent.missingTarget && delegationIntent.target && typeof handlers.runDelegateCommand === "function") {
        const mission = delegationIntent.mission ? ` ${delegationIntent.mission}` : "";
        return handlers.runDelegateCommand(`${delegationIntent.target}${mission}`.trim());
      }
    }

    const typeIntent = parseTypeIntent(value);
    if (typeIntent) return handlers.typeIntoActivePage(typeIntent);

    const clickIntent = parseClickIntent(value);
    if (clickIntent) return handlers.clickActivePageText(clickIntent);

    // A bare "summarize" / "tldr" / "recap" reads the current page and lets the
    // model summarize it — an LLM summary that matches the inline Summarize,
    // with no /control needed. This sits before the generic read intent so a
    // summarize verb never falls to the title+excerpt acknowledgement below.
    const summarizePageIntent = parseSummarizePageIntent(value);
    if (summarizePageIntent) return handlers.summarizeActivePage();

    const readPageIntent = parseReadPageIntent(value);
    if (readPageIntent) return handlers.summarizeSnapshot();

    const scrollIntent = parseScrollIntent(value);
    if (scrollIntent) return handlers.scrollActivePage(scrollIntent);

    const formsIntent = parseFormsIntent(value);
    if (formsIntent) return handlers.detectActivePageForms();

    const searchIntent = parseNaturalSearchIntent(value);
    if (searchIntent) return handlers.searchBrowser(searchIntent);

    const autonomousBrowserActionIntent = parseAutonomousBrowserActionIntent(value);
    if (autonomousBrowserActionIntent) return handlers.runControlCommand(autonomousBrowserActionIntent.goal);

    const structuredEditIntent = parseStructuredPageEditIntent(value);
    if (structuredEditIntent) return handlers.explainStructuredPageEditBoundary(structuredEditIntent.instruction);

    const browserIntent = parseNaturalBrowserIntent(value);
    if (browserIntent) return handlers.openBrowserUrl(browserIntent.target);

    if (/^\/(read|context)\b/i.test(value) || /^\/(summari[sz]e)\b/i.test(value)) {
      return handlers.summarizeSnapshot();
    }

    if (/wallet|phantom|seed phrase|private key/i.test(value)) {
      return handlers.handleWalletBoundary();
    }

    return handlers.runChatTurn();
  }

  return {
    respondToCommand
  };
}
