import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { symlinkSync, unlinkSync } from "node:fs";
import { appendFile, mkdtemp, mkdir, open as openFile, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

import {
  classifyContent,
  classifyPath,
  scanRepository,
} from "./check-repo-hygiene.mjs";

const TEN_MIB = 10 * 1024 * 1024;
const SCRIPT_PATH = fileURLToPath(new URL("./check-repo-hygiene.mjs", import.meta.url));
const ALPHA_BUILD_WORKFLOW_PATH = new URL("../.github/workflows/alpha-build.yml", import.meta.url);
const fileStat = (size = 0) => ({ isFile: () => true, size });
const token = (prefix, body) => `${prefix}${body}`;

async function withTempDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "repo-hygiene-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function writeFixture(root, path, content = "fixture\n") {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

test("classifyPath allows ordinary repository files", () => {
  assert.equal(classifyPath("src/index.js", fileStat()), null);
  assert.equal(classifyPath("docs/output-guide.md", fileStat()), null);
});

test("classifyPath rejects generated, local-state, archive, and environment paths", () => {
  const rejectedPaths = [
    "output/report.json",
    "packages/app/runs/result.txt",
    ".abacusai/session.json",
    "tools/.codex/config.toml",
    ".understand-anything/graph.json",
    "ResonantOS_User/settings.json",
    "tools/.venv/bin/python",
    "examples/venv/pyvenv.cfg",
    "release/resonantos.zip",
  ];

  for (const path of rejectedPaths) {
    const violation = classifyPath(path, fileStat());
    assert.ok(violation, `expected ${path} to be rejected`);
    assert.equal(violation.path, path);
    assert.match(violation.message, /remove|archive|outside|allowlist/i);
  }
});

test("classifyPath accepts the official .rpkg package format", () => {
  // .rpkg is the official Resonant Extension Framework package format
  // (per docs/addons/resonant-extension-framework/ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md
  // and ADR-055 §12.1 C6). Hygiene rule distinguishes official format
  // from ad-hoc ZIP archives; only .rpkg passes.
  const accepted = [
    "packages/example-notes/example-notes-1.0.0.rpkg",
    "tests/fixtures/example-1.0.0.rpkg",
    "PUBLIC/example.rpkg",
  ];
  for (const path of accepted) {
    const violation = classifyPath(path, fileStat());
    assert.equal(violation, null, `expected ${path} to pass hygiene`);
  }
  // A .zip alongside an .rpkg in the same directory is still rejected.
  assert.ok(classifyPath("release/example.zip", fileStat()));
});

test("classifyPath rejects browser profile databases and recognized profile roots", () => {
  for (const name of ["Cookies", "cookies", "LOGIN DATA", "History", "Web Data", "Local State"]) {
    assert.equal(classifyPath(`fixtures/${name}`, fileStat())?.rule, "browser-profile");
  }

  for (const path of [
    "profiles/Default/Account Web Data",
    "profiles/Default/Affiliation Database",
    "profiles/Default/Preferences",
    "chrome-user-data/Profile 2/Extension State/CURRENT",
    "Library/Application Support/Google/Chrome/Default/Preferences",
    ".config/google-chrome/Profile 2/Secure Preferences",
    "AppData/Local/BraveSoftware/Brave-Browser/User Data/Guest Profile/History",
    "User Data/System Profile/Preferences",
    "Default/Preferences",
    "profiles/wallet-main/Default/Preferences",
    "Library/Application Support/Google/Chrome/Default/Bookmarks",
    ".config/chromium/Profile 2/Session Storage/CURRENT",
    "BraveSoftware/Brave-Browser/Default/Code Cache/js/index",
    "Library/Application Support/Google/Chrome Canary/Default/Preferences",
    "Library/Application Support/Google/Chrome Beta/Guest Profile/Preferences",
    ".config/google-chrome-beta/Profile 1/Secure Preferences",
    "Default/Bookmarks",
    "Profile 1/Bookmarks",
    "Default/Session Storage/CURRENT",
    "Guest Profile/Favicons",
    ".config/microsoft-edge/Default/Preferences",
    ".config/microsoft-edge-beta/Profile 1/Preferences",
    ".config/microsoft-edge-dev/Guest Profile/Preferences",
    "chrome-user-data/First Run",
    "User Data/Last Version",
    "chrome-user-data/Default/Local Storage/leveldb/CURRENT",
    "Default/Local Storage/leveldb/CURRENT",
    "profiles/wallet-main/Profile 4/IndexedDB/example.indexeddb.leveldb/CURRENT",
    "Library/Application Support/Google/Chrome/Default/Service Worker/CacheStorage/index",
    "fixtures/Chromium/Default/Preferences",
    "fixtures/Google/Chrome Beta/Default/Preferences",
    "fixtures/Library/Application Support/Google/Chrome/Default/Preferences",
    "fixtures/AppData/Local/Microsoft/Edge/User Data/Default/Preferences",
    "fixtures/Default/Local Storage/leveldb/CURRENT",
    "fixtures/Profile 2/IndexedDB/example.indexeddb.leveldb/CURRENT",
    "Microsoft/Edge/Default/Preferences",
    "docs/Google/Chrome/Default/Local Storage/leveldb/CURRENT",
    "wrap/Google/Chrome SxS/Default/README.md",
    "wrap/Microsoft/Edge SxS/Default/README.md",
    "wrap/Microsoft/Edge SxS/Last Version",
    "chrome-user-data/Research Persona/Preferences",
    "Library/Application Support/Google/Chrome/Wallet Main/Extension State/CURRENT",
    "profiles/wallet-main/Local Storage/leveldb/CURRENT",
  ]) {
    assert.equal(classifyPath(path, fileStat())?.rule, "browser-profile", path);
  }

  assert.equal(classifyPath("docs/History.md", fileStat()), null);
  assert.equal(classifyPath("docs/profiles/default-behavior.md", fileStat()), null);
  assert.equal(classifyPath("docs/profiles/Default/README.md", fileStat()), null);
  assert.equal(classifyPath("docs/Default/Preferences", fileStat()), null);
  assert.equal(classifyPath("config/Preferences", fileStat()), null);
  assert.equal(classifyPath("docs/Chromium/README.md", fileStat()), null);
  assert.equal(classifyPath("docs/Google/Chrome/Default/README.md", fileStat()), null);
  assert.equal(classifyPath("docs/Microsoft Edge/README.md", fileStat()), null);
  assert.equal(classifyPath("docs/User Data/README.md", fileStat()), null);
  assert.equal(classifyPath("src/Default/index.js", fileStat()), null);
  assert.equal(classifyPath("src/Default/utils/index.js", fileStat()), null);
  assert.equal(classifyPath("examples/Profile 1/README.md", fileStat()), null);
  assert.equal(classifyPath("examples/Profile 1/guides/README.md", fileStat()), null);
  assert.equal(classifyPath("profiles/wallet-main/README.md", fileStat()), null);
  assert.equal(classifyPath("src/profiles/wallet-main/Preferences", fileStat()), null);
});

test("classifyPath rejects symbolic links", () => {
  const linkStat = { isFile: () => false, isSymbolicLink: () => true, size: 12 };
  assert.equal(classifyPath("docs/linked.md", linkStat)?.rule, "symlink");
});

test("classifyPath enforces the 10 MiB boundary with an explicit allowlist", () => {
  assert.equal(classifyPath("assets/boundary.bin", fileStat(TEN_MIB)), null);
  assert.equal(classifyPath("assets/large.bin", fileStat(TEN_MIB + 1))?.rule, "large-file");
  assert.equal(
    classifyPath("assets/large.bin", fileStat(TEN_MIB + 1), {
      sizeAllowlist: ["assets/large.bin"],
    }),
    null,
  );
});

test("classifyContent detects founder-specific paths and honors its allowlist", () => {
  const content = "Workspace: /Users/dr.tom/2.0.0-alpha\n";
  assert.equal(classifyContent("docs/setup.md", content)?.rule, "founder-path");
  assert.equal(
    classifyContent("docs/historical-fixture.md", content, {
      contentAllowlist: ["docs/historical-fixture.md"],
    }),
    null,
  );
});

test("classifyContent detects high-confidence provider and source-control credentials", () => {
  const credentials = [
    [token("sk-", "aB3dE5fG7hJ9kL2mN4pQ6rS8"), "credential-openai"],
    [token("sk-api-", "Z9yX7wV5uT3sR1qP8nM6kJ4h"), "credential-openai"],
    [token("sk-ant-api03-", "Q7wE9rT2yU4iO6pA8sD1fG3hJ5kL7zX9"), "credential-anthropic"],
    [token("AIza", "Q7wE9rT2yU4iO6pA8sD1fG3hJ5kL7zX9bC4"), "credential-google-ai"],
    [token("AKIA", "7EXAMPLE9ISBAD2X".replace("EXAMPLE", "Q6M4N8P")), "credential-aws"],
    [token("xai-", "K8mN2pQ4rS6tV9wX3yZ5"), "credential-xai"],
    [token("ghp_", "aB3dE5fG7hJ9kL2mN4pQ6rS8tV1wX3yZ5cD7"), "credential-github"],
    [token("gho_", "bC4eF6gH8jK1mN3pQ5rT7vW9xY2zA4cD6eF8"), "credential-github"],
    [token("ghu_", "cD5fG7hJ9kL2mN4pQ6rS8tV1wX3yZ5aB7cD9"), "credential-github"],
    [token("ghs_", "dE6gH8jK1mN3pQ5rT7vW9xY2zA4bC6dE8fG1"), "credential-github"],
    [token("ghr_", "eF7hJ9kL2mN4pQ6rS8tV1wX3yZ5aB7cD9eF2"), "credential-github"],
    [token("github_pat_", `${"A7bC9dE2fG4hJ6kL8mN1pQ"}_${"R3sT5uV7wX9yZ2aB4cD6eF8gH1jK3mN5pQ7rS9tU2vW4xY6z"}`), "credential-github"],
    [token("gsk_", "B7dF9hJ2kL4mN6pQ8rS1tV3w"), "credential-groq"],
    [token("rpa_", "C8eG1jK3mN5pQ7rT9vX2zA4b"), "credential-replicate"],
  ];

  for (const [credential, expectedRule] of credentials) {
    const result = classifyContent("config/provider.env", `API_KEY=${credential}\n`);
    assert.equal(result?.rule, expectedRule, `expected ${expectedRule}`);
  }
});

test("classifyContent detects supported provider credentials assigned through environment variables", () => {
  const credentials = [
    ["MINIMAX_API_KEY", "mM7qR9sT2uV4wX6yZ8aB1cD3", "credential-minimax"],
    ["ZAI_API_KEY", "zA8bC1dE3fG5hJ7kL9mN2pQ4", "credential-zai"],
    ["GLM_API_KEY", "gL9mN2pQ4rS6tV8wX1yZ3aB5", "credential-glm"],
    ["ZHIPUAI_API_KEY", "zH1jK3mN5pQ7rS9tV2wX4yZ6", "credential-zhipu"],
  ];

  for (const [name, credential, expectedRule] of credentials) {
    const result = classifyContent("config/provider.env", `${name}=${credential}\n`);
    assert.equal(result?.rule, expectedRule, `expected ${expectedRule}`);
  }
});

test("classifyContent does not treat placeholder words embedded in a credential as safe", () => {
  const credential = token("sk-", "aB3dE5testG7hJ9kL2mN4pQ6rS8");
  assert.equal(
    classifyContent("config/provider.env", `OPENAI_API_KEY=${credential}\n`)?.rule,
    "credential-openai",
  );
});

test("classifyContent does not treat repeated or sequential substrings as placeholders", () => {
  const embeddedRepeat = token("sk-", "aB3dE5ffffffffffffG7hJ9kL2mN4pQ6");
  const embeddedSequence = "mM7qR9sT2uV40123456789wX6yZ8aB1cD3";

  assert.equal(
    classifyContent("config/provider.env", `OPENAI_API_KEY=${embeddedRepeat}\n`)?.rule,
    "credential-openai",
  );
  assert.equal(
    classifyContent("config/provider.env", `MINIMAX_API_KEY=${embeddedSequence}\n`)?.rule,
    "credential-minimax",
  );
});

test("classifyContent ignores credential regex source and obvious placeholders", () => {
  const safeContents = [
    String.raw`/\bsk-[A-Za-z0-9_-]{16,}\b/`,
    String.raw`github_pat_[A-Za-z0-9_]{50,}`,
    "OPENAI_API_KEY=sk-abcdefghijklmnop",
    "OPENAI_API_KEY=sk-EXAMPLEEXAMPLEEXAMPLE",
    "ANTHROPIC_API_KEY=sk-ant-api03-REPLACE_WITH_YOUR_KEY",
    "GOOGLE_API_KEY=AIzaPLACEHOLDERPLACEHOLDERPLACEHOLDER123",
    "AWS_ACCESS_KEY_ID=AKIATESTTESTTESTTEST",
    "XAI_API_KEY=xai-REDACTEDREDACTED",
    "GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "GITHUB_TOKEN=gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "GITHUB_TOKEN=ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "GITHUB_TOKEN=ghr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "GROQ_API_KEY=gsk_DUMMYDUMMYDUMMYDUMMY",
    "REPLICATE_API_TOKEN=rpa_FAKEFAKEFAKEFAKE",
  ];

  for (const content of safeContents) {
    assert.equal(classifyContent("docs/example.md", content), null, content);
  }
});

test("classifyContent accepts the protected provider bridge's explicit synthetic fixture", () => {
  assert.equal(
    classifyContent(
      "browser-first/test/provider-bridge-session-secrets.test.mjs",
      'MINIMAX_API_KEY: "minimax-env-credential"',
    ),
    null,
  );
});

test("classifyContent rejects random-looking provider values ending in env-credential", () => {
  const name = ["MINIMAX", "API", "KEY"].join("_");
  const value = ["qR7tV9xB2dF4hJ6kL8mN", "env", "credential"].join("-");
  assert.equal(
    classifyContent(
      "config/provider.env",
      `${name}="${value}"`,
    )?.rule,
    "credential-minimax",
  );
});

test("classifyContent detects stateless GitHub App installation tokens", () => {
  const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const payload = "eyJpc3MiOiJmaXh0dXJlIiwiaWF0IjoxMjM0NTY3ODkwfQ";
  const signature = "qR7tV9xB2dF4hJ6kL8mN0pQ2sT4vW6yZ8aB0cD2eF4g";
  const token = `ghs_1234567_${header}.${payload}.${signature}`;

  assert.equal(classifyContent("config/app-token.txt", token)?.rule, "credential-github");
});

test("classifyContent scans ASCII credentials inside NUL-tainted buffers", () => {
  const token = ["ghs", "qR7tV9xB2dF4hJ6kL8mN0pQ2sT4vW6yZ8aB0cD2eF4g"].join("_");
  const binary = Buffer.concat([Buffer.from([0, 255, 254]), Buffer.from(token)]);

  assert.equal(classifyContent("fixtures/tainted.bin", binary)?.rule, "credential-github");
});

test("classifyContent detects underscore-bearing GitHub tokens", () => {
  const token = ["gho", "qR7tV9xB2dF4_hJ6kL8mN0pQ2sT4vW6yZ8aB0cD2eF4g"].join("_");

  assert.equal(classifyContent("config/oauth-token.txt", token)?.rule, "credential-github");
});

test("classifyContent detects UTF-16 encoded GitHub tokens", () => {
  const token = ["ghs", "qR7tV9xB2dF4hJ6kL8mN0pQ2sT4vW6yZ8aB0cD2eF4g"].join("_");

  assert.equal(
    classifyContent("fixtures/utf16le.bin", Buffer.from(token, "utf16le"))?.rule,
    "credential-github",
  );

  const bigEndian = Buffer.from(token, "utf16le");
  bigEndian.swap16();
  assert.equal(classifyContent("fixtures/utf16be.bin", bigEndian)?.rule, "credential-github");
});

test("classifyContent detects offset, truncated, UTF-32, and NUL-split GitHub tokens", () => {
  const githubToken = ["ghs", "qR7tV9xB2dF4hJ6kL8mN0pQ2sT4vW6yZ8aB0cD2eF4g"].join("_");
  const utf16le = Buffer.from(githubToken, "utf16le");
  const utf16be = Buffer.from(utf16le).swap16();
  const utf32le = Buffer.concat([...githubToken].map((character) => Buffer.from([
    character.charCodeAt(0), 0, 0, 0,
  ])));
  const utf32be = Buffer.concat([...githubToken].map((character) => Buffer.from([
    0, 0, 0, character.charCodeAt(0),
  ])));
  const nulSplit = Buffer.from(githubToken.replace("qR7", "q\0R7"), "latin1");

  for (const [path, content] of [
    ["fixtures/utf16le-trailing.bin", Buffer.concat([utf16le, Buffer.from([255])])],
    ["fixtures/utf16le-offset.bin", Buffer.concat([Buffer.from([255]), utf16le])],
    ["fixtures/utf16be-offset.bin", Buffer.concat([Buffer.from([255]), utf16be])],
    ["fixtures/utf32le.bin", utf32le],
    ["fixtures/utf32be.bin", utf32be],
    ["fixtures/nul-split.bin", nulSplit],
  ]) {
    assert.equal(classifyContent(path, content)?.rule, "credential-github", path);
  }
});

test("classifyContent preserves encoded credential prefixes before malformed trailers", () => {
  const githubToken = ["ghs", "qR7tV9xB2dF4hJ6kL8mN0pQ2sT4vW6yZ8aB0cD2eF4g"].join("_");
  const utf16le = Buffer.from(githubToken, "utf16le");
  const utf32le = Buffer.concat([...githubToken].map((character) => Buffer.from([
    character.charCodeAt(0), 0, 0, 0,
  ])));
  const utf32be = Buffer.concat([...githubToken].map((character) => Buffer.from([
    0, 0, 0, character.charCodeAt(0),
  ])));

  for (const [path, content] of [
    ["fixtures/utf16le-malformed.bin", Buffer.concat([
      Buffer.from("a"), utf16le, Buffer.from([0x00, 0xd8]),
    ])],
    ["fixtures/utf32le-malformed.bin", Buffer.concat([
      Buffer.from("a"), utf32le, Buffer.from([0x00, 0x00, 0x11, 0x00]),
    ])],
    ["fixtures/utf32be-malformed.bin", Buffer.concat([
      Buffer.from("a"), utf32be, Buffer.from([0x00, 0x11, 0x00, 0x00]),
    ])],
  ]) {
    assert.equal(classifyContent(path, content)?.rule, "credential-github", path);
  }
});

test("classifyContent safely skips binary buffers", () => {
  const binary = Buffer.from([0, 255, 254, ...Buffer.from("/Users/dr.tom/private")]);
  assert.doesNotThrow(() => classifyContent("fixtures/profile.db", binary));
  assert.equal(classifyContent("fixtures/profile.db", binary), null);
});

test("classifyContent checks the entire bounded buffer for binary NUL bytes", () => {
  const binary = Buffer.concat([
    Buffer.alloc(9000, "a"),
    Buffer.from([0]),
    Buffer.from("/Users/dr.tom/private"),
  ]);
  assert.equal(classifyContent("fixtures/late-nul.db", binary), null);
});

test("scanRepository checks content only when enabled", async () => {
  await withTempDirectory(async (root) => {
    await writeFixture(root, "docs/setup.md", "Use /Users/dr.tom/project for local setup.\n");

    assert.deepEqual(await scanRepository(root), []);
    const violations = await scanRepository(root, { checkContent: true });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "docs/setup.md");
    assert.equal(violations[0].rule, "founder-path");
  });
});

