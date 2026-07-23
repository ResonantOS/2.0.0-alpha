import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAddonDelegationService } from "../host/addon-delegation-service.mjs";

const REQUIRED_LIVE_GRANTS = ["filesystem", "shell", "providers"];

function safeFileSlug(value) {
  return String(value ?? "item")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function defaultOpenCodeProviderRoute(model) {
  const normalized = String(model ?? "");
  const providerType = normalized.startsWith("google/") ? "google"
    : normalized.startsWith("openai/") || normalized.startsWith("gpt-") ? "openai"
      : "minimax";
  return {
    providerId: `shared-${providerType}`,
    providerType,
    apiBaseUrl: `https://api.${providerType}.example/v1`,
    wireModel: normalized.includes("/") ? normalized.split("/").slice(1).join("/") : normalized,
  };
}

function createService(root, overrides = {}) {
  const browserFirstRoot = () => path.join(root, "BrowserFirst");
  return createAddonDelegationService({
    browserFirstRoot,
    bridgePublicUrl: "http://127.0.0.1:47773",
    dashboardTarget: () => ({ host: "127.0.0.1", port: 9119, url: "http://127.0.0.1:9119" }),
    execFileStdout: async () => "",
    expandUserPath: (value) => path.resolve(root, String(value ?? "")),
    firstExistingExecutable: () => null,
    hermesCommand: () => null,
    hermesHome: () => path.join(root, "HermesHome"),
    hermesPythonRuntime: () => null,
    listFilesRecursive: async () => [],
    memoryRoot: () => path.join(root, "Memory"),
    opencodeCommand: () => overrides.opencodeRuntimeDiagnostics?.().command ?? null,
    opencodeRuntimeDiagnostics: overrides.opencodeRuntimeDiagnostics ?? (() => ({ installed: false, command: null })),
    resolveOpenCodeProviderRoute: overrides.resolveOpenCodeProviderRoute ?? defaultOpenCodeProviderRoute,
    redactPathForDiagnostics: (value) => String(value ?? "").replace(root, "<root>"),
    readProviderSecrets: overrides.readProviderSecrets ?? (async () => ({})),
    repoRoot: root,
    safeFileSlug,
    socketOpen: async () => false,
    uniqueRuntimeId: (prefix) => `${prefix}-test`,
    userRoot: () => root,
  });
}

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ros-opencode-policy-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
}

async function writeSettings(root, opencode) {
  const settingsPath = path.join(root, "BrowserFirst", "Settings", "addon-execution.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({
    hermes: { localCliExecution: false },
    opencode,
  }));
}

function readySettings(overrides = {}) {
  return {
    localCliExecution: true,
    liveSession: {
      enabled: true,
      workspacePath: ".",
      grantedCapabilities: REQUIRED_LIVE_GRANTS,
      ...overrides.liveSession,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "liveSession")),
  };
}

function availableRuntime() {
  return {
    installed: true,
    command: "/usr/local/bin/opencode",
    commandRedacted: "/usr/local/bin/opencode",
  };
}

