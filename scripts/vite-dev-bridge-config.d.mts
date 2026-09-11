export type BridgeConfig = Readonly<{
  bridgeUrl: string;
  bridgeToken: string;
  capabilityBootstrapToken: string;
}>;
export type NonceStore = {
  issue(): string | null;
  consume(nonce: string): boolean;
  clear(): void;
};
export type ReaderDeps = {
  openFile?: typeof import("node:fs/promises").open;
  uid?: () => number;
  onNonLoopback?: () => void;
};
export type DevServerPolicyInput = {
  server: {
    host?: unknown;
    port?: unknown;
    strictPort?: unknown;
    allowedHosts?: unknown;
    fs?: { strict?: unknown; deny?: unknown };
    cors?: unknown;
    watch?: { ignored?: unknown } | null;
    origin?: unknown;
    hmr?: boolean | { host?: unknown };
  };
  additionalAllowedHosts?: unknown;
};
export type DevBridgeDeps = {
  readConfig?: (root: string, onNonLoopback: () => void) => Promise<BridgeConfig | null>;
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
  random?: () => string;
  createCspNonce?: () => string;
  expectedPort?: number;
};
export const EXPECTED_DEV_SERVER_FS_DENY: readonly string[];
export function assertDevServerPolicy(config: DevServerPolicyInput, expectedPort: number): void;
export function parseGeneratedBridgeConfig(source: string, onNonLoopback?: () => void): BridgeConfig | null;
export function readGeneratedBridgeConfig(root: string, deps?: ReaderDeps): Promise<BridgeConfig | null>;
export function createPageNonces(now?: () => number, random?: () => string): NonceStore;
export function createCspNonce(): string;
export function renderBridgeModule(config: BridgeConfig | null): string;
export function renderAuthenticatedPage(html: string, moduleNonce: string, cspNonce: string): string;
export function devBridgeConfigPlugin(deps?: DevBridgeDeps): import("vite").Plugin;
