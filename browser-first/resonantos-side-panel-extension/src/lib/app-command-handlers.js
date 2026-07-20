import { isTerminalBrowserJobStatus, staleBrowserJobEvidence } from "./browser-job-store.js";
import { delegationTargetLabel, startDelegationLifecycle } from "./delegation-lifecycle.js";
import { buildDelegationStatusMessage } from "./delegation-status.js";
import { buildHermesRuntimeStatusMessage } from "./addon-runtime-status.js";

export const parseCommandSections = (body) => String(body ?? "").split("|").map((part) => part.trim()).filter(Boolean);

export function parseHistorySearchCommand(body) {
  const sections = parseCommandSections(body);
  const first = sections[0] ?? "";
  const options = {
    days: 90,
    includeTabs: /\b(tabs?|recent tabs?|open tabs?)\b/i.test(first),
    saveToIntake: /\b(save|intake|archive|export)\b/i.test(first),
    maxResults: 8,
    query: first.replace(/\b(recent tabs?|open tabs?|tabs?|save|intake|archive|export)\b/gi, "").trim(),
    site: ""
  };
  sections.slice(1).forEach((section) => {
    const [rawKey, ...rest] = section.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "site" || key === "host") {
      options.site = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "");
      return;
    }
    if (key === "days" || key === "since") {
      const days = Number.parseInt(value, 10);
      if (Number.isFinite(days) && days > 0 && days <= 3650) options.days = days;
      return;
    }
    if (key === "limit" || key === "max") {
      const maxResults = Number.parseInt(value, 10);
      if (Number.isFinite(maxResults) && maxResults > 0 && maxResults <= 25) options.maxResults = maxResults;
      return;
    }
    if (key === "tabs" || key === "recent-tabs") {
      options.includeTabs = !/^false|no|0$/i.test(value);
      return;
    }
    if (["save", "intake", "archive", "export"].includes(key)) {
      options.saveToIntake = !/^false|no|0$/i.test(value);
    }
  });
  return options;
}

const historyResultLine = (item) => `- ${item.title || item.url}\n  ${item.url}`;

function formatHistorySearchMarkdown({ options, results, readableTabs }) {
  const title = [
    "# Browser Activity Search",
    "",
    `Query: ${options.query || "(none)"}`,
    `Site filter: ${options.site || "(none)"}`,
    `Window: ${options.days} day(s)`,
    "Incognito activity: excluded",
    `Captured at: ${new Date().toISOString()}`,
    ""
  ];
  const sections = [...title];
  if (readableTabs.length) {
    sections.push("## Recent Readable Tabs", "", ...readableTabs.map(historyResultLine), "");
  }
  if (results.length) {
    sections.push("## Browser History Matches", "", ...results.map(historyResultLine), "");
  }
  if (!readableTabs.length && !results.length) {
    sections.push("No browser history or readable-tab matches were found.", "");
  }
  sections.push(
    "## Boundary",
    "",
    "This artifact contains browser activity metadata only. It is raw intake evidence, not trusted AI Memory, until reviewed and promoted through the Living Archive workflow.",
    ""
  );
  return sections.join("\n");
}

function formatSchedulerState(state) {
  if (!state) return "";
  return [
    `Scheduler: ${state.activeSlots}/${state.maxConcurrent} active`,
    `${state.runnableQueued?.length ?? 0} runnable`,
    `${state.lockBlockedQueued?.length ?? 0} locked`,
    `${state.capacityBlockedQueued?.length ?? 0} waiting`
  ].join(" · ");
}

export function sitePermissionModeFromText(body) {
  const normalized = String(body ?? "").trim();
  if (/\b(blocked|block)\b/i.test(normalized)) return "blocked";
  if (/\b(read-only|readonly|read only)\b/i.test(normalized)) return "read-only";
  if (/\b(trusted)\b/i.test(normalized)) return "trusted-for-safe-actions";
  return "ask-before-action";
}