test("scanRepository rejects symbolic link candidates", async () => {
  await withTempDirectory(async (root) => {
    await writeFixture(root, "target.txt", "ordinary content\n");
    await symlink("target.txt", join(root, "linked.txt"));

    const violations = await scanRepository(root, { checkContent: true });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "linked.txt");
    assert.equal(violations[0].rule, "symlink");
  });
});

test("scanRepository rejects candidates escaping through a symlinked parent", async () => {
  await withTempDirectory(async (root) => {
    await withTempDirectory(async (outside) => {
      execFileSync("git", ["init", "--quiet", root]);
      await writeFixture(root, "parent/file.txt", "tracked fixture\n");
      execFileSync("git", ["-C", root, "add", "parent/file.txt"]);
      await writeFixture(root, ".gitignore", "parent\n");
      await rm(join(root, "parent"), { recursive: true });
      await writeFixture(outside, "file.txt", "outside fixture\n");
      await symlink(outside, join(root, "parent"));

      const violations = await scanRepository(root, { checkContent: true });
      assert.equal(violations.length, 1);
      assert.equal(violations[0].path, "parent/file.txt");
      assert.equal(violations[0].rule, "path-escape");
    });
  });
});

test("scanRepository does not inspect content after a forbidden path violation", async () => {
  await withTempDirectory(async (root) => {
    await writeFixture(root, "runs/private/result.txt", "/Users/dr.tom/private\n");

    const violations = await scanRepository(root, { checkContent: true });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "forbidden-path");
  });
});

