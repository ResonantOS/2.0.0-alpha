import { constants, existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const DEFAULT_SNAPSHOT_SKIP = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  "release",
  "dist",
  ".resonant-rig",
]);

function uniqueOrdered(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function assertProfilePath(value) {
  const text = String(value ?? "");
  if (
    !path.isAbsolute(text) ||
    /["\\();\n]/.test(text) ||
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw new Error("Sandbox profile path must be absolute and contain no SBPL metacharacters.");
  }
  return text;
}

function joinRoot(root, ...parts) {
  const base = String(root ?? "").trim();
  return base ? path.join(base, ...parts) : "";
}

export async function resolveDelegationIsolation({
  platform,
  sandboxExecPath = DEFAULT_SANDBOX_EXEC_PATH,
  override,
  isExecutable,
} = {}) {
  const trimmedOverride = String(override ?? "").trim();
  if (trimmedOverride) {
    if (trimmedOverride.toLowerCase() === "contract-only") {
      return { mode: "contract-only", reason: "operator-override" };
    }
    throw new Error(`Unknown RESONANTOS_DELEGATION_ISOLATION value "${trimmedOverride}"; the only supported value is "contract-only".`);
  }

  if (platform === "darwin") {
    if (await isExecutable(sandboxExecPath)) {
      return { mode: "sandbox-exec", reason: "darwin-sandbox-exec" };
    }
    throw new Error(`Delegation isolation unavailable: ${sandboxExecPath} is not executable. Set RESONANTOS_DELEGATION_ISOLATION=contract-only to run delegations unconfined (this is recorded in the governance audit).`);
  }

  return { mode: "contract-only", reason: `no-os-primitive:${platform}` };
}

export function buildSandboxProfile({ writableRoots = [], readDenyRoots = [], readDenyFiles = [] } = {}) {
  const writes = uniqueOrdered(writableRoots).map(assertProfilePath);
  const readRoots = uniqueOrdered(readDenyRoots).map(assertProfilePath);
  const readFiles = uniqueOrdered(readDenyFiles).map(assertProfilePath);
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null")${writes.map((root) => ` (subpath "${root}")`).join("")})`,
  ];
  if (readRoots.length || readFiles.length) {
    lines.push(`(deny file-read*${readRoots.map((root) => ` (subpath "${root}")`).join("")}${readFiles.map((file) => ` (literal "${file}")`).join("")})`);
  }
  return `${lines.join("\n")}\n`;
}

export async function ensureRealpath(dir, { fs = fsPromises } = {}) {
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
}

export async function realpathExisting(paths, { fs = fsPromises } = {}) {
  const result = [];
  for (const candidate of uniqueOrdered(paths)) {
    try {
      result.push(await fs.realpath(candidate));
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
    }
  }
  return result;
}

// protectedPaths: the root may not equal, contain, or lie inside any of them (secret stores, the user root).
// ancestorOnlyPaths: the root may not equal or contain any of them (the repository — a profile home inside it is odd but not a bypass).
export function assertBoundedWritableRoot(realRoot, { home, protectedPaths = [], ancestorOnlyPaths = [] } = {}) {
  const root = String(realRoot ?? "").trim();
  const homeRoot = String(home ?? "").trim();
  const protectedRoots = uniqueOrdered(protectedPaths);
  const ancestorOnly = uniqueOrdered(ancestorOnlyPaths);
  let reason = "";
  if (root === "/") {
    reason = "filesystem root is not allowed";
  } else if (root === homeRoot) {
    reason = "home directory is not allowed";
  } else if (homeRoot && homeRoot.startsWith(`${root}${path.sep}`)) {
    reason = "ancestors of home are not allowed";
  } else {
    const protectedRoot = protectedRoots.find((candidate) => (
      root === candidate || candidate.startsWith(`${root}${path.sep}`) || root.startsWith(`${candidate}${path.sep}`)
    ));
    const containedRoot = protectedRoot ? "" : ancestorOnly.find((candidate) => (
      root === candidate || candidate.startsWith(`${root}${path.sep}`)
    ));
    if (protectedRoot) {
      reason = root.startsWith(`${protectedRoot}${path.sep}`)
        ? `root lies inside protected path ${protectedRoot}`
        : `protected path ${protectedRoot} would be writable`;
    } else if (containedRoot) {
      reason = `protected path ${containedRoot} would be writable`;
    } else if (!homeRoot || !root.startsWith(`${homeRoot}${path.sep}`)) {
      reason = "root must be a descendant of home";
    }
  }
  if (reason) {
    throw new Error(`Delegation isolation refused writable root ${root}: ${reason}`);
  }
  return root;
}

export function writableRootsFor(addon, ctx = {}) {
  const env = ctx.env ?? {};
  const home = String(env.HOME ?? os.homedir()).trim();
  const tmpdir = String(env.TMPDIR ?? env.TEMP ?? env.TMP ?? ctx.tmpdir ?? os.tmpdir()).trim();
  if (addon === "opencode") {
    const opencodeLegacyHome = joinRoot(home, ".opencode");
    return uniqueOrdered([
      ctx.workspacePath,
      ctx.promptTempDir,
      tmpdir,
      "/tmp",
      joinRoot(env.XDG_DATA_HOME ?? joinRoot(home, ".local", "share"), "opencode"),
      joinRoot(env.XDG_CACHE_HOME ?? joinRoot(home, ".cache"), "opencode"),
      joinRoot(env.XDG_CONFIG_HOME ?? joinRoot(home, ".config"), "opencode"),
      joinRoot(home, ".local", "state", "opencode"),
      env.OPENCODE_DATA,
      env.OPENCODE_CACHE,
      env.OPENCODE_CONFIG,
      ctx.pathExists?.(opencodeLegacyHome) ? opencodeLegacyHome : "",
    ]);
  }
  if (addon === "hermes") {
    return uniqueOrdered([
      ctx.profileHome,
      ctx.tempDir,
      tmpdir,
      "/tmp",
      joinRoot(env.XDG_CACHE_HOME ?? joinRoot(home, ".cache"), "pip"),
      joinRoot(env.XDG_CACHE_HOME ?? joinRoot(home, ".cache"), "hermes"),
    ]);
  }
  throw new Error(`Unknown delegation isolation add-on "${addon}".`);
}

export function readDenyRootsFor(ctx = {}) {
  const env = ctx.env ?? {};
  const home = String(env.HOME ?? os.homedir()).trim();
  const actualHomedir = String(os.homedir()).trim();
  const homedir = String(ctx.homedir ?? actualHomedir).trim();
  const userRoot = typeof ctx.userRoot === "function" ? ctx.userRoot() : ctx.userRoot;
  const repoRoot = typeof ctx.repoRoot === "function" ? ctx.repoRoot() : ctx.repoRoot;
  const homes = uniqueOrdered([home, homedir]);
  return {
    roots: uniqueOrdered([
      ...homes.flatMap((root) => [
        joinRoot(root, ".ssh"),
        joinRoot(root, ".gnupg"),
        joinRoot(root, ".aws"),
        joinRoot(root, ".azure"),
        joinRoot(root, ".config", "gcloud"),
        joinRoot(root, ".kube"),
        joinRoot(root, ".docker"),
        joinRoot(root, "Library", "Keychains"),
        joinRoot(root, "Library", "Cookies"),
        joinRoot(root, "Library", "Application Support", "Google"),
        joinRoot(root, "Library", "Application Support", "BraveSoftware"),
        joinRoot(root, "Library", "Application Support", "Firefox"),
        joinRoot(root, "Library", "Application Support", "Claude"),
      ]),
      joinRoot(homedir, "ResonantOS_User", "Secrets"),
      joinRoot(actualHomedir, "ResonantOS_User", "Secrets"),
      joinRoot(userRoot, "Secrets"),
    ]),
    files: uniqueOrdered([
      ...homes.map((root) => joinRoot(root, ".netrc")),
      joinRoot(repoRoot, "browser-first", "resonantos-side-panel-extension", "src", "bridge-config.generated.js"),
    ]),
  };
}

export function wrapCommandForIsolation({ mode, sandboxExecPath, profilePath, command, args = [] } = {}) {
  if (mode === "sandbox-exec") {
    return { command: sandboxExecPath, args: ["-f", profilePath, command, ...args] };
  }
  return { command, args };
}

export function parseSandboxDenialLines(text, processNames = []) {
  const names = new Set(processNames.map((name) => String(name ?? "").trim()).filter(Boolean));
  const entries = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /Sandbox:\s*([^(]+)\(\d+\)\s+deny\(\d+\)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!names.has(name)) continue;
    entries.push({ operation: match[2], path: match[3].trim() });
  }
  return entries;
}

function localTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

export async function readSandboxDenialsDefault({
  startedAt,
  processNames = [],
  spawnProcess = spawn,
  timeoutMs = 10_000,
} = {}) {
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const args = [
    "show",
    "--style",
    "compact",
    "--start",
    localTimestamp(started),
    "--predicate",
    'eventMessage CONTAINS "deny" AND eventMessage CONTAINS "Sandbox"',
  ];
  const output = await new Promise((resolve, reject) => {
    const child = spawnProcess("/usr/bin/log", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.("SIGTERM");
      child.unref?.();
      killTimer = setTimeout(() => {
        child.kill?.("SIGKILL");
      }, 1_000);
      killTimer.unref?.();
      reject(new Error(`sandbox denial capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 65_536) stdout += String(chunk).slice(0, 65_536 - stdout.length);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8_192) stderr += String(chunk).slice(0, 8_192 - stderr.length);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", () => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stdout || stderr);
    });
  });
  const parsed = parseSandboxDenialLines(output, processNames);
  return { count: parsed.length, sample: parsed.slice(0, 20) };
}

function skippedDirectory(name, skip) {
  return skip.has(name);
}

export async function snapshotTree(root, {
  fs = fsPromises,
  maxEntries = 20_000,
  maxDurationMs = 3_000,
  skip = DEFAULT_SNAPSHOT_SKIP,
} = {}) {
  const started = Date.now();
  const entries = new Map();
  const skipSet = skip instanceof Set ? skip : new Set(skip);
  let truncated = false;

  async function visit(dir) {
    if (truncated || Date.now() - started > maxDurationMs) {
      truncated = true;
      return;
    }
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) return;
      throw error;
    }
    for await (const dirent of handle) {
      if (truncated) break;
      if (skippedDirectory(dirent.name, skipSet)) continue;
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!dirent.isFile()) continue;
      const details = await fs.stat(fullPath);
      const rel = path.relative(root, fullPath).split(path.sep).join("/");
      entries.set(rel, { size: details.size, mtimeMs: details.mtimeMs });
      if (entries.size >= maxEntries || Date.now() - started > maxDurationMs) {
        truncated = true;
        break;
      }
    }
  }

  await visit(root);
  return { entries, truncated };
}

export function diffTrees(before, after) {
  const added = [];
  const modified = [];
  const removed = [];
  const beforeEntries = before?.entries ?? new Map();
  const afterEntries = after?.entries ?? new Map();
  for (const [rel, details] of afterEntries) {
    const previous = beforeEntries.get(rel);
    if (!previous) {
      added.push(rel);
    } else if (previous.size !== details.size || previous.mtimeMs !== details.mtimeMs) {
      modified.push(rel);
    }
  }
  for (const rel of beforeEntries.keys()) {
    if (!afterEntries.has(rel)) removed.push(rel);
  }
  added.sort();
  modified.sort();
  removed.sort();
  return {
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    truncated: Boolean(before?.truncated || after?.truncated),
    sample: {
      added: added.slice(0, 100),
      modified: modified.slice(0, 100),
      removed: removed.slice(0, 100),
    },
  };
}

export function createDelegationIsolationAdapter({
  browserFirstRoot,
  env = process.env,
  fs = fsPromises,
  platform = process.platform,
  repoRoot,
  sandboxExecPath = DEFAULT_SANDBOX_EXEC_PATH,
  spawnProcess = spawn,
  uniqueRuntimeId = (prefix) => `${prefix}-${Date.now()}`,
  userRoot,
  isExecutable,
  readSandboxDenials,
} = {}) {
  const executableCheck = isExecutable ?? (async (candidate) => {
    try {
      await fs.access(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const denialReader = readSandboxDenials ?? ((payload) => readSandboxDenialsDefault({
    ...payload,
    spawnProcess,
  }));
  return {
    sandboxExecPath,
    resolve: () => resolveDelegationIsolation({
      platform,
      sandboxExecPath,
      override: env.RESONANTOS_DELEGATION_ISOLATION,
      isExecutable: executableCheck,
    }),
    writableRootsFor: (addon, ctx) => writableRootsFor(addon, {
      ...ctx,
      env: ctx?.env ?? env,
      pathExists: ctx?.pathExists ?? existsSync,
    }),
    readDenyRootsFor: (ctx) => readDenyRootsFor({
      ...ctx,
      env: ctx?.env ?? env,
      repoRoot: ctx?.repoRoot ?? repoRoot,
      userRoot: ctx?.userRoot ?? userRoot,
    }),
    ensureRealpath: (dir) => ensureRealpath(dir, { fs }),
    realpathExisting: (paths) => realpathExisting(paths, { fs }),
    buildSandboxProfile,
    assertBoundedWritableRoot,
    wrapCommandForIsolation,
    writeProfile: async (profileText) => {
      const isolationRoot = path.join(browserFirstRoot(), "Runtime", "isolation");
      await fs.mkdir(isolationRoot, { recursive: true });
      const profilePath = path.join(isolationRoot, `profile-${uniqueRuntimeId("isolation")}.sb`);
      await fs.writeFile(profilePath, profileText, { mode: 0o600 });
      await fs.chmod(profilePath, 0o600).catch(() => undefined);
      return profilePath;
    },
    removeProfile: async (profilePath) => {
      if (profilePath) await fs.rm(profilePath, { force: true }).catch(() => undefined);
    },
    readSandboxDenials: denialReader,
    snapshotTree: (root, options) => snapshotTree(root, { ...options, fs }),
    diffTrees,
  };
}
