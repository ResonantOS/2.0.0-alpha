import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_SUMMARY_ARTIFACT_KEY,
  deleteSessionSummaryArtifact,
  loadSessionSummaryArtifact,
  saveSessionSummaryArtifact
} from "../resonantos-side-panel-extension/src/lib/session-summary-store.js";
import { buildSessionSummaryArtifact } from "../resonantos-side-panel-extension/src/lib/session-summary-artifact.js";

// A chrome.storage.local mock backed by an in-memory map (the real API persists
// across reloads; this mock proves the round-trip + deletion contract).
function createChromeMock() {
  const store = new Map();
  const writes = [];
  return {
    storage: {
      local: {
        async get(key) {
          return store.has(key) ? { [key]: store.get(key) } : {};
        },
        async set(patch) {
          writes.push(patch);
          for (const [key, value] of Object.entries(patch)) store.set(key, value);
        },
        async remove(key) {
          store.delete(key);
        }
      }
    },
    _store: store,
    _writes: writes
  };
}

test("saveSessionSummaryArtifact persists the artifact under the canonical key", async () => {
  const chrome = createChromeMock();
  const artifact = buildSessionSummaryArtifact({ included: [{ title: "A", url: "https://a.test/" }], summary: "notes" });

  const saved = await saveSessionSummaryArtifact(chrome, artifact);
  assert.equal(saved, true);
  assert.ok(chrome._store.has(SESSION_SUMMARY_ARTIFACT_KEY));
  assert.equal(SESSION_SUMMARY_ARTIFACT_KEY, "augmentorSessionSummaryArtifact");
  assert.deepEqual(chrome._writes, [{ augmentorSessionSummaryArtifact: artifact }]);
});

test("saveSessionSummaryArtifact redacts direct unsanitized provenance and summary at the storage boundary", async () => {
  const chrome = createChromeMock();
  const artifact = {
    kind: "session-summary",
    trigger: "explicit-command",
    generatedAt: "2026-08-19T12:00:00.000Z",
    included: [{ title: "Account password=synthetic-password", url: "https://a.test/?token=synthetic-token&view=notes" }],
    skipped: [{ title: "Authorization: Bearer synthetic-bearer", url: "https://b.test/?client_secret=synthetic-client", reason: "pin=123456 restricted" }],
    summary: `Notes ${"deadbeef".repeat(4)}`
  };
  const original = structuredClone(artifact);

  assert.equal(await saveSessionSummaryArtifact(chrome, artifact), true);
  assert.equal(chrome._writes.length, 1);
  assert.deepEqual(chrome._writes[0], {
    augmentorSessionSummaryArtifact: {
      kind: "session-summary",
      trigger: "explicit-command",
      generatedAt: "2026-08-19T12:00:00.000Z",
      included: [{ title: "Account password=[redacted]", url: "https://a.test/?token=[redacted]&view=notes" }],
      skipped: [{ title: "Authorization: [redacted]", url: "https://b.test/?client_secret=[redacted]", reason: "pin=[redacted] restricted" }],
      summary: "Notes [redacted]"
    }
  });
  assert.deepEqual(artifact, original, "redaction must not mutate the caller's artifact");
  assert.deepEqual(await loadSessionSummaryArtifact(chrome), chrome._writes[0].augmentorSessionSummaryArtifact);
  assert.equal(await deleteSessionSummaryArtifact(chrome), true);
  assert.equal(await loadSessionSummaryArtifact(chrome), null);
});

test("saveSessionSummaryArtifact redacts direct caller metadata and nested strings", async () => {
  const chrome = createChromeMock();
  const artifact = {
    kind: "session-summary",
    trigger: "token=synthetic-trigger",
    generatedAt: "password=synthetic-timestamp",
    metadata: {
      password: "synthetic-property",
      notes: ["ordinary notes", { detail: "Authorization: Bearer synthetic-nested", count: 2, ready: true, missing: null }],
      "token=synthetic-key": "safe value"
    }
  };
  const original = structuredClone(artifact);

  assert.equal(await saveSessionSummaryArtifact(chrome, artifact), true);
  assert.equal(chrome._writes.length, 1);
  assert.deepEqual(chrome._writes[0], {
    augmentorSessionSummaryArtifact: {
      kind: "session-summary",
      trigger: "token=[redacted]",
      generatedAt: "password=[redacted]",
      metadata: {
        password: "[redacted]",
        notes: ["ordinary notes", { detail: "Authorization: [redacted]", count: 2, ready: true, missing: null }],
        "token=[redacted]": "safe value"
      }
    }
  });
  assert.deepEqual(artifact, original);
});

