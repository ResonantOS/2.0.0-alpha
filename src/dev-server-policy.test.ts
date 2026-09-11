import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_SERVER_FS_DENY } from "./dev-server-policy";

describe("dev server filesystem policy", () => {
  it("denies generated bridge credentials and local user data", () => {
    expect(DEV_SERVER_FS_DENY).toEqual(expect.arrayContaining([
      "**/bridge-config.generated.js",
      "**/ResonantOS_User/**",
    ]));
  });

  it("preserves all four Vite default deny patterns", () => {
    expect(DEV_SERVER_FS_DENY).toEqual(expect.arrayContaining([
      ".env",
      ".env.*",
      "*.{crt,pem}",
      "**/.git/**",
    ]));
  });

  it("wires the deny list into a strict Vite server fs block", () => {
    const source = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
    const fsBlock = source.match(/\bserver\s*:\s*\{\s*[^{}]*\bfs\s*:\s*\{([^{}]*)\}/)?.[1];

    expect(fsBlock).toBeDefined();
    expect(fsBlock).toMatch(/\bdeny\s*:\s*DEV_SERVER_FS_DENY\b/);
    expect(fsBlock).toMatch(/\bstrict\s*:\s*true\b/);
  });
});

// P1–P8: use the resolved Vite policy, without starting a listener.
import { resolveConfig } from "vite";
import { assertDevServerPolicy, EXPECTED_DEV_SERVER_FS_DENY, type DevServerPolicyInput } from "../scripts/vite-dev-bridge-config.mjs";

const sensitiveIgnores = ["**/bridge-config.generated.js", "**/ResonantOS_User/**"];
const policy = (): DevServerPolicyInput => ({
  additionalAllowedHosts: [],
  server: { host: "127.0.0.1", port: 1430, strictPort: true,
    allowedHosts: ["127.0.0.1"], fs: { strict: true, deny: [...DEV_SERVER_FS_DENY] },
    cors: false, watch: { ignored: [...sensitiveIgnores] } },
});
const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
};

describe.sequential("authenticated development policy", () => {
  it("resolved Vite config wires the delivery plugin and strict policy", async () => {
    const config = await resolveConfig({ configFile: "vite.config.ts" }, "serve");
    expect(config.plugins.some(p => p.name === "resonantos-dev-bridge-config")).toBe(true);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.allowedHosts).toEqual(["127.0.0.1"]);
    expect(config.server.fs.strict).toBe(true);
    expect(config.server.fs.deny).toEqual(DEV_SERVER_FS_DENY);
    expect(config.server.cors).toBe(false);
    expect(config.server.watch?.ignored).toEqual(expect.arrayContaining(sensitiveIgnores));
    expect(() => assertDevServerPolicy(config, 1430)).not.toThrow();
  });
  it("startup rejects noncanonical hosts", () => {
    for (const host of [undefined, true, "0.0.0.0", "localhost", "::1", "127.0.0.2"]) {
      const config = policy(); config.server.host = host;
      expect(() => assertDevServerPolicy(config, 1430)).toThrow();
    }
  });
  it("startup rejects missing or broadened allowedHosts", () => {
    for (const allowedHosts of [undefined, [], true, ["*"], [".test"], ["127.0.0.1", "attacker.test"]]) {
      const config = policy(); config.server.allowedHosts = allowedHosts;
      expect(() => assertDevServerPolicy(config, 1430)).toThrow();
    }
  });
  it("startup rejects every missing deny entry and nonstrict fs", () => {
    for (const entry of DEV_SERVER_FS_DENY) {
      const config = policy(); config.server.fs = { strict: true, deny: DEV_SERVER_FS_DENY.filter(x => x !== entry) };
      expect(() => assertDevServerPolicy(config, 1430)).toThrow();
    }
    for (const strict of [false, undefined]) {
      const config = policy(); config.server.fs = { strict, deny: [...DEV_SERVER_FS_DENY] };
      expect(() => assertDevServerPolicy(config, 1430)).toThrow();
    }
  });
  it("startup rejects port CORS and watcher weakening", () => {
    for (const patch of [{ port: undefined }, { port: 0 }, { port: 1431 }, { port: 1.5 }, { port: 65536 },
      { strictPort: false }, { strictPort: undefined }, { cors: true }, { cors: undefined },
      ...sensitiveIgnores.map(entry => ({ watch: { ignored: sensitiveIgnores.filter(x => x !== entry) } }))]) {
      const config = policy(); Object.assign(config.server, patch);
      expect(() => assertDevServerPolicy(config, 1430)).toThrow();
    }
    for (const port of [0, -1, 65536, 1.5, NaN]) expect(() => assertDevServerPolicy(policy(), port)).toThrow();
  });
  it("startup checks effective environment host additions", async () => {
    const name = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";
    const previous = process.env[name], enabled = process.env.RESONANTOS_DEV_BRIDGE_CONFIG;
    try {
      process.env[name] = "attacker.test"; delete process.env.RESONANTOS_DEV_BRIDGE_CONFIG;
      const config = await resolveConfig({ configFile: "vite.config.ts" }, "serve");
      expect(() => assertDevServerPolicy(config, 1430)).toThrow();
    } finally { restoreEnv(name, previous); restoreEnv("RESONANTOS_DEV_BRIDGE_CONFIG", enabled); }
  });
  it("startup rejects implicit origins and HMR host overrides", async () => {
    const config = await resolveConfig({ configFile: "vite.config.ts" }, "serve");
    expect(() => assertDevServerPolicy(config, 1430)).not.toThrow();
    for (const additionalAllowedHosts of [undefined, true, "127.0.0.1", ["attacker.test"]]) {
      expect(() => assertDevServerPolicy({ ...policy(), additionalAllowedHosts }, 1430)).toThrow();
    }
    for (const additionalAllowedHosts of [[], ["127.0.0.1"], ["127.0.0.1", "127.0.0.1"]]) {
      expect(() => assertDevServerPolicy({ ...policy(), additionalAllowedHosts }, 1430)).not.toThrow();
    }
    for (const patch of [{ origin: "http://attacker.test" }, { hmr: { host: "attacker.test" } }]) {
      const unsafe = policy(); Object.assign(unsafe.server, patch);
      expect(() => assertDevServerPolicy(unsafe, 1430)).toThrow();
    }
  });
  it("plugin deny expectations match the canonical deny set", () => {
    expect(EXPECTED_DEV_SERVER_FS_DENY).toEqual(DEV_SERVER_FS_DENY);
    expect(Object.isFrozen(EXPECTED_DEV_SERVER_FS_DENY)).toBe(true);
  });
});
