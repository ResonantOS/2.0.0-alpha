import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import {
  appendProviderHandoffAudit,
  buildProviderDraftHandoff,
  parseDraftPacketMarkdown,
} from "./addon-draft-connectors.mjs";
import { isInsidePath } from "./browser-first-host-utils.mjs";
import { dashboardProxyUrl } from "./bridge-server.mjs";
import { createDelegationIsolationAdapter } from "./delegation-isolation.mjs";
import { ensureOpencodeServer, peekOpencodeServer } from "./opencode-client.mjs";
import { createOpenCodeWebUrlHandler } from "./opencode-session-host-service.mjs";

const DEFAULT_OPENCODE_MODEL = "openai/gpt-5.4-mini";
const MINIMAX_OPENCODE_MODEL = "minimax/MiniMax-M3";
const DEFAULT_HERMES_PROVIDER = "openai-api";
const DEFAULT_HERMES_MODEL = "gpt-5.4-mini";
const DEFAULT_HERMES_MINIMAX_MODEL = "MiniMax-M3";
const MINIMAX_OPENAI_COMPAT_BASE_URL = "https://api.minimax.io/v1";

const providerEnvKeyDefaults = Object.freeze({
  anthropic: ["ANTHROPIC_API_KEY"],
  "anthropic-api": ["ANTHROPIC_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  glm: ["GLM_API_KEY", "ZAI_API_KEY", "ZHIPUAI_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "openai-api": ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  xai: ["XAI_API_KEY"],
  zai: ["ZAI_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"],
  zhipuai: ["ZHIPUAI_API_KEY", "ZAI_API_KEY", "GLM_API_KEY"],
});

export const OPENCODE_EXPLICIT_PROVIDER_ENV_KEYS = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "GEMINI_BASE_URL",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "GOOGLE_API_BASE_URL",
  "GLM_BASE_URL",
  "MINIMAX_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENROUTER_BASE_URL",
  "XAI_BASE_URL",
  "ZAI_BASE_URL",
  "ZHIPUAI_BASE_URL",
]);

const providerSecretIdDefaults = Object.freeze({
  anthropic: ["shared-anthropic", "anthropic"],
  "anthropic-api": ["shared-anthropic", "anthropic"],
  deepseek: ["shared-deepseek", "deepseek"],
  gemini: ["shared-gemini", "shared-google", "gemini", "google"],
  google: ["shared-google", "shared-gemini", "google", "gemini"],
  minimax: ["shared-minimax", "minimax"],
  openai: ["shared-openai", "openai"],
  "openai-api": ["shared-openai", "openai"],
  openrouter: ["shared-openrouter", "openrouter"],
  xai: ["shared-xai", "xai"],
  zai: ["shared-zai-glm", "shared-zai", "zai", "glm", "zhipuai"],
  zhipuai: ["shared-zai-glm", "shared-zhipuai", "zhipuai", "zai", "glm"],
});

function providerFromModel(model, fallback = "") {
  const [provider] = String(model ?? "").trim().split("/");
  return provider && provider !== String(model ?? "").trim() ? provider.toLowerCase() : fallback;
}

function providerEnvKeysForProvider(provider) {
  return providerEnvKeyDefaults[String(provider ?? "").trim().toLowerCase()] ?? [];
}

function providerSecretCandidates(provider) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  return providerSecretIdDefaults[normalized] ?? (normalized ? [`shared-${normalized}`, normalized] : []);
}

function secretForProvider(provider, secrets = {}) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  const entries = Object.entries(secrets ?? {})
    .map(([providerId, credential]) => [String(providerId ?? "").trim(), String(credential ?? "").trim()])
    .filter(([providerId, credential]) => providerId && credential);
  const byId = new Map(entries.map(([providerId, credential]) => [providerId.toLowerCase(), credential]));
  for (const candidate of providerSecretCandidates(normalized)) {
    const credential = byId.get(String(candidate).toLowerCase());
    if (credential) return credential;
  }
  const fuzzy = entries.find(([providerId]) => {
    const id = providerId.toLowerCase();
    return normalized && (id === normalized || id.includes(`-${normalized}`) || id.includes(normalized));
  });
  return fuzzy?.[1] ?? "";
}

function providerEnvFromSecrets(provider, secrets = {}, envKeys = providerEnvKeysForProvider(provider)) {
  const credential = secretForProvider(provider, secrets);
  if (!credential) return {};
  const selectedKey = envKeys.find((key) => !String(process.env[key] ?? "").trim()) ?? envKeys[0];
  return selectedKey ? { [selectedKey]: credential } : {};
}

function providerCredential(provider, secrets = {}, envKeys = providerEnvKeysForProvider(provider)) {
  const secret = secretForProvider(provider, secrets);
  if (secret) return secret;
  return envKeys
    .map((key) => String(process.env[key] ?? "").trim())
    .find(Boolean) ?? "";
}

function providerEnvKeysPresent(provider, secrets = {}, envKeys = providerEnvKeysForProvider(provider)) {
  const fromProcess = envKeys.filter((key) => String(process.env[key] ?? "").trim());
  const fromSecrets = secretForProvider(provider, secrets) ? [envKeys[0]].filter(Boolean) : [];
  return [...new Set([...fromProcess, ...fromSecrets])];
}

