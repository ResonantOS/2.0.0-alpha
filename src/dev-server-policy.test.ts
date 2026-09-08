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
