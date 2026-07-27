import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_NPM_INSTALL_COMMAND,
  opencodeCandidatePaths,
  opencodeRuntimeDiagnostics,
} from "../host/opencode-runtime.mjs";

test("opencode diagnostics surface install and override guidance when runtime is missing", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "resonantos-opencode-missing-"));
  try {
    const diagnostics = opencodeRuntimeDiagnostics({
      env: {
        PATH: tempDir,
        OPENCODE_COMMAND: path.join(tempDir, "missing-opencode"),
      },
      includeCommonCandidates: false,
    });

    assert.equal(diagnostics.installed, false);
    assert.equal(diagnostics.command, null);
    assert.equal(diagnostics.overrideConfigured, true);
    assert.equal(diagnostics.overrideFound, false);
    assert.equal(diagnostics.installCommand, OPENCODE_INSTALL_COMMAND);
    assert.ok(diagnostics.alternativeInstallCommands.includes(OPENCODE_NPM_INSTALL_COMMAND));
    assert.match(diagnostics.configureCommand, /OPENCODE_COMMAND/);
    assert.match(diagnostics.configureCommand, /usr\/local\/bin\/opencode/);
    assert.doesNotMatch(diagnostics.configureCommand, /absolute\/path/);
    assert.deepEqual(diagnostics.searchedCommands, ["opencode", "opencode-ai"]);
    assert.deepEqual(diagnostics.searchedPaths, []);
    assert.equal(diagnostics.overrideAccepted, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("opencode diagnostics ignore ambient PATH and untrusted overrides", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "resonantos-opencode-path-"));
  const fakeOpenCode = path.join(tempDir, "opencode");
  try {
    writeFileSync(fakeOpenCode, "#!/bin/sh\n");
    chmodSync(fakeOpenCode, 0o755);

    const diagnostics = opencodeRuntimeDiagnostics({
      env: { PATH: tempDir, OPENCODE_COMMAND: fakeOpenCode },
      homeDir: "/home/reviewer",
      platform: "linux",
    });

    assert.equal(diagnostics.installed, false);
    assert.equal(diagnostics.command, null);
    assert.equal(diagnostics.overrideAccepted, false);
    assert.ok(diagnostics.candidates.every(({ path: candidate }) => candidate !== fakeOpenCode));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("opencode diagnostics return canonical provenance for a fixed system candidate", () => {
  const command = "/usr/local/bin/opencode";
  const diagnostics = opencodeRuntimeDiagnostics({
    env: { OPENCODE_COMMAND: command, PATH: "/tmp/attacker" },
    homeDir: "/home/reviewer",
    platform: "linux",
    exists: (candidate) => candidate === command,
    realpath: (candidate) => candidate,
    stat: () => ({ isFile: () => true, mode: 0o755 }),
  });

  assert.equal(diagnostics.command, command);
  assert.equal(diagnostics.overrideAccepted, true);
  assert.deepEqual(diagnostics.resolution, {
    base: "system-bin",
    path: command,
    canonical_path: command,
    validated_by: "opencodeRuntimeDiagnostics",
    source: "fixed-system-root",
  });
});

test("opencode Windows candidates reject command shims and include only direct executables", () => {
  const candidates = opencodeCandidatePaths({
    env: {
      OPENCODE_COMMAND: "C:\\Users\\reviewer\\bin\\opencode.cmd",
      PATH: "C:\\Users\\reviewer\\bin",
    },
    homeDir: "C:\\Users\\reviewer",
    platform: "win32",
  });

  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(({ path: candidate }) => /\.exe$/i.test(candidate)));
  assert.ok(candidates.every(({ path: candidate }) => !/\.(?:cmd|bat)$/i.test(candidate)));
});

test("opencode diagnostics reject canonical escapes from trusted candidates", () => {
  const command = "/usr/local/bin/opencode";
  const diagnostics = opencodeRuntimeDiagnostics({
    env: {},
    homeDir: "/home/reviewer",
    platform: "linux",
    exists: (candidate) => candidate === command,
    realpath: (candidate) => candidate === command ? "/tmp/attacker/opencode" : candidate,
    stat: () => ({ isFile: () => true, mode: 0o755 }),
  });

  assert.equal(diagnostics.command, null);
  assert.ok(diagnostics.rejections.some(({ reason }) => /canonical path escapes/i.test(reason)));
});

test("opencode diagnostics accept an npm-global symlink into the bin root's lib/node_modules", () => {
  // `npm install -g --prefix ~/.local opencode-ai` symlinks ~/.local/bin/opencode
  // to ~/.local/lib/node_modules/opencode-ai/bin/opencode — a legitimate install.
  const link = "/home/reviewer/.local/bin/opencode";
  const target = "/home/reviewer/.local/lib/node_modules/opencode-ai/bin/opencode";
  const diagnostics = opencodeRuntimeDiagnostics({
    env: {},
    homeDir: "/home/reviewer",
    platform: "linux",
    exists: (candidate) => candidate === link,
    realpath: (candidate) => (candidate === link ? target : candidate),
    stat: () => ({ isFile: () => true, mode: 0o755 }),
  });

  assert.equal(diagnostics.installed, true);
  assert.equal(diagnostics.command, target);
  assert.equal(diagnostics.resolution?.source, "fixed-user-install-root");
});