test("scanRepository does not inspect content after a size violation", async () => {
  await withTempDirectory(async (root) => {
    await writeFixture(root, "large.txt", "/Users/dr.tom/private\n");

    const violations = await scanRepository(root, {
      checkContent: true,
      maxFileSize: 8,
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "large-file");
  });
});

test("scanRepository bounds content reads for allowlisted large files", async () => {
  await withTempDirectory(async (root) => {
    await writeFixture(root, "large.txt", `safe-prefix-${"x".repeat(64)}/Users/dr.tom/private\n`);

    const violations = await scanRepository(root, {
      checkContent: true,
      contentScanLimit: 32,
      maxFileSize: 16,
      sizeAllowlist: ["large.txt"],
    });
    assert.deepEqual(violations, []);
  });
});

test("scanRepository rejects files changed during a bounded content read", async () => {
  await withTempDirectory(async (root) => {
    const candidatePath = join(root, "changing.txt");
    await writeFixture(root, "changing.txt", "ordinary content\n");

    const probe = await openFile(candidatePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    const originalRead = fileHandlePrototype.read;
    await probe.close();
    let mutated = false;

    fileHandlePrototype.read = async function patchedRead(...args) {
      const result = await originalRead.apply(this, args);
      if (!mutated) {
        mutated = true;
        await appendFile(candidatePath, "changed\n");
      }
      return result;
    };

    try {
      const violations = await scanRepository(root, { checkContent: true });
      assert.equal(mutated, true);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].path, "changing.txt");
      assert.equal(violations[0].rule, "file-changed-during-read");
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });
});

test("scanRepository rejects a candidate swapped to a symlink before content open", async () => {
  await withTempDirectory(async (root) => {
    const candidatePath = join(root, "candidate.txt");
    await writeFixture(root, "candidate.txt", "x".repeat(32));
    await writeFixture(root, "target.txt", "/Users/dr.tom/x");

    const violations = await scanRepository(root, {
      checkContent: true,
      contentAllowlist: ["target.txt"],
      maxFileSize: 20,
      sizeAllowlist: (path) => {
        if (path === "candidate.txt") {
          unlinkSync(candidatePath);
          symlinkSync("target.txt", candidatePath);
        }
        return true;
      },
    });

    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "candidate.txt");
    assert.equal(violations[0].rule, "symlink");
  });
});

