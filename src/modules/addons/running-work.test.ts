import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAddonWorkRegistry, withAddonWork } from "./running-work";

const matchingCloseParen = (source: string, callIndex: number): number => {
  const openIndex = source.indexOf("(", callIndex);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
};

const occurrenceIndexes = (source: string, needle: string): number[] => {
  const indexes: number[] = [];
  let index = source.indexOf(needle);
  while (index !== -1) {
    indexes.push(index);
    index = source.indexOf(needle, index + needle.length);
  }
  return indexes;
};

describe("createAddonWorkRegistry", () => {
  it("counts independent work per add-on", () => {
    const registry = createAddonWorkRegistry();
    const endA1 = registry.begin("addon.a");
    const endA2 = registry.begin("addon.a");
    const endB = registry.begin("addon.b");

    expect(registry.inFlight("addon.a")).toBe(2);
    expect(registry.inFlight("addon.b")).toBe(1);

    endA1();
    expect(registry.inFlight("addon.a")).toBe(1);
    expect(registry.inFlight("addon.b")).toBe(1);

    endA2();
    endB();
    expect(registry.inFlight("addon.a")).toBe(0);
    expect(registry.inFlight("addon.b")).toBe(0);
  });

  it("reports running work until the matching end function is called", async () => {
    const registry = createAddonWorkRegistry();
    const end = registry.begin("addon.a");

    await expect(registry.stopRunningWork({ addonId: "addon.a" })).resolves.toEqual({
      stopped: false,
      detail: "Work for this add-on is still running in the desktop shell. Wait for it to finish, then uninstall.",
    });

    end();
    await expect(registry.stopRunningWork({ addonId: "addon.a" })).resolves.toEqual({ stopped: true });
  });

  it("keeps double end calls safe", () => {
    const registry = createAddonWorkRegistry();
    const end = registry.begin("addon.a");

    end();
    end();

    expect(registry.inFlight("addon.a")).toBe(0);
  });
});

describe("withAddonWork", () => {
  it("keeps the count raised until a resolving promise settles", async () => {
    const registry = createAddonWorkRegistry();
    let settle: (value: string) => void = () => undefined;
    const promise = withAddonWork(
      registry,
      "addon.a",
      () =>
        new Promise<string>((resolvePromise) => {
          settle = resolvePromise;
        }),
    );

    expect(registry.inFlight("addon.a")).toBe(1);
    settle("ok");
    await expect(promise).resolves.toBe("ok");
    expect(registry.inFlight("addon.a")).toBe(0);
  });

  it("keeps the count raised until a rejecting promise settles and rethrows", async () => {
    const registry = createAddonWorkRegistry();
    let reject: (error: Error) => void = () => undefined;
    const promise = withAddonWork(
      registry,
      "addon.a",
      () =>
        new Promise<string>((_, rejectPromise) => {
          reject = rejectPromise;
        }),
    );

    expect(registry.inFlight("addon.a")).toBe(1);
    reject(new Error("boom"));
    await expect(promise).rejects.toThrow("boom");
    expect(registry.inFlight("addon.a")).toBe(0);
  });
});

describe("add-on work source contract", () => {
  it("keeps every wrapped add-on starter inside withAddonWork", () => {
    const files = [
      "src/App.tsx",
      "src/modules/addons/AddOnsWorkspace.tsx",
      "src/modules/addons/HermesAddonPanel.tsx",
    ];
    const scanned = files
      .map((file) => readFileSync(resolve(process.cwd(), file), "utf8"))
      .join("\n");
    const wrappedNames = [
      "runAddonLogicianScript(",
      "runAddonLogicianHook(",
      "requestBrowserInstallEngine(",
      "requestHermesInstall(",
    ];

    for (const name of wrappedNames) {
      const indexes = occurrenceIndexes(scanned, name);
      expect(indexes.length, `${name} occurs in scanned source`).toBeGreaterThan(0);
      for (const index of indexes) {
        const wrapperIndex = scanned.lastIndexOf("withAddonWork(", index);
        expect(wrapperIndex, `${name} has a preceding withAddonWork call`).toBeGreaterThanOrEqual(0);
        expect(index, `${name} is inside withAddonWork`).toBeLessThan(matchingCloseParen(scanned, wrapperIndex));
      }
    }
  });
});
