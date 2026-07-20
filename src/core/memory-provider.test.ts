import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddOnManifest, ResonantShellState } from "./contracts";
import { buildDefaultState } from "./defaults";
import { resolveMemoryProviderBroker } from "./memory-provider";

const memoryManifest = (id: string, name: string): AddOnManifest => ({
  id,
  name,
  version: "0.1.0",
  author: "Test",
  category: "memory",
  sdkVersion: "0.1.0",
  description: "Test memory provider",
  runtimeType: "local-service",
  surfaces: [],
  requestedCapabilities: [
    { capability: "memory-provider", granted: false, scope: "system", revocationBehavior: "hard-stop" },
  ],
  providerRequirements: {
    sharedProfiles: [],
    supportsPrivateCredentials: false,
  },
  systemSlots: [
    {
      id: "memory-system",
      role: "default-provider",
      replaceable: true,
      recommended: true,
    },
  ],
  archiveIntegration: {
    readScopes: [],
    intakeWriteScopes: [],
    canRequestIngest: false,
    canWriteKnowledgePages: false,
  },
  health: {
    strategy: "host-command-ready",
  },
  installHooks: {},
  compatibility: {
    shellVersion: "^0.1.0",
    platforms: ["macOS", "linux", "windows"],
  },
});

const httpMemoryManifest = (): AddOnManifest => ({
  ...memoryManifest("addon.reference-memory", "Reference Memory"),
  requestedCapabilities: [
    { capability: "memory-provider", granted: false, scope: "system", revocationBehavior: "hard-stop" },
    { capability: "network", granted: false, scope: "self", revocationBehavior: "hard-stop" },
  ],
  service: {
    protocol: "http-json",
    entrypoint: "http://127.0.0.1:4888",
    healthCommand: "memory.status",
  },
});

const enableMemoryProvider = (state: ResonantShellState, manifest: AddOnManifest): ResonantShellState => ({
  ...state,
  installations: {
    ...state.installations,
    [manifest.id]: {
      ...state.installations[manifest.id],
      installed: true,
      enabled: true,
      status: "enabled",
      grantedCapabilities: state.installations[manifest.id].grantedCapabilities.map((grant) =>
        grant.capability === "memory-provider" ? { ...grant, granted: true } : grant,
      ),
    },
  },
});

describe("memory provider broker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Living Archive for legacy manifest sets without memory slots", () => {
    const state = buildDefaultState([]);

    expect(resolveMemoryProviderBroker(state, []).kind).toBe("living-archive");
  });

  it("resolves enabled Living Archive as the concrete broker", () => {
    const manifest = memoryManifest("addon.living-archive", "Living Archive");
    const state = enableMemoryProvider(buildDefaultState([manifest]), manifest);

    const broker = resolveMemoryProviderBroker(state, [manifest]);

    expect(broker.providerId).toBe("addon.living-archive");
    expect(broker.kind).toBe("living-archive");
    expect(broker.supports.search).toBe(true);
  });

  it("does not route replacement memory providers through Living Archive commands", async () => {
    const manifest = memoryManifest("addon.alt-memory", "Alternative Memory");
    const state = enableMemoryProvider(buildDefaultState([manifest]), manifest);

    const broker = resolveMemoryProviderBroker(state, [manifest]);

    expect(broker.providerId).toBe("addon.alt-memory");
    expect(broker.kind).toBe("unsupported");
    await expect(broker.search("test")).rejects.toThrow("Alternative Memory does not expose the search");
  });

  it("routes http-json memory providers through their declared local service endpoint", async () => {
    const manifest = httpMemoryManifest();
    const state = enableMemoryProvider(buildDefaultState([manifest]), manifest);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        query: "augmentor",
        pages: [],
        sources: [],
      }),
    } as Response);

    const broker = resolveMemoryProviderBroker(state, [manifest]);
    const result = await broker.search("augmentor", 3);

    expect(broker.kind).toBe("http-json");
    expect(result.query).toBe("augmentor");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4888/memory/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "augmentor", limit: 3 }),
      }),
    );
  });

  it("uses the installation memoryServiceUrl override for sideloaded memory providers", async () => {
    const manifest = httpMemoryManifest();
    const state = enableMemoryProvider(buildDefaultState([manifest]), manifest);
    state.installations[manifest.id].config = {
      memoryServiceUrl: "http://127.0.0.1:4999/",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        path: "reference://note",
        title: "Reference Note",
        docType: "note",
        frontmatter: {},
        content: "Reference memory content.",
      }),
    } as Response);

    const broker = resolveMemoryProviderBroker(state, [manifest]);
    const result = await broker.read("reference://note");

    expect(result.title).toBe("Reference Note");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4999/memory/read",
      expect.objectContaining({
        body: JSON.stringify({ path: "reference://note" }),
      }),
    );
  });

  it("forwards the configured bearer token on write operations", async () => {
    const manifest = httpMemoryManifest();
    const state = enableMemoryProvider(buildDefaultState([manifest]), manifest);
    state.installations[manifest.id].config = {
      memoryServiceToken: "secret-token",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ artifactPath: "INTAKE/mcp/default/note.md", metadataPath: "" }),
    } as Response);

    const broker = resolveMemoryProviderBroker(state, [manifest]);
    await broker.intakeWrite({
      actorId: "tester",
      bucket: "default",
      fileName: "note.md",
      content: "hello",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
  });

  it("falls back to RESONANTOS_MEMORY_SERVICE_TOKEN for writes when config omits a token", async () => {
    const previous = process.env.RESONANTOS_MEMORY_SERVICE_TOKEN;
    process.env.RESONANTOS_MEMORY_SERVICE_TOKEN = "env-token";
    try {
      const manifest = httpMemoryManifest();
      const state = enableMemoryProvider(buildDefaultState([manifest]), manifest);
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ requestFile: "INTAKE/review-queue/1.json", queuedAt: "" }),
      } as Response);

      const broker = resolveMemoryProviderBroker(state, [manifest]);
      await broker.ingestRequest({
        actorId: "tester",
        sourcePath: "EXTERNAL_KNOWLEDGE/doc.md",
        sourceType: "markdown",
        intent: "ingest",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer env-token");
    } finally {
      if (previous === undefined) {
        delete process.env.RESONANTOS_MEMORY_SERVICE_TOKEN;
      } else {
        process.env.RESONANTOS_MEMORY_SERVICE_TOKEN = previous;
      }
    }
  });

  it("does not send an Authorization header on read operations", async () => {
    const previous = process.env.RESONANTOS_MEMORY_SERVICE_TOKEN;
    process.env.RESONANTOS_MEMORY_SERVICE_TOKEN = "env-token";
    try {
      const manifest = httpMemoryManifest();
      const state = enableMemoryProvider(buildDefaultState([manifest]), manifest);
      state.installations[manifest.id].config = { memoryServiceToken: "secret-token" };
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ query: "augmentor", pages: [], sources: [] }),
      } as Response);

      const broker = resolveMemoryProviderBroker(state, [manifest]);
      await broker.search("augmentor", 3);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.RESONANTOS_MEMORY_SERVICE_TOKEN;
      } else {
        process.env.RESONANTOS_MEMORY_SERVICE_TOKEN = previous;
      }
    }
  });
});