test("scanRepository rejects ignored known-sensitive paths in a Git repository", async () => {
  await withTempDirectory(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFixture(root, ".gitignore", "output/\nbrowser-first/certs/\n");
    await writeFixture(root, "output/local-report.json");
    await writeFixture(root, "browser-first/certs/resonantos-ca.crt");

    const violations = await scanRepository(root);
    assert.deepEqual(
      violations.map(({ path, rule }) => ({ path, rule })),
      [
        { path: "browser-first/certs/resonantos-ca.crt", rule: "generated-certificate" },
        { path: "output/local-report.json", rule: "forbidden-path" },
      ],
    );
  });
});

test("scanRepository prunes ignored dependency, build, and cache trees", async () => {
  await withTempDirectory(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFixture(root, ".gitignore", "node_modules/\ndist/\nbuild/\n.cache/\n");
    await writeFixture(root, "node_modules/example/output/private.json");
    await writeFixture(root, "node_modules/example/output/tracked.json");
    await writeFixture(root, "dist/runs/private.json");
    await writeFixture(root, "build/ResonantOS_User/private.json");
    await writeFixture(root, ".cache/browser-first/certs/private.pem");
    execFileSync("git", [
      "-C",
      root,
      "add",
      "-f",
      "node_modules/example/output/tracked.json",
    ]);

    const violations = await scanRepository(root);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "node_modules/example/output/tracked.json");
    assert.equal(violations[0].rule, "forbidden-path");
  });
});

