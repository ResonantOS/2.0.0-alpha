// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md
// Intent citation: docs/architecture/ADR-017-resonant-browser-addon.md

import type {
  AddOnInstallation,
  AddOnManifest,
  AddOnToolDefinition,
  BrowserHostActionResult,
  BrowserHostEvidenceResult,
  BrowserHostHealthResult,
  BrowserHostOpenUrlResult,
  BrowserHostReadPageResult,
  BrowserExtensionListResult,
  BrowserToolCommand,
  Capability,
} from "./contracts";
import { isCapabilityGranted } from "./policies";

export type BrowserToolResult =
  | BrowserHostHealthResult
  | BrowserHostOpenUrlResult
  | BrowserHostReadPageResult
  | BrowserHostActionResult
  | BrowserHostEvidenceResult
  | BrowserExtensionListResult;

export type BrowserToolTransport = {
  call: (
    method: string,
    params: Record<string, unknown>,
    options?: { humanApproved?: boolean },
  ) => Promise<BrowserToolResult>;
};

type BrowserToolRunnerInput = {
  manifest: AddOnManifest | undefined;
  installation: AddOnInstallation | undefined;
  transport: BrowserToolTransport;
};

const commandToToolName: Record<BrowserToolCommand["type"], string> = {
  start: "browser.start",
  open_url: "browser.open_url",
  read_page: "browser.read_page",
  click: "browser.click",
  type: "browser.type",
  capture_evidence: "browser.capture_evidence",
  close: "browser.close_session",
  health: "browser.health",
  extensions_list: "browser.extensions.list",
  extensions_set_pinned: "browser.extensions.set_pinned",
  extensions_disable: "browser.extensions.disable",
  wallet_host_health: "browser.wallet_host.health",
  wallet_host_start: "browser.wallet_host.start",
  wallet_host_open_url: "browser.wallet_host.open_url",
  wallet_host_read_page: "browser.wallet_host.read_page",
  wallet_host_inspect_dapp_gate: "browser.wallet_host.inspect_dapp_gate",
  wallet_host_list_tabs: "browser.wallet_host.list_tabs",
};

const privilegedTypingMessage =
  "Browser typing marked sensitive requires explicit human approval before the action can run.";

function toolForCommand(manifest: AddOnManifest, command: BrowserToolCommand): AddOnToolDefinition {
  const toolName = commandToToolName[command.type];
  const tool = manifest.tools?.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Browser manifest does not expose required tool ${toolName}.`);
  }
  return tool;
}

function assertBrowserManifest(manifest: AddOnManifest | undefined): AddOnManifest {
  if (!manifest || manifest.id !== "addon.browser") {
    throw new Error("Resonant Browser manifest is not loaded.");
  }
  if (manifest.runtimeType !== "local-service") {
    throw new Error("Resonant Browser must run as a local-service add-on before AI control is allowed.");
  }
  if (manifest.service?.protocol !== "stdio-json-rpc" && manifest.service?.protocol !== "host-command") {
    throw new Error("Resonant Browser must expose a host-mediated service before AI control is allowed.");
  }
  return manifest;
}

function assertRequiredCapabilities(installation: AddOnInstallation | undefined, capabilities: Capability[]): void {
  if (!installation?.enabled) {
    throw new Error("Resonant Browser add-on is not enabled.");
  }

  const missing = capabilities.filter((capability) => !isCapabilityGranted(installation, capability));
  if (missing.length) {
    throw new Error(`Resonant Browser is missing required capability grants: ${missing.join(", ")}.`);
  }
}

function assertHumanApproval(command: BrowserToolCommand): void {
  if (command.type === "type" && command.params?.sensitive === true && !command.humanApproved) {
    throw new Error(privilegedTypingMessage);
  }
}

export function createBrowserToolRunner({ manifest, installation, transport }: BrowserToolRunnerInput) {
  return {
    async run(command: BrowserToolCommand): Promise<BrowserToolResult> {
      const browserManifest = assertBrowserManifest(manifest);
      const tool = toolForCommand(browserManifest, command);
      assertRequiredCapabilities(installation, tool.requiredCapabilities);
      assertHumanApproval(command);

      return transport.call(commandToToolName[command.type], command.params ?? {}, {
        humanApproved: command.humanApproved,
      });
    },
  };
}

export const browserToolApprovalMessages = {
  privilegedTyping: privilegedTypingMessage,
};
