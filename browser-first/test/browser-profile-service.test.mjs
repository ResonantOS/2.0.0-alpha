import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chromeProfileRoots,
  findChromiumExtension,
  removeCachedUnpackedExtension,
  seedPinnedExtensions,
  seedResonantStartupExperience
} from "../host/browser-profile-service.mjs";

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "resonantos-profile-service-"));
}

async function readPreferences(profileDir) {
  return JSON.parse(await readFile(path.join(profileDir, "Default", "Preferences"), "utf8"));
}

test("browser profile service seeds ResonantOS startup and new-tab ownership", async () => {
  const profile = await tempRoot();
  try {
    await seedResonantStartupExperience(profile, "resonantos-extension", "chrome-extension://resonantos-extension/src/main-workspace.html");
    const preferences = await readPreferences(profile);

    assert.equal(preferences.profile.exit_type, "Normal");
    assert.equal(preferences.profile.exited_cleanly, true);
    assert.equal(preferences.session.restore_on_startup, 4);
    assert.deepEqual(preferences.session.startup_urls, ["chrome-extension://resonantos-extension/src/main-workspace.html"]);
    assert.equal(preferences.extensions.chrome_url_overrides.newtab[0].extension_id, "resonantos-extension");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("browser profile service pins unique extension ids without dropping existing pins", async () => {
  const profile = await tempRoot();
  try {
    await mkdir(path.join(profile, "Default"), { recursive: true });
    await writeFile(path.join(profile, "Default", "Preferences"), JSON.stringify({
      extensions: { pinned_extensions: ["existing"] },
      account_values: { extensions: { pinned_extensions: ["account-existing"] } }
    }));

    await seedPinnedExtensions(profile, ["resonantos", "phantom", "resonantos", null]);
    const preferences = await readPreferences(profile);

    assert.deepEqual(preferences.extensions.pinned_extensions, ["resonantos", "phantom", "existing"]);
    assert.deepEqual(preferences.account_values.extensions.pinned_extensions, ["resonantos", "phantom", "account-existing"]);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("browser profile service discovers override extensions and clears unpacked caches", async () => {
  const profile = await tempRoot();
  const override = await tempRoot();
  try {
    await writeFile(path.join(override, "manifest.json"), "{}\n");
    assert.equal(findChromiumExtension({
      extensionId: "phantom",
      overrideEnvName: "RESONANTOS_TEST_EXTENSION",
      env: { RESONANTOS_TEST_EXTENSION: override }
    }), override);

    for (const cache of ["Extensions", "Extension Scripts", "Extension Rules"]) {
      const dir = path.join(profile, "Default", cache, "resonantos");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "cached.txt"), "cached");
    }

    await removeCachedUnpackedExtension(profile, "resonantos");
    for (const cache of ["Extensions", "Extension Scripts", "Extension Rules"]) {
      await assert.rejects(readFile(path.join(profile, "Default", cache, "resonantos", "cached.txt")));
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(override, { recursive: true, force: true });
  }
});

test("browser profile roots are platform specific and portable", () => {
  assert.deepEqual(chromeProfileRoots({ home: "/home/user", platform: "linux", env: {} }), [
    "/home/user/.config/google-chrome",
    "/home/user/.config/BraveSoftware/Brave-Browser",
    "/home/user/.config/chromium",
  ]);
  assert.deepEqual(chromeProfileRoots({ home: "C:\\Users\\User", platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\User\\AppData\\Local" } }), [
    path.win32.join("C:\\Users\\User\\AppData\\Local", "Google", "Chrome", "User Data"),
    path.win32.join("C:\\Users\\User\\AppData\\Local", "BraveSoftware", "Brave-Browser", "User Data"),
    path.win32.join("C:\\Users\\User\\AppData\\Local", "Chromium", "User Data"),
  ]);
});
