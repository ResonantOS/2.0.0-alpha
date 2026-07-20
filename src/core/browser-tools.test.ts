import { describe, expect, it, vi } from "vitest";
import type { AddOnInstallation, AddOnManifest, BrowserHostReadPageResult, BrowserToolCommand } from "./contracts";
import type { BrowserToolResult } from "./browser-tools";
import { browserToolApprovalMessages, createBrowserToolRunner } from "./browser-tools";

const browserManifest = (): AddOnManifest => ({
  id: "addon.browser",
  name: "Resonant Browser",
  version: "0.1.0",
  author: "Resonant Alpha",
  category: "tool",
  description: "Controlled browser add-on.",
  runtimeType: "local-service",
  surfaces: [{ id: "browser", type: "embedded-pane", label: "Browser", description: "Browser" }],
  requestedCapabilities: [
    { capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
    { capability: "browser-control", granted: false, scope: "system", revocationBehavior: "hard-stop" },
    { capability: "filesystem", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
  ],
  providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
  archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
  health: { strategy: "browser-engine-ready" },
  service: {
    protocol: "host-command",
    entrypoint: "browser-first/host/run-bridge-minimal.mjs",
    healthCommand: "browser.health",
    shutdownCommand: "browser.close",
  },
  tools: [
    {
      name: "browser.open_url",
      description: "Open URL.",
      requiredCapabilities: ["network", "browser-control"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      audit: { logRequest: true, logResult: true, artifactTypes: ["log"] },
    },
    {
      name: "browser.read_page",
      description: "Read page.",
      requiredCapabilities: ["browser-control"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      audit: { logRequest: true, logResult: true, artifactTypes: ["log", "citation-bundle"] },
    },
    {
      name: "browser.type",
      description: "Type.",
      requiredCapabilities: ["browser-control"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      audit: { logRequest: true, logResult: true, artifactTypes: ["log"] },
    },
    {
      name: "browser.extensions.load_unpacked",
      description: "Load extension.",
      requiredCapabilities: ["filesystem", "browser-control"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      audit: { logRequest: true, logResult: true, artifactTypes: ["log"] },
      requiresHumanApproval: true,
    },
    {
      name: "browser.extensions.disable",
      description: "Disable extension.",
      requiredCapabilities: ["browser-control"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      audit: { logRequest: true, logResult: true, artifactTypes: ["log"] },
    },
  ],
  installHooks: {},
  compatibility: { shellVersion: "^0.1.0", platforms: ["macOS", "windows", "linux"] },
});

const installation = (granted = true): AddOnInstallation => ({
  addonId: "addon.browser",
  provenanceTier: "curated-signed",
  verificationState: "verified",
  installed: true,
  enabled: true,
  status: "enabled",
  source: "bundled",
  grantedCapabilities: [
    { capability: "network", granted, scope: "shared", revocationBehavior: "hard-stop" },
    { capability: "browser-control", granted, scope: "system", revocationBehavior: "hard-stop" },
    { capability: "filesystem", granted, scope: "shared", revocationBehavior: "hard-stop" },
  ],
  recommendedGrantPresetIds: [],
  privateProviderProfileIds: [],
  notes: [],
});

describe("Browser tool runner", () => {
  it("routes approved Browser commands through the governed transport", async () => {
    const result: BrowserHostReadPageResult = {
      sessionId: "browser-1",
      finalUrl: "https://resonantos.com/",
      title: "ResonantOS",
      text: "Sovereign AI workspace.",
      links: [],
      audit: [],
    };
    const call = vi.fn(async (): Promise<BrowserToolResult> => result);
    const runner = createBrowserToolRunner({
      manifest: browserManifest(),
      installation: installation(),
      transport: { call },
    });

    await expect(runner.run({ type: "read_page", params: { sessionId: "browser-1" } })).resolves.toEqual(result);
    expect(call).toHaveBeenCalledWith("browser.read_page", { sessionId: "browser-1" }, { humanApproved: undefined });
  });

  it("blocks Browser commands when required grants are missing", async () => {
    const call = vi.fn();
    const runner = createBrowserToolRunner({
      manifest: browserManifest(),
      installation: installation(false),
      transport: { call },
    });

    await expect(runner.run({ type: "open_url", params: { url: "https://resonantos.com" } })).rejects.toThrow(
      "network, browser-control",
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("requires explicit approval before sensitive typing", async () => {
    const command: BrowserToolCommand = {
      type: "type",
      params: { selector: "#password", text: "secret", sensitive: true },
    };
    const call = vi.fn();
    const runner = createBrowserToolRunner({
      manifest: browserManifest(),
      installation: installation(),
      transport: { call },
    });

    await expect(runner.run(command)).rejects.toThrow(browserToolApprovalMessages.privilegedTyping);
    expect(call).not.toHaveBeenCalled();

    await runner.run({ ...command, humanApproved: true });
    expect(call).toHaveBeenCalledWith("browser.type", command.params, { humanApproved: true });
  });

  it("refuses Browser AI control when the manifest is not the local-service host contract", async () => {
    const manifest = { ...browserManifest(), runtimeType: "embedded-module" as const };
    const runner = createBrowserToolRunner({
      manifest,
      installation: installation(),
      transport: { call: vi.fn() },
    });

    await expect(runner.run({ type: "read_page" })).rejects.toThrow("local-service add-on");
  });
});