test("scanRepository rejects untracked nonignored forbidden files in a Git repository", async () => {
  await withTempDirectory(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFixture(root, "runs/private/result.json");

    const violations = await scanRepository(root);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "runs/private/result.json");
    assert.equal(violations[0].rule, "forbidden-path");
  });
});

test("scanRepository preserves POSIX backslashes in Git candidate filenames", {
  skip: process.platform === "win32",
}, async () => {
  await withTempDirectory(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFixture(root, "docs\\setup.md", "/Users/dr.tom/project\n");

    const violations = await scanRepository(root, { checkContent: true });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "docs\\setup.md");
    assert.equal(violations[0].rule, "founder-path");
  });
});

test("scanRepository reports Git candidate paths that are not valid UTF-8", {
  skip: process.platform === "win32",
}, async () => {
  await withTempDirectory(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    const blobHash = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      encoding: "utf8",
      input: "fixture\n",
    }).trim();
    const indexEntry = Buffer.concat([
      Buffer.from(`100644 ${blobHash}\tinvalid-`),
      Buffer.from([0xff, 0]),
    ]);
    execFileSync("git", ["-C", root, "update-index", "-z", "--index-info"], {
      input: indexEntry,
    });

    const violations = await scanRepository(root);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "unsupported-path-encoding");
    assert.match(violations[0].message, /UTF-8|encoding/i);
  });
});