test("OpenCode live-session settings default closed and reject invalid desired authority", async () => {
  await withTempRoot(async (root) => {
    const service = createService(root);
    const initial = await service.executeAddonExecutionSettingsGet();

    assert.deepEqual(initial.settings.opencode, {
      localCliExecution: false,
      liveSession: {
        enabled: false,
        workspacePath: "",
        grantedCapabilities: [],
      },
    });

    await assert.rejects(
      service.executeAddonExecutionSettingsUpdate({
        addon: "opencode",
        localCliExecution: "false",
        liveSession: {
          enabled: false,
          workspacePath: "",
          grantedCapabilities: [],
        },
      }),
      /localCliExecution must be a boolean/i,
    );

    await assert.rejects(
      service.executeAddonExecutionSettingsUpdate({
        addon: "opencode",
        localCliExecution: false,
        liveSession: null,
      }),
      /liveSession must be an object/i,
    );

    await assert.rejects(
      service.executeAddonExecutionSettingsUpdate({
        addon: "opencode",
        localCliExecution: false,
        liveSession: {
          enabled: "false",
          workspacePath: "",
          grantedCapabilities: [],
        },
      }),
      /liveSession.enabled must be a boolean/i,
    );

    await assert.rejects(
      service.executeAddonExecutionSettingsUpdate({
        addon: "opencode",
        localCliExecution: true,
        liveSession: {
          enabled: false,
          workspacePath: ".",
          grantedCapabilities: ["filesystem", "wallet"],
        },
      }),
      /unsupported OpenCode live-session capability: wallet/i,
    );

    await assert.rejects(
      service.executeAddonExecutionSettingsUpdate({
        addon: "opencode",
        localCliExecution: true,
        liveSession: {
          enabled: true,
          workspacePath: "",
          grantedCapabilities: REQUIRED_LIVE_GRANTS,
        },
      }),
      /workspace is required/i,
    );

    await assert.rejects(
      service.executeAddonExecutionSettingsUpdate({
        addon: "opencode",
        localCliExecution: true,
        liveSession: {
          enabled: true,
          workspacePath: ".",
          grantedCapabilities: ["filesystem", "shell"],
        },
      }),
      /providers.*required/i,
    );

    const updated = await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
      liveSession: {
        enabled: true,
        workspacePath: root,
        grantedCapabilities: ["providers", "filesystem", "shell", "filesystem"],
      },
    });

    assert.deepEqual(updated.settings.opencode, {
      localCliExecution: true,
      liveSession: {
        enabled: true,
        workspacePath: ".",
        grantedCapabilities: REQUIRED_LIVE_GRANTS,
      },
    });
    const persisted = JSON.parse(await readFile(
      path.join(root, "BrowserFirst", "Settings", "addon-execution.json"),
      "utf8",
    ));
    assert.equal(persisted.opencode.liveSession.workspacePath, ".");
    assert.doesNotMatch(JSON.stringify(updated), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const addonStatus = await service.executeAddonsStatus();
    const openCodeStatus = addonStatus.addons.find((addon) => addon.id === "addon.opencode");
    assert.deepEqual(openCodeStatus.requestedCapabilities, [
      ...REQUIRED_LIVE_GRANTS,
      "archive-read",
      "archive-intake-write",
    ]);
    assert.deepEqual(openCodeStatus.grantedCapabilities, REQUIRED_LIVE_GRANTS);
    assert.deepEqual(openCodeStatus.deniedCapabilities, ["archive-read", "archive-intake-write"]);

    const revokedGrant = await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
      liveSession: {
        enabled: true,
        workspacePath: ".",
        grantedCapabilities: ["filesystem", "shell"],
      },
    });
    assert.equal(revokedGrant.settings.opencode.liveSession.enabled, false);
    assert.equal(revokedGrant.stopRequired, true);

    const reenabled = await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
      liveSession: {
        enabled: true,
        workspacePath: ".",
        grantedCapabilities: REQUIRED_LIVE_GRANTS,
      },
    });
    assert.equal(reenabled.settings.opencode.liveSession.enabled, true);

    const revokedWorkspace = await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
      liveSession: {
        enabled: true,
        workspacePath: "",
        grantedCapabilities: REQUIRED_LIVE_GRANTS,
      },
    });
    assert.equal(revokedWorkspace.settings.opencode.liveSession.enabled, false);
    assert.equal(revokedWorkspace.stopRequired, true);
    assert.equal(revokedWorkspace.settings.opencode.liveSession.workspacePath, "");

    await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
      liveSession: {
        enabled: true,
        workspacePath: ".",
        grantedCapabilities: REQUIRED_LIVE_GRANTS,
      },
    });

    const legacyToggle = await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: false,
    });
    assert.deepEqual(legacyToggle.settings.opencode.liveSession, {
      enabled: false,
      workspacePath: ".",
      grantedCapabilities: REQUIRED_LIVE_GRANTS,
    });

    await writeSettings(root, readySettings({ liveSession: { workspacePath: "missing-workspace" } }));
    const revokedInvalidWorkspace = await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: false,
    });
    assert.deepEqual(revokedInvalidWorkspace.settings.opencode.liveSession, {
      enabled: false,
      workspacePath: "",
      grantedCapabilities: REQUIRED_LIVE_GRANTS,
    });
  });
});

test("OpenCode live-session workspace replacement revokes the active workspace before re-enable", async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, "workspace-a"));
    await mkdir(path.join(root, "workspace-b"));
    const service = createService(root);

    await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
      liveSession: {
        enabled: true,
        workspacePath: "workspace-a",
        grantedCapabilities: REQUIRED_LIVE_GRANTS,
      },
    });

    const replaced = await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
      liveSession: {
        enabled: true,
        workspacePath: "workspace-b",
        grantedCapabilities: REQUIRED_LIVE_GRANTS,
      },
    });

    assert.equal(replaced.settings.opencode.liveSession.enabled, false);
    assert.equal(replaced.settings.opencode.liveSession.workspacePath, "workspace-b");
    assert.equal(replaced.stopRequired, true);

    const reenabled = await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
      liveSession: {
        enabled: true,
        workspacePath: "workspace-b",
        grantedCapabilities: REQUIRED_LIVE_GRANTS,
      },
    });
    assert.equal(reenabled.settings.opencode.liveSession.enabled, true);
    assert.equal(reenabled.stopRequired, false);
  });
});

