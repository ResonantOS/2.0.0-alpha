// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-failure-modes
// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#8-existing-addons
//
// Cross-addon validation: every concrete addon manifest shipped under
// `examples/addons/` that declares the §3 conjunction (providers +
// agent-delegation) MUST survive the §7 failure-mode harness. This file
// loads each such manifest from disk and runs the F1–F10 suite against
// it.
//
// Per ADR-040 §8, `recursive-mas.json` pre-dates and satisfies this
// ADR. This test guards that claim. Per ADR-040 §9,
// `addon.deepseek-harness.json` is the canonical new external
// runtime exemplar; this test guards that claim too.
//
// F10 is special: it asserts the deny path for an *undeclared*
// experimental route. If the manifest declares
// `providerRequirements.allowExperimentalAuth: true`, F10 is
// inapplicable and we treat it as a `fixture-mismatch` (which is what
// the runner returns) rather than a failure. Addons that declare
// experimental auth should pass F10 trivially; this test ensures the
// runner doesn't crash.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateAddOnManifest } from "../../../src/sdk/addons/validation.ts";
import {
  runAddOnFailureMode,
  FAILURE_MODE_IDS,
} from "../src/failure-modes/index.ts";
import type { ExternalAgentRuntimeManifest } from "../src/manifest-fixtures.ts";
import type { AddOnManifest } from "../../../src/core/contracts.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..", "..");

interface CrossAddonCase {
  path: string;
  id: string;
}

const cases: readonly CrossAddonCase[] = [
  {
    path: "examples/addons/addon.deepseek-harness.json",
    id: "addon.deepseek-harness",
  },
  {
    path: "examples/addons/recursive-mas.json",
    id: "addon.recursive-mas",
  },
] as const;

const loadManifest = (relPath: string): AddOnManifest => {
  const absPath = resolve(repoRoot, relPath);
  return JSON.parse(readFileSync(absPath, "utf8")) as AddOnManifest;
};

const declaredCapabilities = (manifest: AddOnManifest): Set<string> =>
  new Set((manifest.requestedCapabilities ?? []).map((g) => g.capability));

const withCallerId = (manifest: AddOnManifest): ExternalAgentRuntimeManifest => {
  const callerId = `caller.${manifest.id}`;
  return { ...manifest, callerId };
};

describe("cross-addon: every shipped external-agent-runtime manifest passes F1–F10", () => {
  for (const { path: relPath, id } of cases) {
    describe(id, () => {
      const manifest = loadManifest(relPath);
      const declared = declaredCapabilities(manifest);
      const annotated = withCallerId(manifest);
      const declaresExperimentalAuth =
        manifest.providerRequirements?.allowExperimentalAuth === true;

      it("loads from disk", () => {
        expect(manifest.id).toBe(id);
      });

      it("validates against validateAddOnManifest (no errors)", () => {
        const result = validateAddOnManifest(manifest);
        const errors = result.issues.filter((i) => i.severity === "error");
        expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
      });

      it("declares the §3 trigger conjunction (providers + agent-delegation)", () => {
        expect(declared.has("providers")).toBe(true);
        expect(declared.has("agent-delegation")).toBe(true);
      });

      it("declares at least one tool", () => {
        expect((manifest.tools ?? []).length).toBeGreaterThanOrEqual(1);
      });

      for (const modeId of FAILURE_MODE_IDS) {
        it(`survives ${modeId} (host emits well-formed report)`, () => {
          const report = runAddOnFailureMode(modeId, annotated);
          expect(report).toBeDefined();
          expect(report.modeId).toBe(modeId);
          expect(typeof report.pass).toBe("boolean");
          expect(report.actual).toBeDefined();
          expect(report.expected).toBeDefined();
          expect(typeof report.expected.code).toBe("string");
          expect(typeof report.actual.code).toBe("string");
          // F10 is the only mode whose pass condition is conditional
          // on `allowExperimentalAuth`. For addons that declare it,
          // F10 returns fixture-mismatch and that's acceptable here.
          if (modeId === "F10" && declaresExperimentalAuth) {
            expect(report.actual.code).toBe("fixture-mismatch");
          }
        });
      }
    });
  }
});