test("scanRepository still rejects tracked files under ignored paths", async () => {
  await withTempDirectory(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFixture(root, ".gitignore", "output/\n");
    await writeFixture(root, "output/tracked-report.json");
    execFileSync("git", ["-C", root, "add", "-f", "output/tracked-report.json"]);

    const violations = await scanRepository(root);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "output/tracked-report.json");
    assert.equal(violations[0].rule, "forbidden-path");
  });
});

test("scanRepository rejects a force-tracked browser-first generated certificate", async () => {
  await withTempDirectory(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFixture(root, ".gitignore", "browser-first/certs/\n");
    await writeFixture(root, "browser-first/certs/resonantos-ca.crt", "generated certificate\n");
    await writeFixture(root, "test/fixtures/reviewed-ca.crt", "reviewed certificate fixture\n");
    execFileSync("git", ["-C", root, "add", "test/fixtures/reviewed-ca.crt"]);
    execFileSync("git", ["-C", root, "add", "-f", "browser-first/certs/resonantos-ca.crt"]);

    const violations = await scanRepository(root);

    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "browser-first/certs/resonantos-ca.crt");
    assert.equal(violations[0].rule, "generated-certificate");
  });
});

test("scanRepository rejects force-tracked payloads under custom browser profile directories", async () => {
  await withTempDirectory(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFixture(root, ".gitignore", "chrome-user-data/\nprofiles/\nLibrary/\n");
    const profilePayloads = [
      "Library/Application Support/Google/Chrome/Wallet Main/Extension State/CURRENT",
      "chrome-user-data/Research Persona/Preferences",
      "profiles/wallet-main/Local Storage/leveldb/CURRENT",
    ];

    for (const path of profilePayloads) {
      await writeFixture(root, path);
      execFileSync("git", ["-C", root, "add", "-f", "--", path]);
    }

    const violations = await scanRepository(root);
    assert.deepEqual(
      violations.map(({ path, rule }) => ({ path, rule })),
      profilePayloads
        .toSorted()
        .map((path) => ({ path, rule: "browser-profile" })),
    );
  });
});

