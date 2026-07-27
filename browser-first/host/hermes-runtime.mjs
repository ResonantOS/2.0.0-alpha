import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function uniqueCandidates(candidates, platform) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pythonAdapterDescriptor(agentRoot, binRoot, platform, pathApi) {
  return {
    agentRoot,
    canonicalRoots: [agentRoot],
    pythonPath: pathApi.join(binRoot, platform === "win32" ? "python.exe" : "python"),
    runAgentPath: pathApi.join(agentRoot, "run_agent.py"),
  };
}

function candidate(root, name, base, source, pathApi, canonicalRoots = [root], pythonAdapter = null) {
  return {
    base,
    canonicalRoots,
    path: pathApi.join(root, name),
    pythonAdapter,
    source,
    validated_by: "hermesRuntimeDiagnostics",
  };
}

export function hermesTrustedCandidates({
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const primaryAgentRoot = pathApi.join(homeDir, ".hermes", "hermes-agent");
    const primaryBinRoot = pathApi.join(primaryAgentRoot, "venv", "Scripts");
    const fallbackAgentRoot = pathApi.join(homeDir, ".hermes");
    const fallbackBinRoot = pathApi.join(fallbackAgentRoot, "venv", "Scripts");
    const programFilesRoot = "C:\\Program Files\\Hermes";
    return uniqueCandidates([
      candidate(primaryBinRoot, "hermes.exe", "install-prefix", "fixed-user-install-root", pathApi, [primaryBinRoot],
        pythonAdapterDescriptor(primaryAgentRoot, primaryBinRoot, platform, pathApi)),
      candidate(fallbackBinRoot, "hermes.exe", "install-prefix", "fixed-user-install-root", pathApi, [fallbackBinRoot],
        pythonAdapterDescriptor(fallbackAgentRoot, fallbackBinRoot, platform, pathApi)),
      candidate(programFilesRoot, "hermes.exe", "install-prefix", "fixed-program-files-root", pathApi, [programFilesRoot],
        pythonAdapterDescriptor(programFilesRoot, programFilesRoot, platform, pathApi)),
    ], platform);
  }

  const primaryAgentRoot = pathApi.join(homeDir, ".hermes", "hermes-agent");
  const primaryBinRoot = pathApi.join(primaryAgentRoot, "venv", "bin");
  const fallbackAgentRoot = pathApi.join(homeDir, ".hermes");
  const fallbackVenvBinRoot = pathApi.join(fallbackAgentRoot, "venv", "bin");
  const fallbackBinRoot = pathApi.join(fallbackAgentRoot, "bin");
  const candidates = [
    candidate(primaryBinRoot, "hermes", "install-prefix", "fixed-user-install-root", pathApi, [primaryBinRoot],
      pythonAdapterDescriptor(primaryAgentRoot, primaryBinRoot, platform, pathApi)),
    candidate(fallbackVenvBinRoot, "hermes", "install-prefix", "fixed-user-install-root", pathApi, [fallbackVenvBinRoot],
      pythonAdapterDescriptor(fallbackAgentRoot, fallbackVenvBinRoot, platform, pathApi)),
    candidate(fallbackBinRoot, "hermes", "install-prefix", "fixed-user-install-root", pathApi, [fallbackBinRoot],
      pythonAdapterDescriptor(fallbackAgentRoot, fallbackBinRoot, platform, pathApi)),
    candidate("/usr/local/bin", "hermes", "system-bin", "fixed-system-root", pathApi, ["/usr/local/bin", "/usr/local/Cellar"]),
    candidate("/usr/bin", "hermes", "system-bin", "fixed-system-root", pathApi),
    candidate("/bin", "hermes", "system-bin", "fixed-system-root", pathApi),
  ];
  if (platform === "darwin") {
    candidates.unshift(candidate(
      "/opt/homebrew/bin",
      "hermes",
      "system-bin",
      "fixed-system-root",
      pathApi,
      ["/opt/homebrew/bin", "/opt/homebrew/Cellar"],
    ));
  }
  return uniqueCandidates(candidates, platform);
}

function normalizeOverride(value, homeDir, platform) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (raw === "~") return pathApi.normalize(homeDir);
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return pathApi.normalize(pathApi.join(homeDir, raw.slice(2)));
  }
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

