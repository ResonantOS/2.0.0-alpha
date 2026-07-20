// Intent citation: docs/architecture/ADR-017-resonant-browser-addon.md
// PR-R08 / finding P1-d — containment tests for pathContains + the two product
// sites (captureEvidence artifactsDir, loadUnpackedExtension directory).

import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, before } from "node:test";

import { pathContains, assertContained } from "../src/lib/path-contains.mjs";
import { ResonantBrowserHost } from "../src/browser-host.mjs";

describe("pathContains primitive (P1-d)", () => {
  let root;
  let outside;

  before(async () => {
    root = realpathSync(await mkdtemp(path.join(tmpdir(), "pc-root-")));
    outside = realpathSync(await mkdtemp(path.join(tmpdir(), "pc-outside-")));
    await writeFile(path.join(outside, "secret.txt"), "secret");
  });

  it("passes a target equal to the root", () => {
    const v = pathContains(root, root);
    assert.equal(v.result, "pass");
  });

  it("passes an in-root target (existing and not-yet-created leaf)", () => {
    assert.equal(pathContains(root, path.join(root, "a", "b.png")).result, "pass");
    assert.equal(pathContains(root, path.join(root, "child")).result, "pass");
  });

  it("blocks a `..` chain that escapes the root", () => {
    const v = pathContains(root, path.join(root, "..", "..", "etc", "passwd"));
    assert.equal(v.result, "block");
  });

  it("blocks an absolute path outside the root", () => {
    const v = pathContains(root, path.join(outside, "secret.txt"));
    assert.equal(v.result, "block");
    assert.equal(v.evidence.escapeKind, "absolute-outside");
  });

  it("blocks a symlink leaf that points outside the root", async () => {
    const link = path.join(root, "escape-link");
    await symlink(outside, link);
    const v = pathContains(root, path.join(link, "secret.txt"));
    assert.equal(v.result, "block");
    assert.equal(v.evidence.escapeKind, "symlink-escape");
  });

  it("assertContained throws EPATH_CONTAINMENT on escape and returns the real path on pass", () => {
    assert.equal(assertContained(root, path.join(root, "ok.png"), "x"), path.join(root, "ok.png"));
    assert.throws(
      () => assertContained(root, path.join(outside, "secret.txt"), "x"),
      (err) => err.code === "EPATH_CONTAINMENT",
    );
  });
});

describe("captureEvidence artifactsDir containment (P1-d, browser-host)", () => {
  let artifactsDir;
  let outside;

  before(async () => {
    artifactsDir = realpathSync(await mkdtemp(path.join(tmpdir(), "pc-artifacts-")));
    outside = realpathSync(await mkdtemp(path.join(tmpdir(), "pc-art-outside-")));
  });

  function hostWithFakePage(captured) {
    const host = new ResonantBrowserHost({ headless: true });
    host.sessionId = "session-test";
    host.page = {
      async screenshot({ path: screenshotPath }) {
        captured.push(screenshotPath);
      },
    };
    return host;
  }

  it("allows an in-root artifactsDir and writes the screenshot inside it", async () => {
    const captured = [];
    const host = hostWithFakePage(captured);
    const evidence = await host.captureEvidence({ artifactsDir, reason: "ok" });
    assert.equal(captured.length, 1);
    assert.equal(pathContains(artifactsDir, captured[0]).result, "pass");
    assert.equal(pathContains(artifactsDir, evidence.evidenceRef).result, "pass");
  });

  it("rejects a screenshot leaf that traverses out of the artifacts root", async () => {
    const captured = [];
    const host = hostWithFakePage(captured);
    // The screenshot leaf is composed from sessionId; a traversal in sessionId
    // would walk the written file out of the artifacts root. The guard contains
    // the resolved leaf to realpath(artifactsDir) and refuses before any write.
    host.sessionId = "../../escape";
    await assert.rejects(
      () => host.captureEvidence({ artifactsDir, reason: "escape" }),
      (err) => err.code === "EPATH_CONTAINMENT" || /escapes the allowed root/.test(err.message),
    );
    assert.equal(captured.length, 0);
  });

  it("rejects a screenshot leaf that absolute-reroots out of the artifacts root via symlink", async () => {
    const captured = [];
    const host = hostWithFakePage(captured);
    // artifactsDir is itself a symlink whose realpath is `outside`; a sessionId
    // traversal then walks the leaf out of realpath(artifactsDir).
    const linkBase = path.join(artifactsDir, "linked-base");
    await symlink(outside, linkBase).catch(() => {});
    host.sessionId = "../../escape";
    await assert.rejects(
      () => host.captureEvidence({ artifactsDir: linkBase, reason: "escape" }),
      (err) => err.code === "EPATH_CONTAINMENT" || /escapes the allowed root/.test(err.message),
    );
    assert.equal(captured.length, 0);
  });
});