export function parseDraftAddonCommand(target, body) {
  const text = String(body ?? "").trim();
  if (!["email", "calendar"].includes(target) || !text) return null;
  const sections = parseCommandSections(text);
  const first = sections[0] ?? "";
  const keyed = Object.fromEntries(sections.slice(1).map((section) => {
    const [rawKey, ...rest] = section.split(":");
    return [rawKey.trim().toLowerCase(), rest.join(":").trim()];
  }).filter(([key, value]) => key && value));
  const intent = keyed.subject || keyed.title || keyed.intent || first;
  const draftBody = keyed.body || keyed.details || keyed.message || sections.slice(1).filter((section) => !/^[a-z-]+\s*:/i.test(section)).join("\n") || first;
  return {
    body: draftBody,
    intent,
    target
  };
}

const delegationTargets = [
  { id: "opencode", pattern: /\b(?:opencode|open\s+code)\b/i },
  { id: "hermes", pattern: /\bhermes\b/i },
  { id: "engineer", pattern: /\b(?:resonant\s+engineer|engineer\s+agent|engineer|setup\s+agent|r-eg|reg)\b/i }
];

function stripDelegationCommandLanguage(text, target) {
  const targetPattern = target === "opencode"
    ? "(?:opencode|open\\s+code)"
    : target === "engineer"
      ? "(?:resonant\\s+engineer|engineer\\s+agent|engineer|setup\\s+agent|r-eg|reg)"
      : "hermes";
  const starters = [
    new RegExp(`^(?:can\\s+you\\s+|please\\s+)?(?:delegate|handoff|hand\\s+off|route|send|pass|assign|dispatch|spawn|spin\\s+up|launch)\\s+(?:this\\s+)?(?:task\\s+)?(?:work\\s+)?(?:to\\s+(?:the\\s+)?)?${targetPattern}\\s*(?:to|and|:|-)?\\s*`, "i"),
    new RegExp(`^(?:can\\s+you\\s+|please\\s+)?(?:ask|tell|have|use)\\s+${targetPattern}\\s*(?:to|for|:|-)?\\s*`, "i"),
    new RegExp(`^${targetPattern}\\s*(?:should|can|please)?\\s*`, "i")
  ];
  return starters.reduce((value, pattern) => value.replace(pattern, ""), text).trim();
}