test("scanRepository does not allow tracked credentials to bypass content scanning", async () => {
  await withTempDirectory(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFixture(root, ".gitignore", "*.env\n");
    const credential = token("sk-api-", "N8pQ2rS4tV6wX9yZ3aB5cD7e");
    await writeFixture(root, "provider.env", `OPENAI_API_KEY=${credential}\n`);
    execFileSync("git", ["-C", root, "add", "-f", "provider.env"]);

    const violations = await scanRepository(root, {
      checkContent: true,
      contentAllowlist: ["provider.env"],
    });

    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "provider.env");
    assert.equal(violations[0].rule, "credential-openai");
  });
});

test("CLI exits zero for a clean repository", async () => {
  await withTempDirectory(async (root) => {
    await writeFixture(root, "README.md", "Clean fixture\n");
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed/i);
    assert.match(result.stdout, /prefix/i);
    assert.match(result.stdout, /10 MiB|10485760/);
  });
});

test("CLI enables founder-path content scanning", async () => {
  await withTempDirectory(async (root) => {
    await writeFixture(root, "docs/setup.md", "/Users/dr.tom/project\n");
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: root,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /docs\/setup\.md/);
    assert.match(`${result.stdout}\n${result.stderr}`, /founder-path/);
  });
});

test("CLI credential diagnostics identify the path and rule without logging the value", async () => {
  await withTempDirectory(async (root) => {
    const credential = token("ghp_", "qR3sT5uV7wX9yZ2aB4cD6eF8gH1jK3mN5pQ7");
    await writeFixture(root, "config/provider.txt", `TOKEN=${credential}\n`);
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: root,
      encoding: "utf8",
    });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0);
    assert.match(output, /config\/provider\.txt/);
    assert.match(output, /credential-github/);
    assert.equal(output.includes(credential), false);
  });
});