function redactCliText(value) {
  return String(value ?? "")
    .replace(/sk-[a-z0-9_-]+/gi, "[redacted-key]")
    .replace(/bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted-token]")
    .replace(/api[_-]?key\s*[:=]\s*[^\s]+/gi, "api_key=[redacted]")
    .replace(/token\s*[:=]\s*[^\s]+/gi, "token=[redacted]")
    .replace(/secret\s*[:=]\s*[^\s]+/gi, "secret=[redacted]");
}

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
    hermesPythonRuntime,
    listFilesRecursive,
    memoryRoot,
    opencodeCommand,
    opencodeRuntimeDiagnostics,
    ensureOpenCodeServer = ensureOpencodeServer,
    peekOpenCodeServer = peekOpencodeServer,
    platform = process.platform,
    redactPathForDiagnostics,
    readProviderSecrets = async () => ({}),
    repoRoot,
    safeFileSlug,
    fs: isolationFs = fsPromises,
    isolation: isolationDependency,
    spawnProcess = spawn,
    socketOpen,
    uniqueRuntimeId,
    userRoot,
  } = dependencies;
  const isolation = isolationDependency?.resolve
    ? isolationDependency
    : createDelegationIsolationAdapter({
      browserFirstRoot,
      env: process.env,
      fs: isolationFs,
      platform,
      repoRoot,
      spawnProcess,
      uniqueRuntimeId,
      userRoot,
      ...(isolationDependency ?? {}),
    });

  function currentOpenCodeRuntime() {
    if (typeof opencodeRuntimeDiagnostics === "function") {
      return opencodeRuntimeDiagnostics();
    }
    const command = opencodeCommand();
    return {
      installed: Boolean(command),
      command,
      commandRedacted: command ? redactPathForDiagnostics(command) : "",
      installHint: "Install OpenCode with `curl -fsSL https://opencode.ai/install | bash` or `npm install -g opencode-ai`. To select a binary at a supported fixed install root, set `OPENCODE_COMMAND=/usr/local/bin/opencode` and restart ResonantOS.",
      installCommand: "curl -fsSL https://opencode.ai/install | bash",
      alternativeInstallCommands: ["npm install -g opencode-ai", "brew install anomalyco/tap/opencode"],
      configureCommand: "OPENCODE_COMMAND=/usr/local/bin/opencode",
      searchedCommands: ["opencode", "opencode-ai"],
      searchedPaths: [],
      searchedPathCount: 0,
      searchedPathOmitted: 0,
      overrideConfigured: false,
      overridePath: "",
      overrideFound: false,
    };
  }

  function openCodeProviderForModel(model) {
    const normalized = String(model ?? "").trim();
    if (/^minimax-m/i.test(normalized)) return "minimax";
    if (/^gpt-/i.test(normalized)) return "openai";
    return providerFromModel(normalized, "openai");
  }

  function openCodeModel(payload = {}, secrets = {}) {
    const requested = String(payload.model ?? process.env.RESONANTOS_OPENCODE_MODEL ?? "").trim();
    if (requested) return requested;
    if (providerEnvKeysPresent("minimax", secrets).length) return MINIMAX_OPENCODE_MODEL;
    return DEFAULT_OPENCODE_MODEL;
  }

  function isAllowedOpenCodeProviderEnvKey(key) {
    return OPENCODE_EXPLICIT_PROVIDER_ENV_KEYS.includes(key);
  }

  function openCodeProviderEnvKeys(model) {
    const provider = openCodeProviderForModel(model);
    const explicit = String(process.env.RESONANTOS_OPENCODE_PROVIDER_ENV ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(isAllowedOpenCodeProviderEnvKey);
    return [...new Set([...providerEnvKeysForProvider(provider), ...explicit])];
  }

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

  function addonGovernanceAuditPath() {
    return path.join(browserFirstRoot(), "Settings", "addon-governance-audit.jsonl");
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

  async function appendAddonGovernanceAuditEntry(entry) {
    const filePath = addonGovernanceAuditPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
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

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  const addonIdPattern = /^[a-z0-9][a-z0-9._-]{0,119}$/i;
  const addonCapabilityPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
  const userDataListKeys = Object.freeze(["addonId"]);
  const userDataDeleteKeys = Object.freeze(["addonId", "bucket", "paths", "confirm"]);
  const addonDelegationTargets = new Map([
    ["addon.hermes", ["hermes"]],
    ["addon.opencode", ["opencode"]],
  ]);
  const intakeNotAttributableReason = "No intake file on the bridge carries a structured add-on id; the browser-job and Living Archive source-intake writers do not record one, so nothing can be listed or deleted for this add-on.";
  const uninstallAuditKeys = Object.freeze([
    "actor",
    "addonId",
    "alsoDeleteUserDataOffered",
    "at",
    "clearedCapabilities",
    "clearedPrivateProviderProfileIds",
    "configDeleted",
    "event",
    "previousEnabled",
    "previousInstalled",
    "previousStatus",
    "source",
    "userDataRetained",
  ]);
  const installationStatuses = new Set([
    "available",
    "installed",
    "enabled",
    "disabled",
    "degraded",
    "update-available",
    "incompatible",
    "uninstalled",
  ]);

  function rejectUninstallAudit(reason) {
    throw new Error(`Uninstall audit record rejected: ${reason}`);
  }

  function rejectRunningWork(reason) {
    throw new Error(`Running-work query rejected: ${reason}`);
  }

  function rejectUserDataQuery(reason) {
    throw new Error(`User-data query rejected: ${reason}`);
  }

  function rejectUserDataDelete(reason) {
    throw new Error(`User-data delete rejected: ${reason}`);
  }

  function hasExactKeys(payload, allowedKeys) {
    const keys = Object.keys(payload);
    const allowed = new Set(allowedKeys);
    if (keys.some((key) => !allowed.has(key))) return "unexpected-keys";
    if (allowedKeys.some((key) => !Object.hasOwn(payload, key))) return "missing-keys";
    return "";
  }

  function validateCanonicalIsoTimestamp(value) {
    if (typeof value !== "string") return false;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.toISOString() === value;
  }

  function validateUserDataListPayload(payload) {
    if (!isPlainObject(payload)) rejectUserDataQuery("not-an-object");
    const keyError = hasExactKeys(payload, userDataListKeys);
    if (keyError) rejectUserDataQuery(keyError);
    if (typeof payload.addonId !== "string" || !addonIdPattern.test(payload.addonId)) {
      rejectUserDataQuery("addonId");
    }
    return { addonId: payload.addonId };
  }

  function hasParentPathSegment(value) {
    return String(value).split(/[\\/]+/).includes("..");
  }

  function isAbsoluteRequestPath(value) {
    return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
  }

  function validateUserDataDeletePayload(payload) {
    if (!isPlainObject(payload)) rejectUserDataDelete("not-an-object");
    const keyError = hasExactKeys(payload, userDataDeleteKeys);
    if (keyError) rejectUserDataDelete(keyError);
    if (typeof payload.addonId !== "string" || !addonIdPattern.test(payload.addonId)) {
      rejectUserDataDelete("addonId");
    }
    if (!["delegation", "intake"].includes(payload.bucket)) rejectUserDataDelete("bucket");
    if (
      !Array.isArray(payload.paths) ||
      payload.paths.length === 0 ||
      payload.paths.length > 300 ||
      payload.paths.some((entry) => (
        typeof entry !== "string" ||
        !entry ||
        entry.length > 512 ||
        isAbsoluteRequestPath(entry) ||
        hasParentPathSegment(entry)
      ))
    ) {
      rejectUserDataDelete("paths");
    }
    if (payload.confirm !== `delete:${payload.addonId}:${payload.bucket}`) rejectUserDataDelete("confirm");
    return {
      addonId: payload.addonId,
      bucket: payload.bucket,
      paths: [...new Set(payload.paths)],
    };
  }

  function validateUninstallAuditRecord(payload) {
    if (!isPlainObject(payload)) rejectUninstallAudit("not-an-object");
    const keyError = hasExactKeys(payload, uninstallAuditKeys);
    if (keyError) rejectUninstallAudit(keyError);
    if (payload.event !== "addonUninstalled") rejectUninstallAudit("event");
    if (typeof payload.addonId !== "string" || !addonIdPattern.test(payload.addonId)) {
      rejectUninstallAudit("addonId");
    }
    if (!["bundled", "sideload"].includes(payload.source)) rejectUninstallAudit("source");
    if (!installationStatuses.has(payload.previousStatus)) rejectUninstallAudit("previousStatus");
    if (
      typeof payload.previousInstalled !== "boolean" ||
      typeof payload.previousEnabled !== "boolean" ||
      typeof payload.configDeleted !== "boolean" ||
      typeof payload.alsoDeleteUserDataOffered !== "boolean"
    ) {
      rejectUninstallAudit("booleans");
    }
    if (payload.userDataRetained !== true) rejectUninstallAudit("userDataRetained");
    if (payload.actor !== "human") rejectUninstallAudit("actor");
    if (
      !Array.isArray(payload.clearedCapabilities) ||
      payload.clearedCapabilities.length > 64 ||
      payload.clearedCapabilities.some((capability) => (
        typeof capability !== "string" || !addonCapabilityPattern.test(capability)
      ))
    ) {
      rejectUninstallAudit("clearedCapabilities");
    }
    if (
      !Number.isInteger(payload.clearedPrivateProviderProfileIds) ||
      payload.clearedPrivateProviderProfileIds < 0 ||
      payload.clearedPrivateProviderProfileIds > 10_000
    ) {
      rejectUninstallAudit("clearedPrivateProviderProfileIds");
    }
    if (!validateCanonicalIsoTimestamp(payload.at)) rejectUninstallAudit("at");
    return Object.fromEntries(uninstallAuditKeys.map((key) => [key, payload[key]]));
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

  function resultArtifactPathFromMarkdown(content) {
    const fieldValue = fieldFromMarkdown(content, "resultArtifactPath");
    if (fieldValue) return fieldValue;
    return sectionFromMarkdown(content, "Result Artifact")
      .split(/\s+/)
      .map((line) => line.trim())
      .find(Boolean) || "";
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
      resultArtifactPath: resultArtifactPathFromMarkdown(content),
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

  async function executeAddonUninstallAudit(payload) {
    const record = validateUninstallAuditRecord(payload);
    const recordedAt = new Date().toISOString();
    await appendAddonGovernanceAuditEntry({
      ...record,
      recordedAt,
      recordedVia: "bridge",
    });
    return { recorded: true, addonId: record.addonId, recordedAt };
  }

  function emptyUserDataDelegation(targets = []) {
    return {
      targets,
      records: [],
      artifacts: [],
      truncated: false,
      dropped: 0,
    };
  }

  async function safeLstat(filePath) {
    try {
      return await isolationFs.lstat(filePath);
    } catch {
      return null;
    }
  }

  async function safeRealpath(filePath) {
    try {
      return await isolationFs.realpath(filePath);
    } catch {
      return "";
    }
  }

  async function userDataTrustedRoots() {
    const browserRoot = browserFirstRoot();
    const recordsRoot = delegationRoot();
    const artifactsRoot = delegationArtifactRoot();
    const result = {
      base: "",
      records: { root: recordsRoot, real: "", available: false, untrusted: false },
      artifacts: { root: artifactsRoot, real: "", available: false, untrusted: false },
      untrusted: false,
    };
    const baseDetails = await safeLstat(browserRoot);
    if (!baseDetails) return result;
    if (!baseDetails.isDirectory() || baseDetails.isSymbolicLink()) {
      result.untrusted = true;
      return result;
    }
    result.base = await safeRealpath(browserRoot);
    if (!result.base) {
      result.untrusted = true;
      return result;
    }
    for (const bucket of ["records", "artifacts"]) {
      const entry = result[bucket];
      const details = await safeLstat(entry.root);
      if (!details) continue;
      if (!details.isDirectory() || details.isSymbolicLink()) {
        entry.untrusted = true;
        result.untrusted = true;
        continue;
      }
      const real = await safeRealpath(entry.root);
      if (!real || !isInsidePath(real, result.base)) {
        entry.untrusted = true;
        result.untrusted = true;
        continue;
      }
      entry.real = real;
      entry.available = true;
    }
    return result;
  }

  async function targetDirectoryState(root, target) {
    const targetDir = path.join(root, target);
    const details = await safeLstat(targetDir);
    if (!details) return { target, targetDir, available: false, invalid: false };
    if (!details.isDirectory() || details.isSymbolicLink()) {
      return { target, targetDir, available: false, invalid: true };
    }
    return { target, targetDir, available: true, invalid: false };
  }

  function safeUserRelativePath(filePath) {
    const relativePath = path.relative(userRoot(), filePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return "";
    }
    return relativePath;
  }

  async function executeAddonUserDataListInternal(addonId) {
    const targets = addonDelegationTargets.get(addonId) ?? [];
    const delegation = emptyUserDataDelegation(targets);
    const listed = new Map();
    const invalidTargetDirs = [];
    const trusted = await userDataTrustedRoots();

    async function collect(kind, rootInfo, predicate) {
      if (!rootInfo.available || rootInfo.untrusted) return;
      for (const target of targets) {
        const targetState = await targetDirectoryState(rootInfo.root, target);
        if (targetState.invalid) {
          invalidTargetDirs.push(targetState.targetDir);
          continue;
        }
        if (!targetState.available) continue;
        let files = [];
        try {
          files = await listFilesRecursive(targetState.targetDir, predicate, 300);
        } catch {
          files = [];
        }
        if (files.length >= 300) delegation.truncated = true;
        for (const filePath of files) {
          const relativePath = safeUserRelativePath(filePath);
          if (!relativePath) {
            delegation.dropped += 1;
            continue;
          }
          if (kind === "records") {
            const content = await isolationFs.readFile(filePath, "utf8").catch(() => "");
            const status = (fieldFromMarkdown(content, "status") || "queued").toLowerCase();
            const record = {
              path: relativePath,
              id: fieldFromMarkdown(content, "id") || path.basename(filePath, ".md"),
              status,
              running: status === "running",
            };
            delegation.records.push(record);
            listed.set(relativePath, { ...record, kind, target });
          } else {
            const artifact = { path: relativePath };
            delegation.artifacts.push(artifact);
            listed.set(relativePath, { ...artifact, kind, target, running: false });
          }
        }
      }
    }

    await collect("records", trusted.records, (filePath) => filePath.endsWith(".md"));
    await collect("artifacts", trusted.artifacts, () => true);

    return {
      addonId,
      delegation,
      intake: {
        attributable: false,
        reason: intakeNotAttributableReason,
        entries: [],
      },
      listed,
      invalidTargetDirs,
      trusted,
    };
  }

  async function executeAddonUserDataList(payload) {
    const { addonId } = validateUserDataListPayload(payload);
    const { delegation, intake } = await executeAddonUserDataListInternal(addonId);
    return { addonId, delegation, intake };
  }

  function refusalReasonCounts(refused) {
    return refused.reduce((counts, entry) => {
      counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
      return counts;
    }, {});
  }

  async function auditAddonUserDataDelete({ addonId, bucket, requested, deleted, refused }) {
    await appendAddonGovernanceAuditEntry({
      at: new Date().toISOString(),
      event: "addonUserDataDeleted",
      addonId,
      bucket,
      requested,
      deleted: deleted.length,
      refused: refused.length,
      refusalReasons: refusalReasonCounts(refused),
    });
  }

  function pathInsideAnyTarget(absPath, targets, rootForTarget) {
    return targets.some((target) => isInsidePath(absPath, rootForTarget(target)));
  }

  async function stoppedAfterUserDataDelete(addonId) {
    const listing = await executeAddonUserDataListInternal(addonId);
    return !listing.delegation.records.some((record) => record.running);
  }

  async function executeAddonUserDataDelete(payload) {
    const { addonId, bucket, paths } = validateUserDataDeletePayload(payload);
    const deleted = [];
    const refused = [];

    if (bucket === "intake") {
      refused.push(...paths.map((entryPath) => ({ path: entryPath, reason: "intake-not-attributable" })));
      const stopped = await stoppedAfterUserDataDelete(addonId);
      await auditAddonUserDataDelete({ addonId, bucket, requested: paths.length, deleted, refused });
      return { addonId, bucket, deleted, refused, stopped };
    }

    const listing = await executeAddonUserDataListInternal(addonId);
    const targets = listing.delegation.targets;
    if (listing.trusted.untrusted) {
      refused.push(...paths.map((entryPath) => ({ path: entryPath, reason: "roots-untrusted" })));
      const stopped = await stoppedAfterUserDataDelete(addonId);
      await auditAddonUserDataDelete({ addonId, bucket, requested: paths.length, deleted, refused });
      return { addonId, bucket, deleted, refused, stopped };
    }

    for (const relativePath of paths) {
      const absPath = path.resolve(userRoot(), relativePath);
      if (listing.invalidTargetDirs.some((targetDir) => isInsidePath(absPath, targetDir))) {
        refused.push({ path: relativePath, reason: "outside-root" });
        continue;
      }
      const listed = listing.listed.get(relativePath);
      if (!listed) {
        refused.push({ path: relativePath, reason: "not-listed" });
        continue;
      }
      if (listed.running) {
        refused.push({ path: relativePath, reason: "running" });
        continue;
      }
      if (!pathInsideAnyTarget(absPath, targets, (target) => path.join(delegationRoot(), target)) &&
        !pathInsideAnyTarget(absPath, targets, (target) => path.join(delegationArtifactRoot(), target))) {
        refused.push({ path: relativePath, reason: "outside-root" });
        continue;
      }
      const details = await safeLstat(absPath);
      if (!details || !details.isFile() || details.isSymbolicLink()) {
        refused.push({ path: relativePath, reason: "not-a-file" });
        continue;
      }
      const realPath = await safeRealpath(absPath);
      if (!realPath || (
        (!listing.trusted.records.real || !isInsidePath(realPath, listing.trusted.records.real)) &&
        (!listing.trusted.artifacts.real || !isInsidePath(realPath, listing.trusted.artifacts.real))
      )) {
        refused.push({ path: relativePath, reason: "outside-root" });
        continue;
      }
      try {
        await isolationFs.rm(absPath, { force: false });
        deleted.push(relativePath);
      } catch {
        refused.push({ path: relativePath, reason: "delete-failed" });
      }
    }

    const stopped = await stoppedAfterUserDataDelete(addonId);
    await auditAddonUserDataDelete({ addonId, bucket, requested: paths.length, deleted, refused });
    return { addonId, bucket, deleted, refused, stopped };
  }

  async function executeAddonRunningWork(payload) {
    if (!isPlainObject(payload)) rejectRunningWork("not-an-object");
    const keyError = hasExactKeys(payload, ["addonId"]);
    if (keyError) rejectRunningWork(keyError);
    if (typeof payload.addonId !== "string" || !addonIdPattern.test(payload.addonId)) {
      rejectRunningWork("addonId");
    }

    const targets = addonDelegationTargets.get(payload.addonId) ?? [];
    const running = [];
    let queuedCount = 0;

    for (const target of targets) {
      const root = path.join(delegationRoot(), target);
      const files = await listFilesRecursive(root, (filePath) => filePath.endsWith(".md"), 300);
      for (const filePath of files) {
        const [details, content] = await Promise.all([
          stat(filePath).catch(() => null),
          readFile(filePath, "utf8").catch(() => ""),
        ]);
        const status = (fieldFromMarkdown(content, "status") || "queued").toLowerCase();
        if (status === "queued") {
          queuedCount += 1;
        }
        if (status === "running") {
          running.push({
            id: fieldFromMarkdown(content, "id") || path.basename(filePath, ".md"),
            target,
            updatedAt: details?.mtime?.toISOString?.() ?? "",
          });
        }
      }
    }

    const stopped = running.length === 0;
    return {
      addonId: payload.addonId,
      targets,
      running,
      queuedCount,
      stopped,
      detail: stopped
        ? "No running delegations for this add-on on the bridge."
        : `${running.length} running delegation(s) for this add-on; cancel them or wait for them to finish before uninstalling.`,
    };
  }

  async function executeHermesStatus(payload = {}) {
    const executionSettings = await readAddonExecutionSettings();
    const profileHome = hermesHome(payload.profileHome);
    const command = hermesCommand(profileHome);
    const dashboard = await executeHermesDashboardStatus({ profileHome, host: payload.host, port: payload.port });
    const secrets = await readProviderSecrets();
    const provider = hermesProvider(payload, secrets);
    const model = hermesModel(payload, provider);
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
      provider,
      model,
      providerEnvKeys: providerEnvKeysPresent(provider, secrets, providerEnvKeysForProvider(provider)),
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

  async function failDelegationAfterRunning(taskPath, error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const updated = await writeDelegationStatus(taskPath, "failed", {
        failedAt: new Date().toISOString(),
        failureReason: message.slice(0, 500),
      });
      return {
        ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
        failureReason: message,
        status: "failed",
      };
    } catch (statusError) {
      const statusMessage = statusError instanceof Error ? statusError.message : String(statusError);
      throw new Error(`Delegation failed, and failed-status recovery also failed: ${message}; recovery: ${statusMessage}`);
    }
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function withDelegationRunAudit(error, audit) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.delegationRunAudit = audit;
    return wrapped;
  }

  function emptyChangeAudit() {
    return {
      added: 0,
      modified: 0,
      removed: 0,
      truncated: false,
      sample: { added: [], modified: [], removed: [] },
    };
  }

  function auditChangeCounts(changeAudit) {
    return changeAudit
      ? {
        added: changeAudit.added,
        modified: changeAudit.modified,
        removed: changeAudit.removed,
        truncated: Boolean(changeAudit.truncated),
      }
      : null;
  }

  function auditDenialCount(publicIsolation) {
    return publicIsolation?.denials ? publicIsolation.denials.count : null;
  }

  function publicIsolationFromPrepared(prepared, denials = null, denialCaptureError = "") {
    return {
      mode: prepared.mode,
      reason: prepared.reason,
      writableRootCount: prepared.writableRootCount,
      readDenyRootCount: prepared.readDenyRootCount,
      denials,
      ...(denialCaptureError ? { denialCaptureError } : {}),
    };
  }

  function failedIsolation(mode, reason) {
    return {
      mode,
      reason,
      writableRootCount: 0,
      readDenyRootCount: 0,
      denials: null,
    };
  }

  async function appendDelegationExecutionAudit(addonId, taskId, outcome, runAudit) {
    if (!runAudit?.isolation) return;
    const publicIsolation = runAudit.isolation;
    await appendAddonGovernanceAuditEntry({
      at: new Date().toISOString(),
      event: "delegationExecuted",
      addonId,
      taskId,
      isolation: {
        mode: publicIsolation.mode,
        reason: publicIsolation.reason,
        denials: auditDenialCount(publicIsolation),
      },
      changeAudit: auditChangeCounts(runAudit.changeAudit),
      outcome,
    });
  }

  function isolationResultLines(result) {
    const isolationInfo = result?.isolation;
    const changeAudit = result?.changeAudit;
    if (!isolationInfo) return [];
    const isolationLine = isolationInfo.mode === "sandbox-exec"
      ? `Isolation: sandbox-exec (writes confined to ${isolationInfo.writableRootCount} roots; ${isolationInfo.readDenyRootCount} protected paths unreadable)`
      : `Isolation: contract-only (${isolationInfo.reason}) — no OS confinement on this platform`;
    const changeAuditLine = changeAudit
      ? `Workspace changes: +${changeAudit.added} ~${changeAudit.modified} -${changeAudit.removed}`
      : `Workspace changes: unavailable (${result.changeAuditError || "change audit unavailable"})`;
    return [
      isolationLine,
      changeAuditLine,
      "",
    ];
  }

  async function prepareDelegationIsolation(addonId, context) {
    let resolved;
    try {
      resolved = await isolation.resolve();
    } catch (error) {
      const message = errorMessage(error);
      const mode = message.startsWith("Unknown RESONANTOS_DELEGATION_ISOLATION")
        ? "unresolved"
        : "sandbox-exec";
      throw withDelegationRunAudit(error, {
        isolation: failedIsolation(mode, message),
        changeAudit: emptyChangeAudit(),
        changeAuditError: "",
      });
    }
    if (resolved.mode !== "sandbox-exec") {
      return {
        mode: resolved.mode,
        reason: resolved.reason,
        sandboxExecPath: isolation.sandboxExecPath ?? "/usr/bin/sandbox-exec",
        profilePath: "",
        writableRootCount: 0,
        readDenyRootCount: 0,
      };
    }
    let profilePath = "";
    try {
      const readDeny = isolation.readDenyRootsFor({
        env: context.env,
        repoRoot,
        userRoot,
      });
      const readDenyRoots = await isolation.realpathExisting(readDeny.roots);
      const readDenyFiles = await isolation.realpathExisting(readDeny.files);
      if (addonId === "hermes") {
        // Lexical pre-check before any mkdir, so a rejected payload never creates a directory inside a protected path.
        isolation.assertBoundedWritableRoot(path.resolve(String(context.profileHome ?? "")), {
          home: path.resolve(String(context.env?.HOME ?? os.homedir())),
          // Inside-or-containing forbidden: secret stores, and the ResonantOS state tree a delegation could use to
          // rewrite its own audit log or execution gates. Containing forbidden: the repository and the user root.
          protectedPaths: [
            ...readDeny.roots,
            ...readDeny.files,
            path.join(userRoot(), "BrowserFirst"),
            path.join(os.homedir(), "ResonantOS_User", "BrowserFirst"),
          ].filter(Boolean).map((candidate) => path.resolve(String(candidate))),
          ancestorOnlyPaths: [repoRoot, userRoot(), path.join(os.homedir(), "ResonantOS_User")]
            .filter(Boolean).map((candidate) => path.resolve(String(candidate))),
        });
      }
      const writableRoots = [];
      let realProfileHome = "";
      for (const candidate of isolation.writableRootsFor(addonId, context)) {
        const realWritableRoot = await isolation.ensureRealpath(candidate);
        writableRoots.push(realWritableRoot);
        if (addonId === "hermes" && path.resolve(candidate) === path.resolve(context.profileHome)) {
          realProfileHome = realWritableRoot;
        }
      }
      if (addonId === "hermes") {
        const [realHome] = await isolation.realpathExisting([context.env?.HOME ?? os.homedir()]);
        if (!realHome) {
          throw new Error("Hermes home could not be resolved for writable root boundary.");
        }
        const protectedPaths = [
          ...readDenyRoots,
          ...readDenyFiles,
          ...await isolation.realpathExisting([
            path.join(userRoot(), "BrowserFirst"),
            path.join(os.homedir(), "ResonantOS_User", "BrowserFirst"),
          ]),
        ];
        isolation.assertBoundedWritableRoot(realProfileHome || context.profileHome, {
          home: realHome,
          protectedPaths,
          ancestorOnlyPaths: await isolation.realpathExisting([repoRoot, userRoot(), path.join(os.homedir(), "ResonantOS_User")]),
        });
      }
      const profileText = isolation.buildSandboxProfile({
        writableRoots,
        readDenyRoots,
        readDenyFiles,
      });
      profilePath = await isolation.writeProfile(profileText);
      return {
        mode: resolved.mode,
        reason: resolved.reason,
        sandboxExecPath: isolation.sandboxExecPath ?? "/usr/bin/sandbox-exec",
        profilePath,
        writableRootCount: writableRoots.length,
        readDenyRootCount: readDenyRoots.length + readDenyFiles.length,
      };
    } catch (error) {
      if (profilePath) await isolation.removeProfile(profilePath);
      const message = `Delegation isolation could not be applied: ${errorMessage(error)}`;
      throw withDelegationRunAudit(new Error(message), {
        isolation: failedIsolation(resolved.mode, resolved.reason),
        changeAudit: emptyChangeAudit(),
        changeAuditError: "",
      });
    }
  }

  async function snapshotChangeRoots(roots) {
    const snapshots = [];
    const errors = [];
    for (const root of roots) {
      try {
        snapshots.push({ root, snapshot: await isolation.snapshotTree(root) });
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }
    return { snapshots, error: errors.join("; ") };
  }

  function aggregateChangeAudit(before, after) {
    if (before.error || after.error) {
      return {
        changeAudit: null,
        changeAuditError: [before.error, after.error].filter(Boolean).join("; "),
      };
    }
    let added = 0;
    let modified = 0;
    let removed = 0;
    let truncated = false;
    const sample = { added: [], modified: [], removed: [] };
    for (const beforeEntry of before.snapshots) {
      const afterEntry = after.snapshots.find((candidate) => candidate.root === beforeEntry.root);
      if (!afterEntry) continue;
      const diff = isolation.diffTrees(beforeEntry.snapshot, afterEntry.snapshot);
      added += diff.added;
      modified += diff.modified;
      removed += diff.removed;
      truncated = truncated || diff.truncated;
      for (const bucket of ["added", "modified", "removed"]) {
        sample[bucket].push(...diff.sample[bucket].slice(0, 100 - sample[bucket].length));
      }
    }
    return { changeAudit: { added, modified, removed, truncated, sample }, changeAuditError: "" };
  }

  async function captureSandboxDenials(prepared, startedAt, processNames) {
    if (prepared.mode !== "sandbox-exec") return { denials: null, denialCaptureError: "" };
    try {
      const denials = await isolation.readSandboxDenials({ startedAt, processNames });
      return { denials: denials ?? null, denialCaptureError: "" };
    } catch (error) {
      return { denials: null, denialCaptureError: errorMessage(error) };
    }
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
      "You are running in reviewable-artifact mode. No interactive tools are available.",
      "",
      "Mission:",
      mission,
      "",
      context ? "Context packet:" : "",
      context,
      "",
      "Rules:",
      "- Return a reviewable artifact only.",
      "- Do not attempt tool calls, function calls, XML tool tags, shell commands, file writes, or local runtime actions.",
      "- Do not include unresolved provider/tool markers such as <tool_call>, tool_call, function_call, or provider control tokens.",
      "- If the mission asks you to create, run, inspect, browse, or execute something, describe the requested action and mark it as requiring approval or unavailable instead of attempting it.",
      "- Do not send messages, schedule events, post publicly, submit forms, operate wallets, expose secrets, or write trusted memory.",
      "- If external action is needed, list it under Approval Needs instead of performing it.",
      "- Keep the output concise and structured with these headings exactly: Final Summary, Actions Taken, Approval Needs, Residual Risks, Verification.",
    ].filter(Boolean).join("\n");
  }

  function parseHermesCliResult(output) {
    const text = String(output ?? "").trim();
    if (/<\s*tool_call\b|tool_call|function_call|]<]minimax\[>\[</i.test(text)) {
      throw new Error("Hermes returned unresolved provider tool-call markup instead of a reviewable artifact.");
    }
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

  function hermesProvider(payload = {}, secrets = {}) {
    const requested = String(payload.provider ?? process.env.RESONANTOS_HERMES_PROVIDER ?? process.env.HERMES_INFERENCE_PROVIDER ?? "").trim();
    if (requested) return requested;
    if (providerEnvKeysPresent("minimax", secrets).length) return "minimax";
    if (providerEnvKeysPresent("openai-api", secrets).length) return DEFAULT_HERMES_PROVIDER;
    if (providerEnvKeysPresent("openrouter", secrets).length) return "openrouter";
    if (providerEnvKeysPresent("anthropic", secrets).length) return "anthropic";
    return DEFAULT_HERMES_PROVIDER;
  }

  function hermesModel(payload = {}, provider = DEFAULT_HERMES_PROVIDER) {
    const requested = String(payload.model ?? process.env.RESONANTOS_HERMES_MODEL ?? process.env.HERMES_INFERENCE_MODEL ?? "").trim();
    const normalizedProvider = String(provider ?? "").trim().toLowerCase();
    const model = requested || (
      normalizedProvider === "minimax"
        ? DEFAULT_HERMES_MINIMAX_MODEL
        : normalizedProvider === "openrouter"
          ? "openai/gpt-5.4-mini"
          : DEFAULT_HERMES_MODEL
    );
    if ((normalizedProvider === "openai" || normalizedProvider === "openai-api") && model.startsWith("openai/")) {
      return model.slice("openai/".length);
    }
    return model;
  }

  function hermesProviderCredentialState(payload = {}, secrets = {}) {
    const provider = hermesProvider(payload, secrets);
    const model = hermesModel(payload, provider);
    const envKeys = providerEnvKeysForProvider(provider);
    const configuredEnvKeys = providerEnvKeysPresent(provider, secrets, envKeys);
    return {
      configured: configuredEnvKeys.length > 0,
      configuredEnvKeys,
      envKeys,
      model,
      provider,
    };
  }

  function hermesProviderCredentialBlockedReason(state) {
    const provider = String(state?.provider ?? DEFAULT_HERMES_PROVIDER);
    const model = String(state?.model ?? DEFAULT_HERMES_MODEL);
    const envHint = state?.envKeys?.length
      ? ` The bridge can also be started with ${state.envKeys.join(" or ")} in its environment.`
      : "";
    return [
      `Hermes provider credential unavailable for ${provider} / ${model}.`,
      "Re-save the provider credential in Settings > Providers so the restarted browser-first bridge has it in session memory.",
      "Provider secrets remain session-only; ResonantOS does not persist plaintext provider credentials for this alpha.",
      envHint.trim(),
    ].filter(Boolean).join(" ");
  }

  function hermesRuntimeProviderConfig(provider, secrets = {}) {
    const normalizedProvider = String(provider ?? "").trim().toLowerCase();
    if (normalizedProvider !== "minimax") {
      return {
        provider,
        baseUrl: "",
        apiKey: "",
        apiMode: "",
      };
    }
    const baseUrl = String(
      process.env.RESONANTOS_HERMES_MINIMAX_BASE_URL ??
      process.env.RESONANTOS_MINIMAX_OPENAI_BASE_URL ??
      MINIMAX_OPENAI_COMPAT_BASE_URL
    ).trim().replace(/\/+$/, "");
    return {
      // Hermes' built-in MiniMax provider currently routes to /anthropic.
      // The browser-first alpha provider fabric uses MiniMax's OpenAI-compatible
      // /v1 surface, so hand Hermes an explicit custom runtime for execution.
      provider: "custom",
      baseUrl,
      apiKey: providerCredential("minimax", secrets),
      apiMode: "chat_completions",
    };
  }

  function isHermesProviderCredentialError(message) {
    return /(?:selected provider env missing|provider credential unavailable|no inference provider configured|api key|OPENAI_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|set an api key)/i
      .test(String(message ?? ""));
  }

  function scopedHermesEnv({ provider, model, profileHome, secrets = {} } = {}) {
    const providerKeys = providerEnvKeysForProvider(provider);
    const allowed = [
      "HOME",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "OPENAI_BASE_URL",
      "HERMES_CONFIG",
      ...providerKeys,
    ];
    const inherited = Object.fromEntries(
      allowed
        .map((key) => [key, process.env[key]])
        .filter(([, value]) => value !== undefined)
    );
    return {
      ...inherited,
      ...providerEnvFromSecrets(provider, secrets, providerKeys),
      HERMES_HOME: profileHome,
      ...(provider ? { HERMES_INFERENCE_PROVIDER: provider } : {}),
      ...(model ? { HERMES_INFERENCE_MODEL: model } : {}),
    };
  }

  function hermesPythonAdapterScript() {
    return String.raw`import contextlib
import json
import os
import sys
import traceback
from pathlib import Path

prompt_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
agent_root = Path(os.environ["RESONANTOS_HERMES_AGENT_ROOT"])
if str(agent_root) not in sys.path:
    sys.path.insert(0, str(agent_root))

prompt = prompt_path.read_text(encoding="utf-8")
provider = os.environ.get("HERMES_INFERENCE_PROVIDER") or None
model = os.environ.get("HERMES_INFERENCE_MODEL") or ""
base_url = os.environ.get("RESONANTOS_HERMES_BASE_URL") or None
api_key = os.environ.get("RESONANTOS_HERMES_API_KEY") or None
api_mode = os.environ.get("RESONANTOS_HERMES_API_MODE") or None
max_turns = int(os.environ.get("RESONANTOS_HERMES_MAX_TURNS", "20"))

try:
    from run_agent import AIAgent

    agent = AIAgent(
        base_url=base_url,
        api_key=api_key,
        provider=provider,
        api_mode=api_mode,
        model=model,
        max_iterations=max_turns,
        enabled_toolsets=[],
        disabled_toolsets=[],
        quiet_mode=True,
        tool_progress_mode="off",
        platform="cli",
        skip_context_files=False,
        skip_memory=False,
        log_prefix="",
    )
    with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink):
        result = agent.run_conversation(prompt)
    output_path.write_text(json.dumps({
        "ok": True,
        "finalResponse": str(result.get("final_response") or ""),
        "completed": bool(result.get("completed")),
        "apiCalls": int(result.get("api_calls") or 0),
    }), encoding="utf-8")
except BaseException as exc:
    output_path.write_text(json.dumps({
        "ok": False,
        "error": str(exc),
        "traceback": traceback.format_exc(limit=5),
    }), encoding="utf-8")
    raise
`;
  }

  async function execHermesPythonAdapter(runtime, promptPath, outputPath, options = {}) {
    const timeout = Math.min(900_000, Math.max(30_000, Number(options.timeout ?? 300_000)));
    const adapterPath = options.adapterPath;
    return new Promise((resolve, reject) => {
      const innerArgs = [adapterPath, promptPath, outputPath];
      const wrapped = isolation.wrapCommandForIsolation({
        ...(options.isolation ?? { mode: "contract-only" }),
        command: runtime.pythonPath,
        args: innerArgs,
      });
      const child = spawnProcess(wrapped.command, wrapped.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Hermes local runtime timed out after ${timeout}ms.`));
      }, timeout);
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const detail = redactCliText(stderr || stdout || `Hermes local runtime exited with code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}.`).trim();
          reject(new Error(detail));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async function runHermesCliDelegation(command, packet, payload = {}) {
    const profileHome = hermesHome(payload.profileHome);
    const runtime = hermesPythonRuntime(command);
    if (!runtime?.installed) {
      throw new Error(
        "Hermes local execution requires an installed Hermes venv with run_agent.py. " +
        "The detected hermes command does not expose a prompt-safe local runtime."
      );
    }
    const secrets = await readProviderSecrets();
    const provider = hermesProvider(payload, secrets);
    const model = hermesModel(payload, provider);
    const runtimeProvider = hermesRuntimeProviderConfig(provider, secrets);
    const prompt = buildHermesExecutionPrompt(packet);
    const tempRoot = path.join(browserFirstRoot(), "Runtime", "hermes-prompts");
    await mkdir(tempRoot, { recursive: true });
    const tempDir = await mkdtemp(path.join(tempRoot, "prompt-"));
    const promptPath = path.join(tempDir, "resonantos-hermes-task.md");
    const adapterPath = path.join(tempDir, "resonantos_hermes_adapter.py");
    const outputPath = path.join(tempDir, "result.json");
    let preparedIsolation = null;
    try {
      await writeFile(promptPath, prompt, { mode: 0o600 });
      await writeFile(adapterPath, hermesPythonAdapterScript(), { mode: 0o600 });
      await chmod(promptPath, 0o600).catch(() => undefined);
      await chmod(adapterPath, 0o600).catch(() => undefined);
      const env = {
        ...scopedHermesEnv({ provider, model, profileHome, secrets }),
        ...(runtimeProvider.provider ? { HERMES_INFERENCE_PROVIDER: runtimeProvider.provider } : {}),
        ...(runtimeProvider.baseUrl ? {
          OPENAI_BASE_URL: runtimeProvider.baseUrl,
          RESONANTOS_HERMES_BASE_URL: runtimeProvider.baseUrl,
        } : {}),
        ...(runtimeProvider.apiKey ? {
          OPENAI_API_KEY: runtimeProvider.apiKey,
          RESONANTOS_HERMES_API_KEY: runtimeProvider.apiKey,
        } : {}),
        ...(runtimeProvider.apiMode ? { RESONANTOS_HERMES_API_MODE: runtimeProvider.apiMode } : {}),
        PYTHONDONTWRITEBYTECODE: "1",
        RESONANTOS_HERMES_AGENT_ROOT: runtime.agentRoot,
        RESONANTOS_HERMES_MAX_TURNS: String(Math.min(90, Math.max(1, Number(payload.maxTurns ?? 20)))),
      };
      preparedIsolation = await prepareDelegationIsolation("hermes", {
        env,
        profileHome,
        tempDir,
        tmpdir: os.tmpdir(),
      });
      const beforeSnapshots = await snapshotChangeRoots([profileHome, tempDir]);
      const startedAt = new Date();
      let executionError = null;
      try {
        await execHermesPythonAdapter(runtime, promptPath, outputPath, {
          adapterPath,
          cwd: repoRoot,
          env,
          isolation: preparedIsolation,
          timeout: Math.min(900_000, Math.max(30_000, Number(payload.timeoutMs ?? 300_000))),
        });
      } catch (error) {
        executionError = error;
      }
      const afterSnapshots = await snapshotChangeRoots([profileHome, tempDir]);
      const { changeAudit, changeAuditError } = aggregateChangeAudit(beforeSnapshots, afterSnapshots);
      const denialCapture = await captureSandboxDenials(preparedIsolation, startedAt, [
        path.basename(runtime.pythonPath),
        "sh",
        "bash",
        "zsh",
        "python",
        "python3",
      ]);
      const publicIsolation = publicIsolationFromPrepared(
        preparedIsolation,
        denialCapture.denials,
        denialCapture.denialCaptureError,
      );
      const runAudit = { isolation: publicIsolation, changeAudit, changeAuditError };
      if (executionError) {
        throw withDelegationRunAudit(executionError, runAudit);
      }
      const rawResult = await readFile(outputPath, "utf8");
      const parsed = JSON.parse(rawResult);
      if (!parsed.ok) {
        throw withDelegationRunAudit(
          new Error(redactCliText(parsed.error || "Hermes local runtime failed.")),
          runAudit,
        );
      }
      try {
        return {
          ...parseHermesCliResult(parsed.finalResponse, repoRoot),
          adapter: "hermes-cli",
          changeAudit,
          ...(changeAuditError ? { changeAuditError } : {}),
          isolation: publicIsolation,
          model,
          provider,
        };
      } catch (error) {
        throw withDelegationRunAudit(error, runAudit);
      }
    } catch (error) {
      throw error;
    } finally {
      if (preparedIsolation?.profilePath) {
        await isolation.removeProfile(preparedIsolation.profilePath);
      }
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
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
      result.provider ? `- provider: ${result.provider}` : "",
      result.model ? `- model: ${result.model}` : "",
      "- boundary: Reviewable artifact only. External sends and trusted memory writes remain blocked.",
      ...isolationResultLines(result),
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
    if (adapter !== "deterministic") {
      const credentialState = hermesProviderCredentialState(payload, await readProviderSecrets());
      if (!credentialState.configured) {
        const blockedAt = new Date().toISOString();
        const blockedReason = hermesProviderCredentialBlockedReason(credentialState);
        const updated = await writeDelegationStatus(taskPath, "blocked", {
          blockedAt,
          blockedReason,
          provider: credentialState.provider,
          model: credentialState.model,
        });
        return {
          ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
          blockedReason,
          status: "blocked",
        };
      }
    }
    let result;
    try {
      result = adapter === "deterministic"
        ? deterministicHermesResult(packet)
        : await runHermesCliDelegation(command, packet, payload);
    } catch (error) {
      const failedAt = new Date().toISOString();
      const failureReason = error instanceof Error ? error.message : String(error);
      await appendDelegationExecutionAudit(
        "hermes",
        fieldFromMarkdown(packet, "id") || path.basename(taskPath, ".md"),
        "failed",
        error?.delegationRunAudit,
      );
      if (adapter !== "deterministic" && isHermesProviderCredentialError(failureReason)) {
        const credentialState = hermesProviderCredentialState(payload, await readProviderSecrets());
        const blockedReason = hermesProviderCredentialBlockedReason(credentialState);
        const updated = await writeDelegationStatus(taskPath, "blocked", {
          blockedAt: failedAt,
          blockedReason,
          provider: credentialState.provider,
          model: credentialState.model,
        });
        return {
          ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
          blockedReason,
          status: "blocked",
        };
      }
      const updated = await writeDelegationStatus(taskPath, "failed", {
        failedAt,
        failureReason: failureReason.slice(0, 500),
      });
      return {
        ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
        failureReason,
        ...(error?.delegationRunAudit?.isolation ? { isolation: error.delegationRunAudit.isolation } : {}),
        ...(error?.delegationRunAudit?.changeAudit ? { changeAudit: error.delegationRunAudit.changeAudit } : {}),
        ...(error?.delegationRunAudit?.changeAuditError ? { changeAuditError: error.delegationRunAudit.changeAuditError } : {}),
        status: "failed",
      };
    }
    try {
      const artifactPath = await writeHermesResultArtifact(taskPath, packet, result);
      await appendDelegationExecutionAudit(
        "hermes",
        fieldFromMarkdown(packet, "id") || path.basename(taskPath, ".md"),
        "completed",
        result,
      );
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
        ...(result.isolation ? { isolation: result.isolation } : {}),
        ...(result.changeAudit ? { changeAudit: result.changeAudit } : {}),
        ...(result.changeAuditError ? { changeAuditError: result.changeAuditError } : {}),
        status: "completed",
      };
    } catch (error) {
      if (result?.isolation) {
        await appendDelegationExecutionAudit(
          "hermes",
          fieldFromMarkdown(packet, "id") || path.basename(taskPath, ".md"),
          "failed",
          result,
        );
      }
      return failDelegationAfterRunning(taskPath, error);
    }
  }

  async function executeHermesDelegationStatus(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "hermes");
    const [details, content] = await Promise.all([stat(taskPath), readFile(taskPath, "utf8")]);
    return delegationSummaryFromMarkdown(taskPath, content, details);
  }

  async function executeHermesDelegationArtifact(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "hermes");
    const content = await readFile(taskPath, "utf8");
    const artifactRelative = resultArtifactPathFromMarkdown(content);
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
    const runtime = currentOpenCodeRuntime();
    const command = runtime.command;
    const secrets = await readProviderSecrets();
    const model = openCodeModel(payload, secrets);
    const provider = openCodeProviderForModel(model);
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
      command: runtime.commandRedacted || (command ? redactPathForDiagnostics(command) : ""),
      mode: command && addonLocalCliExecutionEnabled("opencode", payload, executionSettings) ? "local-opencode-cli" : command ? "local-opencode-cli-disabled" : "packet-only",
      executionEnabled: addonLocalCliExecutionEnabled("opencode", payload, executionSettings),
      workspaceLaunch: "not-enabled-in-browser-first-v1",
      model,
      modelSource: payload.model ? "request" : process.env.RESONANTOS_OPENCODE_MODEL ? "env" : model === MINIMAX_OPENCODE_MODEL ? "provider-default" : "default",
      providerEnvKeys: providerEnvKeysPresent(provider, secrets, openCodeProviderEnvKeys(model)),
      detail: command
        ? "OpenCode runtime was detected. ResonantOS can create governed coding packets and start execution only when explicit OpenCode execution is enabled."
        : "OpenCode runtime was not detected. Install OpenCode, or point ResonantOS at an existing binary with OPENCODE_COMMAND.",
      installHint: runtime.installHint,
      installCommand: runtime.installCommand,
      alternativeInstallCommands: runtime.alternativeInstallCommands,
      configureCommand: runtime.configureCommand,
      searchedCommands: runtime.searchedCommands,
      searchedPaths: runtime.searchedPaths,
      searchedPathCount: runtime.searchedPathCount,
      searchedPathOmitted: runtime.searchedPathOmitted,
      overrideConfigured: runtime.overrideConfigured,
      overridePath: runtime.overridePath,
      overrideFound: runtime.overrideFound,
      taskCounts: statusCounts,
      delegationPackets: tasks.length,
      requiredGrants: ["filesystem", "shell", "providers", "ui-embedding"],
      boundary: "OpenCode is an add-on agent. Filesystem, shell, provider secrets, wallet actions, and trusted memory writes remain mediated by ResonantOS.",
    };
  }

  const executeOpenCodeWebUrl = createOpenCodeWebUrlHandler({
    executionEnabled: async (payload = {}) => {
      const executionSettings = await readAddonExecutionSettings();
      return addonLocalCliExecutionEnabled("opencode", payload, executionSettings);
    },
    ensureServer: () => ensureOpenCodeServer({
      fetchImpl: (...args) => fetch(...args),
      spawnImpl: (cmd, args, opts) => spawnProcess(cmd, args, opts),
      command: opencodeCommand(),
      hostname: "127.0.0.1",
      port: process.env.RESONANTOS_OPENCODE_PORT ? Number(process.env.RESONANTOS_OPENCODE_PORT) : undefined,
      env: process.env,
    }),
    // #343: never spawn a server just to refuse the cockpit handoff — peek the
    // registered singleton first; only an already-running server yields a URL.
    peekServer: () => peekOpenCodeServer({ command: opencodeCommand(), hostname: "127.0.0.1", env: process.env }),
    appendAuditEntry: appendAddonGovernanceAuditEntry,
  });

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

  function extractOpenCodeOutputText(output) {
    const raw = String(output ?? "").trim();
    const textEvents = [];
    for (const line of raw.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        const event = JSON.parse(candidate);
        const text = event?.part?.type === "text" ? event.part.text : event?.type === "text" ? event.text : "";
        if (text) textEvents.push(text);
      } catch {
        // Non-JSON output falls back to the raw stream below.
      }
    }
    return textEvents.join("\n\n").trim() || raw;
  }

  function parseOpenCodeCliResult(output, workspacePath) {
    const text = extractOpenCodeOutputText(output);
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

  function scopedOpenCodeEnv(model = DEFAULT_OPENCODE_MODEL, secrets = {}) {
    const allowed = [
      "HOME",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "OPENCODE_CONFIG",
      "OPENCODE_DATA",
      "OPENCODE_CACHE",
      "OPENCODE_SERVER_USERNAME",
      "OPENCODE_SERVER_PASSWORD",
      ...openCodeProviderEnvKeys(model),
    ];
    const inherited = Object.fromEntries(
      allowed
        .map((key) => [key, process.env[key]])
        .filter(([, value]) => value !== undefined)
    );
    return {
      ...inherited,
      ...providerEnvFromSecrets(openCodeProviderForModel(model), secrets, openCodeProviderEnvKeys(model)),
    };
  }

  function redactOpenCodeCliText(value) {
    return String(value ?? "")
      .replace(/sk-[a-z0-9_-]+/gi, "[redacted-key]")
      .replace(/bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted-token]")
      .replace(/api[_-]?key\s*[:=]\s*[^\s]+/gi, "api_key=[redacted]")
      .replace(/token\s*[:=]\s*[^\s]+/gi, "token=[redacted]")
      .replace(/secret\s*[:=]\s*[^\s]+/gi, "secret=[redacted]");
  }

  async function execOpenCodeCli(command, args, options = {}) {
    const timeout = Math.min(900_000, Math.max(30_000, Number(options.timeout ?? 300_000)));
    return new Promise((resolve, reject) => {
      if (/\.(?:cmd|bat)$/i.test(String(command))) {
        reject(new Error("OpenCode command shims (.cmd/.bat) are not supported; configure a pinned direct executable."));
        return;
      }
      if (platform === "win32" && !/\.exe$/i.test(String(command))) {
        reject(new Error("OpenCode on Windows requires a pinned direct .exe executable."));
        return;
      }
      const wrapped = isolation.wrapCommandForIsolation({
        ...(options.isolation ?? { mode: "contract-only" }),
        command,
        args,
      });
      const child = spawnProcess(wrapped.command, wrapped.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`OpenCode CLI timed out after ${timeout}ms.`));
      }, timeout);
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const detail = redactOpenCodeCliText(stderr || stdout || `OpenCode CLI exited with code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}.`).trim();
          reject(new Error(detail));
          return;
        }
        resolve(String(stdout ?? "").trim());
      });
    });
  }

  async function runOpenCodeCliDelegation(command, packet, payload = {}) {
    const workspacePath = resolveOpenCodeWorkspacePath(payload);
    const secrets = await readProviderSecrets();
    const model = openCodeModel(payload, secrets);
    const prompt = buildOpenCodeExecutionPrompt(packet, workspacePath);
    const tempRoot = path.join(browserFirstRoot(), "Runtime", "opencode-prompts");
    await mkdir(tempRoot, { recursive: true });
    const tempDir = await mkdtemp(path.join(tempRoot, "prompt-"));
    const promptPath = path.join(tempDir, "resonantos-opencode-task.md");
    let preparedIsolation = null;
    try {
      await writeFile(promptPath, prompt, { mode: 0o600 });
      await chmod(promptPath, 0o600).catch(() => undefined);
      const env = scopedOpenCodeEnv(model, secrets);
      const resolvedWorkspacePath = await isolationFs.realpath(workspacePath);
      const realRepoRoot = await isolationFs.realpath(repoRoot);
      if (resolvedWorkspacePath !== realRepoRoot && !resolvedWorkspacePath.startsWith(`${realRepoRoot}${path.sep}`)) {
        const message = "Delegation isolation could not be applied: OpenCode workspace resolves outside the repository.";
        throw withDelegationRunAudit(new Error(message), {
          isolation: failedIsolation("sandbox-exec", message),
          changeAudit: emptyChangeAudit(),
          changeAuditError: "",
        });
      }
      preparedIsolation = await prepareDelegationIsolation("opencode", {
        env,
        promptTempDir: tempDir,
        tmpdir: os.tmpdir(),
        workspacePath: resolvedWorkspacePath,
      });
      const beforeSnapshots = await snapshotChangeRoots([resolvedWorkspacePath]);
      const args = [
        "run",
        "Read the attached ResonantOS OpenCode task packet and return the requested artifact.",
        "--file",
        promptPath,
        "--dir",
        workspacePath,
        "-m",
        model,
        "--format",
        "json",
      ];
      const startedAt = new Date();
      let output = "";
      let executionError = null;
      try {
        output = await execOpenCodeCli(command, args, {
          cwd: workspacePath,
          env,
          isolation: preparedIsolation,
          timeout: Math.min(900_000, Math.max(30_000, Number(payload.timeoutMs ?? 300_000))),
        });
      } catch (error) {
        executionError = error;
      }
      const afterSnapshots = await snapshotChangeRoots([resolvedWorkspacePath]);
      const { changeAudit, changeAuditError } = aggregateChangeAudit(beforeSnapshots, afterSnapshots);
      const denialCapture = await captureSandboxDenials(preparedIsolation, startedAt, [
        path.basename(command),
        "sh",
        "bash",
        "zsh",
        "bun",
        "node",
      ]);
      const publicIsolation = publicIsolationFromPrepared(
        preparedIsolation,
        denialCapture.denials,
        denialCapture.denialCaptureError,
      );
      const runAudit = { isolation: publicIsolation, changeAudit, changeAuditError };
      if (executionError) {
        throw withDelegationRunAudit(executionError, runAudit);
      }
      try {
        return {
          ...parseOpenCodeCliResult(output, workspacePath),
          changeAudit,
          ...(changeAuditError ? { changeAuditError } : {}),
          isolation: publicIsolation,
          model,
        };
      } catch (error) {
        throw withDelegationRunAudit(error, runAudit);
      }
    } finally {
      if (preparedIsolation?.profilePath) {
        await isolation.removeProfile(preparedIsolation.profilePath);
      }
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
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
      result.model ? `- model: ${result.model}` : "",
      "- boundary: Reviewable coding artifact only. Shell, filesystem, provider secrets, trusted memory writes, and external sends remain governed by ResonantOS.",
      ...isolationResultLines(result),
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
    const runtime = currentOpenCodeRuntime();
    const command = runtime.command;
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
        blockedReason: "OpenCode CLI unavailable.",
        installHint: runtime.installHint,
        installCommand: runtime.installCommand,
        alternativeInstallCommands: runtime.alternativeInstallCommands,
        configureCommand: runtime.configureCommand,
        searchedCommands: runtime.searchedCommands,
        searchedPaths: runtime.searchedPaths,
        searchedPathCount: runtime.searchedPathCount,
        searchedPathOmitted: runtime.searchedPathOmitted,
        overrideConfigured: runtime.overrideConfigured,
        overridePath: runtime.overridePath,
        overrideFound: runtime.overrideFound,
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
    if (adapter !== "deterministic") {
      const secrets = await readProviderSecrets();
      const model = openCodeModel(payload, secrets);
      const provider = openCodeProviderForModel(model);
      const envKeys = openCodeProviderEnvKeys(model);
      if (!providerEnvKeysPresent(provider, secrets, envKeys).length) {
        const blockedReason = [
          `OpenCode provider credential unavailable for ${provider} / ${model}.`,
          "Re-save the provider credential in Settings > Providers so the restarted browser-first bridge has it in session memory.",
          "Provider secrets remain session-only; ResonantOS does not persist plaintext provider credentials for this alpha.",
          envKeys.length ? `The bridge can also be started with ${envKeys.join(" or ")} in its environment.` : "",
        ].filter(Boolean).join(" ");
        const updated = await writeDelegationStatus(taskPath, "blocked", {
          blockedAt: new Date().toISOString(),
          blockedReason,
          model,
        });
        return {
          ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
          blockedReason,
          status: "blocked",
        };
      }
    }
    let result;
    try {
      result = adapter === "deterministic"
        ? deterministicOpenCodeResult(packet, payload)
        : await runOpenCodeCliDelegation(command, packet, payload);
    } catch (error) {
      await appendDelegationExecutionAudit(
        "opencode",
        fieldFromMarkdown(packet, "id") || path.basename(taskPath, ".md"),
        "failed",
        error?.delegationRunAudit,
      );
      const updated = await writeDelegationStatus(taskPath, "failed", {
        failedAt: new Date().toISOString(),
        failureReason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
      return {
        ...delegationSummaryFromMarkdown(taskPath, updated, await stat(taskPath)),
        failureReason: error instanceof Error ? error.message : String(error),
        ...(error?.delegationRunAudit?.isolation ? { isolation: error.delegationRunAudit.isolation } : {}),
        ...(error?.delegationRunAudit?.changeAudit ? { changeAudit: error.delegationRunAudit.changeAudit } : {}),
        ...(error?.delegationRunAudit?.changeAuditError ? { changeAuditError: error.delegationRunAudit.changeAuditError } : {}),
        status: "failed",
      };
    }
    try {
      const artifactPath = await writeOpenCodeResultArtifact(taskPath, packet, result);
      await appendDelegationExecutionAudit(
        "opencode",
        fieldFromMarkdown(packet, "id") || path.basename(taskPath, ".md"),
        "completed",
        result,
      );
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
        ...(result.isolation ? { isolation: result.isolation } : {}),
        ...(result.changeAudit ? { changeAudit: result.changeAudit } : {}),
        ...(result.changeAuditError ? { changeAuditError: result.changeAuditError } : {}),
        status: "completed",
      };
    } catch (error) {
      if (result?.isolation) {
        await appendDelegationExecutionAudit(
          "opencode",
          fieldFromMarkdown(packet, "id") || path.basename(taskPath, ".md"),
          "failed",
          result,
        );
      }
      return failDelegationAfterRunning(taskPath, error);
    }
  }

  async function executeOpenCodeDelegationStatus(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "opencode");
    const [details, content] = await Promise.all([stat(taskPath), readFile(taskPath, "utf8")]);
    return delegationSummaryFromMarkdown(taskPath, content, details);
  }

  async function executeOpenCodeDelegationArtifact(payload = {}) {
    const taskPath = resolveDelegationPath(payload.path, "opencode");
    const content = await readFile(taskPath, "utf8");
    const artifactRelative = resultArtifactPathFromMarkdown(content);
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
    const previousLocalCliExecution = Boolean(next[addon].localCliExecution);
    const nextLocalCliExecution = Boolean(payload.localCliExecution);
    next[addon] = {
      ...next[addon],
      localCliExecution: nextLocalCliExecution,
    };
    const settings = await writeAddonExecutionSettings(next);
    if (previousLocalCliExecution !== nextLocalCliExecution) {
      await appendAddonGovernanceAuditEntry({
        at: new Date().toISOString(),
        addonId: addon,
        field: "localCliExecution",
        from: previousLocalCliExecution,
        to: nextLocalCliExecution,
      });
    }
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
    const secrets = await readProviderSecrets();
    const provider = hermesProvider(payload, secrets);
    const model = hermesModel(payload, provider);
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
      provider,
      model,
      providerEnvKeys: providerEnvKeysPresent(provider, secrets, providerEnvKeysForProvider(provider)),
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
    const secrets = await readProviderSecrets();
    const provider = hermesProvider(payload, secrets);
    const model = hermesModel(payload, provider);
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
      const child = spawnProcess(command, args, {
        detached: true,
        env: scopedHermesEnv({ provider, model, profileHome, secrets }),
        shell: false,
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
    const secrets = await readProviderSecrets();
    const provider = hermesProvider(payload, secrets);
    const model = hermesModel(payload, provider);
    if (!command) {
      throw new Error("Hermes CLI was not found. Install or configure Hermes before stopping the dashboard.");
    }
    await new Promise((resolve) => {
      const child = spawnProcess(command, ["dashboard", "--stop"], {
        env: scopedHermesEnv({ provider, model, profileHome, secrets }),
        shell: false,
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
    executeOpenCodeWebUrl,
    executeAddonDraftRead,
    executeAddonDraftTransition,
    executeAddonDraftProviderHandoff,
    executeAddonsStatus,
    executeAddonExecutionSettingsGet,
    executeAddonExecutionSettingsUpdate,
    executeAddonUninstallAudit,
    executeAddonRunningWork,
    executeAddonUserDataList,
    executeAddonUserDataDelete,
    executeHermesDashboardStatus,
    executeHermesDashboardStart,
    executeHermesDashboardStop,
  };
}
