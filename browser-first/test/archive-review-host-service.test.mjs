import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  artifactInsights,
  artifactKind,
  createArchiveReviewHostService,
  frontmatterValue,
  markdownBody,
  markdownSection,
  markdownTitle,
  safeMemoryRelativePathForRoot,
  writeFrontmatterValue,
} from "../host/archive-review-host-service.mjs";

test("archive review host helpers parse governed markdown artifacts", () => {
  const content = [
    "---",
    'title: "Browser Report"',
    'createdAt: "2026-06-01T00:00:00.000Z"',
    "---",
    "",
    "# Fallback Title",
    "",
    "- status: ready",
    "- phase: review",
    "- next human action: inspect promotion",
    "",
    "## Content",
    "Body text",
    "",
    "## Other",
    "Other text",
  ].join("\n");

  assert.equal(frontmatterValue(content, "title"), "Browser Report");
  assert.equal(markdownTitle(content, "Untitled"), "Browser Report");
  assert.equal(markdownSection(content, "Content"), "Body text");
  assert.equal(markdownBody(content).startsWith("# Fallback Title"), true);
  assert.deepEqual(artifactInsights(content), {
    nextHumanAction: "inspect promotion",
    percentComplete: "",
    phase: "review",
    status: "ready",
    summary: "",
    targetReason: "",
    targetSite: "",
  });
  assert.equal(artifactKind("# Browser Job Report\n\nDone", "/tmp/report.md"), "browser-job-report");
  assert.equal(artifactKind("note", `/tmp/browser${process.platform === "win32" ? "\\" : "/"}note.md`), "browser-intake");
});

test("archive review host helpers write frontmatter and enforce memory-relative paths", () => {
  const updated = writeFrontmatterValue("# Note\n", "artifactPath", "REVIEW/artifacts/example.md");
  assert.match(updated, /artifactPath: "REVIEW\/artifacts\/example\.md"/);
  assert.equal(
    safeMemoryRelativePathForRoot("/tmp/resonantos-memory", "INTAKE/browser/item.md", "INTAKE"),
    path.resolve("/tmp/resonantos-memory", "INTAKE", "browser", "item.md"),
  );
  assert.throws(
    () => safeMemoryRelativePathForRoot("/tmp/resonantos-memory", "../escape.md", "INTAKE"),
    /Archive path must stay inside INTAKE|Archive path escapes/,
  );
  assert.throws(
    () => safeMemoryRelativePathForRoot("/tmp/resonantos-memory", "INTAKE/../REVIEW/escape.md", "INTAKE"),
    /Archive path must stay inside INTAKE/,
  );
});

test("archive review host service wires archive review dependencies", () => {
  const service = createArchiveReviewHostService({
    memoryRoot: () => "/tmp/resonantos-memory",
    userRoot: () => "/tmp",
    listFilesRecursive: async () => [],
    safeFileSlug: (value) => String(value ?? "item").replace(/[^a-z0-9]+/gi, "-"),
    runArchiveIngestWriter: async () => ({ status: "drafted" }),
    runArchiveSemanticVerifier: async () => ({ status: "verified" }),
  });

  assert.equal(typeof service.executeArchiveReviewRequest, "function");
  assert.equal(typeof service.executeArchiveReviewArtifactPromote, "function");
  assert.equal(typeof service.executeMemoryWikiPageRead, "function");
});