test("OpenCode host capability disclosure exactly matches the bundled manifest", async () => {
  await withTempRoot(async (root) => {
    const manifest = JSON.parse(await readFile(
      new URL("../../public/addons/opencode.json", import.meta.url),
      "utf8",
    ));
    const service = createService(root);
    const status = await service.executeAddonsStatus();
    const openCode = status.addons.find((addon) => addon.id === "addon.opencode");
    const declared = manifest.requestedCapabilities.map(({ capability }) => capability);

    assert.deepEqual(openCode.requestedCapabilities, declared);
    assert.deepEqual(openCode.grantedCapabilities, []);
    assert.deepEqual(openCode.deniedCapabilities, declared);
  });
});

test("OpenCode live-session preflight cannot be enabled by request or environment overrides", async () => {
  await withEnv({
    RESONANTOS_OPENCODE_EXECUTION: "enabled",
    RESONANTOS_OPENCODE_MODEL: undefined,
    MINIMAX_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  }, async () => {
    await withTempRoot(async (root) => {
      const service = createService(root, {
        opencodeRuntimeDiagnostics: availableRuntime,
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
      });

      await assert.rejects(
        service.executeOpenCodeLiveSessionPreflight({ enableOpenCodeExecution: true }),
        (error) => {
          assert.match(error.message, /local CLI execution is disabled/i);
          assert.equal(error.stopRequired, false);
          return true;
        },
      );
    });
  });
});

test("OpenCode live-session preflight fails closed for every persisted gate", async () => {
  await withEnv({
    RESONANTOS_OPENCODE_EXECUTION: undefined,
    RESONANTOS_OPENCODE_MODEL: undefined,
    MINIMAX_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
  }, async () => {
    await withTempRoot(async (root) => {
      const configuredService = (overrides = {}) => createService(root, {
        opencodeRuntimeDiagnostics: availableRuntime,
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
        ...overrides,
      });

      const cases = [
        [readySettings({ liveSession: { enabled: false } }), /live session is disabled/i],
        [readySettings({ liveSession: { workspacePath: "" } }), /workspace is required/i],
        [readySettings({ liveSession: { grantedCapabilities: ["shell", "providers"] } }), /filesystem.*required/i],
        [readySettings({ liveSession: { grantedCapabilities: ["filesystem", "providers"] } }), /shell.*required/i],
        [readySettings({ liveSession: { grantedCapabilities: ["filesystem", "shell"] } }), /providers.*required/i],
        [readySettings({ liveSession: { workspacePath: ".." } }), /outside the ResonantOS repository/i],
      ];

      for (const [settings, expected] of cases) {
        await writeSettings(root, settings);
        await assert.rejects(configuredService().executeOpenCodeLiveSessionPreflight(), expected);
      }

      await writeSettings(root, readySettings());
      await assert.rejects(
        createService(root, {
          readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
        }).executeOpenCodeLiveSessionPreflight(),
        /runtime is unavailable/i,
      );

      await assert.rejects(
        createService(root, {
          opencodeRuntimeDiagnostics: availableRuntime,
          readProviderSecrets: async () => ({}),
        }).executeOpenCodeLiveSessionPreflight(),
        /provider credential is unavailable/i,
      );
    });
  });
});

