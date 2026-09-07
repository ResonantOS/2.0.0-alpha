import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createArchiveReviewHostService } from "../host/archive-review-host-service.mjs";
import { createChatSessionStore } from "../resonantos-side-panel-extension/src/lib/chat-session-store.js";
import { redactTraceText } from "../resonantos-side-panel-extension/src/lib/trace-redaction.js";

const STORAGE_KEYS = {
  messages: "messages",
  forks: "forks",
  sessions: "sessions",
  projects: "projects",
  folders: "folders",
  writer: "writer",
  activeSessionId: "activeSessionId",
  model: "model",
  thinkingDepth: "thinkingDepth",
  attachments: "attachments"
};

function cloneStorageValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createMemoryStorage(initial = {}) {
  const state = cloneStorageValue(initial);
  const writes = [];
  return {
    snapshot: () => cloneStorageValue(state),
    storage: {
      get: async (keys) => {
        if (!Array.isArray(keys)) return cloneStorageValue(state);
        return Object.fromEntries(keys.map((key) => [key, cloneStorageValue(state[key])]));
      },
      set: async (payload) => {
        writes.push(cloneStorageValue(payload));
        Object.assign(state, cloneStorageValue(payload));
      }
    },
    writes
  };
}

function createStoreForStorage(storage, { now, instanceId = "continuity-test" }) {
  return createChatSessionStore({
    storage,
    storageKeys: STORAGE_KEYS,
    instanceId,
    getModel: () => "MiniMax-M3",
    getThinkingDepth: () => "high",
    setModel: () => {},
    setThinkingDepth: () => {},
    isAllowedModel: (value) => value === "MiniMax-M3",
    isAllowedThinkingDepth: (value) => value === "high",
    now,
    createId: (() => {
      let index = 0;
      return () => `continuity-id-${++index}`;
    })()
  });
}

async function listFilesRecursive(root, predicate, limit = 2_000) {
  const results = [];
  async function visit(directory) {
    if (results.length >= limit) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (predicate(filePath)) {
        results.push(filePath);
      }
      if (results.length >= limit) return;
    }
  }
  await visit(root);
  return results;
}

function safeFileSlug(value) {
  return String(value ?? "artifact")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "artifact";
}

function contextContinuityMarkdown(session, runStartedAt) {
  const compactState = session.compactState ?? {};
  const sources = Array.isArray(compactState.sources) ? compactState.sources : [];
  const sourceLines = sources.flatMap((source, index) => [
    `### Source ${index + 1}: ${source.title}`,
    `- url: ${source.url}`,
    `- capturedAt: ${source.capturedAt}`,
    `- messageIds: ${Array.isArray(source.sourceMessageIds) ? source.sourceMessageIds.join(", ") : ""}`,
    ""
  ]);
  return redactTraceText([
    "# Living Archive Context Continuity Artifact",
    "",
    `- runStartedAt: ${runStartedAt}`,
    `- sessionId: ${session.id}`,
    `- compactedAt: ${compactState.compactedAt}`,
    `- restartBoundary: fresh-chat-session-store-instance`,
    "",
    "## User Intent",
    compactState.userIntent?.goal ?? "",
    "",
    "## Working Summary",
    compactState.workingSummary ?? "",
    "",
    "## Source Provenance",
    ...sourceLines,
    "## Open Tasks",
    ...(Array.isArray(compactState.openTasks)
      ? compactState.openTasks.map((task) => `- ${task.description} (${task.status})`)
      : []),
    ""
  ].join("\n"));
}

