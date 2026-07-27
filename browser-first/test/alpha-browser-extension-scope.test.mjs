import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

test("2.0.0 alpha release scope is Chrome extension and bridge only", async () => {
  const packageJson = await readJson("package.json");
  const addonIndex = await readJson("public/addons/index.json");
  const manifest = await readJson("browser-first/resonantos-side-panel-extension/manifest.json");

  for (const removedPath of [
    "src-tauri",
    "electron-host",
    "addons/resonant-browser-native",
    "src/modules/terminal",
    "src/modules/audio2tol",
    "rust-toolchain.toml",
    "public/addons/camofox-browser.json",
    "public/addons/terminal.json",
    "public/addons/audio2tol.json",
  ]) {
    assert.equal(existsSync(path.join(repoRoot, removedPath)), false, `${removedPath} must not be present in alpha`);
  }

  const scripts = JSON.stringify(packageJson.scripts);
  assert.doesNotMatch(scripts, /tauri|electron|browser-native|desktop|install-browser-first-app|verify-browser-native/i);
  assert.equal(packageJson.scripts["browser-first:dev"], "node run-bridge-minimal.mjs");
  assert.equal(packageJson.scripts["browser-first:bridge"], "node run-bridge-minimal.mjs");

  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  for (const removedDependency of [
    "@tauri-apps/api",
    "@tauri-apps/plugin-dialog",
    "@tauri-apps/cli",
    "@xterm/xterm",
    "@xterm/addon-fit",
  ]) {
    assert.equal(dependencies[removedDependency], undefined, `${removedDependency} must not ship in alpha`);
  }

  assert.deepEqual(
    addonIndex.filter((entry) => /camofox|terminal|audio2tol/i.test(entry)),
    [],
  );
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, "src/side-panel.html");
  // The extension ships its own ResonantOS brand icon (matching the in-app brand
  // mark) for every required size, for both the toolbar action and the store
  // listing — so Chrome never falls back to an auto-generated letter icon.
  for (const size of ["16", "32", "48", "128"]) {
    assert.equal(manifest.icons?.[size], `icons/icon-${size}.png`);
    assert.equal(manifest.action?.default_icon?.[size], `icons/icon-${size}.png`);
  }
  // The extension must not override Chrome's new-tab page — the browser keeps
  // whatever the human has configured. The Augmentor workspace is opt-in via the
  // side-panel toggle, never forced onto new tabs.
  assert.equal(manifest.chrome_url_overrides, undefined);
  assert.equal(manifest.permissions.includes("audioCapture"), false);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'self' http:\/\/127\.0\.0\.1:\*/);
  // The extension connects to a user-configured bridge that can live on any
  // LAN/Tailscale host, so connect-src/img-src/frame-src permit any host — CSP
  // has no CIDR syntax to scope it to private ranges (#199). Code execution
  // stays locked down: script-src must remain 'self' and never gain an
  // any-host source, so the broadening only affects data/connection sources.
  assert.doesNotMatch(
    manifest.content_security_policy.extension_pages,
    /script-src[^;]*https?:\/\/\*/,
    "script-src must never allow an any-host source",
  );
  assert.match(
    manifest.content_security_policy.extension_pages,
    /connect-src[^;]*https?:\/\/\*:\*/,
    "connect-src must permit the user's bridge host (remote LAN/Tailscale deployments)",
  );
  assert.equal(manifest.content_scripts[0].js[0], "src/lib/resonant-context.js");
  assert.deepEqual(
    manifest.content_scripts[0].js.slice(0, 3),
    ["src/lib/resonant-context.js", "src/lib/context-plugins.js", "src/lib/resonator.js"],
  );
  assert.ok(manifest.content_scripts[0].js.includes("src/lib/content-field-safety.js"));
});

test("2.0.0 alpha release scope excludes local credential artifacts", () => {
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).split("\n").filter(Boolean);
  const forbidden = tracked.filter((entry) =>
    /(^|\/)provider-secrets\.json$/i.test(entry) ||
    /(^|\/)bridge-config\.generated\.js$/i.test(entry) ||
    /(^|\/)\.env$/i.test(entry) ||
    /(^|\/)ResonantOS_User(\/|$)/i.test(entry)
  );

  assert.deepEqual(forbidden, [], "alpha must not track credential, bridge-token, env, or local user-state artifacts");
});
