import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { redactPathForDiagnostics } from "./browser-first-host-utils.mjs";

export const OPENCODE_INSTALL_COMMAND = "curl -fsSL https://opencode.ai/install | bash";
export const OPENCODE_NPM_INSTALL_COMMAND = "npm install -g opencode-ai";
export const OPENCODE_BREW_INSTALL_COMMAND = "brew install anomalyco/tap/opencode";
export const OPENCODE_CONFIGURE_COMMAND = "OPENCODE_COMMAND=/usr/local/bin/opencode";
export const OPENCODE_COMMAND_NAMES = ["opencode", "opencode-ai"];

function uniqueCandidates(candidates, platform) {
  const seen = new Set();
  return candidates.filter((entry) => {
    const key = platform === "win32" ? entry.path.toLowerCase() : entry.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidate(root, name, base, source, pathApi, canonicalRoots = [root]) {
  return {
    base,
    canonicalRoots,
    path: pathApi.join(root, name),
    source,
    validated_by: "opencodeRuntimeDiagnostics",
  };
}

function trustedCandidates({ homeDir, platform }) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32"
    ? OPENCODE_COMMAND_NAMES.map((name) => `${name}.exe`)
    : OPENCODE_COMMAND_NAMES;
  const candidates = [];
  const appendRoot = (root, base, source, canonicalRoots) => {
    for (const name of names) candidates.push(candidate(root, name, base, source, pathApi, canonicalRoots));
  };
  if (platform === "win32") {
    appendRoot(pathApi.join(homeDir, ".opencode", "bin"), "install-prefix", "fixed-user-install-root");
    appendRoot(pathApi.join(homeDir, "scoop", "apps", "opencode", "current"), "install-prefix", "fixed-user-install-root");
    appendRoot("C:\\Program Files\\OpenCode", "install-prefix", "fixed-program-files-root");
  } else {
    appendRoot(pathApi.join(homeDir, ".opencode", "bin"), "install-prefix", "fixed-user-install-root");
    appendRoot(pathApi.join(homeDir, ".local", "bin"), "install-prefix", "fixed-user-install-root");
    if (platform === "darwin") {
      appendRoot("/opt/homebrew/bin", "system-bin", "fixed-system-root", ["/opt/homebrew/bin", "/opt/homebrew/Cellar"]);
    }
    appendRoot("/usr/local/bin", "system-bin", "fixed-system-root", ["/usr/local/bin", "/usr/local/Cellar"]);
    appendRoot("/usr/bin", "system-bin", "fixed-system-root");
    appendRoot("/bin", "system-bin", "fixed-system-root");
    if (platform === "darwin") {
      candidates.push(candidate("/Applications/OpenCode.app/Contents/MacOS", "opencode-cli", "install-prefix", "fixed-application-root", pathApi));
      candidates.push(candidate("/Applications/OpenCode Desktop.app/Contents/MacOS", "opencode-cli", "install-prefix", "fixed-application-root", pathApi));
    }
  }
  return uniqueCandidates(candidates, platform);
}

function normalizeOverride(value, homeDir, platform) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (raw === "~") return pathApi.normalize(homeDir);
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return pathApi.normalize(pathApi.join(homeDir, raw.slice(2)));
  return pathApi.normalize(raw);
}

function samePath(left, right, platform) {
  return platform === "win32"
    ? String(left).toLowerCase() === String(right).toLowerCase()
    : left === right;
}

function pathInside(candidatePath, root, platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relative = pathApi.relative(root, candidatePath);
  const normalized = platform === "win32" ? relative.toLowerCase() : relative;
  return normalized === "" || (!normalized.startsWith("..") && !pathApi.isAbsolute(relative));
}

function resolveCandidate(candidateDescriptor, { exists, platform, realpath, stat }) {
  if (!exists(candidateDescriptor.path)) return { resolution: null, rejection: null };
  try {
    const details = stat(candidateDescriptor.path);
    if (!details.isFile()) {
      return { resolution: null, rejection: { path: candidateDescriptor.path, reason: "candidate is not a regular file" } };
    }
    if (platform === "win32" && !/\.exe$/i.test(candidateDescriptor.path)) {
      return { resolution: null, rejection: { path: candidateDescriptor.path, reason: "Windows OpenCode requires a direct .exe executable" } };
    }
    if (platform !== "win32" && (details.mode & 0o111) === 0) {
      return { resolution: null, rejection: { path: candidateDescriptor.path, reason: "candidate is not executable" } };
    }
    const canonicalPath = realpath(candidateDescriptor.path);
    if (!candidateDescriptor.canonicalRoots.some((root) => pathInside(canonicalPath, root, platform))) {
      return { resolution: null, rejection: { path: candidateDescriptor.path, reason: "canonical path escapes fixed allowlisted roots" } };
    }
    return {
      resolution: {
        base: candidateDescriptor.base,
        path: canonicalPath,
        canonical_path: canonicalPath,
        validated_by: candidateDescriptor.validated_by,
        source: candidateDescriptor.source,
      },
      rejection: null,
    };
  } catch (error) {
    return {
      resolution: null,
      rejection: { path: candidateDescriptor.path, reason: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function opencodeInstallHint() {
  return [
    `Install OpenCode with \`${OPENCODE_INSTALL_COMMAND}\`.`,
    `Node users can use \`${OPENCODE_NPM_INSTALL_COMMAND}\`; Homebrew users can use \`${OPENCODE_BREW_INSTALL_COMMAND}\`.`,
    `To select an OpenCode binary at a supported fixed install root, set \`${OPENCODE_CONFIGURE_COMMAND}\` and restart ResonantOS.`
  ].join(" ");
}

export function opencodeCandidatePaths(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const candidates = options.includeCommonCandidates === false
    ? []
    : trustedCandidates({ homeDir, platform });
  const overridePath = normalizeOverride(env.OPENCODE_COMMAND, homeDir, platform);
  const overrideCandidate = candidates.find((entry) => samePath(entry.path, overridePath, platform));
  return overrideCandidate
    ? [overrideCandidate, ...candidates.filter((entry) => entry !== overrideCandidate)]
    : candidates;
}

export function opencodeRuntimeDiagnostics(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const realpath = options.realpath ?? ((candidatePath) => realpathSync.native(candidatePath));
  const stat = options.stat ?? statSync;
  const displayLimit = Number.isInteger(options.displayLimit) && options.displayLimit > 0 ? options.displayLimit : 48;
  const overridePath = normalizeOverride(env.OPENCODE_COMMAND, homeDir, platform);
  const candidates = opencodeCandidatePaths(options);
  const overrideCandidate = candidates.find((entry) => samePath(entry.path, overridePath, platform));
  const rejections = [];
  let resolution = null;
  let selectedCandidate = null;
  for (const candidateDescriptor of candidates) {
    const result = resolveCandidate(candidateDescriptor, { exists, platform, realpath, stat });
    if (result.rejection) rejections.push(result.rejection);
    if (result.resolution) {
      resolution = result.resolution;
      selectedCandidate = candidateDescriptor;
      break;
    }
  }
  const command = resolution?.canonical_path ?? null;
  const searchedPaths = candidates.map(({ path: candidatePath }) => redactPathForDiagnostics(candidatePath)).slice(0, displayLimit);
  return {
    installed: Boolean(command),
    command,
    candidates: candidates.map(({ base, path: candidatePath, source, validated_by }) => ({
      base,
      path: candidatePath,
      source,
      validated_by,
    })),
    resolution,
    commandRedacted: command ? redactPathForDiagnostics(command) : "",
    installHint: opencodeInstallHint(),
    installCommand: OPENCODE_INSTALL_COMMAND,
    alternativeInstallCommands: [OPENCODE_NPM_INSTALL_COMMAND, OPENCODE_BREW_INSTALL_COMMAND],
    configureCommand: OPENCODE_CONFIGURE_COMMAND,
    searchedCommands: OPENCODE_COMMAND_NAMES,
    searchedPaths,
    searchedPathCount: candidates.length,
    searchedPathOmitted: Math.max(0, candidates.length - searchedPaths.length),
    overrideConfigured: Boolean(overridePath),
    overridePath: overridePath ? redactPathForDiagnostics(overridePath) : "",
    overrideFound: overridePath ? exists(overridePath) : false,
    overrideAccepted: selectedCandidate === overrideCandidate,
    rejections,
  };
}

export function opencodeCommand(options = {}) {
  return opencodeRuntimeDiagnostics(options).command;
}
