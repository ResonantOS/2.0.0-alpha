import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ephemeralProfileRoot,
  persistentProfileOptIn,
  resolveBrowserProfile,
  resolveRemoteDebugging,
  LOOPBACK_ADDRESS,
} from "../host/browser-launch-config.mjs";

const PERSISTENT_DEFAULT = path.join(os.homedir(), "ResonantOS_User", "BrowserFirst", "Profiles", "main");
const USER_ROOT = path.join(os.homedir(), "ResonantOS_User");

function evaluateLaunchPath({ profile, debugPort, loopbackBound, extensionSet }) {
  const reasons = [];
  if (profile !== "ephemeral") reasons.push("profile must be ephemeral");
  if (!(debugPort === 0 || loopbackBound)) reasons.push("debugging must use port 0 or bind loopback");
  if (extensionSet !== "pinned") reasons.push("extension set must be pinned");
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

function emptyArgs() {
  return new Map();
}

function argsWith(entries) {
  return new Map(Object.entries(entries));
}

test("default profile is owned + ephemeral, never the persistent Profiles/main", () => {
  const resolved = resolveBrowserProfile({
    args: emptyArgs(),
    env: {},
    persistentDefaultProfile: PERSISTENT_DEFAULT,
    userRoot: USER_ROOT,
  });
  assert.equal(resolved.mode, "ephemeral");
  assert.equal(resolved.ephemeral, true);
  assert.notEqual(resolved.profileDir, PERSISTENT_DEFAULT);
  // Lives under the owned ephemeral root, not the persistent main profile.
  const ephemeralRoot = ephemeralProfileRoot({ userRoot: USER_ROOT });
  assert.ok(resolved.profileDir.startsWith(ephemeralRoot), `expected under ${ephemeralRoot}, got ${resolved.profileDir}`);
  assert.ok(!resolved.profileDir.includes(path.join("Profiles", "main")));
});

test("each default launch gets a fresh ephemeral profile dir", () => {
  const base = {
    args: emptyArgs(),
    env: {},
    persistentDefaultProfile: PERSISTENT_DEFAULT,
    userRoot: USER_ROOT,
  };
  const a = resolveBrowserProfile(base);
  const b = resolveBrowserProfile(base);
  assert.notEqual(a.profileDir, b.profileDir);
});

test("persistent profile only under explicit env opt-in", () => {
  const resolved = resolveBrowserProfile({
    args: emptyArgs(),
    env: { RESONANTOS_BROWSER_PERSISTENT_PROFILE: "1" },
    persistentDefaultProfile: PERSISTENT_DEFAULT,
    userRoot: USER_ROOT,
  });
  assert.equal(resolved.mode, "persistent");
  assert.equal(resolved.ephemeral, false);
  assert.equal(resolved.profileDir, PERSISTENT_DEFAULT);
});

test("persistent profile only under explicit flag opt-in", () => {
  const resolved = resolveBrowserProfile({
    args: argsWith({ "persistent-profile": "true" }),
    env: {},
    persistentDefaultProfile: PERSISTENT_DEFAULT,
    userRoot: USER_ROOT,
  });
  assert.equal(resolved.mode, "persistent");
  assert.equal(resolved.profileDir, PERSISTENT_DEFAULT);
});

test("explicit --profile path is honored as-is (intentional caller choice)", () => {
  const target = path.join(os.tmpdir(), "explicit-profile");
  const resolved = resolveBrowserProfile({
    args: argsWith({ profile: target }),
    env: {},
    persistentDefaultProfile: PERSISTENT_DEFAULT,
    userRoot: USER_ROOT,
  });
  assert.equal(resolved.mode, "explicit");
  assert.equal(resolved.profileDir, path.resolve(target));
});

test("persistentProfileOptIn recognizes accepted truthy values", () => {
  assert.equal(persistentProfileOptIn({ args: emptyArgs(), env: { RESONANTOS_BROWSER_PERSISTENT_PROFILE: "yes" } }), true);
  assert.equal(persistentProfileOptIn({ args: emptyArgs(), env: { RESONANTOS_BROWSER_PERSISTENT_PROFILE: "0" } }), false);
  assert.equal(persistentProfileOptIn({ args: emptyArgs(), env: {} }), false);
});

test("no remote debugging requested => nothing exposed", () => {
  const result = resolveRemoteDebugging({ args: emptyArgs(), env: {} });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.hostArgs, []);
});

test("requested debug port is contained to port 0 + loopback (caller fixed port dropped)", () => {
  const result = resolveRemoteDebugging({ args: argsWith({ "remote-debugging-port": "9222" }), env: {} });
  assert.equal(result.enabled, true);
  assert.equal(result.port, 0);
  assert.equal(result.loopbackBound, true);
  assert.equal(result.requestedPort, "9222");
  assert.ok(result.hostArgs.includes("--resonantos-remote-debugging-port=0"));
  assert.ok(result.hostArgs.includes(`--resonantos-remote-debugging-address=${LOOPBACK_ADDRESS}`));
  // The exposed fixed port is never forwarded.
  assert.ok(!result.hostArgs.some((a) => a.includes("9222")));
});

test("env-supplied debug port is also contained", () => {
  const result = resolveRemoteDebugging({
    args: emptyArgs(),
    env: { RESONANTOS_BROWSER_FIRST_REMOTE_DEBUGGING_PORT: "9333" },
  });
  assert.equal(result.port, 0);
  assert.equal(result.loopbackBound, true);
});

// End-to-end: the resolved launch description satisfies the cdp-proof predicate
// (ephemeral_profile AND (port==0 OR loopback) AND pinned_extension_set).
test("default launch passes the cdp-proof predicate", () => {
  const profile = resolveBrowserProfile({
    args: emptyArgs(),
    env: {},
    persistentDefaultProfile: PERSISTENT_DEFAULT,
    userRoot: USER_ROOT,
  });
  const debugging = resolveRemoteDebugging({ args: argsWith({ "remote-debugging-port": "9222" }), env: {} });

  const verdict = evaluateLaunchPath({
    id: "browser-first-host-launch",
    surface: "browser-first/host/run-browser-first.mjs",
    profile: profile.ephemeral ? "ephemeral" : "persistent",
    debugPort: debugging.enabled ? debugging.port : 0,
    loopbackBound: debugging.loopbackBound,
    extensionSet: "pinned", // owned resonant extension (+ phantom by id), no caller-supplied dirs
  });
  assert.equal(verdict.verdict, "pass", JSON.stringify(verdict.reasons));
});
