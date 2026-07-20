// Intent citation: docs/architecture/ADR-029-living-archive-mcp-bridge.md

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createLivingArchiveBridge } from "./living-archive-mcp.mjs";
import {
  createLivingArchiveMemoryOperationEvaluator,
  createLivingArchiveMemoryService,
  isWriteMemoryOperation,
} from "./living-archive-memory-service.mjs";

const TEST_TOKEN = "test-memory-service-token";

const makeMemoryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "resonantos-memory-service-"));
  await mkdir(join(root, "HUMAN_KNOWLEDGE", "sources"), { recursive: true });
  await mkdir(join(root, "EXTERNAL_KNOWLEDGE", "research"), { recursive: true });
  await mkdir(join(root, "AI_MEMORY", "wiki"), { recursive: true });
  await writeFile(
    join(root, "HUMAN_KNOWLEDGE", "sources", "identity.md"),
    "---\nresonantos.ownership: human\n---\n# Human Identity\nPortable memory preserves original human knowledge.",
    "utf8",
  );
  await writeFile(
    join(root, "AI_MEMORY", "wiki", "system.md"),
    "# System Memory\nThe AI curated memory is promoted only through review.",
    "utf8",
  );
  return root;
};

const listen = async (server) => {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
};

function skipIfSandboxLocalhostDenied(t, error) {
  if (error?.code === "EPERM" && error?.address === "127.0.0.1") {
    t.skip("localhost bind is denied in this sandbox; Living Archive live memory-service behavior must be verified outside sandboxed CI.");
    return true;
  }
  return false;
}

const postMemory = async (endpoint, operation, input = {}, token = TEST_TOKEN) => {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  // Writes require a bearer token (DD-3 F6). Reads stay unauth on loopback.
  if (token && isWriteMemoryOperation(operation)) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${endpoint}/memory/${operation}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  const payload = await response.json();
  return { response, payload };
};

