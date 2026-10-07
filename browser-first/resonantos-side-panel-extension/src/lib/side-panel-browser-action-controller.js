import { normalizeSearchQuery, parseQuotedText } from "./browser-command-parser.js";

export function createSidePanelBrowserActionController({
  addMessage = async () => undefined,
  clickActivePageText = async () => undefined,
  detectActivePageForms = async () => undefined,
  getLastSnapshot = () => null,
  openBrowserUrl = async () => undefined,
  readActivePage = async () => null,
  saveCurrentPageToArchive = async () => undefined,
  saveResearchTrailToArchive = async () => undefined,
  saveSelectionToArchive = async () => undefined,
  scrollActivePage = async () => undefined,
  searchBrowser = async () => undefined,
  setActivity = () => undefined,
  setStatus = () => undefined,
  summarizeCurrentPageToArchive = async () => undefined,
  summarizeSnapshot = async () => undefined,
  typeIntoActivePage = async () => undefined
} = {}) {
  const saveIntake = async (target = "page") => {
    if (/trail|research/i.test(String(target))) {
      // The side panel prefixes the command word; the research question is what follows it.
      return saveResearchTrailToArchive(String(target).replace(/^\s*(?:research\s*trail|researchtrail|trail|research)\b\s*/i, ""));
    }
    if (/summary|summari[sz]e|synthesis/i.test(String(target))) {
      return summarizeCurrentPageToArchive();
    }
    if (/selection|selected/i.test(String(target))) {
      return saveSelectionToArchive();
    }
    return saveCurrentPageToArchive();
  };

  const explainStructuredPageEditBoundary = async (instruction) => {
    const response = getLastSnapshot() ? { ok: true, snapshot: getLastSnapshot() } : await readActivePage({ announce: false });
    const snapshot = response?.snapshot;
    const title = snapshot?.title || "the active page";
    const url = snapshot?.url || "unknown URL";
    setActivity("completed", "Checked active page", title);
    setStatus("Needs precise edit target");
    await addMessage(
      "system",
      [
        `I can see the active page: ${title}`,
        url,
        "",
        "I can read the page, click visible page controls, and type into focused or normal editable fields from the side-panel host.",
        "This request is a structured document edit, so I need a precise editable target before I act. For Google Sheets/Docs, line/row edits are canvas/app-level interactions and should not be guessed from visible text.",
        "",
        `Requested change: ${instruction}`,
        "",
        "Give me a specific target such as a cell address, visible button/text to click, or ask me to type quoted text into the currently focused field. Example: click cell A17, then ask: type \"we need to add model selection and providers to ResonantOS browser\"."
      ].join("\n")
    );
  };

  const runBrowserCommand = async (body) => {
    const match = /^(open|navigate|visit|go|search|find|news|research|read|context|click|type|write|scroll|forms|fields)\b\s*([\s\S]*)$/i.exec(body.trim());
    const target = (match?.[2] ?? body).trim();
    if (!target) {
      const action = match?.[1]?.toLowerCase();
      if (action === "read" || action === "context") {
        await summarizeSnapshot();
        return;
      }
      if (action === "scroll") {
        await scrollActivePage({ direction: "down" });
        return;
      }
      if (action === "forms" || action === "fields") {
        await detectActivePageForms();
        return;
      }
      await addMessage("system", "Use `/browser open <url>`, `/browser search <query>`, `/browser read`, `/browser click \"text\"`, `/browser type \"text\"`, `/browser scroll down`, or `/browser forms`.");
      return;
    }
    const action = match?.[1]?.toLowerCase();
    if (["search", "find", "news", "research"].includes(action)) {
      await searchBrowser({ query: normalizeSearchQuery(target), action: action === "news" ? "news" : "search" });
      return;
    }
    if (action === "read" || action === "context") {
      await summarizeSnapshot();
      return;
    }
    if (action === "click") {
      const text = parseQuotedText(target) || target;
      await clickActivePageText({ text });
      return;
    }
    if (action === "type" || action === "write") {
      const text = parseQuotedText(target) || target;
      await typeIntoActivePage({ text, submit: /\b(submit|press enter|hit enter|search)\b/i.test(target) });
      return;
    }
    if (action === "scroll") {
      await scrollActivePage({ direction: /\b(up|top)\b/i.test(target) ? /\btop\b/i.test(target) ? "top" : "up" : /\b(bottom|end)\b/i.test(target) ? "bottom" : "down" });
      return;
    }
    if (action === "forms" || action === "fields") {
      await detectActivePageForms();
      return;
    }
    await openBrowserUrl(target);
  };

  const handleWalletBoundary = async () => {
    await addMessage("system", "Wallet actions are human-approval gated. I can discuss Phantom and browser context, but wallet connect, signing, seed phrases, private keys, and credential actions stay human-only.");
    setStatus("Approval gated");
  };

  return {
    explainStructuredPageEditBoundary,
    handleWalletBoundary,
    runBrowserCommand,
    saveIntake
  };
}