export function parseNaturalDelegationIntent(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("/")) return null;
  if (/\b(?:without|not|don't|do\s+not)\s+(?:delegate|delegating|use|spawn|dispatch|assign)\b/i.test(text)) return null;
  const target = delegationTargets.find((candidate) => candidate.pattern.test(text))?.id ?? "";
  const hasDelegationVerb = /\b(delegate|delegating|delegation|handoff|hand\s+off|route|send|pass|ask|tell|have|use|assign|dispatch|spawn|spin\s+up|launch)\b/i.test(text);
  const asksForAgent = /\b(?:another|other|sub|different)\s+agents?\b/i.test(text) || /\bagent\s+control\s+layer\b/i.test(text);
  if (!hasDelegationVerb && !asksForAgent) return null;
  if (!target) {
    if (!asksForAgent && !/\b(delegate|delegating|delegation|handoff|hand\s+off|route|send|pass|assign|dispatch|spawn|spin\s+up|launch)\b/i.test(text)) return null;
    return {
      missingTarget: true,
      mission: text.replace(/^(?:can\s+you\s+|please\s+)?(?:delegate|delegating|delegation|handoff|hand\s+off|route|send|pass|assign|dispatch|spawn|spin\s+up|launch)\s+(?:this\s+)?(?:task\s+|work\s+)?/i, "").trim(),
      target: ""
    };
  }
  const mission = stripDelegationCommandLanguage(text, target);
  return {
    missingTarget: false,
    mission: mission || text,
    target
  };
}

export function createAppCommandHandlers({
  activeTab,
  addMessage,
  bridgeRequest,
  getBridgeRequest,
  browserJobStore,
  chrome,
  detectWalletState,
  finishControlRun,
  focusBrowserJob,
  getCurrentControlRun,
  permissionForUrl,
  renderJobMonitor,
  renderSitePermissionPanel,
  restartBrowserJob,
  saveBrowserJobReportToArchive,
  setActivity,
  setSitePermission,
  setStatus,
  siteKeyForUrl,
  tickBrowserJobScheduler,
  updateBrowserJob
}) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  async function runGoalCommand(body) {
    const sections = parseCommandSections(body);
    const mission = sections[0] ?? "";
    setActivity("tool-running", "Creating goal workspace", mission);
    const result = await bridge()("/goals", {
      method: "POST",
      body: {
        mission,
        success: sections.filter((section) => /^success\s*:/i.test(section)).flatMap((section) => section.replace(/^success\s*:/i, "").split(/[,;]/).map((item) => item.trim()).filter(Boolean)),
        constraints: sections.filter((section) => /^constraints?\s*:/i.test(section)).flatMap((section) => section.replace(/^constraints?\s*:/i, "").split(/[,;]/).map((item) => item.trim()).filter(Boolean))
      }
    });
    await addMessage("system", `Goal workspace recorded: ${result.id}\n${result.mission}`);
  }

  async function startDelegationIfPossible(result) {
    return startDelegationLifecycle(result, { bridgeRequest, getBridgeRequest: () => bridgeRequest });
  }

  async function runDelegateCommand(body) {
    const match = /^(engineer|hermes|opencode|open code)\b\s*([\s\S]*)$/i.exec(String(body ?? "").trim());
    if (!match) {
      await addMessage("system", "Use `/delegate <engineer|hermes|opencode> <mission>`.");
      return;
    }
    const target = match[1].toLowerCase().replace(/\s+/g, "");
    const mission = match[2].trim();
    if (mission.length < 8) {
      await addMessage("system", `Give ${delegationTargetLabel(target)} a concrete mission before I create the delegation packet.`);
      return;
    }
    setActivity("tool-running", `Creating ${target} delegation`, mission);
    const result = await bridge()("/addons/delegate", {
      method: "POST",
      body: { target, mission }
    });
    const lifecycle = await startDelegationIfPossible(result);
    await addMessage("system", `Delegation queued for ${delegationTargetLabel(result.target)}: ${result.id}\n${result.path}${lifecycle}`);
  }

  async function runDelegationsCommand(body = "") {
    setActivity("retrieving", "Checking delegated work", body || "recent Hermes/OpenCode/Engineer packets");
    const message = await buildDelegationStatusMessage({ bridgeRequest, getBridgeRequest: () => bridgeRequest, filter: body, limit: 6 });
    await addMessage("system", message);
  }

  async function runHermesStatusCommand() {
    setActivity("retrieving", "Checking Hermes runtime", "CLI, execution grant, dashboard, and delegation task counts");
    const message = await buildHermesRuntimeStatusMessage({ bridgeRequest, getBridgeRequest: () => bridgeRequest });
    await addMessage("system", message);
  }

  async function runNaturalDelegationCommand(intent) {
    if (!intent || intent.missingTarget) {
      await addMessage(
        "system",
        "I can delegate through the ResonantOS agent control layer. Choose a target: Hermes for general agent work, OpenCode for coding, or Resonant Engineer for system repair."
      );
      return;
    }
    const mission = String(intent.mission ?? "").trim();
    if (mission.length < 8) {
      await addMessage("system", `Give ${delegationTargetLabel(intent.target)} a concrete mission before I create the delegation packet.`);
      return;
    }
    setActivity("tool-running", `Creating ${delegationTargetLabel(intent.target)} delegation`, mission);
    const result = await bridge()("/addons/delegate", {
      method: "POST",
      body: { target: intent.target, mission }
    });
    const lifecycle = await startDelegationIfPossible(result);
    await addMessage(
      "system",
      [
        `Delegation queued for ${delegationTargetLabel(result.target)}: ${result.id}`,
        result.path,
        "Boundary: the add-on receives a governed task packet. ResonantOS keeps provider secrets, wallet actions, and trusted memory writes mediated.",
        lifecycle
      ].join("\n")
    );
  }

  async function runDraftAddonCommand(target, body) {
    const draft = parseDraftAddonCommand(target, body);
    if (!draft || draft.intent.length < 3 || draft.body.length < 8) {
      await addMessage("system", `Use \`/${target} <intent> | body: <draft text>\`. ${target === "email" ? "Sending" : "Scheduling"} remains human-approval gated.`);
      return;
    }
    setActivity("tool-running", `Creating ${target} draft packet`, draft.intent);
    const result = await bridge()("/addons/draft", {
      method: "POST",
      body: draft
    });
    await addMessage(
      "system",
      [
        `${target === "email" ? "Email" : "Calendar"} draft created: ${result.id}`,
        result.path,
        `${target === "email" ? "Sending email" : "Scheduling calendar events"} is not automated from chat. Review and approve inside the ${target} add-on before any external action.`
      ].join("\n")
    );
  }

  async function runStatusCommand() {
    setActivity("retrieving", "Checking ResonantOS status", "Providers, Living Archive, add-ons, goals");
    const result = await bridge()("/status");
    const addonLines = result.addons.map((addon) => `- ${addon.name}: ${addon.available ? "available" : "missing"} · ${addon.mode}`).join("\n");
    await addMessage(
      "system",
      [
        "ResonantOS Browser status",
        `MiniMax credential: ${result.providers["shared-minimax"] ? "ready" : "missing"}`,
        `Z.AI GLM credential: ${result.providers["shared-zai-glm"] ? "ready" : "missing"}`,
        `OpenAI credential: ${result.providers["shared-openai"] ? "ready" : "missing"}`,
        `Living Archive wiki pages: ${result.memory.wiki.pages}`,
        `Intake artifacts: ${result.memory.intake.artifacts}`,
        `Review requests/artifacts: ${result.memory.review.requests}/${result.memory.review.artifacts}`,
        "Add-ons:",
        addonLines,
        `Recorded goals/delegations: ${result.records.goals}/${result.records.delegations}`
      ].join("\n")
    );
  }

  async function runSitePermissionCommand(body) {
    const normalized = String(body ?? "").trim();
    const tab = await activeTab();
    if (!normalized || /^status$/i.test(normalized)) {
      const mode = tab?.url ? await permissionForUrl(tab.url) : "unknown";
      await addMessage("system", `Current site permission: ${tab?.url ? siteKeyForUrl(tab.url) : "no site"} · ${mode}`);
      return;
    }
    const result = await setSitePermission(tab?.url, sitePermissionModeFromText(normalized), {
      reason: `Slash command: /site ${normalized}`,
      source: "slash-command"
    });
    await renderSitePermissionPanel(tab);
    await addMessage("system", `Set ${result.key} Assistant permission to ${result.mode}.`);
  }

  async function runMemorySearchCommand(body) {
    const query = String(body ?? "").trim();
    setActivity("retrieving", "Searching Living Archive", query);
    const result = await bridge()("/memory/search", {
      method: "POST",
      body: { query, limit: 5 }
    });
    await addMessage(
      "system",
      result.matches.length
        ? `Living Archive matches for "${result.query}":\n${result.matches.map((match) => `- ${match.title} (${match.path})\n  ${match.excerpt}`).join("\n")}`
        : `No Living Archive wiki match found for "${result.query}".`
    );
  }

  async function runHistorySearchCommand(body) {
    const options = parseHistorySearchCommand(body);
    if (!options.query && !options.includeTabs) {
      await addMessage("system", "Use `/history <query> | site:example.com | days:7 | tabs | intake` to search local browser history metadata, recent readable tabs, and optionally save the result to Living Archive intake.");
      return;
    }
    if (!chrome.history?.search) {
      await addMessage("system", "Browser history search is not available in this runtime.");
      return;
    }
    setActivity("retrieving", "Searching browser history", options.query || options.site || "recent tabs");
    const siteMatches = (url) => {
      if (!options.site) return true;
      try {
        return new URL(url).hostname.replace(/^www\./, "") === options.site;
      } catch {
        return false;
      }
    };
    const historyResults = options.query ? await chrome.history.search({
      text: options.query,
      maxResults: Math.min(options.maxResults * 3, 75),
      startTime: Date.now() - 1000 * 60 * 60 * 24 * options.days
    }).catch(() => []) : [];
    const results = historyResults.filter((item) => siteMatches(item.url)).slice(0, options.maxResults);
    const readableTabs = options.includeTabs && chrome.tabs?.query
      ? (await chrome.tabs.query({ currentWindow: true }).catch(() => []))
        .filter((tab) => !tab.incognito && /^https?:\/\//i.test(tab.url ?? "") && siteMatches(tab.url))
        .slice(0, options.maxResults)
      : [];
    const lines = [];
    if (readableTabs.length) {
      lines.push("Recent readable tabs:");
      lines.push(...readableTabs.map((tab) => `- ${tab.title || tab.url}\n  ${tab.url}`));
    }
    if (results.length) {
      lines.push(`Browser history matches${options.query ? ` for "${options.query}"` : ""}:`);
      lines.push(...results.map((item) => `- ${item.title || item.url}\n  ${item.url}`));
    }
    if (options.site) {
      lines.push(`Filter: site ${options.site}`);
    }
    lines.push(`Window: ${options.days} day(s). Incognito activity is excluded.`);
    await addMessage(
      "system",
      lines.length > 1
        ? lines.join("\n")
        : `No browser history or readable tab match found for "${options.query || options.site}".\nWindow: ${options.days} day(s). Incognito activity is excluded.`
    );
    if (options.saveToIntake) {
      const content = formatHistorySearchMarkdown({ options, results, readableTabs });
      const intake = await bridge()("/archive/intake", {
        method: "POST",
        body: {
          title: `Browser activity search: ${options.query || options.site || "recent tabs"}`,
          content,
          origin: "browser-history-search",
          url: null,
          metadata: {
            query: options.query,
            site: options.site,
            days: options.days,
            historyMatches: results.length,
            readableTabs: readableTabs.length,
            incognitoExcluded: true
          }
        }
      });
      const review = await bridge()("/archive/review/request", {
        method: "POST",
        body: {
          path: intake.path,
          reason: "Evaluate browser activity metadata for durable research context, source provenance, and possible wiki updates."
        }
      });
      await addMessage("system", `Saved browser activity search to Living Archive intake: ${intake.path}\nReview request created: ${review.path}`);
    }
    setStatus("Ready");
    setActivity(
      "completed",
      options.saveToIntake ? "History search saved to intake" : "History search complete",
      `${results.length} history · ${readableTabs.length} tabs`
    );
  }

  async function runCapabilitiesCommand() {
    const tab = await activeTab();
    const mode = tab?.url ? await permissionForUrl(tab.url) : "unknown";
    const host = tab?.url ? siteKeyForUrl(tab.url) : "no readable page";
    await addMessage(
      "system",
      [
        "What Augmentor can do now:",
        `- Current site: ${host} · ${mode}`,
        "- Read visible page text, controls, fields, frames, and page metadata.",
        "- Open/search pages, switch tabs, click visible safe controls, type into editable fields, and scroll.",
        "- Use Inline Assistant on selected text and send selected context into chat.",
        "- Search local browser history metadata and readable open tabs with `/history <query> | site:example.com | days:7 | tabs`.",
        "- Check read-only Phantom wallet provider presence with `/wallet status`.",
        "- Save read-only wallet/DAO evidence to Living Archive intake with `/wallet audit` or `/dao audit <goal>`.",
        "- Save selected browser activity metadata to raw Living Archive intake with `/history <query> | intake`.",
        "- Save page/context artifacts into ResonantOS intake.",
        "",
        "Hard boundaries:",
        "- Wallet signing, payment, login, credential autofill, and public submission require human approval.",
        "- Blocked sites disable reading and page actions. Read-only sites disable actions but still allow context reading."
      ].join("\n")
    );
  }

  async function runWalletStatusCommand() {
    if (typeof detectWalletState !== "function") {
      await addMessage("system", "Wallet status detection is not available in this runtime. Wallet connect, signing, seed phrases, private keys, and credential actions stay human-only.");
      return;
    }
    const result = await detectWalletState({ announce: true });
    if (!result?.ok) {
      setStatus("Wallet status unavailable");
    }
  }

  async function runJobsCommand(body = "") {
    const rawFilter = String(body ?? "").trim();
    if (/^(?:run|start|tick|scheduler)\b/i.test(rawFilter)) {
      if (typeof tickBrowserJobScheduler !== "function") {
        await addMessage("system", "Browser job scheduler is not available in this runtime.");
        return;
      }
      const result = await tickBrowserJobScheduler();
      const started = result?.startedJobs ?? [];
      const state = result?.schedulerState ?? null;
      await addMessage(
        "system",
        [
          started.length
            ? `Started ${started.length} browser job${started.length === 1 ? "" : "s"}: ${started.map((job) => job.id).join(", ")}`
            : "No runnable queued browser jobs were available.",
          formatSchedulerState(state)
        ].filter(Boolean).join("\n")
      );
      return;
    }
    const focusMatch = /^(?:focus|active|select)\s+(.+)$/i.exec(rawFilter);
    if (focusMatch) {
      const job = browserJobStore.findJob(focusMatch[1]);
      if (!job) {
        await addMessage("system", `No browser job matches "${focusMatch[1]}".`);
        return;
      }
      const focused = await focusBrowserJobOrReport(job);
      if (!focused) return;
      renderJobMonitor();
      await addMessage("system", `Focused browser job ${job.id}: ${job.goal}`);
      return;
    }
    const filter = rawFilter.toLowerCase();
    const visible = browserJobStore.getJobs()
      .filter((job) => !filter || job.status === filter || job.goal.toLowerCase().includes(filter) || job.id.toLowerCase().includes(filter))
      .slice(0, 12);
    const scheduler = typeof browserJobStore.getSchedulerState === "function"
      ? browserJobStore.getSchedulerState({ maxConcurrent: 2 })
      : null;
    const schedulerLine = formatSchedulerState(scheduler);
    const blockedLines = scheduler?.lockBlockedQueued?.length
      ? scheduler.lockBlockedQueued.map((job) => `- locked ${job.id} by ${job.blockerId}: ${job.goal}`).join("\n")
      : "";
    const staleLines = visible
      .map((job) => ({ evidence: staleBrowserJobEvidence(job), job }))
      .filter((entry) => entry.evidence)
      .map(({ evidence, job }) => `- attention ${job.id}: ${evidence.reason} Last activity ${Math.round(evidence.ageMs / 60000)} min ago. ${evidence.nextHumanAction}`)
      .join("\n");
    renderJobMonitor();
    await addMessage(
      "system",
      visible.length
        ? [`Browser jobs:`, schedulerLine, visible.map((job) => `- ${job.id} · ${job.status} · ${job.goal}`).join("\n"), blockedLines, staleLines].filter(Boolean).join("\n")
        : "No browser jobs match that filter."
    );
  }

  async function focusBrowserJobOrReport(job) {
    try {
      if (typeof focusBrowserJob === "function") {
        await focusBrowserJob(job.id);
      } else {
        await browserJobStore.activateJob?.(job.id);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await addMessage(
        "system",
        [
          `Cannot focus browser job ${job.id}: ${job.goal}`,
          message,
          "I will not resume or approve this job until its controlled tab can be recovered. Open the target page again, then retry or create a new browser job."
        ].join("\n")
      );
      renderJobMonitor();
      return false;
    }
  }

  async function pauseBrowserJob(body = "") {
    const job = browserJobStore.findJob(body);
    if (!job) {
      await addMessage("system", "No browser job is available to pause.");
      return;
    }
    if (job.id === browserJobStore.getActiveJobId() && getCurrentControlRun() && job.status === "running") {
      finishControlRun("paused");
    }
    await updateBrowserJob(job.id, { status: "paused" });
    await addMessage("system", `Paused browser job ${job.id}: ${job.goal}`);
  }

  async function resumeBrowserJob(body = "") {
    const job = browserJobStore.findJob(body);
    if (!job) {
      await addMessage("system", "No browser job is available to resume.");
      return;
    }
    if (!["paused", "queued", "failed"].includes(job.status)) {
      await addMessage("system", `Browser job ${job.id} is ${job.status}; only paused, queued, or failed jobs can resume.`);
      return;
    }
    const focused = await focusBrowserJobOrReport(job);
    if (!focused) return;
    await updateBrowserJob(job.id, { allowHumanStopOverride: true, status: "queued" });
    await addMessage(
      "system",
      [
        `Queued browser job ${job.id} for exact resume: ${job.goal}`,
        `Persisted steps loaded: ${Array.isArray(job.steps) ? job.steps.length : 0}`,
        "Resuming now from the current page state while preserving the previous step history."
      ].join("\n")
    );
    if (typeof restartBrowserJob === "function") {
      await restartBrowserJob(job);
    }
  }

  async function continueBrowserJob(body = "") {
    const job = browserJobStore.findJob(body);
    if (!job) {
      await addMessage("system", "No browser job is available to continue.");
      return;
    }
    if (job.status === "running") {
      await addMessage("system", `Browser job ${job.id} is already running: ${job.goal}`);
      return;
    }
    if (typeof restartBrowserJob !== "function") {
      await addMessage("system", `Browser job ${job.id} can be continued manually with /control ${job.goal}`);
      return;
    }
    const focused = await focusBrowserJobOrReport(job);
    if (!focused) return;
    await addMessage(
      "system",
      [
        `Continuing browser job ${job.id}: ${job.goal}`,
        "Previous steps remain in the same durable job. The new run starts from the current page state and keeps the same approval boundaries."
      ].join("\n")
    );
    await restartBrowserJob(job);
  }

  async function reportBrowserJob(body = "") {
    const job = browserJobStore.findJob(body);
    if (!job) {
      await addMessage("system", "No browser job is available to report.");
      return;
    }
    if (typeof saveBrowserJobReportToArchive !== "function") {
      await addMessage("system", `Browser job ${job.id} report is unavailable in this runtime.`);
      return;
    }
    const result = await saveBrowserJobReportToArchive(job);
    if (result?.error) {
      await addMessage("system", `Browser job report failed: ${result.error}`);
      return;
    }
    const artifact = { type: "archive-intake", path: result.path };
    await updateBrowserJob(job.id, {
      artifacts: [...(job.artifacts ?? []), artifact]
    });
    await addMessage("system", `Saved browser job report to Living Archive intake: ${result.path}`);
  }

  async function cancelBrowserJob(body = "") {
    const job = browserJobStore.findJob(body);
    const currentControlRun = getCurrentControlRun();
    if (!job) {
      await addMessage("system", "No browser job is available to cancel.");
      return;
    }
    if (job.id === browserJobStore.getActiveJobId() && currentControlRun && !isTerminalBrowserJobStatus(currentControlRun.status)) {
      finishControlRun("cancelled");
    }
    await updateBrowserJob(job.id, { status: "cancelled" });
    await addMessage("system", `Cancelled browser job ${job.id}: ${job.goal}`);
  }

  return {
    cancelBrowserJob,
    continueBrowserJob,
    pauseBrowserJob,
    runDraftAddonCommand,
    resumeBrowserJob,
    reportBrowserJob,
    runCapabilitiesCommand,
    runDelegateCommand,
    runDelegationsCommand,
    runHermesStatusCommand,
    runGoalCommand,
    runHistorySearchCommand,
    runJobsCommand,
    runMemorySearchCommand,
    runNaturalDelegationCommand,
    runSitePermissionCommand,
    runStatusCommand,
    runWalletStatusCommand
  };
}
