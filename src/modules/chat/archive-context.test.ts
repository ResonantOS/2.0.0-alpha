import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultState } from "../../core/defaults";
import { resolveMemoryProviderBroker, type MemoryProviderBroker } from "../../core/memory-provider";
import { requestArchiveSystemMemory, requestArchiveSystemMemoryRefresh } from "../../core/runtime";

import { buildSystemMemoryContextBundle, archiveCitationsFromBundle, formatArchiveContextForPrompt, type ArchiveContextBundle } from "./archive-context";

vi.mock("../../core/runtime", () => ({
  requestArchiveSystemMemory: vi.fn(),
  requestArchiveSystemMemoryRefresh: vi.fn(),
}));

describe("archive chat context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestArchiveSystemMemory).mockResolvedValue({
      status: "missing", manifestPath: "system/manifest.json", pagesRoot: "system",
      sources: [], pages: [], staleSources: [], missingSources: [],
    });
  });

  it.each(["http-json", "unsupported"] as const)("does not call Living Archive system memory for a %s broker", async kind => {
    const vacant = resolveMemoryProviderBroker(buildDefaultState([]), []);
    const broker: MemoryProviderBroker = {
      ...vacant, kind, supports: { ...vacant.supports, read: kind === "http-json" },
    };

    const bundle = await buildSystemMemoryContextBundle(broker);

    expect(requestArchiveSystemMemory).not.toHaveBeenCalled();
    expect(requestArchiveSystemMemoryRefresh).not.toHaveBeenCalled();
    expect(bundle).toBeNull();
  });

  it.each(["living-archive", "omitted"] as const)("preserves Living Archive status and refresh for a %s broker", async kind => {
    const vacant = resolveMemoryProviderBroker(buildDefaultState([]), []);
    const broker: MemoryProviderBroker = {
      ...vacant, kind: "living-archive", supports: { ...vacant.supports, read: true },
    };

    const bundle = await buildSystemMemoryContextBundle(kind === "omitted" ? undefined : broker);

    expect(requestArchiveSystemMemory).toHaveBeenCalledTimes(2);
    expect(requestArchiveSystemMemoryRefresh).toHaveBeenCalledTimes(1);
    expect(bundle?.status).toBe("missing");
  });

  it("passes raw imported source excerpts to the Strategist without treating them as promoted pages", () => {
    const bundle: ArchiveContextBundle = {
      query: "do you know what's the mixtape protocol?",
      pages: [],
      sources: [
        {
          title: "Play_047_The_Mixtape_Constraint",
          sourceType: "md",
          rawPath: "/Memory/INTAKE/imports/mixed/sources/base/02_PROTOCOL_LIBRARY/Play_047_The_Mixtape_Constraint.md",
          processed: false,
          snippet: "The Protocol of Mixtape forbids average answers by adding deliberate curation and friction.",
        },
      ],
      failures: [],
    };

    const prompt = formatArchiveContextForPrompt(bundle);
    const citations = archiveCitationsFromBundle(bundle);

    expect(prompt).toContain("raw/imported source evidence, not yet a trusted promoted wiki page");
    expect(prompt).toContain("answer directly while naming the boundary");
    expect(prompt).toContain("Protocol of Mixtape");
    expect(citations).toEqual([
      expect.objectContaining({
        title: "Play_047_The_Mixtape_Constraint",
        pageType: "raw-imported-source",
      }),
    ]);
  });
});