test("issue #228: Living Archive context continuity survives restart with provenance and redaction", async () => {
  const runStartedAt = new Date().toISOString();
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-continuity-"));
  const sourceUrlWithSecret = "https://research.example.test/report?token=SECRET&ref=archive";
  const sourceUrlWithoutSecret = "https://docs.resonantos.test/alpha/runtime-boundary";
  const thirdSourceUrl = "https://catalog.example.test/results?q=browser-first";

  try {
    const initialSession = {
      id: "research-session-228",
      title: "Browser research continuity",
      workspaceId: "memory",
      createdAt: runStartedAt,
      updatedAt: runStartedAt,
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Research browser-first memory continuity for the Alpha proof.",
          createdAt: runStartedAt
        },
        {
          id: "message-2",
          role: "assistant",
          content: "Tracked source-backed notes and kept archive promotion as review-only.",
          createdAt: runStartedAt
        },
        {
          id: "message-3",
          role: "user",
          content: "Preserve the context artifact across restart.",
          createdAt: runStartedAt
        }
      ],
      compactState: {
        threadId: "research-session-228",
        compactedAt: runStartedAt,
        sourceRange: {
          fromMessageId: "message-1",
          toMessageId: "message-3"
        },
        userIntent: {
          goal: "Prove a realistic browser research session can resume with source-backed context intact.",
          successCriteria: [
            "context artifact survives restart",
            "source provenance remains visible",
            "secrets are redacted before archive intake"
          ],
          sourceMessageIds: ["message-1", "message-3"]
        },
        workingSummary: "The session compared Alpha runtime docs, Living Archive boundaries, and a research report before restart.",
        sources: [
          {
            title: "Alpha Runtime Boundary",
            url: sourceUrlWithoutSecret,
            capturedAt: runStartedAt,
            sourceMessageIds: ["message-1"]
          },
          {
            title: "Private Research Report",
            url: sourceUrlWithSecret,
            capturedAt: runStartedAt,
            sourceMessageIds: ["message-2"]
          },
          {
            title: "Browser-first Search Results",
            url: thirdSourceUrl,
            capturedAt: runStartedAt,
            sourceMessageIds: ["message-3"]
          }
        ],
        openTasks: [{
          taskId: "task-228",
          description: "Review continuity artifact after restart.",
          status: "open",
          sourceMessageIds: ["message-3"]
        }],
        preservedRecentMessageIds: ["message-2", "message-3"],
        checksum: "fnv32:continuity-acceptance"
      },
      sourceReferences: [
        { messageId: "message-1", title: "Alpha Runtime Boundary", url: sourceUrlWithoutSecret },
        { messageId: "message-2", title: "Private Research Report", url: sourceUrlWithSecret },
        { messageId: "message-3", title: "Browser-first Search Results", url: thirdSourceUrl }
      ]
    };

    const originalStorage = createMemoryStorage({
      sessions: [initialSession],
      activeSessionId: initialSession.id
    });
    const originalStore = createStoreForStorage(originalStorage.storage, {
      now: () => runStartedAt,
      instanceId: "continuity-before-restart"
    });

    await originalStore.hydrate();
    await originalStore.persist();

    const persistedState = originalStorage.snapshot();
    assert.equal(persistedState.activeSessionId, initialSession.id);
    assert.equal(persistedState.sessions.length, 1);
    assert.deepEqual(persistedState.sessions[0].compactState.sources.map((source) => source.title), [
      "Alpha Runtime Boundary",
      "Private Research Report",
      "Browser-first Search Results"
    ]);

    const restartedStorage = createMemoryStorage(persistedState);
    const restartedStore = createStoreForStorage(restartedStorage.storage, {
      now: () => runStartedAt,
      instanceId: "continuity-after-restart"
    });
    await restartedStore.hydrate();

    const reloadedSession = restartedStore.getActiveSession();
    assert.notEqual(restartedStore, originalStore);
    assert.equal(reloadedSession.id, initialSession.id);
    assert.equal(reloadedSession.compactState.compactedAt, runStartedAt);
    assert.deepEqual(reloadedSession.sourceReferences.map((source) => source.title), [
      "Alpha Runtime Boundary",
      "Private Research Report",
      "Browser-first Search Results"
    ]);

    const artifactMarkdown = contextContinuityMarkdown(reloadedSession, runStartedAt);
    const service = createArchiveReviewHostService({
      memoryRoot: () => memoryRoot,
      userRoot: () => os.tmpdir(),
      listFilesRecursive,
      safeFileSlug,
      runArchiveIngestWriter: async () => ({ status: "drafted" }),
      runArchiveSemanticVerifier: async () => ({ status: "verified" })
    });

    const beforeIntake = Date.now();
    const intake = await service.executeArchiveIntake({
      title: `Context Continuity ${reloadedSession.id}`,
      content: artifactMarkdown,
      url: redactTraceText(sourceUrlWithSecret),
      sourceMessageId: reloadedSession.id
    });
    const review = await service.executeArchiveReviewRequest({
      path: intake.path,
      reason: "Review this restarted browser research context artifact for possible Living Archive ingestion."
    });
    const afterIntake = Date.now();
    const artifact = await service.executeArchiveIntakeRead({ path: intake.path });
    const artifactPath = path.join(memoryRoot, intake.path);
    const artifactStats = await stat(artifactPath);
    const artifactBody = await readFile(artifactPath, "utf8");

    assert.equal(review.sourceArtifactPath, intake.path);
    assert.equal(review.status, "pending");
    // Filesystem mtimes are coarser than Date.now() on some kernels (Linux CI runners round to the
    // clock tick), so the artifact can legitimately carry an mtime a few ms before `beforeIntake`.
    // Bound both sides with the same one-second tolerance instead of trusting sub-tick ordering.
    assert.ok(artifactStats.mtimeMs >= beforeIntake - 1_000, `artifact mtime ${artifactStats.mtimeMs} predates intake start ${beforeIntake} by more than 1s`);
    assert.ok(artifactStats.mtimeMs <= afterIntake + 1_000, `artifact mtime ${artifactStats.mtimeMs} is more than 1s after intake end ${afterIntake}`);
    assert.match(artifact.content, /# Living Archive Context Continuity Artifact/);
    assert.match(artifact.content, new RegExp(`runStartedAt: ${runStartedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(artifact.content, /restartBoundary: fresh-chat-session-store-instance/);
    assert.match(artifact.content, /Alpha Runtime Boundary/);
    assert.match(artifact.content, /https:\/\/docs\.resonantos\.test\/alpha\/runtime-boundary/);
    assert.match(artifact.content, /Private Research Report/);
    assert.match(artifact.content, /https:\/\/research\.example\.test\/report\?token=REDACTED&ref=archive/);
    assert.match(artifact.content, /Browser-first Search Results/);
    assert.match(artifact.content, /https:\/\/catalog\.example\.test\/results\?q=browser-first/);
    assert.doesNotMatch(artifactBody, /token=SECRET/);
    assert.doesNotMatch(artifactBody, /SECRET/);
    assert.match(artifactBody, /url: "https:\/\/research\.example\.test\/report\?token=REDACTED&ref=archive"/);
  } finally {
    await rm(memoryRoot, { recursive: true, force: true });
  }
});
