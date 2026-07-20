import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function latestManifestDirectory(root) {
  if (!existsSync(root)) {
    return null;
  }
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(root, name, "manifest.json")))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  return versions[0] ? path.join(root, versions[0]) : null;
}

export function chromeProfileRoots({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") {
    return [
      path.posix.join(home, "Library", "Application Support", "Google", "Chrome"),
      path.posix.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
      path.posix.join(home, "Library", "Application Support", "Chromium"),
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local");
    return [
      path.win32.join(local, "Google", "Chrome", "User Data"),
      path.win32.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
      path.win32.join(local, "Chromium", "User Data"),
    ];
  }
  return [
    path.posix.join(home, ".config", "google-chrome"),
    path.posix.join(home, ".config", "BraveSoftware", "Brave-Browser"),
    path.posix.join(home, ".config", "chromium"),
  ];
}

export function findChromiumExtension({ extensionId, overrideEnvName, env = process.env } = {}) {
  if (overrideEnvName && env[overrideEnvName]) {
    const override = path.resolve(env[overrideEnvName]);
    return existsSync(path.join(override, "manifest.json")) ? override : null;
  }
  for (const root of chromeProfileRoots({ env })) {
    if (!existsSync(root)) {
      continue;
    }
    const profileNames = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/i.test(entry.name)))
      .map((entry) => entry.name);
    for (const profile of profileNames) {
      const candidate = latestManifestDirectory(path.join(root, profile, "Extensions", extensionId));
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export async function seedPinnedExtensions(profileDir, extensionIds) {
  const defaultDir = path.join(profileDir, "Default");
  const preferencesPath = path.join(defaultDir, "Preferences");
  await mkdir(defaultDir, { recursive: true });
  let preferences = {};
  if (existsSync(preferencesPath)) {
    preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
  }
  preferences.extensions = preferences.extensions ?? {};
  preferences.account_values = preferences.account_values ?? {};
  preferences.account_values.extensions = preferences.account_values.extensions ?? {};
  preferences.extensions.pinned_extensions = unique([
    ...extensionIds,
    ...(preferences.extensions.pinned_extensions ?? []),
  ]);
  preferences.account_values.extensions.pinned_extensions = unique([
    ...extensionIds,
    ...(preferences.account_values.extensions.pinned_extensions ?? []),
  ]);
  await writeFile(preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`);
}

export async function seedResonantStartupExperience(profileDir, extensionId, mainWorkspaceUrl) {
  const defaultDir = path.join(profileDir, "Default");
  const preferencesPath = path.join(defaultDir, "Preferences");
  await mkdir(defaultDir, { recursive: true });
  let preferences = {};
  if (existsSync(preferencesPath)) {
    try {
      preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
    } catch {
      preferences = {};
    }
  }
  preferences.profile = preferences.profile ?? {};
  preferences.profile.exit_type = "Normal";
  preferences.profile.exited_cleanly = true;
  preferences.session = preferences.session ?? {};
  preferences.session.restore_on_startup = 4;
  preferences.session.startup_urls = [mainWorkspaceUrl];
  preferences.extensions = preferences.extensions ?? {};
  preferences.extensions.chrome_url_overrides = preferences.extensions.chrome_url_overrides ?? {};
  const existingNewTab = Array.isArray(preferences.extensions.chrome_url_overrides.newtab)
    ? preferences.extensions.chrome_url_overrides.newtab
    : [];
  preferences.extensions.chrome_url_overrides.newtab = [
    { active: true, extension_id: extensionId, entry: `chrome-extension://${extensionId}/src/main-workspace.html` },
    ...existingNewTab.filter((entry) => String(entry?.extension_id ?? "") !== extensionId),
  ];
  await writeFile(preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`);
}

export async function removeCachedUnpackedExtension(profileDir, extensionId) {
  const defaultDir = path.join(profileDir, "Default");
  const cacheRoots = [
    path.join(defaultDir, "Extensions", extensionId),
    path.join(defaultDir, "Extension Scripts", extensionId),
    path.join(defaultDir, "Extension Rules", extensionId),
  ];
  for (const cacheRoot of cacheRoots) {
    await rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