test("OpenCode live-session preflight canonicalizes workspace scope and rejects symlink escapes", async () => {
  await withTempRoot(async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "ros-opencode-outside-"));
    try {
      const link = path.join(root, "linked-outside");
      await import("node:fs/promises").then(({ symlink }) => symlink(outside, link));
      await writeSettings(root, readySettings({ liveSession: { workspacePath: "linked-outside" } }));
      const service = createService(root, {
        opencodeRuntimeDiagnostics: availableRuntime,
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
      });

      await assert.rejects(
        service.executeOpenCodeLiveSessionPreflight(),
        /outside the ResonantOS repository/i,
      );

      const fileWorkspace = path.join(root, "not-a-directory.txt");
      await writeFile(fileWorkspace, "not a workspace\n");
      await writeSettings(root, readySettings({ liveSession: { workspacePath: "not-a-directory.txt" } }));
      await assert.rejects(
        service.executeOpenCodeLiveSessionPreflight(),
        /workspace.*directory/i,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("OpenCode live-session preflight returns scoped internals while public status stays redacted", async () => {
  await withEnv({
    RESONANTOS_OPENCODE_MODEL: undefined,
    RESONANTOS_BROWSER_FIRST_TOKEN: "must-not-reach-opencode",
    OPENCODE_SERVER_USERNAME: "inherited-user",
    OPENCODE_SERVER_PASSWORD: "inherited-password",
    OPENAI_API_KEY: "unselected-provider-credential",
    MINIMAX_API_KEY: undefined,
  }, async () => {
    await withTempRoot(async (root) => {
      const workspace = path.join(root, "packages", "governed-workspace");
      await mkdir(workspace, { recursive: true });
      const service = createService(root, {
        opencodeRuntimeDiagnostics: availableRuntime,
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
      });
      await service.executeAddonExecutionSettingsUpdate({
        addon: "opencode",
        localCliExecution: true,
        liveSession: {
          enabled: true,
          workspacePath: workspace,
          grantedCapabilities: ["providers", "shell", "filesystem"],
        },
      });

      const preflight = await service.executeOpenCodeLiveSessionPreflight();

      assert.equal(preflight.command, "/usr/local/bin/opencode");
      assert.equal(preflight.workspacePath, await realpath(workspace));
      assert.equal(preflight.workspaceLabel, "packages/governed-workspace");
      assert.equal(preflight.model, "minimax/MiniMax-M3");
      assert.equal(preflight.provider, "minimax");
      assert.equal(preflight.childEnvironment.MINIMAX_API_KEY, "session-minimax-credential");
      assert.equal(preflight.childEnvironment.OPENAI_API_KEY, undefined);
      assert.equal(preflight.childEnvironment.OPENCODE_SERVER_USERNAME, undefined);
      assert.equal(preflight.childEnvironment.OPENCODE_SERVER_PASSWORD, undefined);
      assert.equal(preflight.childEnvironment.RESONANTOS_BROWSER_FIRST_TOKEN, undefined);
      assert.equal(preflight.childEnvironment.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
      assert.equal(
        preflight.childEnvironment.OPENCODE_PERMISSION,
        JSON.stringify({ "*": "ask", external_directory: "deny" }),
      );

      const status = await service.executeOpenCodeStatus();
      assert.deepEqual(status.requiredGrants, REQUIRED_LIVE_GRANTS);
      assert.equal(status.liveSession.ready, true);
      assert.equal(status.liveSession.workspacePath, "packages/governed-workspace");
      assert.deepEqual(status.liveSession.readinessReasons, []);
      assert.doesNotMatch(JSON.stringify(status), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      await service.executeAddonExecutionSettingsUpdate({
        addon: "opencode",
        localCliExecution: true,
        liveSession: {
          enabled: false,
          workspacePath: "packages/governed-workspace",
          grantedCapabilities: REQUIRED_LIVE_GRANTS,
        },
      });
      await assert.rejects(
        service.executeOpenCodeLiveSessionPreflight({ activeSession: true }),
        (error) => {
          assert.equal(error.stopRequired, true);
          assert.match(error.message, /live session is disabled/i);
          return true;
        },
      );
    });
  });
});

test("OpenCode live-session preflight forwards exactly one selected-provider credential", async () => {
  await withEnv({
    RESONANTOS_OPENCODE_MODEL: "google/gemini-2.5-pro",
    GOOGLE_GENERATIVE_AI_API_KEY: "unselected-google-env-credential",
    GEMINI_API_KEY: "alternate-google-env-credential",
    GOOGLE_API_KEY: "second-alternate-google-env-credential",
    OPENAI_API_KEY: "unselected-openai-credential",
  }, async () => {
    await withTempRoot(async (root) => {
      await writeSettings(root, readySettings());
      const service = createService(root, {
        opencodeRuntimeDiagnostics: availableRuntime,
        readProviderSecrets: async () => ({
          "google-personal": "unselected-personal-credential",
          "google-work": "selected-google-credential",
        }),
        resolveOpenCodeProviderRoute: async () => ({
          providerId: "google-work",
          providerType: "google",
          apiBaseUrl: "https://google-work.example/v1",
          wireModel: "gemini-2.5-pro",
        }),
      });

      const preflight = await service.executeOpenCodeLiveSessionPreflight();

      assert.equal(preflight.provider, "google");
      assert.equal(preflight.childEnvironment.GOOGLE_GENERATIVE_AI_API_KEY, "selected-google-credential");
      assert.equal(preflight.childEnvironment.GEMINI_API_KEY, undefined);
      assert.equal(preflight.childEnvironment.GOOGLE_API_KEY, undefined);
      assert.equal(preflight.childEnvironment.OPENAI_API_KEY, undefined);
      assert.equal(preflight.childEnvironment.GOOGLE_GENERATIVE_AI_BASE_URL, "https://google-work.example/v1");
      assert.equal(preflight.providerProfileId, "google-work");

      const ambiguousOnly = createService(root, {
        opencodeRuntimeDiagnostics: availableRuntime,
        readProviderSecrets: async () => ({ "google-personal": "wrong-profile-credential" }),
        resolveOpenCodeProviderRoute: async () => ({
          providerId: "google-work",
          providerType: "google",
          apiBaseUrl: "https://google-work.example/v1",
          wireModel: "gemini-2.5-pro",
        }),
      });
      await assert.rejects(
        ambiguousOnly.executeOpenCodeLiveSessionPreflight(),
        /selected provider credential is unavailable/i,
      );
    });
  });
});