test("CLI accepts an explicit content allowlist path", async () => {
  await withTempDirectory(async (root) => {
    await writeFixture(root, "docs/historical.md", "/Users/dr.tom/archive\n");
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--content-allowlist", "docs/historical.md"],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed/i);
  });
});

test("CLI executes when the script path is a symbolic link", async () => {
  await withTempDirectory(async (root) => {
    const repositoryRoot = join(root, "repository");
    const linkedScript = join(root, "check-repo-hygiene-link.mjs");
    await mkdir(repositoryRoot);
    await writeFixture(repositoryRoot, "README.md", "Clean fixture\n");
    await symlink(SCRIPT_PATH, linkedScript);

    const result = spawnSync(process.execPath, [linkedScript], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed/i);
  });
});

test("CLI prints actionable violations and exits nonzero", async () => {
  await withTempDirectory(async (root) => {
    await writeFixture(root, "runs/private/result.json");
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: root,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /runs\/private\/result\.json/);
    assert.match(`${result.stdout}\n${result.stderr}`, /remove|archive|outside/i);
  });
});

test("CLI quotes and escapes control characters in diagnostic paths", {
  skip: process.platform === "win32",
}, async () => {
  await withTempDirectory(async (root) => {
    const filename = "bad\n\u001b[31m.zip";
    await writeFixture(root, filename);
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: root,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.includes("\u001b"), false);
    assert.equal(result.stderr.includes(JSON.stringify(filename)), true);
  });
});

test("alpha-build declares explicit least-privilege token permissions", async () => {
  const workflow = parse(await readFile(ALPHA_BUILD_WORKFLOW_PATH, "utf8"));

  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "alpha-build must set workflow-level contents: read permissions",
  );
});
