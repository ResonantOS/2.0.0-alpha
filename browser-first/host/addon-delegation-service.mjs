import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import {
  appendProviderHandoffAudit,
  buildProviderDraftHandoff,
  parseDraftPacketMarkdown,
} from "./addon-draft-connectors.mjs";
import { dashboardProxyUrl } from "./bridge-server.mjs";

// When the bridge runs on a multi-homed host (e.g. the Pi5 has loopback,
// LAN 192.168.1.100, and Tailscale 100.100.100.100), it has to publish URLs
// that a remote extension can actually reach. `dashboardTarget()` returns
// the loopback URL the dashboard process binds to (correct for the bridge
// to manage the process), but the URL the extension displays to the user
// must be the one that resolves on the *client* machine — same port, but
// the host the bridge has told clients to dial. We use the same env var
// the bridge config file uses (RESONANTOS_BRIDGE_PUBLIC_URL) so the two
// stay in lockstep.
function clientReachableHost() {
  const explicit = process.env.RESONANTOS_BRIDGE_PUBLIC_URL;
  if (explicit) {
    try {
      const u = new URL(explicit);
      return u.hostname || "127.0.0.1";
    } catch {
      /* fall through to RESONANTOS_BRIDGE_HOST */
    }
  }
  const host = process.env.RESONANTOS_BRIDGE_HOST ?? "127.0.0.1";
  // Don't expose a bind-everything address as a client-facing URL.
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

function clientReachableUrl(loopbackUrl) {
  try {
    const u = new URL(loopbackUrl);
    return `${u.protocol}//${clientReachableHost()}:${u.port}`;
  } catch {
    return loopbackUrl;
  }
}

export function createAddonDelegationService(dependencies) {
  const {
    browserFirstRoot,
    bridgePublicUrl,
    dashboardTarget,
    execFileStdout,
    expandUserPath,
    firstExistingExecutable,
    hermesCommand,
    hermesHome,
    listFilesRecursive,
    memoryRoot,
    opencodeCommand,
    redactPathForDiagnostics,
    repoRoot,
    safeFileSlug,
    socketOpen,
    uniqueRuntimeId,
    userRoot,
  } = dependencies;

  // Reverse-proxy URL the extension can embed in an iframe without tripping
  // Chrome's mixed-content blocker. The proxy lives at the bridge origin
  // (same origin as the bridge request itself), and the bridge streams the
  // Hermes dashboard (running on 127.0.0.1:9119 on the Pi) through it. The
  // dependency is a getter (not a static string) because the bridge host URL
  // is only known after the server actually binds a port.
  function clientReachableProxyUrl() {
    return dashboardProxyUrl({
      publicUrl: typeof bridgePublicUrl === "function" ? bridgePublicUrl() : bridgePublicUrl,
    });
  }

  async function executeGoalRecord(payload) {
    const mission = String(payload.mission ?? "").trim();
    if (mission.length < 8) {
      throw new Error("Goal requires a concrete mission.");
    }
    const goalDir = path.join(browserFirstRoot(), "Goals");
    await mkdir(goalDir, { recursive: true });
    const goal = {
      id: uniqueRuntimeId("goal"),
      mission,
      success: payload.success ?? [],
      constraints: payload.constraints ?? [],
      createdAt: new Date().toISOString(),
      status: "active",
    };
    const goalPath = path.join(goalDir, `${goal.id}.json`);
    await writeFile(goalPath, `${JSON.stringify(goal, null, 2)}\n`);
    return { ...goal, path: path.relative(userRoot(), goalPath) };
  }

  async function executeDelegationRecord(payload) {
    const target = String(payload.target ?? "").trim().toLowerCase();
    const mission = String(payload.mission ?? "").trim();
    const contextMarkdown = String(payload.contextMarkdown ?? "").trim().slice(0, 24_000);
    const source = String(payload.source ?? "resonantos-chat").trim().slice(0, 120);
    const sourceControlRunId = String(payload.sourceControlRunId ?? "").trim().slice(0, 120);
    if (!["hermes", "opencode", "engineer"].includes(target)) {
      throw new Error("Delegation target must be hermes, opencode, or engineer.");
    }
    if (mission.length < 8) {
      throw new Error("Delegation requires a concrete mission.");
    }
    const taskDir = path.join(delegationRoot(), target);
    await mkdir(taskDir, { recursive: true });
    const id = uniqueRuntimeId(target);
    const taskPath = path.join(taskDir, `${id}.md`);
    const body = [
      `# Delegation: ${target}`,
      "",
      `- id: ${id}`,
      `- createdAt: ${new Date().toISOString()}`,
      `- source: ResonantOS Browser Layer`,
      `- sourceKind: ${source || "resonantos-chat"}`,
      ...(sourceControlRunId ? [`- sourceControlRunId: ${sourceControlRunId}`] : []),
      `- status: queued`,
      `- trust: add-on agent, not core trusted Strategist`,
      "- allowedCapabilities: agent-delegation, archive-read-optional",
      "- forbiddenActions: provider-secrets, wallet-actions, trusted-memory-write, external-send",
      "- approvalRequiredBeforeExternalAction: true",
      "- expectedArtifacts: final-summary, actions-taken, approval-needs, residual-risks, verification",
      "",
      "## Mission",
      mission,
      "",
      "## Success Criteria",
      "- Return a concise final summary.",
      "- List actions taken or explain why no action was taken.",
      "- Identify any approval needed before external communication or public action.",
      "- State residual risks and verification evidence.",
      "",
      ...(contextMarkdown
        ? [
          "## Context Packet",
          contextMarkdown,
          ""
        ]
        : []),
      "## Artifact Return Contract",
      "- finalSummary: user-facing result",
      "- actionsTaken: bounded list",
      "- approvalNeeds: human review gates",
      "- residualRisks: uncertainty and limitations",
      "- verification: how the result was checked",
      "",
      "## Boundary",
      "The add-on receives a task packet only. Provider secrets, wallet actions, and trusted memory writes remain host-mediated.",
      "",
    ].join("\n");
    await writeFile(taskPath, body);
    return {
      hasContextPacket: Boolean(contextMarkdown),
      id,
      mission,
      path: path.relative(userRoot(), taskPath),
      source,
      sourceControlRunId,
      status: "queued",
      target,
    };
  }

  async function executeAddonDraftRecord(payload) {
    const target = String(payload.target ?? "").trim().toLowerCase();
    if (!["email", "calendar"].includes(target)) {
      throw new Error("Draft target must be email or calendar.");
    }
    const intent = String(payload.intent ?? payload.subject ?? payload.title ?? "").trim();
    const body = String(payload.body ?? payload.details ?? payload.mission ?? "").trim();
    if (intent.length < 3 || body.length < 8) {
      throw new Error("Draft requires a concrete intent and body.");
    }
    const draftDir = path.join(browserFirstRoot(), "AddOnDrafts", target);
    await mkdir(draftDir, { recursive: true });
    const id = uniqueRuntimeId(`${target}-draft`);
    const draftPath = path.join(draftDir, `${id}-${safeFileSlug(intent)}.md`);
    const content = [
      `# ${target === "email" ? "Email" : "Calendar"} Draft`,
      "",
      `- id: ${id}`,
      `- createdAt: ${new Date().toISOString()}`,
      `- target: ${target}`,
      "- status: draft-only",
      "- approvalRequired: true",
      "- source: ResonantOS Browser Layer",
      "",
      "## Intent",
      intent,
      "",
      "## Draft Body",
      body,
      "",
      "## Boundary",
      target === "email"
        ? "This is a draft packet only. ResonantOS does not send email from this route; sending requires a separate human approval flow in the email add-on."
        : "This is a draft packet only. ResonantOS does not schedule calendar events from this route; scheduling requires a separate human approval flow in the calendar add-on.",
      "",
    ].join("\n");
    await writeFile(draftPath, content);
    return {
      approvalRequired: true,
      id,
      path: path.relative(userRoot(), draftPath),
      status: "draft-created",
      target,
    };
  }

  function draftRoot() {
    return path.join(browserFirstRoot(), "AddOnDrafts");
  }

  function delegationRoot() {
    return path.join(browserFirstRoot(), "Delegations");
  }

  function delegationArtifactRoot() {
    return path.join(browserFirstRoot(), "DelegationArtifacts");
  }

  function addonExecutionSettingsPath() {
    return path.join(browserFirstRoot(), "Settings", "addon-execution.json");
  }

  function defaultAddonExecutionSettings() {
    return {
      hermes: { localCliExecution: false },
      opencode: { localCliExecution: false },
    };
  }

  function normalizeAddonExecutionSettings(value = {}) {
    const defaults = defaultAddonExecutionSettings();
    return {
      hermes: { localCliExecution: Boolean(value?.hermes?.localCliExecution ?? defaults.hermes.localCliExecution) },
      opencode: { localCliExecution: Boolean(value?.opencode?.localCliExecution ?? defaults.opencode.localCliExecution) },
    };
  }

  async function readAddonExecutionSettings() {
    const raw = await readFile(addonExecutionSettingsPath(), "utf8").catch(() => "");
    if (!raw) return defaultAddonExecutionSettings();
    try {
      return normalizeAddonExecutionSettings(JSON.parse(raw));
    } catch {
      return defaultAddonExecutionSettings();
    }
  }

  async function writeAddonExecutionSettings(next) {
    const normalized = normalizeAddonExecutionSettings(next);
    const filePath = addonExecutionSettingsPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    return normalized;
  }

  function addonLocalCliExecutionEnabled(addon, payload = {}, settings = defaultAddonExecutionSettings()) {
    if (addon === "hermes" && payload.enableHermesExecution === true) return true;
    if (addon === "opencode" && payload.enableOpenCodeExecution === true) return true;
    if (addon === "hermes" && /^enabled|true|1$/i.test(String(process.env.RESONANTOS_HERMES_EXECUTION ?? ""))) return true;
    if (addon === "opencode" && /^enabled|true|1$/i.test(String(process.env.RESONANTOS_OPENCODE_EXECUTION ?? ""))) return true;
    return Boolean(settings?.[addon]?.localCliExecution);
  }

  function resolveDraftPath(relativePath) {
    const resolved = path.resolve(userRoot(), String(relativePath ?? ""));
    const root = path.resolve(draftRoot());
    if (!resolved.startsWith(`${root}${path.sep}`) || !resolved.endsWith(".md")) {
      throw new Error("Draft path must point to a draft packet inside BrowserFirst/AddOnDrafts.");
    }
    return resolved;
  }

  function resolveDelegationPath(relativePath, expectedTarget = "") {
    const resolved = path.resolve(userRoot(), String(relativePath ?? ""));
    const target = String(expectedTarget ?? "").trim().toLowerCase();
    const root = path.resolve(target ? path.join(delegationRoot(), target) : delegationRoot());
    if (!resolved.startsWith(`${root}${path.sep}`) || !resolved.endsWith(".md")) {
      throw new Error("Delegation path must point to a task packet inside BrowserFirst/Delegations.");
    }
    return resolved;
  }

  function fieldFromMarkdown(content, field) {
    const match = new RegExp(`^- ${field}:\\s*(.+)$`, "mi").exec(content);
    return match ? match[1].trim() : "";
  }

  function sectionFromMarkdown(content, heading) {
    const normalizedContent = String(content ?? "").replace(/\r\n?/g, "\n");
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`, "i").exec(normalizedContent);
    return match ? match[1].trim() : "";
  }

  function sectionListFromMarkdown(content, heading) {
    return sectionFromMarkdown(content, heading)
      .split("\n")
      .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean);
  }

  function draftSummaryFromMarkdown(filePath, content, details) {
    return {
      id: fieldFromMarkdown(content, "id") || path.basename(filePath, ".md"),
      target: fieldFromMarkdown(content, "target") || path.basename(path.dirname(filePath)),
      status: fieldFromMarkdown(content, "status") || "draft-only",
      approvalRequired: /- approvalRequired:\s*true/i.test(content),
      path: path.relative(userRoot(), filePath),
      intent: sectionFromMarkdown(content, "Intent").slice(0, 220),
      updatedAt: details?.mtime?.toISOString?.() ?? "",
    };
  }

  function delegationSummaryFromMarkdown(filePath, content, details) {
    const context = sectionFromMarkdown(content, "Context Packet");
    const result = sectionFromMarkdown(content, "Result");
    return {
      contextExcerpt: context.replace(/\s+/g, " ").slice(0, 360),
      hasContextPacket: Boolean(context),
      id: fieldFromMarkdown(content, "id") || path.basename(filePath, ".md"),
      mission: sectionFromMarkdown(content, "Mission").slice(0, 360),
      path: path.relative(userRoot(), filePath),
      resultArtifactPath: fieldFromMarkdown(content, "resultArtifactPath"),
      resultExcerpt: result.replace(/\s+/g, " ").slice(0, 360),
      sourceControlRunId: fieldFromMarkdown(content, "sourceControlRunId"),
      sourceKind: fieldFromMarkdown(content, "sourceKind") || "resonantos-chat",
      status: fieldFromMarkdown(content, "status") || "queued",
      target: path.basename(path.dirname(filePath)),
      updatedAt: details?.mtime?.toISOString?.() ?? "",
    };
  }

  async function executeAddonDraftList(payload) {
    const limit = Math.min(40, Math.max(1, Number(payload.limit ?? 20)));
    const target = String(payload.target ?? "").trim().toLowerCase();
    const roots = ["email", "calendar"]
      .filter((candidate) => !target || candidate === target)
      .map((candidate) => path.join(draftRoot(), candidate));
    const files = [];
    for (const root of roots) {
      files.push(...await listFilesRecursive(root, (filePath) => filePath.endsWith(".md"), limit));
    }
    const drafts = [];
    for (const filePath of files) {
      const [details, content] = await Promise.all([
        stat(filePath).catch(() => null),
        readFile(filePath, "utf8").catch(() => ""),
      ]);
      if (!details || !content) continue;
      drafts.push(draftSummaryFromMarkdown(filePath, content, details));
    }
    drafts.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return { root: path.relative(userRoot(), draftRoot()), drafts: drafts.slice(0, limit) };
  }

  async function executeDelegationList(payload) {
    const limit = Math.min(40, Math.max(1, Number(payload.limit ?? 20)));
    const target = String(payload.target ?? "").trim().toLowerCase();
    const roots = ["hermes", "opencode", "engineer"]
      .filter((candidate) => !target || candidate === target)
      .map((candidate) => path.join(delegationRoot(), candidate));
    const files = [];
    for (const root of roots) {
      files.push(...await listFilesRecursive(root, (filePath) => filePath.endsWith(".md"), limit));
    }
    const delegations = [];
    for (const filePath of files) {
      const [details, content] = await Promise.all([
        stat(filePath).catch(() => null),
        readFile(filePath, "utf8").catch(() => ""),
      ]);
      if (!details || !content) continue;
      delegations.push(delegationSummaryFromMarkdown(filePath, content, details));
    }
    delegations.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return { root: path.relative(userRoot(), delegationRoot()), delegations: delegations.slice(0, limit) };
  }

  async function executeHermesStatus(payload = {}) {
    const executionSettings = await readAddonExecutionSettings();
    const profileHome = hermesHome(payload.profileHome);
    const command = hermesCommand(profileHome);
    const dashboard = await executeHermesDashboardStatus({ profileHome, host: payload.host, port: payload.port });
    const taskRoot = path.join(delegationRoot(), "hermes");
    const tasks = await listFilesRecursive(taskRoot, (filePath) => filePath.endsWith(".md"), 200);
    const statusCounts = {};
    for (const filePath of tasks) {
      const content = await readFile(filePath, "utf8").catch(() => "");
      const status = fieldFromMarkdown(content, "status") || "queued";
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
    return {
      available: Boolean(command),
      command: command ? redactPathForDiagnostics(command) : "",
      dashboard,
      executionEnabled: addonLocalCliExecutionEnabled("hermes", payload, executionSettings),
      mode: command
        ? addonLocalCliExecutionEnabled("hermes", payload, executionSettings)
          ? "local-hermes-cli"
          : "local-hermes-cli-disabled"
        : "packet-only",
      profileHome: redactPathForDiagnostics(profileHome),
      taskCounts: statusCounts,
      boundary: "Hermes is an add-on agent. ResonantOS mediates task packets, artifacts, provider access, memory access, and external-send approval.",
    };
  }

  async function writeDelegationStatus(filePath, status, extraFields = {}) {
    const previous = await readFile(filePath, "utf8");
    let next = previous.replace(/^- status:\s*.+$/mi, `- status: ${status}`);
    for (const [field, value] of Object.entries(extraFields)) {
      const line = `- ${field}: ${String(value).replace(/\n/g, " ").trim()}`;
      const expression = new RegExp(`^- ${field}:\\s*.+$`, "mi");
      next = expression.test(next) ? next.replace(expression, line) : next.replace(/(\n## Mission\n)/, `\n${line}$1`);
    }
    await writeFile(filePath, next);
    return next;
  }

  function deterministicHermesResult(packet) {
    const mission = sectionFromMarkdown(packet, "Mission");
    const hasContext = Boolean(sectionFromMarkdown(packet, "Context Packet"));
    return {
      adapter: "deterministic",
      actionsTaken: [
        "Read the governed Hermes delegation packet.",
        "Checked the task boundary and artifact return contract.",
        hasContext ? "Reviewed the attached bounded context packet." : "No additional context packet was attached.",
        "Prepared a reviewable result without external sends or trusted memory writes.",
      ],
      approvalNeeds: [
        "Human approval is required before Hermes sends messages, schedules events, posts publicly, or changes external systems."
      ],
      finalSummary: `Hermes delegation is ready for review: ${mission}`,
      residualRisks: [
        "This deterministic adapter proves ResonantOS delegation lifecycle behavior; it does not claim the local Hermes model completed real-world research."
      ],
      verification: [
        "Task packet was parsed.",
        "Safety boundary was preserved.",
        "Result artifact was written under BrowserFirst/DelegationArtifacts/hermes."
      ],
    };
  }

  function buildHermesExecutionPrompt(packet) {
    const mission = sectionFromMarkdown(packet, "Mission");
    const context = sectionFromMarkdown(packet, "Context Packet");
    return [
      "You are Hermes operating as a ResonantOS add-on agent.",
      "",
      "Mission:",
      mission,
      "",
      context ? "Context packet:" : "",
      context,
      "",
      "Rules:",
      "- Return a reviewable artifact only.",
      "- Do not send messages, schedule events, post publicly, submit forms, operate wallets, expose secrets, or write trusted memory.",
      "- If external action is needed, list it under Approval Needs instead of performing it.",
      "- Keep the output concise and structured with these headings exactly: Final Summary, Actions Taken, Approval Needs, Residual Risks, Verification.",
    ].filter(Boolean).join("\n");
  }

  function parseHermesCliResult(output) {
    const text = String(output ?? "").trim();
    const actionsTaken = sectionListFromMarkdown(text, "Actions Taken");
    const approvalNeeds = sectionListFromMarkdown(text, "Approval Needs");
    const residualRisks = sectionListFromMarkdown(text, "Residual Risks");
    const verification = sectionListFromMarkdown(text, "Verification");
    return {
      adapter: "hermes-cli",
      actionsTaken: actionsTaken.length
        ? actionsTaken
        : ["Hermes returned a result through the local CLI adapter."],
      approvalNeeds: approvalNeeds.length
        ? approvalNeeds
        : ["Human approval is required before any external send, submission, wallet action, or trusted memory write."],
      finalSummary: sectionFromMarkdown(text, "Final Summary") || text.slice(0, 1600) || "Hermes completed without returning a summary.",
      residualRisks: residualRisks.length
        ? residualRisks
        : ["Hermes output was accepted as an add-on artifact and still requires normal human review."],
      verification: verification.length
        ? verification
        : ["Local Hermes CLI returned successfully."],
    };
  }

  async function runHermesCliDelegation(command, packet, payload = {}) {
    const prompt = buildHermesExecutionPrompt(packet);
    const toolsets = String(payload.toolsets ?? process.env.RESONANTOS_HERMES_TOOLSETS ?? "memory").trim();
    const args = ["chat", "-q", prompt, "-Q", "--source", "resonantos", "--max-turns", "8"];
    if (toolsets) args.push("--toolsets", toolsets);
    const output = await execFileStdout(command, args, {
      cwd: browserFirstRoot(),
      env: {
        ...process.env,
        HERMES_HOME: hermesHome(payload.profileHome),
      },
      timeout: Math.min(600_000, Math.max(30_000, Number(payload.timeoutMs ?? 180_000))),
    });
    return parseHermesCliResult(output);
  }

  async function writeHermesResultArtifact(taskPath, packet, result) {
    const id = fieldFromMarkdown(packet, "id") || path.basename(taskPath, ".md");
    const artifactDir = path.join(delegationArtifactRoot(), "hermes");
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, `${id}-result.md`);
    const lines = [
      `# Hermes Result: ${id}`,
      "",
      `- id: ${id}`,
      `- taskPath: ${path.relative(userRoot(), taskPath)}`,
      `- createdAt: ${new Date().toISOString()}`,
      `- adapter: ${result.adapter}`,
      "- status: completed",
      "- boundary: Reviewable artifact only. External sends and trusted memory writes remain blocked.",
      "",
      "## Final Summary",
      result.finalSummary,
      "",
      "## Actions Taken",
      ...result.actionsTaken.map((item) => `- ${item}`),
      "",
      "## Approval Needs",
      ...result.approvalNeeds.map((item) => `- ${item}`),
      "",
      "## Residual Risks",
      ...result.residualRisks.map((item) => `- ${item}`),
      "",
      "## Verification",
      ...result.verification.map((item) => `- ${item}`),
      "",
    ];
    await writeFile(artifactPath, lines.join("\n"));
    return artifactPath;
  }

  async function executeHermesDelegationStart(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "hermes");
    const packet = await readFile(taskPath, "utf8");
    const currentStatus = fieldFromMarkdown(packet, "status") || "queued";
    if (["completed", "cancelled"].includes(currentStatus)) {
      throw new Error(`Hermes delegation is already ${currentStatus}.`);
    }
    const adapter = String(payload.adapter ?? process.env.RESONANTOS_HERMES_ADAPTER ?? "auto").trim().toLowerCase();
    const profileHome = hermesHome(payload.profileHome);
    const command = hermesCommand(profileHome);
    const executionSettings = await readAddonExecutionSettings();
    await writeDelegationStatus(taskPath, "running", {
      startedAt: new Date().toISOString(),
      adapter: adapter || "auto",
    });
    if (adapter !== "deterministic" && !command) {
      const blockedAt = new Date().toISOString();
      const updated = await writeDelegationStatus(taskPath, "blocked", {
        blockedAt,
        blockedReason: "Hermes CLI unavailable",
      });
      return {
        ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
        blockedReason: "Hermes CLI unavailable. Install or configure Hermes, or run the deterministic adapter in tests.",
        status: "blocked",
      };
    }
    if (adapter !== "deterministic" && !addonLocalCliExecutionEnabled("hermes", payload, executionSettings)) {
      const blockedAt = new Date().toISOString();
      const updated = await writeDelegationStatus(taskPath, "blocked", {
        blockedAt,
        blockedReason: "Hermes execution requires explicit enablement",
      });
      return {
        ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
        blockedReason: "Hermes CLI was found, but execution is disabled. Set RESONANTOS_HERMES_EXECUTION=enabled or pass enableHermesExecution from a trusted Settings flow.",
        status: "blocked",
      };
    }
    let result;
    try {
      result = adapter === "deterministic"
        ? deterministicHermesResult(packet)
        : await runHermesCliDelegation(command, packet, payload);
    } catch (error) {
      const failedAt = new Date().toISOString();
      const updated = await writeDelegationStatus(taskPath, "failed", {
        failedAt,
        failureReason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
      return {
        ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
        failureReason: error instanceof Error ? error.message : String(error),
        status: "failed",
      };
    }
    const artifactPath = await writeHermesResultArtifact(taskPath, packet, result);
    let updated = await writeDelegationStatus(taskPath, "completed", {
      completedAt: new Date().toISOString(),
      resultArtifactPath: path.relative(userRoot(), artifactPath),
    });
    updated = `${updated.trimEnd()}\n\n## Result\n${result.finalSummary}\n\n## Result Artifact\n${path.relative(userRoot(), artifactPath)}\n`;
    await writeFile(taskPath, updated);
    return {
      ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
      adapter: result.adapter,
      artifact: {
        path: path.relative(userRoot(), artifactPath),
        ...result,
      },
      status: "completed",
    };
  }

  async function executeHermesDelegationStatus(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "hermes");
    const [details, content] = await Promise.all([stat(taskPath), readFile(taskPath, "utf8")]);
    return delegationSummaryFromMarkdown(taskPath, content, details);
  }

  async function executeHermesDelegationArtifact(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "hermes");
    const content = await readFile(taskPath, "utf8");
    const artifactRelative = fieldFromMarkdown(content, "resultArtifactPath");
    if (!artifactRelative) {
      throw new Error("Hermes delegation has no result artifact yet.");
    }
    const artifactPath = path.resolve(userRoot(), artifactRelative);
    const artifactRoot = path.resolve(path.join(delegationArtifactRoot(), "hermes"));
    if (!artifactPath.startsWith(`${artifactRoot}${path.sep}`) || !artifactPath.endsWith(".md")) {
      throw new Error("Hermes result artifact path is outside the approved artifact root.");
    }
    const artifact = await readFile(artifactPath, "utf8");
    return {
      actionsTaken: sectionListFromMarkdown(artifact, "Actions Taken"),
      approvalNeeds: sectionListFromMarkdown(artifact, "Approval Needs"),
      content: artifact,
      finalSummary: sectionFromMarkdown(artifact, "Final Summary"),
      path: path.relative(userRoot(), artifactPath),
      residualRisks: sectionListFromMarkdown(artifact, "Residual Risks"),
      verification: sectionListFromMarkdown(artifact, "Verification"),
    };
  }

  async function executeHermesDelegationCancel(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "hermes");
    const content = await readFile(taskPath, "utf8");
    const currentStatus = fieldFromMarkdown(content, "status") || "queued";
    if (["completed", "cancelled"].includes(currentStatus)) {
      return delegationSummaryFromMarkdown(taskPath, content, await stat(taskPath));
    }
    const updated = await writeDelegationStatus(taskPath, "cancelled", {
      cancelledAt: new Date().toISOString(),
      cancelReason: String(payload.reason ?? "Human cancelled Hermes delegation.").slice(0, 240),
    });
    return delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath));
  }

  async function executeOpenCodeStatus(payload = {}) {
    const executionSettings = await readAddonExecutionSettings();
    const command = opencodeCommand();
    const taskRoot = path.join(delegationRoot(), "opencode");
    const tasks = await listFilesRecursive(taskRoot, (filePath) => filePath.endsWith(".md"), 200);
    const statusCounts = {};
    for (const filePath of tasks) {
      const content = await readFile(filePath, "utf8").catch(() => "");
      const status = fieldFromMarkdown(content, "status") || "queued";
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
    return {
      installed: Boolean(command),
      command: command ? redactPathForDiagnostics(command) : "",
      mode: command && addonLocalCliExecutionEnabled("opencode", payload, executionSettings) ? "local-opencode-cli" : command ? "local-opencode-cli-disabled" : "packet-only",
      executionEnabled: addonLocalCliExecutionEnabled("opencode", payload, executionSettings),
      workspaceLaunch: "not-enabled-in-browser-first-v1",
      detail: command
        ? "OpenCode runtime was detected. ResonantOS can create governed coding packets and start execution only when explicit OpenCode execution is enabled."
        : "OpenCode runtime was not detected. Install or configure OpenCode before enabling local coding execution.",
      taskCounts: statusCounts,
      delegationPackets: tasks.length,
      requiredGrants: ["filesystem", "shell", "providers", "ui-embedding"],
      boundary: "OpenCode is an add-on agent. Filesystem, shell, provider secrets, wallet actions, and trusted memory writes remain mediated by ResonantOS.",
    };
  }

  function resolveOpenCodeWorkspacePath(payload = {}) {
    const workspacePath = payload.workspacePath
      ? expandUserPath(payload.workspacePath)
      : repoRoot;
    const resolved = path.resolve(workspacePath);
    const allowedRoot = path.resolve(repoRoot);
    if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) {
      throw new Error("OpenCode workspace path must stay inside the ResonantOS repository for browser-first V1.");
    }
    return resolved;
  }

  function deterministicOpenCodeResult(packet, payload = {}) {
    const mission = sectionFromMarkdown(packet, "Mission");
    return {
      adapter: "deterministic",
      actionsTaken: [
        "Read the governed OpenCode coding packet.",
        "Checked the coding handoff boundary and required artifact contract.",
        "Prepared a reviewable coding result without shell execution, file edits, provider-secret access, wallet actions, or trusted memory writes.",
      ],
      changedFiles: [],
      commandsRun: [],
      finalSummary: `OpenCode coding delegation is ready for review: ${mission}`,
      residualRisks: [
        "This deterministic adapter proves ResonantOS OpenCode delegation lifecycle behavior; it does not claim code was changed by a local OpenCode runtime."
      ],
      verification: [
        "Task packet was parsed.",
        "Workspace scope was checked.",
        "Result artifact was written under BrowserFirst/DelegationArtifacts/opencode."
      ],
      workspacePath: path.relative(repoRoot, resolveOpenCodeWorkspacePath(payload)) || ".",
    };
  }

  function buildOpenCodeExecutionPrompt(packet, workspacePath) {
    const mission = sectionFromMarkdown(packet, "Mission");
    const context = sectionFromMarkdown(packet, "Context Packet");
    return [
      "You are OpenCode operating as a ResonantOS add-on coding agent.",
      "",
      `Workspace: ${workspacePath}`,
      "",
      "Mission:",
      mission,
      "",
      context ? "Context packet:" : "",
      context,
      "",
      "Rules:",
      "- Work only inside the approved workspace.",
      "- Do not access provider secrets, wallets, trusted Living Archive writes, or external send/submission surfaces.",
      "- Return a reviewable artifact.",
      "- Keep the output structured with these headings exactly: Final Summary, Changed Files, Commands Run, Tests, Residual Risks, Verification.",
    ].filter(Boolean).join("\n");
  }

  function parseOpenCodeCliResult(output, workspacePath) {
    const text = String(output ?? "").trim();
    return {
      adapter: "opencode-cli",
      actionsTaken: ["Local OpenCode CLI returned a coding result through the host adapter."],
      changedFiles: sectionFromMarkdown(text, "Changed Files").split("\n").filter(Boolean),
      commandsRun: sectionFromMarkdown(text, "Commands Run").split("\n").filter(Boolean),
      finalSummary: sectionFromMarkdown(text, "Final Summary") || text.slice(0, 1600) || "OpenCode completed without returning a summary.",
      residualRisks: sectionFromMarkdown(text, "Residual Risks").split("\n").filter(Boolean).length
        ? sectionFromMarkdown(text, "Residual Risks").split("\n").filter(Boolean)
        : ["OpenCode output is an add-on artifact and still requires normal human review."],
      verification: sectionFromMarkdown(text, "Verification").split("\n").filter(Boolean).length
        ? sectionFromMarkdown(text, "Verification").split("\n").filter(Boolean)
        : sectionFromMarkdown(text, "Tests").split("\n").filter(Boolean).length
          ? sectionFromMarkdown(text, "Tests").split("\n").filter(Boolean)
          : ["Local OpenCode CLI returned successfully."],
      workspacePath: path.relative(repoRoot, workspacePath) || ".",
    };
  }

  async function runOpenCodeCliDelegation(command, packet, payload = {}) {
    const workspacePath = resolveOpenCodeWorkspacePath(payload);
    const prompt = buildOpenCodeExecutionPrompt(packet, workspacePath);
    const args = ["run", prompt, "--dir", workspacePath];
    const output = await execFileStdout(command, args, {
      cwd: workspacePath,
      timeout: Math.min(900_000, Math.max(30_000, Number(payload.timeoutMs ?? 300_000))),
    });
    return parseOpenCodeCliResult(output, workspacePath);
  }

  async function writeOpenCodeResultArtifact(taskPath, packet, result) {
    const id = fieldFromMarkdown(packet, "id") || path.basename(taskPath, ".md");
    const artifactDir = path.join(delegationArtifactRoot(), "opencode");
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, `${id}-result.md`);
    const lines = [
      `# OpenCode Result: ${id}`,
      "",
      `- id: ${id}`,
      `- taskPath: ${path.relative(userRoot(), taskPath)}`,
      `- createdAt: ${new Date().toISOString()}`,
      `- adapter: ${result.adapter}`,
      "- status: completed",
      `- workspacePath: ${result.workspacePath || "."}`,
      "- boundary: Reviewable coding artifact only. Shell, filesystem, provider secrets, trusted memory writes, and external sends remain governed by ResonantOS.",
      "",
      "## Final Summary",
      result.finalSummary,
      "",
      "## Actions Taken",
      ...(result.actionsTaken ?? []).map((item) => `- ${item}`),
      "",
      "## Changed Files",
      ...((result.changedFiles ?? []).length ? result.changedFiles : ["None reported."]).map((item) => `- ${item}`),
      "",
      "## Commands Run",
      ...((result.commandsRun ?? []).length ? result.commandsRun : ["None reported."]).map((item) => `- ${item}`),
      "",
      "## Residual Risks",
      ...(result.residualRisks ?? []).map((item) => `- ${item}`),
      "",
      "## Verification",
      ...(result.verification ?? []).map((item) => `- ${item}`),
      "",
    ];
    await writeFile(artifactPath, lines.join("\n"));
    return artifactPath;
  }

  async function executeOpenCodeDelegationStart(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "opencode");
    const packet = await readFile(taskPath, "utf8");
    const currentStatus = fieldFromMarkdown(packet, "status") || "queued";
    if (["completed", "cancelled"].includes(currentStatus)) {
      throw new Error(`OpenCode delegation is already ${currentStatus}.`);
    }
    const adapter = String(payload.adapter ?? process.env.RESONANTOS_OPENCODE_ADAPTER ?? "auto").trim().toLowerCase();
    const command = opencodeCommand();
    const executionSettings = await readAddonExecutionSettings();
    await writeDelegationStatus(taskPath, "running", {
      startedAt: new Date().toISOString(),
      adapter: adapter || "auto",
      workspacePath: path.relative(repoRoot, resolveOpenCodeWorkspacePath(payload)) || ".",
    });
    if (adapter !== "deterministic" && !command) {
      const updated = await writeDelegationStatus(taskPath, "blocked", {
        blockedAt: new Date().toISOString(),
        blockedReason: "OpenCode CLI unavailable",
      });
      return {
        ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
        blockedReason: "OpenCode CLI unavailable. Install or configure OpenCode, or run the deterministic adapter in tests.",
        status: "blocked",
      };
    }
    if (adapter !== "deterministic" && !addonLocalCliExecutionEnabled("opencode", payload, executionSettings)) {
      const updated = await writeDelegationStatus(taskPath, "blocked", {
        blockedAt: new Date().toISOString(),
        blockedReason: "OpenCode execution requires explicit enablement",
      });
      return {
        ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
        blockedReason: "OpenCode CLI was found, but execution is disabled. Set RESONANTOS_OPENCODE_EXECUTION=enabled or pass enableOpenCodeExecution from a trusted Settings flow.",
        status: "blocked",
      };
    }
    let result;
    try {
      result = adapter === "deterministic"
        ? deterministicOpenCodeResult(packet, payload)
        : await runOpenCodeCliDelegation(command, packet, payload);
    } catch (error) {
      const updated = await writeDelegationStatus(taskPath, "failed", {
        failedAt: new Date().toISOString(),
        failureReason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
      return {
        ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
        failureReason: error instanceof Error ? error.message : String(error),
        status: "failed",
      };
    }
    const artifactPath = await writeOpenCodeResultArtifact(taskPath, packet, result);
    let updated = await writeDelegationStatus(taskPath, "completed", {
      completedAt: new Date().toISOString(),
      resultArtifactPath: path.relative(userRoot(), artifactPath),
    });
    updated = `${updated.trimEnd()}\n\n## Result\n${result.finalSummary}\n\n## Result Artifact\n${path.relative(userRoot(), artifactPath)}\n`;
    await writeFile(taskPath, updated);
    return {
      ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
      adapter: result.adapter,
      artifact: {
        path: path.relative(userRoot(), artifactPath),
        ...result,
      },
      status: "completed",
    };
  }

  async function executeOpenCodeDelegationStatus(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "opencode");
    const [details, content] = await Promise.all([stat(taskPath), readFile(taskPath, "utf8")]);
    return delegationSummaryFromMarkdown(taskPath, content, details);
  }

  async function executeOpenCodeDelegationArtifact(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "opencode");
    const content = await readFile(taskPath, "utf8");
    const artifactRelative = fieldFromMarkdown(content, "resultArtifactPath");
    if (!artifactRelative) {
      throw new Error("OpenCode delegation has no result artifact yet.");
    }
    const artifactPath = path.resolve(userRoot(), artifactRelative);
    const artifactRoot = path.resolve(path.join(delegationArtifactRoot(), "opencode"));
    if (!artifactPath.startsWith(`${artifactRoot}${path.sep}`) || !artifactPath.endsWith(".md")) {
      throw new Error("OpenCode result artifact path is outside the approved artifact root.");
    }
    const artifact = await readFile(artifactPath, "utf8");
    return {
      changedFiles: sectionFromMarkdown(artifact, "Changed Files"),
      commandsRun: sectionFromMarkdown(artifact, "Commands Run"),
      content: artifact,
      finalSummary: sectionFromMarkdown(artifact, "Final Summary"),
      path: path.relative(userRoot(), artifactPath),
      residualRisks: sectionFromMarkdown(artifact, "Residual Risks"),
      verification: sectionFromMarkdown(artifact, "Verification"),
    };
  }

  async function executeOpenCodeDelegationCancel(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "opencode");
    const content = await readFile(taskPath, "utf8");
    const currentStatus = fieldFromMarkdown(content, "status") || "queued";
    if (["completed", "cancelled"].includes(currentStatus)) {
      return delegationSummaryFromMarkdown(taskPath, content, await stat(taskPath));
    }
    const updated = await writeDelegationStatus(taskPath, "cancelled", {
      cancelledAt: new Date().toISOString(),
      cancelReason: String(payload.reason ?? "Human cancelled OpenCode delegation.").slice(0, 240),
    });
    return delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath));
  }

  async function executeAddonDraftRead(payload) {
    const filePath = resolveDraftPath(payload.path);
    const [details, content] = await Promise.all([stat(filePath), readFile(filePath, "utf8")]);
    return {
      ...draftSummaryFromMarkdown(filePath, content, details),
      content,
    };
  }

  async function executeAddonDraftTransition(payload) {
    const status = String(payload.status ?? "").trim().toLowerCase();
    if (!["approved-for-manual-send", "rejected", "draft-only"].includes(status)) {
      throw new Error("Draft status must be approved-for-manual-send, rejected, or draft-only.");
    }
    const filePath = resolveDraftPath(payload.path);
    const previous = await readFile(filePath, "utf8");
    const previousStatus = fieldFromMarkdown(previous, "status") || "draft-only";
    const reason = String(payload.reason ?? "Manual review from ResonantOS Add-ons workspace.").trim().slice(0, 240);
    const reviewer = String(payload.reviewer ?? "human").trim().slice(0, 80) || "human";
    const next = previous.replace(/^- status:\s*.+$/mi, `- status: ${status}`);
    const audit = [
      "",
      "## Audit",
      `- reviewedAt: ${new Date().toISOString()}`,
      `- reviewer: ${reviewer}`,
      `- previousStatus: ${previousStatus}`,
      `- newStatus: ${status}`,
      `- reason: ${reason}`,
      "- boundary: This review state does not send email or schedule calendar events.",
      "",
    ].join("\n");
    await writeFile(filePath, `${next.trimEnd()}\n${audit}`);
    const details = await stat(filePath);
    return draftSummaryFromMarkdown(filePath, await readFile(filePath, "utf8"), details);
  }

  async function executeAddonDraftProviderHandoff(payload) {
    const filePath = resolveDraftPath(payload.path);
    const provider = String(payload.provider ?? "").trim().toLowerCase();
    const content = await readFile(filePath, "utf8");
    const draft = parseDraftPacketMarkdown(content, {
      id: path.basename(filePath, ".md"),
      target: path.basename(path.dirname(filePath)),
    });
    if (draft.status !== "approved-for-manual-send") {
      throw new Error("Provider handoff requires a human-approved draft packet first.");
    }
    const handoff = buildProviderDraftHandoff(draft, provider);
    const reviewer = String(payload.reviewer ?? "human").trim().slice(0, 80) || "human";
    await writeFile(filePath, appendProviderHandoffAudit(content, handoff, reviewer));
    const details = await stat(filePath);
    return {
      ...draftSummaryFromMarkdown(filePath, await readFile(filePath, "utf8"), details),
      handoff,
    };
  }

  async function executeAddonsStatus() {
    const executionSettings = await readAddonExecutionSettings();
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
          execution: {
            localCliExecution: Boolean(executionSettings.hermes.localCliExecution),
            runtimeAvailable: Boolean(hermesCommand()),
            mode: hermesCommand() ? "local-cli-detected" : "packet-only",
          },
          boundary: "Bundled browser-first add-on contract. Real Hermes execution still requires a detected local Hermes CLI and explicit execution enablement.",
        },
        {
          id: "addon.opencode",
          name: "OpenCode",
          available: existsSync(path.join(repoRoot, "src", "modules", "opencode")),
          mode: "coding-addon",
          trust: "add-on agent",
          requestedCapabilities: ["agent-delegation", "filesystem-scoped", "shell", "providers"],
          grantedCapabilities: ["agent-delegation"],
          deniedCapabilities: executionSettings.opencode.localCliExecution ? [] : ["shell"],
          execution: {
            localCliExecution: Boolean(executionSettings.opencode.localCliExecution),
            mode: opencodeCommand() ? "local-cli-detected" : "packet-only",
          },
        },
        {
          id: "addon.living-archive",
          name: "Living Archive",
          available: existsSync(memoryRoot()),
          mode: "memory-system",
          trust: "host-mediated memory provider",
          requestedCapabilities: ["archive-read", "archive-intake-write", "archive-knowledge-write"],
          grantedCapabilities: ["archive-read", "archive-intake-write"],
          deniedCapabilities: ["archive-knowledge-write"],
        },
        {
          id: "addon.agent-handoff-kit",
          name: "Agent Handoff Kit",
          available: true,
          mode: "handoff-package-addon",
          trust: "host-mediated documentation package",
          requestedCapabilities: ["agent-delegation", "archive-read", "archive-intake-write"],
          grantedCapabilities: [],
          deniedCapabilities: ["archive-intake-write"],
          boundary: "Read-only handoff package. It presents ResonantOS and Hot Rod Rig context for coding agents, but does not execute shell commands, call providers, write trusted memory, or claim autonomous rig execution.",
        },
        {
          id: "addon.email",
          name: "Email",
          available: true,
          mode: "draft-only-communication-addon",
          trust: "host-mediated draft provider",
          providers: ["gmail"],
          requestedCapabilities: ["communication-draft", "provider-handoff"],
          grantedCapabilities: ["communication-draft", "provider-handoff"],
          deniedCapabilities: ["external-send"],
          boundary: "Draft packets only. Gmail handoff opens a compose draft for human review; ResonantOS does not send email.",
        },
        {
          id: "addon.calendar",
          name: "Calendar",
          available: true,
          mode: "draft-only-scheduling-addon",
          trust: "host-mediated draft provider",
          providers: ["google-calendar"],
          requestedCapabilities: ["calendar-draft", "provider-handoff"],
          grantedCapabilities: ["calendar-draft", "provider-handoff"],
          deniedCapabilities: ["external-schedule"],
          boundary: "Draft packets only. Google Calendar handoff opens an event template for human review; ResonantOS does not schedule events.",
        },
      ],
    };
  }

  async function executeAgentHandoffHotRodRigTest() {
    const generatedAt = new Date().toISOString();
    const checkResults = [];
    const addCheck = (id, label, passed, detail = "", evidence = "") => {
      checkResults.push({
        id,
        label,
        passed: Boolean(passed),
        detail,
        evidence,
      });
    };
    const readJsonFile = async (relativePath) => JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
    const readTextFile = async (relativePath) => readFile(path.join(repoRoot, relativePath), "utf8");
    const existsRelative = (relativePath) => existsSync(path.join(repoRoot, relativePath));

    const manifestPath = "public/addons/agent-handoff-kit.json";
    const runbookPath = "docs/architecture/addon-runbooks/agent-handoff-kit/MASTER_AGENT_HANDOFF.md";
    const packagePath = "docs/architecture/addon-runbooks/agent-handoff-kit/package-manifest.json";
    const skillPath = "docs/architecture/addon-skills/agent-handoff-kit/AGENT_HANDOFF_ORCHESTRATION.md";
    const rendererPath = "browser-first/resonantos-side-panel-extension/src/lib/main-workspace-agent-handoff.js";
    const mainWorkspacePath = "browser-first/resonantos-side-panel-extension/src/main-workspace.js";
    const addonsWorkspacePath = "browser-first/resonantos-side-panel-extension/src/lib/main-workspace-addons.js";

    let manifest = {};
    let packageManifest = {};
    let runbook = "";
    let renderer = "";
    let mainWorkspace = "";
    let addonsWorkspace = "";
    try {
      [manifest, packageManifest, runbook, renderer, mainWorkspace, addonsWorkspace] = await Promise.all([
        readJsonFile(manifestPath),
        readJsonFile(packagePath),
        readTextFile(runbookPath),
        readTextFile(rendererPath),
        readTextFile(mainWorkspacePath),
        readTextFile(addonsWorkspacePath),
      ]);
    } catch (error) {
      addCheck("package-readable", "Package files are readable", false, error instanceof Error ? error.message : String(error), repoRoot);
      return {
        id: "agent-handoff-hot-rod-rig-test",
        name: "Augmentor Hot Rod Rig add-on interface test",
        status: "failed",
        passed: false,
        generatedAt,
        summary: "Package files could not be read.",
        checks: checkResults,
      };
    }

    const index = await readJsonFile("public/addons/index.json").catch(() => []);
    const devIndex = await readJsonFile("public/addons/dev-index.json").catch(() => []);
    addCheck(
      "catalogs-include-manifest",
      "Bundled catalogs include the Agent Handoff Kit manifest",
      Array.isArray(index) && Array.isArray(devIndex) && index.includes("agent-handoff-kit.json") && devIndex.includes("agent-handoff-kit.json"),
      "index.json and dev-index.json both reference agent-handoff-kit.json.",
      "public/addons/index.json; public/addons/dev-index.json"
    );
    addCheck(
      "manifest-boundary",
      "Manifest declares bounded, non-executing Hot Rod Rig handoff behavior",
      manifest.id === "addon.agent-handoff-kit" &&
        manifest.runtimeType === "ui-module" &&
        manifest.archiveIntegration?.canWriteKnowledgePages === false &&
        manifest.providerRequirements?.supportsPrivateCredentials === false &&
        manifest.requestedCapabilities?.every?.((grant) => grant.granted === false),
      "No requested capability is pre-granted; trusted knowledge writes and private credentials are disabled.",
      manifestPath
    );
    const status = await executeAddonsStatus();
    const addonStatus = status.addons.find((addon) => addon.id === "addon.agent-handoff-kit");
    addCheck(
      "host-status-boundary",
      "Host status exposes the add-on without privileged execution",
      addonStatus?.available === true &&
        addonStatus?.mode === "handoff-package-addon" &&
        Array.isArray(addonStatus?.grantedCapabilities) &&
        addonStatus.grantedCapabilities.length === 0 &&
        /does not execute shell commands/i.test(addonStatus?.boundary ?? ""),
      "The live /addons/status entry is available and grants no shell/provider/memory-write power.",
      "/addons/status"
    );
    addCheck(
      "documents-exist",
      "Runbook, package manifest, skill, and renderer documents exist",
      [runbookPath, packagePath, skillPath, rendererPath].every(existsRelative),
      "All handoff documents referenced by the add-on package are present.",
      [runbookPath, packagePath, skillPath, rendererPath].join("; ")
    );
    const sources = Array.isArray(packageManifest.sourceEvidence) ? packageManifest.sourceEvidence : [];
    const sourceNames = sources.map((source) => source.source);
    addCheck(
      "channel-evidence",
      "Hot Rod Rig channel evidence is preserved",
      ["#analog6", "#resonantos", "#logs", "#lux-wireless"].every((channel) => sourceNames.includes(channel)),
      "The package manifest lists every relevant Hot Rod Rig Discord channel that was inspected.",
      packagePath
    );
    addCheck(
      "local-source-evidence",
      "Local Hot Rod Rig source documents are listed",
      sourceNames.some((source) => /HOT-ROD-RIG-V5\.3\.md$/.test(source)) &&
        sourceNames.some((source) => /Z-RIG-TURBO-V5\.5-SPEC\.md$/.test(source)) &&
        sourceNames.some((source) => /PANEL-TRUTH-REPORT\.md$/.test(source)),
      "The package manifest includes HRR v5.3, Z-Rig v5.5, and PANEL-TRUTH evidence paths.",
      packagePath
    );
    addCheck(
      "truth-boundary",
      "Runbook prevents unsupported autonomous rig claims",
      /Do not claim a multi-agent run, autonomous panel, or full Z-Rig execution unless there is ledger/i.test(runbook) &&
        /does not execute a Hot Rod Rig run/i.test(runbook),
      "The master runbook treats Hot Rod Rig as operating discipline, not unsupported execution proof.",
      runbookPath
    );
    addCheck(
      "extension-route",
      "Browser-first extension routes the add-on to the agent-handoff workspace",
      /agent-handoff/.test(mainWorkspace) &&
        /renderAgentHandoffWorkspace/.test(mainWorkspace) &&
        /addon\.agent-handoff-kit/.test(addonsWorkspace),
      "Main workspace and Add-ons workspace both know the Agent Handoff Kit route.",
      `${mainWorkspacePath}; ${addonsWorkspacePath}`
    );
    addCheck(
      "workspace-test-surface",
      "Extension workspace renders the Hot Rod Rig test evidence surface",
      /Augmentor Hot Rod Rig Test/.test(renderer) &&
        /hot-rod-rig-test/.test(renderer) &&
        /Verification Gates/.test(renderer),
      "The renderer includes a bridge-backed Augmentor Hot Rod Rig test panel.",
      rendererPath
    );

    const passed = checkResults.every((check) => check.passed);
    return {
      id: "agent-handoff-hot-rod-rig-test",
      name: "Augmentor Hot Rod Rig add-on interface test",
      status: passed ? "passed" : "failed",
      passed,
      generatedAt,
      summary: passed
        ? "Agent Handoff Kit passed the host-backed Hot Rod Rig package test for the ResonantOS Chrome extension interface."
        : "Agent Handoff Kit did not satisfy every host-backed Hot Rod Rig package check.",
      checks: checkResults,
    };
  }

  async function executeAddonExecutionSettingsGet() {
    const settings = await readAddonExecutionSettings();
    return {
      settings,
      boundary: "Local CLI execution is disabled by default. Enabling it lets a configured add-on runtime execute through host-mediated adapters while preserving scoped task packets and artifact review.",
    };
  }

  async function executeAddonExecutionSettingsUpdate(payload = {}) {
    const current = await readAddonExecutionSettings();
    const addon = String(payload.addon ?? "").trim().toLowerCase();
    if (!["hermes", "opencode"].includes(addon)) {
      throw new Error("Execution settings can only be updated for Hermes or OpenCode.");
    }
    const next = normalizeAddonExecutionSettings(current);
    next[addon] = {
      ...next[addon],
      localCliExecution: Boolean(payload.localCliExecution),
    };
    const settings = await writeAddonExecutionSettings(next);
    return {
      addon,
      settings,
      status: settings[addon].localCliExecution ? "enabled" : "disabled",
    };
  }

  async function executeHermesDashboardStatus(payload = {}) {
    const target = dashboardTarget(payload.host, payload.port);
    const command = hermesCommand(payload.profileHome);
    const running = await socketOpen(target.host, target.port);
    return {
      running,
      url: clientReachableUrl(target.url),
      // Same-origin URL the extension hits to fetch the dashboard HTML,
      // which it then inlines into a sandboxed <iframe srcdoc> on its own
      // secure extension page. This avoids Chrome's mixed-content rule
      // (which would block any http:// iframe src inside a
      // chrome-extension:// page). Works for any addon, no TLS, no certs.
      dashboardProxyUrl: clientReachableProxyUrl(),
      host: target.host,
      port: target.port,
      clientHost: clientReachableHost(),
      command,
      profileHome: hermesHome(payload.profileHome),
      detail: running
        ? `Hermes dashboard is reachable at ${clientReachableUrl(target.url)}.`
        : `Hermes dashboard is not reachable at ${clientReachableUrl(target.url)}.`,
      rawStatus: command ? "Hermes CLI found." : "Hermes CLI was not found.",
    };
  }

  async function executeHermesDashboardStart(payload = {}) {
    const target = dashboardTarget(payload.host, payload.port);
    const profileHome = hermesHome(payload.profileHome);
    const command = hermesCommand(profileHome);
    if (!command) {
      throw new Error("Hermes CLI was not found. Install or configure Hermes before launching the dashboard.");
    }
    const alreadyRunning = await socketOpen(target.host, target.port);
    if (!alreadyRunning) {
      // Bind Hermes to the bridge's public interface so remote clients
      // (Mac/Windows extension over LAN or Tailscale) can reach the
      // dashboard. Falls back to loopback if the bridge is loopback-only.
      const bindHost = clientReachableHost();
      const args = ["dashboard", "--host", bindHost, "--port", String(target.port), "--no-open"];
      if (payload.includeTui !== false) {
        args.push("--tui");
      }
      const child = spawn(command, args, {
        detached: true,
        env: { ...process.env, HERMES_HOME: profileHome },
        stdio: "ignore",
      });
      child.unref();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await socketOpen(target.host, target.port)) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    return executeHermesDashboardStatus({ ...payload, host: target.host, port: target.port, profileHome });
  }

  async function executeHermesDashboardStop(payload = {}) {
    const profileHome = hermesHome(payload.profileHome);
    const command = hermesCommand(profileHome);
    if (!command) {
      throw new Error("Hermes CLI was not found. Install or configure Hermes before stopping the dashboard.");
    }
    await new Promise((resolve) => {
      const child = spawn(command, ["dashboard", "--stop"], {
        env: { ...process.env, HERMES_HOME: profileHome },
        stdio: "ignore",
      });
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    return executeHermesDashboardStatus({ ...payload, profileHome });
  }

  return {
    executeGoalRecord,
    executeDelegationRecord,
    executeAddonDraftRecord,
    executeAddonDraftList,
    executeDelegationList,
    executeHermesStatus,
    executeHermesDelegationStart,
    executeHermesDelegationStatus,
    executeHermesDelegationArtifact,
    executeHermesDelegationCancel,
    executeOpenCodeStatus,
    executeOpenCodeDelegationStart,
    executeOpenCodeDelegationStatus,
    executeOpenCodeDelegationArtifact,
    executeOpenCodeDelegationCancel,
    executeAddonDraftRead,
    executeAddonDraftTransition,
    executeAddonDraftProviderHandoff,
    executeAddonsStatus,
    executeAgentHandoffHotRodRigTest,
    executeAddonExecutionSettingsGet,
    executeAddonExecutionSettingsUpdate,
    executeHermesDashboardStatus,
    executeHermesDashboardStart,
    executeHermesDashboardStop,
  };
}