function resolveCandidate(candidateDescriptor, options) {
  const { exists, platform, realpath, stat } = options;
  if (!exists(candidateDescriptor.path)) return { resolution: null, rejection: null };
  try {
    const details = stat(candidateDescriptor.path);
    if (!details.isFile()) {
      return { resolution: null, rejection: { path: candidateDescriptor.path, reason: "candidate is not a regular file" } };
    }
    if (platform === "win32" && !/\.exe$/i.test(candidateDescriptor.path)) {
      return { resolution: null, rejection: { path: candidateDescriptor.path, reason: "Windows runtime is not a direct .exe executable" } };
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
      rejection: {
        path: candidateDescriptor.path,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function resolveHermesRuntimeSelection(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const realpath = options.realpath ?? ((candidatePath) => realpathSync.native(candidatePath));
  const stat = options.stat ?? statSync;
  const trustedCandidates = hermesTrustedCandidates({ homeDir, platform });
  const overridePath = normalizeOverride(env.HERMES_COMMAND, homeDir, platform);
  const overrideCandidate = trustedCandidates.find((candidateDescriptor) =>
    samePath(candidateDescriptor.path, overridePath, platform)
  );
  const orderedCandidates = overrideCandidate
    ? [overrideCandidate, ...trustedCandidates.filter((candidateDescriptor) => candidateDescriptor !== overrideCandidate)]
    : trustedCandidates;
  const rejections = [];
  let resolution = null;
  let selectedCandidate = null;
  for (const candidateDescriptor of orderedCandidates) {
    const result = resolveCandidate(candidateDescriptor, { exists, platform, realpath, stat });
    if (result.rejection) rejections.push(result.rejection);
    if (result.resolution) {
      resolution = result.resolution;
      selectedCandidate = candidateDescriptor;
      break;
    }
  }
  return {
    exists,
    platform,
    realpath,
    resolution,
    selectedCandidate,
    stat,
    trustedCandidates,
    overrideCandidate,
    overridePath,
    rejections,
  };
}

export function hermesRuntimeDiagnostics(options = {}) {
  const selection = resolveHermesRuntimeSelection(options);
  const {
    overrideCandidate,
    overridePath,
    rejections,
    resolution,
    selectedCandidate,
    trustedCandidates,
  } = selection;
  return {
    installed: Boolean(resolution),
    command: resolution?.canonical_path ?? null,
    resolution,
    candidates: trustedCandidates.map(({ base, path: candidatePath, source, validated_by }) => ({
      base,
      path: candidatePath,
      source,
      validated_by,
    })),
    overrideConfigured: Boolean(overridePath),
    overrideAccepted: selectedCandidate === overrideCandidate,
    overridePath,
    profileCommandRootsAllowed: false,
    rejections,
  };
}

function unavailablePythonRuntime(rejections) {
  return {
    installed: false,
    agentRoot: null,
    pythonPath: null,
    runAgentPath: null,
    resolution: null,
    rejections,
  };
}

export function hermesPythonRuntimeDiagnostics(command, options = {}) {
  const selection = resolveHermesRuntimeSelection(options);
  const {
    exists,
    platform,
    realpath,
    resolution: hermesResolution,
    selectedCandidate,
    stat,
  } = selection;
  const rejections = [...selection.rejections];
  if (!hermesResolution || !samePath(hermesResolution.canonical_path, String(command ?? ""), platform)) {
    rejections.push({
      path: String(command ?? ""),
      reason: "command is not the selected fixed-root Hermes runtime",
    });
    return unavailablePythonRuntime(rejections);
  }

  const adapter = selectedCandidate?.pythonAdapter;
  if (!adapter) {
    rejections.push({
      path: hermesResolution.canonical_path,
      reason: "selected Hermes installation has no fixed Python adapter layout",
    });
    return unavailablePythonRuntime(rejections);
  }

  try {
    if (!exists(adapter.pythonPath)) {
      rejections.push({ path: adapter.pythonPath, reason: "Python adapter executable was not found" });
      return unavailablePythonRuntime(rejections);
    }
    const pythonStat = stat(adapter.pythonPath);
    if (!pythonStat.isFile()) {
      rejections.push({ path: adapter.pythonPath, reason: "Python adapter is not a regular file" });
      return unavailablePythonRuntime(rejections);
    }
    if (platform === "win32" && !/\.exe$/i.test(adapter.pythonPath)) {
      rejections.push({ path: adapter.pythonPath, reason: "Windows Python adapter is not a direct .exe executable" });
      return unavailablePythonRuntime(rejections);
    }
    if (platform !== "win32" && (pythonStat.mode & 0o111) === 0) {
      rejections.push({ path: adapter.pythonPath, reason: "Python adapter is not executable" });
      return unavailablePythonRuntime(rejections);
    }
    if (!exists(adapter.runAgentPath)) {
      rejections.push({ path: adapter.runAgentPath, reason: "run_agent.py was not found" });
      return unavailablePythonRuntime(rejections);
    }
    const runAgentStat = stat(adapter.runAgentPath);
    if (!runAgentStat.isFile()) {
      rejections.push({ path: adapter.runAgentPath, reason: "run_agent.py is not a regular file" });
      return unavailablePythonRuntime(rejections);
    }

    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const canonicalInstallationRoot = realpath(adapter.agentRoot);
    const canonicalPythonPath = realpath(adapter.pythonPath);
    const canonicalRunAgentPath = realpath(adapter.runAgentPath);
    if (!adapter.canonicalRoots.some((root) => pathInside(canonicalInstallationRoot, root, platform))) {
      rejections.push({ path: adapter.agentRoot, reason: "canonical installation root escapes fixed allowlisted roots" });
      return unavailablePythonRuntime(rejections);
    }
    // A virtualenv legitimately symlinks its python launcher to a base
    // interpreter in a Python store (uv/pyenv/system), so realpath(python) can
    // resolve OUTSIDE the Hermes root. Accept the interpreter when its resolved
    // path stays inside the root (copied venv) OR it is a genuine venv rooted
    // INSIDE the trusted installation root — proven by a pyvenv.cfg whose
    // canonical path is also inside the root. The trust anchor still holds:
    // creating such a venv needs write access to the Hermes install itself,
    // which already implies control of run_agent.py. A bare malicious symlink
    // (no pyvenv.cfg inside the root) is still rejected.
    const venvConfigPath = pathApi.join(pathApi.dirname(pathApi.dirname(adapter.pythonPath)), "pyvenv.cfg");
    let rootedVenv = false;
    if (exists(venvConfigPath) && stat(venvConfigPath).isFile()) {
      rootedVenv = pathInside(realpath(venvConfigPath), canonicalInstallationRoot, platform);
    }
    if (!pathInside(canonicalPythonPath, canonicalInstallationRoot, platform) && !rootedVenv) {
      rejections.push({ path: adapter.pythonPath, reason: "canonical path escapes fixed allowlisted Hermes installation root" });
      return unavailablePythonRuntime(rejections);
    }
    if (!pathInside(canonicalRunAgentPath, canonicalInstallationRoot, platform)) {
      rejections.push({ path: adapter.runAgentPath, reason: "canonical path escapes fixed allowlisted Hermes installation root" });
      return unavailablePythonRuntime(rejections);
    }

    // Spawn the venv LAUNCHER (inside the trusted root), not the resolved base
    // interpreter, so the venv's site-packages activate. For a copied venv the
    // two are identical; for a symlinked venv only the launcher activates it.
    const launchPythonPath = adapter.pythonPath;
    return {
      installed: true,
      agentRoot: canonicalInstallationRoot,
      pythonPath: launchPythonPath,
      runAgentPath: canonicalRunAgentPath,
      resolution: {
        base: selectedCandidate.base,
        path: launchPythonPath,
        canonical_path: canonicalPythonPath,
        validated_by: "hermesPythonRuntimeDiagnostics",
        source: selectedCandidate.source,
        derived_from: hermesResolution.canonical_path,
        installation_root: canonicalInstallationRoot,
      },
      rejections,
    };
  } catch (error) {
    rejections.push({
      path: adapter.pythonPath,
      reason: error instanceof Error ? error.message : String(error),
    });
    return unavailablePythonRuntime(rejections);
  }
}

export function hermesCommand(options = {}) {
  return hermesRuntimeDiagnostics(options).command;
}

export function hermesHome(profileHome, { homeDir = os.homedir() } = {}) {
  const value = String(profileHome ?? process.env.HERMES_HOME ?? "~/.hermes").trim();
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return path.resolve(value);
}