async function assertCompleteMemoryServiceFlow(postOperation, root) {
  const status = await postOperation("status");
  assert.equal(status.status, 200);
  assert.equal(status.payload.status, "ready");
  assert.equal(status.payload.backend, "portable-folder");

  const search = await postOperation("search", { query: "human knowledge", limit: 4 });
  assert.equal(search.status, 200);
  assert.equal(search.payload.results[0].path, "HUMAN_KNOWLEDGE/sources/identity.md");

  const read = await postOperation("read", { path: "AI_MEMORY/wiki/system.md" });
  assert.equal(read.status, 200);
  assert.equal(read.payload.title, "System Memory");

  const intake = await postOperation("intake-write", {
    actorId: "external.agent",
    bucket: "obsidian",
    fileName: "note.md",
    content: "# External Note\nBridge this into review.",
    metadata: { source: "test" },
  });
  assert.equal(intake.status, 200);
  assert.equal(intake.payload.artifactPath, "INTAKE/mcp/obsidian/note.md");

  const ingest = await postOperation("ingest-request", {
    actorId: "external.agent",
    sourcePath: intake.payload.artifactPath,
    sourceType: "markdown",
    intent: "Prepare review artifact.",
  });
  assert.equal(ingest.status, 200);
  assert.match(ingest.payload.requestFile, /^INTAKE\/review-queue\/.+\.json$/);

  const reviewQueue = await postOperation("review-queue");
  assert.equal(reviewQueue.status, 200);
  assert.equal(reviewQueue.payload.length, 1);
  assert.equal(reviewQueue.payload[0].boundary.requiresStrategistOwnedIngest, true);

  const queued = JSON.parse(await readFile(join(root, ingest.payload.requestFile), "utf8"));
  assert.equal(queued.boundary.trustedKnowledgeWrite, false);

  const processed = await postOperation("process-ingest-request", {
    requestFile: ingest.payload.requestFile,
  });
  assert.equal(processed.status, 200);
  assert.match(processed.payload.reviewArtifactFile, /^AI_MEMORY\/provenance\/review-artifacts\/.+\.json$/);

  const reviewArtifacts = await postOperation("review-artifacts");
  assert.equal(reviewArtifacts.status, 200);
  assert.equal(reviewArtifacts.payload.length, 1);
  assert.equal(reviewArtifacts.payload[0].status, "pending");
  assert.equal(reviewArtifacts.payload[0].boundary.trustedKnowledgeWrite, false);

  const decided = await postOperation("decide-review", {
    artifactFile: processed.payload.reviewArtifactFile,
    actorId: "strategist.core",
    action: "approve",
    notes: "Approved by deterministic service test.",
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.payload.status, "approved");

  const promoted = await postOperation("promote-review-artifact", {
    artifactFile: processed.payload.reviewArtifactFile,
    actorId: "strategist.core",
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.payload.status, "promoted");
  assert.equal(promoted.payload.promotedPage, "AI_MEMORY/wiki/external-note.md");

  const promotedPage = await readFile(join(root, promoted.payload.promotedPage), "utf8");
  assert.match(promotedPage, /# External Note/);
  assert.match(promotedPage, /Source Provenance/);
  assert.equal(
    await readFile(join(root, "INTAKE", "mcp", "obsidian", "note.md"), "utf8"),
    "# External Note\nBridge this into review.",
  );

  const wikiSearch = await postOperation("search", { query: "Bridge this into review", limit: 4, domains: ["AI_MEMORY"] });
  assert.equal(wikiSearch.status, 200);
  assert.equal(wikiSearch.payload.results[0].path, "AI_MEMORY/wiki/external-note.md");
  assert.equal(wikiSearch.payload.searchMode, "index-first-wiki");

  const log = await readFile(join(root, "AI_MEMORY", "wiki", "log.md"), "utf8");
  assert.match(log, /trusted_wiki_promote/);
  const index = await readFile(join(root, "AI_MEMORY", "wiki", "index.md"), "utf8");
  assert.match(index, /\[\[external-note\|External Note\]\]/);

  const lint = await postOperation("lint");
  assert.equal(lint.status, 200);
  assert.equal(Array.isArray(lint.payload.findings), true);
}

test("Living Archive memory service operation evaluator exposes portable status, search, read, intake, review queue, and lint", async () => {
  const root = await makeMemoryRoot();
  const evaluate = createLivingArchiveMemoryOperationEvaluator({ memoryRoot: root, readonly: false });
  try {
    await assertCompleteMemoryServiceFlow(
      async (operation, input = {}) => evaluate(operation, input),
      root,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Living Archive memory service operation evaluator returns deterministic service errors", async () => {
  const root = await makeMemoryRoot();
  const evaluate = createLivingArchiveMemoryOperationEvaluator({ memoryRoot: root, readonly: false });
  try {
    const unsupported = await evaluate("direct-knowledge-write", { path: "AI_MEMORY/wiki/unsafe.md" });
    assert.equal(unsupported.status, 404);
    assert.match(unsupported.payload.error, /Unsupported Living Archive memory operation/);

    const unsafeRead = await evaluate("read", { path: "../outside.md" });
    assert.equal(unsafeRead.status, 400);
    assert.equal(unsafeRead.payload.operation, "read");
    assert.match(unsafeRead.payload.error, /escapes the configured Living Archive memory root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Living Archive memory service exposes portable status, search, read, intake, review queue, and lint over HTTP", async (t) => {
  const root = await makeMemoryRoot();
  const server = createLivingArchiveMemoryService({ memoryRoot: root, readonly: false, token: TEST_TOKEN });
  let endpoint;
  try {
    endpoint = await listen(server);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (skipIfSandboxLocalhostDenied(t, error)) return;
    throw error;
  }

  try {
    await assertCompleteMemoryServiceFlow(
      async (operation, input = {}) => {
        const result = await postMemory(endpoint, operation, input);
        return { status: result.response.status, payload: result.payload };
      },
      root,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test("Living Archive MCP bridge can use the local memory service as its live backend", async (t) => {
  const root = await makeMemoryRoot();
  const server = createLivingArchiveMemoryService({ memoryRoot: root, readonly: false, token: TEST_TOKEN });
  let endpoint;
  try {
    endpoint = await listen(server);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (skipIfSandboxLocalhostDenied(t, error)) return;
    throw error;
  }

  try {
    const bridge = createLivingArchiveBridge({
      memoryRoot: "",
      memoryServiceUrl: endpoint,
      memoryServiceToken: TEST_TOKEN,
      maxSearchBytes: 1024 * 1024,
      readonly: false,
    });

    const status = await bridge.callTool("living_archive_status");
    assert.equal(status.backend, "host-http");
    assert.equal(status.boundary.directExternalKnowledgeWrites, false);

    const search = await bridge.callTool("living_archive_search", { query: "curated", limit: 2 });
    assert.equal(search.results[0].path, "AI_MEMORY/wiki/system.md");

    const intake = await bridge.callTool("living_archive_write_intake", {
      actorId: "external.agent",
      bucket: "hermes",
      fileName: "hermes-note.md",
      content: "# Hermes Note\nHermes can queue knowledge for trusted review.",
      metadata: { source: "hermes-test" },
    });
    const ingest = await bridge.callTool("living_archive_request_ingest", {
      actorId: "external.agent",
      sourcePath: intake.artifactPath,
      sourceType: "markdown",
      intent: "Review Hermes artifact.",
    });
    const processed = await bridge.callTool("living_archive_process_ingest_request", {
      requestFile: ingest.requestFile,
    });
    await bridge.callTool("living_archive_decide_review", {
      artifactFile: processed.reviewArtifactFile,
      actorId: "strategist.core",
      action: "approve",
    });
    const promoted = await bridge.callTool("living_archive_promote_review_artifact", {
      artifactFile: processed.reviewArtifactFile,
      actorId: "strategist.core",
    });
    assert.equal(promoted.status, "promoted");
    const readBack = await bridge.callTool("living_archive_read", { path: promoted.promotedPage });
    assert.match(readBack.content, /Hermes can queue knowledge/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

// --- DD-3 (F6) hardening: token-gated writes, readonly default, CORS ---------

test("DD-3: write operations are classified and gate-able", () => {
  assert.equal(isWriteMemoryOperation("intake-write"), true);
  assert.equal(isWriteMemoryOperation("ingest-request"), true);
  assert.equal(isWriteMemoryOperation("process-ingest-request"), true);
  assert.equal(isWriteMemoryOperation("decide-review"), true);
  assert.equal(isWriteMemoryOperation("promote-review-artifact"), true);
  assert.equal(isWriteMemoryOperation("maintenance-cycle"), true);
  assert.equal(isWriteMemoryOperation("background-cycle"), true);
  // Reads must NOT be gated.
  assert.equal(isWriteMemoryOperation("status"), false);
  assert.equal(isWriteMemoryOperation("search"), false);
  assert.equal(isWriteMemoryOperation("read"), false);
  assert.equal(isWriteMemoryOperation("review-queue"), false);
  assert.equal(isWriteMemoryOperation("lint"), false);
});

test("DD-3: writes require a bearer token; reads stay unauth; CORS is not wildcard", async (t) => {
  const root = await makeMemoryRoot();
  const server = createLivingArchiveMemoryService({ memoryRoot: root, readonly: false, token: TEST_TOKEN });
  let endpoint;
  try {
    endpoint = await listen(server);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (skipIfSandboxLocalhostDenied(t, error)) return;
    throw error;
  }

  try {
    // Read on loopback without a token: allowed.
    const status = await postMemory(endpoint, "status", {}, "");
    assert.equal(status.response.status, 200);
    // CORS allow-origin must be an allowlist, never "*".
    const acao = status.response.headers.get("access-control-allow-origin");
    assert.ok(acao && acao !== "*", `CORS allow-origin must not be wildcard, got ${acao}`);

    // Write with NO token: rejected 401.
    const noToken = await postMemory(endpoint, "intake-write", {
      actorId: "external.agent",
      bucket: "obsidian",
      fileName: "note.md",
      content: "# Note",
    }, "");
    assert.equal(noToken.response.status, 401);

    // Write with WRONG token: rejected 401.
    const wrongToken = await postMemory(endpoint, "intake-write", {
      actorId: "external.agent",
      bucket: "obsidian",
      fileName: "note.md",
      content: "# Note",
    }, "not-the-token");
    assert.equal(wrongToken.response.status, 401);

    // Write with the VALID token: accepted.
    const ok = await postMemory(endpoint, "intake-write", {
      actorId: "external.agent",
      bucket: "obsidian",
      fileName: "note.md",
      content: "# Note",
    }, TEST_TOKEN);
    assert.equal(ok.response.status, 200);
    assert.equal(ok.payload.artifactPath, "INTAKE/mcp/obsidian/note.md");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test("DD-3: readonly default rejects writes even with a token", async (t) => {
  const root = await makeMemoryRoot();
  // readonly defaults ON: a service created without an explicit writable opt-in
  // refuses writes (403) regardless of token presence.
  const server = createLivingArchiveMemoryService({ memoryRoot: root, token: TEST_TOKEN });
  let endpoint;
  try {
    endpoint = await listen(server);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (skipIfSandboxLocalhostDenied(t, error)) return;
    throw error;
  }

  try {
    const blocked = await postMemory(endpoint, "intake-write", {
      actorId: "external.agent",
      bucket: "obsidian",
      fileName: "note.md",
      content: "# Note",
    }, TEST_TOKEN);
    assert.equal(blocked.response.status, 403);

    // Reads still work in readonly mode.
    const status = await postMemory(endpoint, "status", {}, "");
    assert.equal(status.response.status, 200);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});