test("saveSessionSummaryArtifact writes a detached copy of caller objects and arrays", async () => {
  const chrome = createChromeMock();
  const artifact = { kind: "session-summary", included: [{ title: "Alpha" }], metadata: { notes: ["notes"] } };
  const original = structuredClone(artifact);

  await saveSessionSummaryArtifact(chrome, artifact);
  assert.equal(chrome._writes.length, 1);
  const stored = chrome._writes[0].augmentorSessionSummaryArtifact;
  assert.deepEqual(stored, original);
  assert.notStrictEqual(stored, artifact);
  assert.notStrictEqual(stored.included, artifact.included);
  assert.notStrictEqual(stored.included[0], artifact.included[0]);
  assert.notStrictEqual(stored.metadata, artifact.metadata);
  assert.notStrictEqual(stored.metadata.notes, artifact.metadata.notes);
  artifact.included[0].title = "Changed title";
  artifact.metadata.notes.push("Later note");
  assert.deepEqual(stored, original, "later caller mutations cannot change the captured write");
});

test("saveSessionSummaryArtifact preserves builder sentinels, metadata and provenance/summary bounds", async () => {
  const chrome = createChromeMock();
  const title = "Title password=synthetic-password " + "long title ".repeat(50);
  const url = "https://a.test/?token=synthetic-token&path=" + "segment/".repeat(60);
  const reason = "secret=synthetic-reason " + "skip reason ".repeat(50);
  const summary = `Authorization: Bearer synthetic-bearer ${"deadbeef".repeat(4)} ` + "session notes ".repeat(400);
  const artifact = buildSessionSummaryArtifact({
    included: [{ title, url }],
    skipped: [{ title, url, reason }],
    summary,
    generatedAt: "2026-08-19T12:00:00.000Z"
  });
  const original = structuredClone(artifact);

  assert.equal(await saveSessionSummaryArtifact(chrome, artifact), true);
  assert.equal(chrome._writes.length, 1);
  const stored = chrome._writes[0].augmentorSessionSummaryArtifact;
  assert.deepEqual(stored, original);
  assert.equal(stored.kind, "session-summary");
  assert.equal(stored.trigger, "explicit-command");
  assert.equal(stored.generatedAt, "2026-08-19T12:00:00.000Z");
  assert.ok(stored.summary.startsWith("Authorization: [redacted] [redacted] "));
  assert.equal(stored.summary.length, 4000);
  for (const field of [stored.included[0].title, stored.included[0].url, ...Object.values(stored.skipped[0])]) {
    assert.equal(field.length, 301);
    assert.ok(field.endsWith("…"));
    assert.ok(field.includes("[redacted]"));
  }
  assert.deepEqual(artifact, original);
});

test("loadSessionSummaryArtifact restores a saved artifact (restart round-trip)", async () => {
  const chrome = createChromeMock();
  const artifact = buildSessionSummaryArtifact({
    included: [{ title: "Alpha", url: "https://alpha.test/" }, { title: "Beta", url: "https://beta.test/" }],
    skipped: [{ title: "Internal", url: "chrome://settings/", reason: "not a readable web page" }],
    summary: "session notes",
    generatedAt: "2026-08-19T12:00:00.000Z"
  });
  await saveSessionSummaryArtifact(chrome, artifact);

  // A fresh load (simulating an extension reload) restores the same artifact.
  const restored = await loadSessionSummaryArtifact(chrome);
  assert.equal(restored.kind, "session-summary");
  assert.equal(restored.included.length, 2);
  assert.equal(restored.skipped.length, 1);
  assert.equal(restored.generatedAt, "2026-08-19T12:00:00.000Z");
});

test("loadSessionSummaryArtifact returns null when nothing is stored or the kind is wrong", async () => {
  const chrome = createChromeMock();
  assert.equal(await loadSessionSummaryArtifact(chrome), null);
  await chrome.storage.local.set({ [SESSION_SUMMARY_ARTIFACT_KEY]: { kind: "other" } });
  assert.equal(await loadSessionSummaryArtifact(chrome), null);
});

test("deleteSessionSummaryArtifact removes the artifact and the deletion persists across a reload", async () => {
  const chrome = createChromeMock();
  const artifact = buildSessionSummaryArtifact({ included: [{ title: "A", url: "https://a.test/" }] });
  await saveSessionSummaryArtifact(chrome, artifact);
  assert.ok(await loadSessionSummaryArtifact(chrome));

  const removed = await deleteSessionSummaryArtifact(chrome);
  assert.equal(removed, true);
  // A fresh load (simulating restart) honors the deletion — storage is the source of truth.
  assert.equal(await loadSessionSummaryArtifact(chrome), null);
});

test("store functions degrade safely without chrome.storage.local", async () => {
  for (const chrome of [undefined, null, {}, { storage: {} }, { storage: { local: {} } }]) {
    assert.equal(await saveSessionSummaryArtifact(chrome, {}), false);
    assert.equal(await loadSessionSummaryArtifact(chrome), null);
    assert.equal(await deleteSessionSummaryArtifact(chrome), false);
  }
});
