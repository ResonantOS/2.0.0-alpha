#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { parseFragment } from "parse5";

import * as validateDocs from "./validate-docs.mjs";

const {
  extractMarkdownLinks,
  extractNpmScripts,
  validateAdrIndex,
  validateCanonicalClaims,
  validateRepositoryDocs,
} = validateDocs;

const SCRIPT_PATH = fileURLToPath(new URL("./validate-docs.mjs", import.meta.url));

function writeFixture(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function makeRepository() {
  const root = mkdtempSync(join(tmpdir(), "validate-docs-"));

  writeFixture(root, "package.json", JSON.stringify({
    name: "docs-fixture",
    type: "module",
    engines: { node: ">=22.13.0" },
    scripts: {
      check: "node --check scripts/validate-docs.mjs",
      "docs:check": "node scripts/validate-docs.mjs",
      "test:docs": "node --test scripts/validate-docs.test.mjs",
    },
  }, null, 2));
  writeFixture(root, ".nvmrc", "22.13.0\n");
  writeFixture(root, "package-lock.json", JSON.stringify({
    name: "docs-fixture",
    lockfileVersion: 3,
    packages: {
      "": { engines: { node: ">=22.13.0" } },
      "node_modules/jsdom": {
        version: "29.0.2",
        engines: { node: "^20.19.0 || ^22.13.0 || >=24.0.0" },
      },
    },
  }, null, 2));
  writeFixture(root, "addons/resonant-browser-host/package.json", JSON.stringify({
    name: "@fixture/browser-host",
    private: true,
    engines: { node: ">=22.13.0" },
  }, null, 2));
  writeFixture(root, "addons/resonant-browser-host/package-lock.json", JSON.stringify({
    name: "@fixture/browser-host",
    lockfileVersion: 3,
    packages: {
      "": { engines: { node: ">=22.13.0" } },
      "node_modules/browser-host-dependency": {
        version: "1.0.0",
        engines: { node: "^22.13.0 || >=24.0.0" },
      },
    },
  }, null, 2));
  writeFixture(root, ".github/workflows/checks.yml", [
    "jobs:",
    "  checks:",
    "    steps:",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version-file: .nvmrc",
    "      - run: npm ci --prefix addons/resonant-browser-host",
  ].join("\n"));

  writeFixture(root, "AGENTS.md", [
    "# Agent Guide",
    "",
    "## Required Reading Order",
    "1. [Read this agent guide](AGENTS.md)",
    "2. [Read the overview](README.md)",
    "3. [Install the runtime](INSTALL.md)",
    "4. [Contribute safely](CONTRIBUTING.md)",
    "5. [Use the documentation index](docs/README.md)",
  ].join("\n"));
  writeFixture(root, "README.md", [
    "# Fixture",
    "",
    "Run `npm run check`.",
    "",
    "[Install](INSTALL.md)",
  ].join("\n"));
  writeFixture(root, "INSTALL.md", "# Install\n\n[Contribute](CONTRIBUTING.md)\n");
  writeFixture(root, "CONTRIBUTING.md", "# Contributing\n\n[Documentation](docs/README.md)\n");
  writeFixture(root, "docs/README.md", [
    "# Documentation",
    "",
    "[Status](STATUS.md)",
    "[Linked page](linked.md#linked-heading)",
    "[Architecture decisions](architecture/README.md)",
  ].join("\n"));
  writeFixture(root, "docs/STATUS.md", "# Status\n\nThis is the current status source of truth.\n");
  writeFixture(root, "docs/linked.md", "# Linked Heading\n");
  writeFixture(root, "docs/architecture/README.md", [
    "# Architecture Decisions",
    "",
    "| ADR | Decision status | Alpha applicability | Superseded by | Owner |",
    "| --- | --- | --- | --- | --- |",
    "| [ADR-001: Fixture decision](ADR-001-fixture.md) | Accepted | Applies | - | Core architecture |",
  ].join("\n"));
  writeFixture(root, "docs/architecture/ADR-001-fixture.md", [
    "# ADR-001: Fixture decision",
    "",
    "## Decision Metadata",
    "",
    "- Decision status: Accepted",
    "- Alpha applicability: Applies",
    "- Superseded by: None",
    "- Owner: Core architecture",
    "",
    "## Decision",
    "The fixture uses the supported runtime.",
  ].join("\n"));

  return root;
}

function withRepository(run) {
  const root = makeRepository();
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function messages(findings) {
  return findings.map((finding) => `${finding.path}:${finding.line} ${finding.message}`);
}

function findHtmlElement(node, tagName) {
  if (node?.tagName === tagName) return node;
  for (const child of node?.childNodes ?? []) {
    const match = findHtmlElement(child, tagName);
    if (match) return match;
  }
  return node?.content ? findHtmlElement(node.content, tagName) : null;
}

function parse5SrcsetAttribute(rawValue) {
  const html = parseFragment(`<img srcset="${rawValue}">`, { sourceCodeLocationInfo: true });
  return findHtmlElement(html, "img").attrs.find((attribute) => attribute.name === "srcset");
}

function assertValidProvenance(rawValue, expectedValue) {
  assert.equal(
    typeof validateDocs.decodeHtmlAttributeWithOffsets,
    "function",
    "the total attribute provenance mapper must be exported for differential verification",
  );
  const mapped = validateDocs.decodeHtmlAttributeWithOffsets(rawValue);
  assert.equal(mapped.text, expectedValue, `decoded parity for ${JSON.stringify(rawValue)}`);
  assert.equal(mapped.offsets.length, mapped.text.length, `map length for ${JSON.stringify(rawValue)}`);
  let previous = -1;
  for (const origin of mapped.offsets) {
    assert(Number.isInteger(origin), `integer origin for ${JSON.stringify(rawValue)}`);
    assert(origin >= 0 && origin < rawValue.length, `in-range origin for ${JSON.stringify(rawValue)}`);
    assert(origin >= previous, `nondecreasing origin for ${JSON.stringify(rawValue)}`);
    previous = origin;
  }
  return mapped;
}

function srcsetTargets(value) {
  return extractMarkdownLinks(`<img srcset="${value}">`).map((link) => link.target);
}

test("extractMarkdownLinks returns inline Markdown link targets", () => {
  assert.deepEqual(
    extractMarkdownLinks("[Guide](docs/README.md#start) and [Install](INSTALL.md \"title\")"),
    [
      { label: "Guide", target: "docs/README.md#start" },
      { label: "Install", target: "INSTALL.md" },
    ],
  );
});

test("extractMarkdownLinks uses Markdown structure for references, nested labels, HTML, and code exclusion", () => {
  const targets = extractMarkdownLinks([
    "[outer [nested] label][guide]",
    "",
    "[guide]: docs/linked.md#linked-heading",
    "",
    "<a href=\"docs/linked.md#linked-heading\">HTML guide</a>",
    "",
    "``[ignored inline](ignored.md)``",
    "",
    "````markdown",
    "[ignored fence](ignored.md)",
    "````",
  ].join("\n")).map(({ target }) => target);

  assert.deepEqual(targets, [
    "docs/linked.md#linked-heading",
    "docs/linked.md#linked-heading",
  ]);
});

test("extractMarkdownLinks uses the first CommonMark definition", () => {
  assert.deepEqual(
    extractMarkdownLinks("[Guide][guide]\n\n[guide]: docs/first.md\n[guide]: docs/second.md"),
    [{ label: "Guide", target: "docs/first.md" }],
  );
});

test("extractMarkdownLinks finds isolated inline SVG image resources in source order", () => {
  assert.deepEqual(
    extractMarkdownLinks([
      "[Before](before.md)",
      '<svg><image href="missing-href.png"></image></svg>',
      '<svg><image xlink:href="missing-xlink.png"></image></svg>',
      '<svg><image href="missing-self-closing.png"/></svg>',
      "[After](after.md)",
    ].join("\n")),
    [
      { label: "Before", target: "before.md" },
      { label: "", target: "missing-href.png" },
      { label: "", target: "missing-xlink.png" },
      { label: "", target: "missing-self-closing.png" },
      { label: "After", target: "after.md" },
    ],
  );
});

test("extractMarkdownLinks finds ordinary template-contained image resources in source order", () => {
  assert.deepEqual(
    extractMarkdownLinks('<template><img src="hidden.png"></template><img src="visible.png">'),
    [
      { label: "", target: "hidden.png" },
      { label: "", target: "visible.png" },
    ],
  );
});

test("extractMarkdownLinks finds template-contained SVG image resources in source order", () => {
  assert.deepEqual(
    extractMarkdownLinks(
      '<template><svg><image href="template.svg"/></svg></template><img src="visible-after-svg.png">',
    ),
    [
      { label: "", target: "template.svg" },
      { label: "", target: "visible-after-svg.png" },
    ],
  );
});

test("extractMarkdownLinks ignores inline SVG lookalikes outside parsed HTML", () => {
  assert.deepEqual(
    extractMarkdownLinks([
      'image href="ordinary-prose.png" is ordinary prose.',
      '`<svg><image href="inline-code.png"/></svg>`',
      '<!-- <svg><image href="comment.png"/></svg> -->',
      '<script>const sample = \'<svg><image href="script.png"/></svg>\';</script>',
      '<style>.sample::after { content: \'<svg><image href="style.png"/></svg>\'; }</style>',
      '<textarea><svg><image href="textarea.png"/></svg></textarea>',
      "```html",
      '<svg><image href="fence.png"/></svg>',
      "```",
    ].join("\n\n")),
    [],
  );
});

test("HTML projection finds template resources while gating code and comments through mdast", () => {
  assert.deepEqual(
    extractMarkdownLinks([
      '<template>text *emphasis* <img src="template-gap.png"></template><img src="visible-gap.png">',
      '`<img src="inline-code.png">`',
      '<!-- <img src="comment.png"> -->',
      "```html",
      '<img src="fenced-code.png">',
      "```",
    ].join("\n\n")),
    [
      { label: "", target: "template-gap.png" },
      { label: "", target: "visible-gap.png" },
    ],
  );
});

test("HTML projection preserves split raw-text context for resources", () => {
  for (const tagName of ["script", "style", "textarea", "title"]) {
    assert.deepEqual(
      extractMarkdownLinks(
        `before <${tagName}>text *emphasis* <img src="hidden-${tagName}.png"></${tagName}>`
          + `<img src="visible-${tagName}.png">`,
      ),
      [{ label: "", target: `visible-${tagName}.png` }],
    );
  }
});

test("extractNpmScripts returns unique documented npm run names", () => {
  assert.deepEqual(
    extractNpmScripts(
      "npm run test:docs -- --watch\n`npm run build`\nnpm run @scope/docs:check\nnpm run foo-\nnpm run foo/\nnpm run foo@\nnpm run prose-dot.\nnpm run prose-comma,\nnpm run prose-colon:\n`npm run literal-dot.`\n`npm run literal-colon:`\nnpm run test:docs",
    ),
    ["@scope/docs:check", "build", "foo-", "foo/", "foo@", "literal-colon:", "literal-dot.", "prose-colon", "prose-comma", "prose-dot", "test:docs"],
  );
});

test("validateRepositoryDocs ignores headings inside long code fences", () => {
  withRepository((root) => {
    writeFixture(root, "docs/code.md", "````markdown\n# Hidden heading\n````\n");
    writeFixture(root, "docs/README.md", "# Documentation\n\n[Hidden](code.md#hidden-heading)\n");
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("heading anchor \"hidden-heading\"")));
  });
});

test("validateRepositoryDocs reports malformed percent encoding in local paths and fragments", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "[Bad path](linked%ZZ.md)",
      "[Bad fragment](linked.md#%ZZ)",
    ].join("\n"));
    assert.doesNotThrow(() => validateRepositoryDocs(root));
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("linked%ZZ.md") && message.includes("invalid URL encoding")));
    assert(output.some((message) => message.includes("%ZZ") && message.includes("invalid URL encoding")));
  });
});

test("validateRepositoryDocs decodes local paths before classifying Markdown suffixes", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", "# Documentation\n\n[Encoded](linked%2Emd#not-a-heading)\n");
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("heading anchor \"not-a-heading\"") && message.includes("docs/linked.md")));
  });
});

test("validateRepositoryDocs resolves id and name anchors on all HTML elements", () => {
  withRepository((root) => {
    writeFixture(root, "docs/linked.md", "<section id=\"section-anchor\"></section>\n<span name=\"legacy-anchor\"></span>\n");
    writeFixture(root, "docs/README.md", "# Documentation\n\n[Section](linked.md#section-anchor)\n[Legacy](linked.md#legacy-anchor)\n");
    const output = messages(validateRepositoryDocs(root).findings);
    assert(!output.some((message) => message.includes("section-anchor") || message.includes("legacy-anchor")));
  });
});

test("HTML projection keeps multiline nested template anchors inert", () => {
  withRepository((root) => {
    writeFixture(root, "docs/target.md", [
      "<template>",
      "  <div>",
      "    <template>",
      '      <section id="multiline"></section>',
      "    </template>",
      "  </div>",
      "</template>",
      '<section id="live-anchor"></section>',
    ].join("\n"));
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "[Inert template anchor](target.md#multiline)",
      "[Live anchor](target.md#live-anchor)",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes(
      'docs/README.md:3 heading anchor "multiline" does not exist in docs/target.md',
    )));
    assert(!output.some((message) => message.includes("live-anchor")));
  });
});

test("HTML projection keeps one-line template descendants inert and surrounding anchors live", () => {
  withRepository((root) => {
    writeFixture(
      root,
      "docs/target.md",
      '<template id="template-own"><span id="hidden-inline" name="hidden-name"></span></template>'
        + '<span id="live-inline"></span>',
    );
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "[Template element](target.md#template-own)",
      "[Hidden ID](target.md#hidden-inline)",
      "[Hidden name](target.md#hidden-name)",
      "[Live after template](target.md#live-inline)",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    for (const anchor of ["hidden-inline", "hidden-name"]) {
      assert(output.some((message) => message.includes(`heading anchor "${anchor}" does not exist`)));
    }
    for (const anchor of ["template-own", "live-inline"]) {
      assert(!output.some((message) => message.includes(`heading anchor "${anchor}" does not exist`)));
    }
  });
});

test("HTML projection keeps template anchors inert across intervening mdast nodes", () => {
  withRepository((root) => {
    writeFixture(
      root,
      "docs/target.md",
      '<template>text *emphasis* <span id="hidden-gap"></span></template><span id="live-gap"></span>',
    );
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "[Hidden gap](target.md#hidden-gap)",
      "[Live gap](target.md#live-gap)",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes('heading anchor "hidden-gap" does not exist')));
    assert(!output.some((message) => message.includes('heading anchor "live-gap" does not exist')));
  });
});

test("HTML projection keeps one-line nested template anchors inert", () => {
  withRepository((root) => {
    writeFixture(
      root,
      "docs/target.md",
      '<template><template><span id="hidden-nested"></span></template></template>'
        + '<span id="live-nested"></span>',
    );
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "[Hidden nested](target.md#hidden-nested)",
      "[Live nested](target.md#live-nested)",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes('heading anchor "hidden-nested" does not exist')));
    assert(!output.some((message) => message.includes('heading anchor "live-nested" does not exist')));
  });
});

test("HTML projection preserves split raw-text context for anchors", () => {
  withRepository((root) => {
    const tagNames = ["script", "style", "textarea", "title"];
    writeFixture(root, "docs/target.md", tagNames.map((tagName) => (
      `before <${tagName}>text *emphasis* <span id="hidden-${tagName}"></span></${tagName}>`
        + `<span id="live-${tagName}"></span>`
    )).join("\n"));
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      ...tagNames.flatMap((tagName) => [
        `[Hidden ${tagName}](target.md#hidden-${tagName})`,
        `[Live ${tagName}](target.md#live-${tagName})`,
      ]),
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    for (const tagName of tagNames) {
      assert(output.some((message) => message.includes(`heading anchor "hidden-${tagName}" does not exist`)));
      assert(!output.some((message) => message.includes(`heading anchor "live-${tagName}" does not exist`)));
    }
  });
});

test("HTML projection treats template-widget descendants as live anchors", () => {
  withRepository((root) => {
    writeFixture(
      root,
      "docs/target.md",
      '<template-widget><span id="custom-live"></span></template-widget>',
    );
    writeFixture(root, "docs/README.md", "# Documentation\n\n[Custom](target.md#custom-live)\n");

    const output = messages(validateRepositoryDocs(root).findings);
    assert(!output.some((message) => message.includes("custom-live")));
  });
});

test("HTML projection separates live and template-contained SVG behavior", () => {
  withRepository((root) => {
    const target = '<svg><g id="live-svg"></g></svg>'
      + '<template><svg><g id="hidden-svg"></g><image href="template-svg.png"/></svg></template>';
    writeFixture(root, "docs/target.md", target);
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "[Live SVG](target.md#live-svg)",
      "[Hidden SVG](target.md#hidden-svg)",
    ].join("\n"));

    assert.deepEqual(extractMarkdownLinks(target), [{ label: "", target: "template-svg.png" }]);
    const output = messages(validateRepositoryDocs(root).findings);
    assert(!output.some((message) => message.includes('heading anchor "live-svg" does not exist')));
    assert(output.some((message) => message.includes('heading anchor "hidden-svg" does not exist')));
  });
});

test("HTML projection handles unclosed and stray template boundaries", () => {
  withRepository((root) => {
    const unclosed = '<template id="template-eof">text *emphasis* '
      + '<span id="hidden-eof"></span><img src="template-eof.png">';
    writeFixture(root, "docs/unclosed.md", unclosed);
    writeFixture(root, "docs/stray.md", '</template>text *emphasis* <span id="live-stray"></span>');
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "[Template element](unclosed.md#template-eof)",
      "[Hidden through EOF](unclosed.md#hidden-eof)",
      "[Live after stray close](stray.md#live-stray)",
    ].join("\n"));

    assert.deepEqual(extractMarkdownLinks(unclosed), [{ label: "", target: "template-eof.png" }]);
    const output = messages(validateRepositoryDocs(root).findings);
    assert(!output.some((message) => message.includes('heading anchor "template-eof" does not exist')));
    assert(output.some((message) => message.includes('heading anchor "hidden-eof" does not exist')));
    assert(!output.some((message) => message.includes('heading anchor "live-stray" does not exist')));
  });
});

test("validateRepositoryDocs ignores HTML comments when extracting links and anchors", () => {
  withRepository((root) => {
    assert.deepEqual(extractMarkdownLinks("<!-- <a href=\"docs/hidden.md\">Hidden</a> -->"), []);
    writeFixture(root, "docs/linked.md", "<!-- <section id=\"hidden-anchor\"></section> -->\n");
    writeFixture(root, "docs/README.md", "# Documentation\n\n[Hidden](linked.md#hidden-anchor)\n");
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("hidden-anchor") && message.includes("does not exist")));
  });
});

test("validateRepositoryDocs ignores markup strings inside raw-text HTML containers", () => {
  withRepository((root) => {
    writeFixture(root, "docs/linked.md", [
      "<script>const markup = '<div id=\"script-anchor\"></div>';</script>",
      "<style>.sample::after { content: '<span id=\"style-anchor\"></span>'; }</style>",
      "<textarea><div id=\"textarea-anchor\"></div></textarea>",
      "<section id=\"real-anchor\"></section>",
    ].join("\n"));
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "[Script](linked.md#script-anchor)",
      "[Style](linked.md#style-anchor)",
      "[Textarea](linked.md#textarea-anchor)",
      "[Real](linked.md#real-anchor)",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("script-anchor") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("style-anchor") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("textarea-anchor") && message.includes("does not exist")));
    assert(!output.some((message) => message.includes("real-anchor")));
  });
});

test("extractMarkdownLinks resumes after browser-tokenized raw-text end tags", () => {
  for (const closingTag of [
    "</script data-x>",
    "</script/>",
    "</style data-x>",
    "</textarea data-x>",
  ]) {
    const openingTag = closingTag.includes("style")
      ? "<style>"
      : closingTag.includes("textarea")
        ? "<textarea>"
        : "<script>";
    assert.deepEqual(
      extractMarkdownLinks(`${openingTag}ignored${closingTag}<img src="visible.png">`),
      [{ label: "", target: "visible.png" }],
    );
  }

  for (const tagName of ["script", "style", "textarea", "title"]) {
    assert.deepEqual(
      extractMarkdownLinks(`<${tagName}><!--</${tagName}>--><img src="visible-${tagName}.png">`),
      [{ label: "", target: `visible-${tagName}.png` }],
    );
  }
});

test("validateRepositoryDocs suppresses markup inside unclosed raw-text containers through EOF", () => {
  withRepository((root) => {
    writeFixture(root, "docs/unclosed-script.md", "<script id=\"real-script-anchor\">\nconst markup = '<div id=\"script-anchor\"></div>';\n");
    writeFixture(root, "docs/unclosed-style.md", "<style>\n.sample::after { content: '<span id=\"style-anchor\"></span>'; }\n");
    writeFixture(root, "docs/unclosed-textarea.md", "<textarea>\n<section id=\"textarea-anchor\"></section>\n");
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "[Script](unclosed-script.md#script-anchor)",
      "[Style](unclosed-style.md#style-anchor)",
      "[Textarea](unclosed-textarea.md#textarea-anchor)",
      "[Real script element](unclosed-script.md#real-script-anchor)",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("script-anchor") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("style-anchor") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("textarea-anchor") && message.includes("does not exist")));
    assert(!output.some((message) => message.includes("real-script-anchor")));
  });
});

test("validateRepositoryDocs resolves local Markdown files and heading anchors", () => {
  withRepository((root) => {
    assert.deepEqual(validateRepositoryDocs(root).findings, []);

    writeFixture(root, "docs/README.md", "# Documentation\n\n[Missing](linked.md#not-a-heading)\n");
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("docs/README.md:3") && message.includes("heading anchor \"not-a-heading\"")));
  });
});

test("validateRepositoryDocs reports missing Markdown and HTML resource assets", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "![Missing diagram](assets/missing-diagram.png)",
      '<img src="assets/missing-preview.webp" alt="Missing preview">',
      "<img",
      '  srcset="assets/missing-small.png 1x, assets/missing-large.png 2x"',
      '  src="assets/missing-multiline.png">',
      '<object data="assets/missing-attachment.pdf"></object>',
      '<iframe src="assets/missing-frame.html"></iframe>',
      '<embed src="assets/missing-embed.svg">',
      '<track src="assets/missing-captions.vtt">',
      '<source srcset="data:image/svg+xml,%3Csvg%3E 1x, assets/missing-local.avif 2x">',
      '<source srcset="data:image/png;base64,AAAA, assets/missing-after-data.avif 2x">',
      '<source srcset="data:image/png;base64,AAAA,&#32;assets/missing-after-entity.avif 2x">',
      '<input src="assets/missing-input.png" type="image">',
      '<svg><image href="assets/missing-svg-image.png"></image></svg>',
      '<svg><use href="assets/missing-symbol.svg#icon"></use></svg>',
      '<svg><feImage href="assets/missing-filter.png"></feImage></svg>',
      '<svg><mpath href="assets/missing-motion.svg#path"></mpath></svg>',
      '<svg><script href="assets/missing-svg-script.js"></script></svg>',
      '<svg><a xlink:href="assets/missing-svg-guide.md"></a></svg>',
      '<link imagesrcset="assets/missing-preload-small.png 1x, assets/missing-preload-large.png 2x">',
      '<img src="assets&sol;missing-entity.png">',
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("assets/missing-diagram.png") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-preview.webp") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("docs/README.md:6") && message.includes("assets/missing-small.png")));
    assert(output.some((message) => message.includes("docs/README.md:6") && message.includes("assets/missing-large.png")));
    assert(output.some((message) => message.includes("docs/README.md:7") && message.includes("assets/missing-multiline.png")));
    assert(output.some((message) => message.includes("docs/README.md:8") && message.includes("assets/missing-attachment.pdf")));
    assert(output.some((message) => message.includes("assets/missing-frame.html") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-embed.svg") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-captions.vtt") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-local.avif") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-after-data.avif") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-after-entity.avif") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-input.png") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-svg-image.png") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-symbol.svg") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-filter.png") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-motion.svg") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-svg-script.js") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-svg-guide.md") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-preload-small.png") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-preload-large.png") && message.includes("does not exist")));
    assert(output.some((message) => message.includes("assets/missing-entity.png") && message.includes("does not exist")));
    assert(!output.some((message) => message.includes("%3Csvg%3E")));
  });
});

test("validateRepositoryDocs preserves lines and source order for isolated inline SVG resources", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      '<img src="assets/missing-before-svg.png">',
      '<svg><image href="assets/missing-svg-first.png"/><image xlink:href="assets/missing-svg-second.png"></image></svg>',
      '<img src="assets/missing-after-svg.png">',
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings)
      .filter((message) => message.includes("assets/missing-"));
    assert.deepEqual(output, [
      'docs/README.md:3 local target "assets/missing-before-svg.png" does not exist',
      'docs/README.md:4 local target "assets/missing-svg-first.png" does not exist',
      'docs/README.md:4 local target "assets/missing-svg-second.png" does not exist',
      'docs/README.md:5 local target "assets/missing-after-svg.png" does not exist',
    ]);
  });
});

test("HTML projection preserves CRLF astral and multiline resource offsets", () => {
  withRepository((root) => {
    const markdown = [
      "# Documentation",
      "",
      "\u{1F680} prefix <img",
      '  src="assets/missing-astral.png">',
      "<template><img",
      '  src="assets/missing-template-offset.png"></template><img src="assets/missing-after-offset.png">',
    ].join("\r\n");
    writeFixture(root, "docs/README.md", markdown);

    assert.deepEqual(extractMarkdownLinks(markdown).map(({ target }) => target), [
      "assets/missing-astral.png",
      "assets/missing-template-offset.png",
      "assets/missing-after-offset.png",
    ]);

    const output = messages(validateRepositoryDocs(root).findings)
      .filter((message) => message.includes("assets/missing-"));
    assert.deepEqual(output, [
      'docs/README.md:4 local target "assets/missing-astral.png" does not exist',
      'docs/README.md:6 local target "assets/missing-after-offset.png" does not exist',
      'docs/README.md:6 local target "assets/missing-template-offset.png" does not exist',
    ]);
  });
});

test("HTML projection preserves entity-heavy srcset source offsets", () => {
  withRepository((root) => {
    const markdown = [
      "# Documentation",
      "",
      '<img srcset="assets&amp;z-first.png 1x,',
      ' assets&amp;a-second.png 2x">',
      '<img srcset="assets/duplicate.png 1x,',
      ' assets/duplicate.png 2x">',
    ].join("\n");
    writeFixture(root, "docs/README.md", markdown);

    assert.deepEqual(extractMarkdownLinks(markdown).map(({ target }) => target), [
      "assets&z-first.png",
      "assets&a-second.png",
      "assets/duplicate.png",
      "assets/duplicate.png",
    ]);
    const output = messages(validateRepositoryDocs(root).findings)
      .filter((message) => message.includes("assets&") || message.includes("assets/duplicate.png"));
    assert.deepEqual(output, [
      'docs/README.md:3 local target "assets&z-first.png" does not exist',
      'docs/README.md:4 local target "assets&a-second.png" does not exist',
      'docs/README.md:5 local target "assets/duplicate.png" does not exist',
      'docs/README.md:6 local target "assets/duplicate.png" does not exist',
    ]);
  });
});

test("HTML projection preserves multiline &sol; srcset source offsets", () => {
  withRepository((root) => {
    const markdown = [
      '<img srcset="assets&sol;first.png 1x,',
      ' assets&sol;second.png 2x">',
    ].join("\n");
    writeFixture(root, "docs/README.md", markdown);

    assert.deepEqual(extractMarkdownLinks(markdown).map(({ target }) => target), [
      "assets/first.png",
      "assets/second.png",
    ]);
    const output = messages(validateRepositoryDocs(root).findings)
      .filter((message) => message.includes("assets/"));
    assert.deepEqual(output, [
      'docs/README.md:1 local target "assets/first.png" does not exist',
      'docs/README.md:2 local target "assets/second.png" does not exist',
    ]);
  });
});

test("HTML projection preserves CRLF duplicate &sol; srcset source offsets", () => {
  withRepository((root) => {
    const markdown = [
      '<img srcset="assets&sol;duplicate.png 1x,',
      ' assets&sol;duplicate.png 2x">',
    ].join("\r\n");
    writeFixture(root, "docs/README.md", markdown);

    assert.deepEqual(extractMarkdownLinks(markdown).map(({ target }) => target), [
      "assets/duplicate.png",
      "assets/duplicate.png",
    ]);
    const output = messages(validateRepositoryDocs(root).findings)
      .filter((message) => message.includes("assets/duplicate.png"));
    assert.deepEqual(output, [
      'docs/README.md:1 local target "assets/duplicate.png" does not exist',
      'docs/README.md:2 local target "assets/duplicate.png" does not exist',
    ]);
  });
});

test("HTML projection preserves lone CR duplicate &sol; srcset source offsets", () => {
  withRepository((root) => {
    const markdown = [
      '<img srcset="assets&sol;duplicate.png 1x,',
      ' assets&sol;duplicate.png 2x">',
    ].join("\r");
    writeFixture(root, "docs/README.md", markdown);

    const output = messages(validateRepositoryDocs(root).findings)
      .filter((message) => message.includes("assets/duplicate.png"));
    assert.deepEqual(output, [
      'docs/README.md:1 local target "assets/duplicate.png" does not exist',
      'docs/README.md:2 local target "assets/duplicate.png" does not exist',
    ]);
  });
});

test("HTML projection preserves literal NUL duplicate &sol; srcset source offsets", () => {
  withRepository((root) => {
    const markdown = [
      '<img srcset="assets\0&sol;duplicate.png 1x,',
      ' assets\0&sol;duplicate.png 2x">',
    ].join("\n");
    writeFixture(root, "docs/README.md", markdown);

    const target = "assets\uFFFD/duplicate.png";
    assert.deepEqual(extractMarkdownLinks(markdown).map((link) => link.target), [target, target]);
    const output = messages(validateRepositoryDocs(root).findings)
      .filter((message) => message.includes(target));
    assert.deepEqual(output, [
      `docs/README.md:1 local target "${target}" does not exist`,
      `docs/README.md:2 local target "${target}" does not exist`,
    ]);
  });
});

test("HTML projection uses ASCII whitespace for comma-bearing srcset URLs", () => {
  const markdown = '<img srcset="assets/comma,name.png 1x,'
    + '\u00A0assets/nbsp-name.png 2x, assets/vt\vname.png 3x">';
  assert.deepEqual(extractMarkdownLinks(markdown).map((link) => link.target), [
    "assets/comma,name.png",
    "\u00A0assets/nbsp-name.png",
    "assets/vt\vname.png",
  ]);
});

test("HTML projection recovers malformed unquoted raw attribute values", () => {
  assert.deepEqual(
    extractMarkdownLinks("<div>\n<img srcset=`assets/malformed.png>\n</div>"),
    [{ label: "", target: "`assets/malformed.png" }],
  );
});

test("HTML projection preserves entity-produced URL commas and ignores data candidates", () => {
  const markdown = '<img srcset="assets/entity&#44;comma.png 1x,'
    + ' data:image/png;base64,AAAA 2x, assets/after-data.png 3x">';
  assert.deepEqual(extractMarkdownLinks(markdown).map((link) => link.target), [
    "assets/entity,comma.png",
    "assets/after-data.png",
  ]);
});

test("HTML projection follows srcset trailing-comma and descriptor states", () => {
  const markdown = '<img srcset="assets/no-descriptor.png,'
    + ' assets/descriptor.png future(foo,bar), assets/final.png 2x">';
  assert.deepEqual(extractMarkdownLinks(markdown).map((link) => link.target), [
    "assets/no-descriptor.png",
    "assets/final.png",
  ]);
});

test("HTML projection rejects an unknown srcset descriptor", () => {
  assert.deepEqual(srcsetTargets("assets/unknown.png bogus"), []);
});

test("HTML projection rejects a zero-width srcset descriptor", () => {
  assert.deepEqual(srcsetTargets("assets/zero-width.png 0w"), []);
});

test("HTML projection rejects conflicting srcset density descriptors", () => {
  assert.deepEqual(srcsetTargets("assets/conflicting.png 1x 2x"), []);
});

test("HTML projection accepts a valid 1x srcset descriptor", () => {
  assert.deepEqual(srcsetTargets("assets/valid-density.png 1x"), ["assets/valid-density.png"]);
});

test("HTML projection accepts valid WHATWG width and density formats", () => {
  const descriptors = [
    "1w",
    "0001w",
    "2147483647w",
    "0x",
    "-0x",
    ".5x",
    "1.5x",
    "2x",
    "1e2x",
    "1E+2x",
    "5e-324x",
    "1e-400x",
  ];
  for (const [index, descriptor] of descriptors.entries()) {
    const target = `assets/valid-format-${index}.png`;
    assert.deepEqual(srcsetTargets(`${target} ${descriptor}`), [target], descriptor);
  }
});

test("HTML projection rejects invalid WHATWG width and density formats", () => {
  const descriptors = [
    "0w",
    "-1w",
    "+1w",
    "1.0w",
    "1W",
    "-1x",
    "+1x",
    "1.x",
    ".x",
    "1e+x",
    "Infinityx",
    "NaNx",
    "1e309x",
    "1X",
    "2147483648w",
    "999999999999999999999999999999w",
  ];
  for (const [index, descriptor] of descriptors.entries()) {
    assert.deepEqual(srcsetTargets(`assets/invalid-format-${index}.png ${descriptor}`), [], descriptor);
  }
});

test("HTML projection accepts Chrome's maximum width descriptor", () => {
  assert.deepEqual(
    srcsetTargets("assets/max-width.png 2147483647w"),
    ["assets/max-width.png"],
  );
});

test("HTML projection rejects a width descriptor above Chrome's maximum", () => {
  assert.deepEqual(srcsetTargets("assets/overflow-width.png 2147483648w"), []);
});

test("HTML projection accepts Chrome's maximum future-compatible height descriptor", () => {
  assert.deepEqual(
    srcsetTargets("assets/max-height.png 1w 2147483647h"),
    ["assets/max-height.png"],
  );
});

test("HTML projection rejects a future-compatible height above Chrome's maximum", () => {
  assert.deepEqual(srcsetTargets("assets/overflow-height.png 1w 2147483648h"), []);
});

test("HTML projection rejects arbitrarily large Chrome integer descriptors", () => {
  assert.deepEqual(srcsetTargets("assets/huge-width.png 999999999999999999999999999999w"), []);
  assert.deepEqual(srcsetTargets("assets/huge-height.png 1w 999999999999999999999999999999h"), []);
});

test("HTML projection handles leading-zero Chrome integer boundaries without precision loss", () => {
  assert.deepEqual(
    srcsetTargets(
      "assets/padded-max-width.png 00000000002147483647w,"
        + " assets/padded-overflow-width.png 00000000002147483648w,"
        + " assets/padded-max-height.png 1w 00000000002147483647h,"
        + " assets/padded-overflow-height.png 1w 00000000002147483648h",
    ),
    ["assets/padded-max-width.png", "assets/padded-max-height.png"],
  );
});

const EXACT_FLOAT32_HALF_MIN = "7.00649232162408535461864791644958065640130970938257885878534141944895541342930300743319094181060791015625e-46";
const EXACT_FLOAT32_MIN = "1.40129846432481707092372958328991613128026194187651577175706828388979108268586060148663818836212158203125e-45";
const EXACT_FLOAT32_MAX = "340282346638528859811704183484516925440";
const EXACT_FLOAT32_OVERFLOW_TIE = "340282356779733661637539395458142568448";

const CHROME_146_DENSITY_MATRIX = [
  { label: "zero", value: "0", accepted: true },
  { label: "negative zero", value: "-0", accepted: true },
  { label: "dot before exponent", value: "1.e2", accepted: true },
  { label: "dot before signed exponent", value: "1.e+2", accepted: true },
  { label: "terminal dot", value: "1.", accepted: false },
  { label: "leading plus", value: "+1", accepted: false },
  { label: "incomplete exponent", value: "1e+", accepted: false },
  { label: "positive binary64 underflow", value: "1e-400", accepted: true },
  { label: "negative binary64 underflow", value: "-1e-400", accepted: true },
  { label: "negative near binary64 underflow", value: "-2e-324", accepted: true },
  { label: "negative binary64 subnormal", value: "-3e-324", accepted: true },
  { label: "negative float32 underflow", value: "-7e-46", accepted: true },
  { label: "negative float32 minimum", value: "-8e-46", accepted: false },
  { label: "negative below rounded half minimum", value: "-7.006492321624084999999999999e-46", accepted: true },
  { label: "negative rounded half minimum", value: "-7.006492321624085e-46", accepted: false },
  { label: "negative exact half minimum", value: `-${EXACT_FLOAT32_HALF_MIN}`, accepted: false },
  { label: "positive exact half minimum", value: EXACT_FLOAT32_HALF_MIN, accepted: true },
  { label: "positive exact minimum", value: EXACT_FLOAT32_MIN, accepted: true },
  { label: "maximum finite float32", value: EXACT_FLOAT32_MAX, accepted: true },
  { label: "positive float32 overflow tie", value: EXACT_FLOAT32_OVERFLOW_TIE, accepted: true },
  { label: "positive float32 overflow", value: "3.5e38", accepted: true },
  { label: "negative float32 overflow", value: "-3.5e38", accepted: false },
  { label: "DBL_MAX", value: "1.7976931348623157e308", accepted: true },
  { label: "DBL_MAX after Decimal truncation", value: "1.79769313486231570999999999999999999999e308", accepted: true },
  { label: "above DBL_MAX after Decimal truncation", value: "1.79769313486231571e308", accepted: false },
  { label: "above DBL_MAX", value: "1.7976931348623158e308", accepted: false },
  { label: "Decimal overflow", value: "1e309", accepted: false },
];

for (const { label, value, accepted } of CHROME_146_DENSITY_MATRIX) {
  test(`Chrome 146 density differential: ${label}`, () => {
    const target = `assets/chrome-density-${label.replaceAll(" ", "-")}.png`;
    assert.deepEqual(
      srcsetTargets(`${target} ${value}x`),
      accepted ? [target] : [],
      value,
    );
  });
}

test("HTML projection enforces future-compatible height descriptor rules", () => {
  for (const [index, descriptors] of ["400w 200h", "200h 400w"].entries()) {
    const target = `assets/valid-height-${index}.png`;
    assert.deepEqual(srcsetTargets(`${target} ${descriptors}`), [target], descriptors);
  }

  for (const [index, descriptors] of [
    "200h",
    "0h 400w",
    "400w 200h 300h",
    "400w 200h 1x",
    "1x 200h 400w",
  ].entries()) {
    assert.deepEqual(srcsetTargets(`assets/invalid-height-${index}.png ${descriptors}`), [], descriptors);
  }
});

test("HTML projection rejects duplicate and conflicting srcset descriptor classes", () => {
  for (const [index, descriptors] of [
    "1w 2w",
    "1x 1x",
    "1x 2x",
    "1w 2x",
    "2x 1w",
  ].entries()) {
    assert.deepEqual(srcsetTargets(`assets/duplicate-${index}.png ${descriptors}`), [], descriptors);
  }
});

test("HTML projection tokenizes descriptors with ASCII whitespace only", () => {
  const value = "assets/space.png 1x,"
    + "assets/tab.png\t1x,"
    + "assets/lf.png\n1x,"
    + "assets/form-feed.png\f1x,"
    + "assets/cr.png\r1x";
  assert.deepEqual(srcsetTargets(value), [
    "assets/space.png",
    "assets/tab.png",
    "assets/lf.png",
    "assets/form-feed.png",
    "assets/cr.png",
  ]);
  assert.deepEqual(
    srcsetTargets("assets/nbsp.png 1x\u00A02x, assets/valid-after-nbsp.png 1x"),
    ["assets/valid-after-nbsp.png"],
  );
  assert.deepEqual(
    srcsetTargets("assets/vt.png 1x\v2x, assets/valid-after-vt.png 1x"),
    ["assets/valid-after-vt.png"],
  );
});

test("HTML projection filters parenthesized descriptors without splitting later candidates", () => {
  assert.deepEqual(
    srcsetTargets("assets/unknown.png future(foo,bar), assets/valid-after-parens.png 1x"),
    ["assets/valid-after-parens.png"],
  );
  assert.deepEqual(
    srcsetTargets("assets/unclosed.png future(foo,bar"),
    [],
  );
  assert.deepEqual(
    srcsetTargets("assets/trailing-comma.png,"),
    ["assets/trailing-comma.png"],
  );
});

test("HTML projection preserves accepted candidate provenance after descriptor filtering", () => {
  withRepository((root) => {
    const markdown = [
      '<img srcset="assets&sol;duplicate.png bogus,',
      ' assets&sol;duplicate.png 1x">',
    ].join("\r\n");
    writeFixture(root, "docs/README.md", markdown);

    const output = messages(validateRepositoryDocs(root).findings)
      .filter((message) => message.includes("assets/duplicate.png"));
    assert.deepEqual(output, [
      'docs/README.md:2 local target "assets/duplicate.png" does not exist',
    ]);
  });
});

test("attribute provenance maps literal preprocessing and entity output by UTF-16 unit", () => {
  for (const { raw, text, offsets } of [
    { raw: "\r\n", text: "\n", offsets: [0] },
    { raw: "\r", text: "\n", offsets: [0] },
    { raw: "\0", text: "\uFFFD", offsets: [0] },
    { raw: "\u{1F680}", text: "\u{1F680}", offsets: [0, 1] },
    { raw: "&sol;", text: "/", offsets: [0] },
    { raw: "&#47;", text: "/", offsets: [0] },
    { raw: "&#13;", text: "\r", offsets: [0] },
    { raw: "&#10;", text: "\n", offsets: [0] },
    { raw: "&#0;", text: "\uFFFD", offsets: [0] },
    { raw: "&#x1F680;", text: "\u{1F680}", offsets: [0, 0] },
  ]) {
    assert.deepEqual(assertValidProvenance(raw, text), { text, offsets });
  }

  for (const raw of ["&NotEqualTilde;", "&acE;"]) {
    const expected = parse5SrcsetAttribute(raw).value;
    const mapped = assertValidProvenance(raw, expected);
    assert.deepEqual(mapped.offsets, Array.from({ length: expected.length }, () => 0));
  }
});

test("attribute provenance matches parse5 for a bounded corpus and seeded fuzz", () => {
  const atoms = [
    "",
    "plain",
    "\r",
    "\r\n",
    "\n",
    "\0",
    "\u00A0",
    "\v",
    "\u{1F680}",
    "&amp;",
    "&sol;",
    "&AElig;",
    "&NotEqualTilde;",
    "&#47;",
    "&#x2f;",
    "&#13;",
    "&#10;",
    "&#0;",
    "&#xD800;",
    "&#x1F680;",
    "&bogus;",
    "&amp",
    "&amp=",
    "&#;",
    "&#x;",
    "&#99999999;",
  ];
  const corpus = new Set(atoms);
  for (const left of atoms) {
    for (const right of atoms) corpus.add(left + right);
  }

  let state = 0x5eed1234;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const fuzzTokens = [
    "a", "Z", "0", "&", "#", ";", "=", "<", ">", ",", " ", "\t", "\n", "\r", "\0",
    "\u00A0", "\v", "\u{1F680}", "&sol;", "&amp", "&#13;", "&#x1F680;", "&NotEqualTilde;",
  ];
  for (let caseIndex = 0; caseIndex < 256; caseIndex += 1) {
    const length = next() % 24;
    let value = "";
    for (let tokenIndex = 0; tokenIndex < length; tokenIndex += 1) {
      value += fuzzTokens[next() % fuzzTokens.length];
    }
    corpus.add(value);
  }

  for (const rawValue of corpus) {
    assertValidProvenance(rawValue, parse5SrcsetAttribute(rawValue).value);
  }
});

test("raw attribute spans follow parse5 recovery for quoted and unquoted values", () => {
  assert.equal(
    typeof validateDocs.htmlAttributeValueSpan,
    "function",
    "the tokenizer-compatible raw attribute scanner must be exported for differential verification",
  );
  for (const { source, raw } of [
    { source: '<img srcset="double.png 1x">', raw: "double.png 1x" },
    { source: "<img srcset='single.png 1x'>", raw: "single.png 1x" },
    { source: "<img srcset=unquoted.png>", raw: "unquoted.png" },
    { source: "<img srcset=`assets/a'b<c=d.png>", raw: "`assets/a'b<c=d.png" },
    { source: "<img srcset=assets/a'b\"c.png>", raw: "assets/a'b\"c.png" },
    { source: "<img srcset=\u00A0assets/vt\vname.png>", raw: "\u00A0assets/vt\vname.png" },
    { source: "<img srcset=first.png\rother=value>", raw: "first.png" },
    { source: '<img srcset="first.png" srcset="ignored.png">', raw: "first.png" },
    { source: "<template><img srcset='template.png'></template>", raw: "template.png" },
    { source: "<img srcset=>", raw: "" },
  ]) {
    const html = parseFragment(source, { sourceCodeLocationInfo: true });
    const image = findHtmlElement(html, "img");
    const attribute = image.attrs.find((candidate) => candidate.name === "srcset");
    const location = image.sourceCodeLocation.attrs.srcset;
    const span = validateDocs.htmlAttributeValueSpan(source, location);
    assert.equal(source.slice(span.start, span.end), raw, source);
    assertValidProvenance(raw, attribute.value);
  }

  assert.deepEqual(extractMarkdownLinks('<script><img srcset="raw-text.png 1x"></script>'), []);
  assert.deepEqual(extractMarkdownLinks('<img srcset="quoted-eof.png'), []);
  assert.deepEqual(extractMarkdownLinks("<img srcset=unquoted-eof.png"), []);
});

test("HTML projection does not normalize numeric CR entity output", () => {
  const markdown = '<img srcset="assets&sol;z-first.png 1x,&#13;assets&sol;a-second.png 2x">';
  assert.deepEqual(extractMarkdownLinks(markdown).map(({ target }) => target), [
    "assets/z-first.png",
    "assets/a-second.png",
  ]);
});

test("validateRepositoryDocs preserves HTML resource source lines after ignored markup", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "# Docs",
      "",
      "<!-- <img src=\"ignored-comment.png\"> -->",
      "<script>",
      "const markup = '<img src=\"ignored-script.png\">';",
      "</script>",
      '<img src="assets/missing-after-ignored.png">',
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("docs/README.md:7") && message.includes("missing-after-ignored.png")));
    assert(!output.some((message) => message.includes("ignored-comment.png")));
    assert(!output.some((message) => message.includes("ignored-script.png")));
  });
});

test("validateRepositoryDocs preserves offsets within one multiline HTML block", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "<div>",
      "<!-- <img src=\"ignored-comment.png\"> -->",
      "<script>const markup = '<img src=\"ignored-script.png\">';</script>",
      "<section>",
      '<img src="assets/missing-line-five.png">',
      '<object data="assets/missing-line-six.pdf"></object>',
      "</section>",
      "</div>",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("docs/README.md:5") && message.includes("missing-line-five.png")));
    assert(output.some((message) => message.includes("docs/README.md:6") && message.includes("missing-line-six.pdf")));
    assert(!output.some((message) => message.includes("ignored-comment.png")));
    assert(!output.some((message) => message.includes("ignored-script.png")));
  });
});

test("validateRepositoryDocs reports the value line when an HTML target equals its attribute name", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "<img",
      '  src="src">',
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(
      output.some((message) => message.includes("docs/README.md:2") && message.includes('local target "src"')),
      output.join("\n"),
    );
  });
});

test("validateRepositoryDocs reports missing npm scripts only from current command documents", () => {
  withRepository((root) => {
    writeFixture(root, "README.md", "# Fixture\n\nRun `npm run missing-current-command`.\n\n[Install](INSTALL.md)\n");
    writeFixture(root, "addons/resonant-browser-host/README.md", "# Browser host\n\nRun `npm run missing-component-command`.\n");
    writeFixture(root, "docs/history.md", "# Historical commands\n\nRun `npm run retired-command`.\n");
    writeFixture(root, "docs/architecture/ADR-001-fixture.md", "# ADR-001\n\nRun `npm run retired-adr-command`.\n");
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("README.md:3") && message.includes("npm run missing-current-command") && message.includes("package.json")));
    assert(output.some((message) => message.includes("addons/resonant-browser-host/README.md:3") && message.includes("npm run missing-component-command")));
    assert(!output.some((message) => message.includes("retired-command")));
    assert(!output.some((message) => message.includes("retired-adr-command")));
  });
});

test("validateRepositoryDocs preserves legal sentence-like punctuation for real package scripts", () => {
  withRepository((root) => {
    writeFixture(root, "package.json", JSON.stringify({
      name: "docs-fixture",
      type: "module",
      engines: { node: ">=22.13.0" },
      scripts: {
        "docs:check": "node scripts/validate-docs.mjs",
        "test:docs": "node --test scripts/validate-docs.test.mjs",
        "release.": "node -e \"process.exit(0)\"",
        "release:": "node -e \"process.exit(0)\"",
      },
    }, null, 2));
    writeFixture(root, "README.md", "# Fixture\n\nRun `npm run release.`\nRun `npm run release:`\nRun npm run missing.\n\n[Install](INSTALL.md)\n");

    const output = messages(validateRepositoryDocs(root).findings);
    assert(!output.some((message) => message.includes("npm run release")));
    assert(output.some((message) => message.includes("npm run missing") && !message.includes("missing.")));
  });
});

test("validateRepositoryDocs treats inline-code npm punctuation as literal", () => {
  withRepository((root) => {
    writeFixture(root, "package.json", JSON.stringify({
      name: "docs-fixture",
      type: "module",
      engines: { node: ">=22.13.0" },
      scripts: {
        "docs:check": "node scripts/validate-docs.mjs",
        "test:docs": "node --test scripts/validate-docs.test.mjs",
        release: "node -e \"process.exit(0)\"",
      },
    }, null, 2));
    writeFixture(root, "README.md", "# Fixture\n\nRun npm run release.\nRun `npm run release.`\n\n[Install](INSTALL.md)\n");

    const releaseFindings = messages(validateRepositoryDocs(root).findings)
      .filter((message) => message.includes("documented npm run release"));
    assert.deepEqual(releaseFindings, [
      "README.md:4 documented npm run release. is absent from package.json scripts",
    ]);
  });
});

test("validateRepositoryDocs reports fenced npm commands on their content line", () => {
  withRepository((root) => {
    writeFixture(root, "README.md", [
      "# Fixture",
      "",
      "```sh",
      "npm run missing-fenced-command",
      "```",
      "",
      "[Install](INSTALL.md)",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("README.md:4") && message.includes("npm run missing-fenced-command")));
    assert(!output.some((message) => message.includes("README.md:3") && message.includes("npm run missing-fenced-command")));
  });
});

test("validateRepositoryDocs requires docs:check and test:docs scripts", () => {
  withRepository((root) => {
    writeFixture(root, "package.json", JSON.stringify({
      name: "docs-fixture",
      type: "module",
      engines: { node: ">=22.13.0" },
      scripts: { check: "node --check scripts/validate-docs.mjs" },
    }, null, 2));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("package.json") && message.includes("docs:check")));
    assert(output.some((message) => message.includes("package.json") && message.includes("test:docs")));
  });
});

test("validateRepositoryDocs reports absent and non-object package scripts without throwing", () => {
  withRepository((root) => {
    writeFixture(root, "package.json", JSON.stringify({
      name: "docs-fixture",
      type: "module",
      engines: { node: ">=22.13.0" },
    }, null, 2));
    let output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("package.json") && message.includes("scripts must be an object")));

    writeFixture(root, "package.json", JSON.stringify({
      name: "docs-fixture",
      type: "module",
      engines: { node: ">=22.13.0" },
      scripts: "not-an-object",
    }, null, 2));
    assert.doesNotThrow(() => validateRepositoryDocs(root));
    output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("package.json") && message.includes("scripts must be an object")));
  });
});

test("validateCanonicalClaims limits obsolete-runtime checks to the normative allowlist", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", "# Documentation\n\nTauri is required for the Alpha runtime.\n");
    writeFixture(root, "docs/architecture/ADR-001-fixture.md", "# ADR-001\n\nTauri and Rust are historical architecture decisions.\n");

    const output = messages(validateCanonicalClaims({ root }));
    assert(output.some((message) => message.includes("docs/README.md:3") && message.includes("Tauri")));
    assert(!output.some((message) => message.includes("ADR-001-fixture.md") && message.includes("obsolete runtime")));
  });
});

test("validateCanonicalClaims rejects stale current-truth claims", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "browser-first-preview is the current runtime.",
      "The development branch is main.",
      "42 tests pass.",
      "Run this from /Users/dr.tom/project.",
      "This guide is the current status source of truth.",
    ].join("\n"));

    const output = messages(validateCanonicalClaims({ root }));
    assert(output.some((message) => message.includes("browser-first-preview")));
    assert(output.some((message) => message.includes("development branch") && message.includes("main")));
    assert(output.some((message) => message.includes("fixed test count")));
    assert(output.some((message) => message.includes("founder-specific absolute path")));
    assert(output.some((message) => message.includes("docs/STATUS.md") && message.includes("status source")));
  });
});

test("validateCanonicalClaims rejects fixed counts after a passing verb", () => {
  withRepository((root) => {
    writeFixture(root, "docs/STATUS.md", [
      "# Status",
      "",
      "The documentation suite passed all 100 checks.",
    ].join("\n"));

    const output = messages(validateCanonicalClaims({ root }));
    assert(output.some((message) => message.includes("fixed test count")));
  });
});

test("validateCanonicalClaims rejects dated verification snapshots", () => {
  withRepository((root) => {
    writeFixture(root, "docs/STATUS.md", [
      "# Status",
      "",
      "Verified snapshot: 2026-07-10.",
      "The current deterministic verification passed on 2026-07-10.",
    ].join("\n"));

    const output = messages(validateCanonicalClaims({ root }));
    assert(output.some((message) => message.includes("dated verification snapshot")));
  });
});

test("validateCanonicalClaims rejects obsolete runtime commands in normative shell fences", () => {
  withRepository((root) => {
    writeFixture(root, "INSTALL.md", [
      "# Install",
      "",
      "```bash",
      "npm install",
      "cargo build",
      "```",
      "",
      "[Contribute](CONTRIBUTING.md)",
    ].join("\n"));

    const output = messages(validateCanonicalClaims({ root }));
    assert(output.some((message) => message.includes("INSTALL.md:5") && message.includes('obsolete runtime "cargo"')));

    writeFixture(root, "INSTALL.md", [
      "# Install",
      "",
      "```shell-session",
      "cargo build",
      "```",
      "",
      "```",
      "cargo test",
      "```",
      "",
      "[Contribute](CONTRIBUTING.md)",
    ].join("\n"));
    const additional = messages(validateCanonicalClaims({ root }));
    assert(additional.some((message) => message.includes("INSTALL.md:4") && message.includes('obsolete runtime "cargo"')));
    assert(additional.some((message) => message.includes("INSTALL.md:8") && message.includes('obsolete runtime "cargo"')));

    writeFixture(root, "INSTALL.md", [
      "# Install",
      "",
      "> ```bash",
      "> cargo build",
      "> ```",
      "",
      "```fish",
      "cargo test",
      "```",
      "",
      "<pre><code>cargo check</code></pre>",
      "",
      "[Contribute](CONTRIBUTING.md)",
    ].join("\n"));
    const nested = messages(validateCanonicalClaims({ root }));
    assert(nested.some((message) => message.includes("INSTALL.md:4") && message.includes('obsolete runtime "cargo"')));
    assert(nested.some((message) => message.includes("INSTALL.md:8") && message.includes('obsolete runtime "cargo"')));
    assert(nested.some((message) => message.includes("INSTALL.md:11") && message.includes('obsolete runtime "cargo"')));

    writeFixture(root, "INSTALL.md", [
      "# Install",
      "",
      "```bash-session",
      "cargo build",
      "```",
      "",
      "<pre><samp><code>cargo check</code></samp></pre>",
      "<pre><!-- review --><code>car<em>go</em> test</code></pre>",
      "<pre><code>cargo&#32;fmt</code></pre>",
      "",
      "[Contribute](CONTRIBUTING.md)",
    ].join("\n"));
    const rendered = messages(validateCanonicalClaims({ root }));
    assert(rendered.some((message) => message.includes("INSTALL.md:4") && message.includes('obsolete runtime "cargo"')));
    assert(rendered.some((message) => message.includes("INSTALL.md:7") && message.includes('obsolete runtime "cargo"')));
    assert(rendered.some((message) => message.includes("INSTALL.md:8") && message.includes('obsolete runtime "cargo"')));
    assert(rendered.some((message) => message.includes("INSTALL.md:9") && message.includes('obsolete runtime "cargo"')));

    writeFixture(root, "INSTALL.md", [
      "# Install",
      "",
      "```zsh-session",
      "cargo build",
      "```",
      "```fish-session",
      "cargo test",
      "```",
      "```terminal",
      "cargo check",
      "```",
      "```pwsh",
      "cargo fmt",
      "```",
      "<pre><code>&#99argo build</code></pre>",
      "<pre><code>car&#x67o test</code></pre>",
      "<pre><code>car<template>not rendered</template>go check</code></pre>",
      "",
      "[Contribute](CONTRIBUTING.md)",
    ].join("\n"));
    const parserEdges = messages(validateCanonicalClaims({ root }));
    for (const line of [4, 7, 10, 13, 15, 16, 17]) {
      assert(parserEdges.some((message) => message.includes(`INSTALL.md:${line}`) && message.includes('obsolete runtime "cargo"')));
    }
  });
});

test("validateCanonicalClaims handles nested templates and batch fence aliases", () => {
  withRepository((root) => {
    writeFixture(root, "INSTALL.md", [
      "# Install",
      "",
      "```bat",
      "cargo build",
      "```",
      "```batch",
      "cargo test",
      "```",
      "<pre><code>car<template>outer<template>inner</template>tail</template>go check</code></pre>",
      "<pre><code>car<template>hidden</template data-x>go build</code></pre>",
      "<pre><code><template-widget>cargo build</template-widget></code></pre>",
      "",
      "[Contribute](CONTRIBUTING.md)",
    ].join("\n"));

    const output = messages(validateCanonicalClaims({ root }));
    for (const line of [4, 7, 9, 10, 11]) {
      assert(output.some((message) => message.includes(`INSTALL.md:${line}`) && message.includes('obsolete runtime "cargo"')));
    }
  });
});

test("validateCanonicalClaims handles remaining executable fence aliases", () => {
  withRepository((root) => {
    writeFixture(root, "INSTALL.md", [
      "# Install",
      "",
      "```shellscript",
      "cargo build",
      "```",
      "```console-session",
      "cargo test",
      "```",
      "```terminal-session",
      "cargo check",
      "```",
      "```windows",
      "cargo fmt",
      "```",
      "```dosbatch",
      "cargo build",
      "```",
      "",
      "[Contribute](CONTRIBUTING.md)",
    ].join("\n"));

    const output = messages(validateCanonicalClaims({ root }));
    for (const line of [4, 7, 10, 13, 16]) {
      assert(output.some((message) => message.includes(`INSTALL.md:${line}`) && message.includes('obsolete runtime "cargo"')));
    }
  });
});

test("canonical product docs preserve implemented chat, project, and draft handoff workflows", () => {
  const guide = readFileSync(
    new URL("../docs/product/PRODUCT_GUIDE.md", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  const matrix = readFileSync(new URL("../docs/reference/CAPABILITY_MATRIX.md", import.meta.url), "utf8");

  for (const phrase of [
    "pin or unpin a chat",
    "fork a chat",
    "archive a chat",
    "create and manage projects",
    "move chats into or out of projects",
    "inline assistant",
    "search local browser history",
    "site permission",
    "wallet status",
    "read-only workflow guidance",
    "save a page",
    "save selected text",
    "save a generated summary",
    "save a multi-tab research trail",
    "browser-job report",
    "artifacts workspace",
  ]) {
    assert.match(guide.toLowerCase(), new RegExp(phrase));
  }
  assert.match(matrix, /Chat and project workspace management/);
  assert.match(matrix, /Gmail and Google Calendar draft handoff/);
  assert.match(matrix, /Inline Assistant page actions/);
  assert.match(matrix, /Browser history search and intake/);
  assert.match(matrix, /Per-site browser permissions/);
  assert.match(matrix, /Wallet and DAO read-only helpers/);
  assert.match(matrix, /Browser evidence capture and Artifacts review/);
});

test("canonical command reference covers every side-panel slash command", () => {
  const router = readFileSync(
    new URL("../browser-first/resonantos-side-panel-extension/src/lib/side-panel-command-router.js", import.meta.url),
    "utf8",
  );
  const reference = readFileSync(new URL("../docs/reference/COMMANDS.md", import.meta.url), "utf8");
  const commands = new Set(
    [...router.matchAll(/name === "([a-z-]+)"/g)].map((match) => match[1]),
  );
  for (const command of ["read", "context", "summarize", ...commands]) {
    assert.match(reference, new RegExp("`/" + command + "(?:\\s|`)"), `missing /${command}`);
  }
});

test("validateRepositoryDocs reports tracked documentation unreachable from canonical or implicit roots", () => {
  withRepository((root) => {
    writeFixture(root, "docs/orphan.md", "# Orphan\n");
    writeFixture(root, "docs/orphan.png", "orphan-image");
    writeFixture(root, "docs/orphan.avif", "orphan-avif");
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("docs/orphan.md") && message.includes("not reachable")));
    assert(output.some((message) => message.includes("docs/orphan.png") && message.includes("not reachable")));
    assert(output.some((message) => message.includes("docs/orphan.avif") && message.includes("not reachable")));
  });
});

test("validateRepositoryDocs accepts implicit runtime and GitHub documentation consumers", () => {
  withRepository((root) => {
    writeFixture(root, ".github/pull_request_template.md", "# Pull request\n");
    writeFixture(root, "index.html", "<!doctype html><title>Runtime</title>\n");
    const output = messages(validateRepositoryDocs(root).findings);
    assert(!output.some((message) => message.includes("pull_request_template.md") && message.includes("not reachable")));
    assert(!output.some((message) => message.includes("index.html") && message.includes("not reachable")));
  });
});

test("validateCanonicalClaims ignores policy prose about the status source", () => {
  withRepository((root) => {
    writeFixture(root, "docs/policy.md", "# Policy\n\nOnly docs/STATUS.md may claim to be the current status source of truth.\n");
    const output = messages(validateCanonicalClaims({ root }));
    assert(!output.some((message) => message.includes("docs/policy.md") && message.includes("status source")));
  });
});

test("validateCanonicalClaims requires obsolete-runtime exceptions in the same non-contradictory clause", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "Tauri is out of scope, but Rust is required.",
      "",
      "## Out of scope",
      "Cargo is required.",
    ].join("\n"));
    const output = messages(validateCanonicalClaims({ root }));
    assert(output.some((message) => message.includes("Rust")));
    assert(output.some((message) => message.includes("Cargo")));
  });
});

test("validateCanonicalClaims accepts shared negative runtime predicates without inheriting historical headings", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "Tauri, Electron, native CEF hosts, Rust toolchains, and Cargo build paths",
      "are not part of this alpha.",
      "src-tauri does not exist.",
      "",
      "## Historical context",
      "Tauri is required.",
    ].join("\n"));

    const output = messages(validateCanonicalClaims({ root }));
    assert(!output.some((message) => message.startsWith("docs/README.md:3")));
    assert(!output.some((message) => message.startsWith("docs/README.md:5")));
    assert(output.some((message) => message.startsWith("docs/README.md:8") && message.includes("Tauri")));
  });
});

test("validateCanonicalClaims accepts only narrowly named negative-heading lists", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "## Not Included",
      "- Tauri desktop shell",
      "- Rust toolchain",
      "- Tauri is required.",
      "",
      "## Historical Rust",
      "- Electron host",
    ].join("\n"));

    const output = messages(validateCanonicalClaims({ root }));
    assert(!output.some((message) => message.startsWith("docs/README.md:4")));
    assert(!output.some((message) => message.startsWith("docs/README.md:5")));
    assert(output.some((message) => message.startsWith("docs/README.md:6") && message.includes("Tauri")));
    assert(output.some((message) => message.startsWith("docs/README.md:9") && message.includes("Electron")));
  });
});

test("validateCanonicalClaims scans GFM tables and blockquotes for positive runtime requirements", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", [
      "# Documentation",
      "",
      "| Runtime | Requirement |",
      "| --- | --- |",
      "| Tauri | Tauri is required |",
      "",
      "> Rust is required.",
    ].join("\n"));
    const output = messages(validateCanonicalClaims({ root }));
    assert(output.some((message) => message.startsWith("docs/README.md:5") && message.includes("Tauri")));
    assert(output.some((message) => message.startsWith("docs/README.md:7") && message.includes("Rust")));
  });
});

test("validateCanonicalClaims reports only the positive colon clause", () => {
  withRepository((root) => {
    writeFixture(root, "docs/README.md", "# Documentation\n\nTauri is historical: Tauri is required.\n");
    const output = messages(validateCanonicalClaims({ root })).filter((message) => message.startsWith("docs/README.md:3") && message.includes("Tauri"));
    assert.equal(output.length, 1);
  });
});

test("validateRepositoryDocs requires the canonical entrypoints and reading order", () => {
  withRepository((root) => {
    rmSync(join(root, "INSTALL.md"));
    const missing = messages(validateRepositoryDocs(root).findings);
    assert(missing.some((message) => message.includes("Missing canonical entrypoint INSTALL.md")));

    writeFixture(root, "INSTALL.md", "# Install\n\n[Contribute](CONTRIBUTING.md)\n");
    writeFixture(root, "AGENTS.md", [
      "# Agent Guide",
      "",
      "[Overview](README.md)",
      "[Install](INSTALL.md)",
      "[Contribute](CONTRIBUTING.md)",
      "[Documentation](docs/README.md)",
    ].join("\n"));
    const noFirstEntrypoint = messages(validateRepositoryDocs(root).findings);
    assert(noFirstEntrypoint.some((message) => message.includes("AGENTS.md") && message.includes("canonical reading order")));

    writeFixture(root, "AGENTS.md", [
      "# Agent Guide",
      "",
      "[Agent guide](AGENTS.md)",
      "[Install](INSTALL.md)",
      "[Overview](README.md)",
      "[Contribute](CONTRIBUTING.md)",
      "[Documentation](docs/README.md)",
    ].join("\n"));
    const unordered = messages(validateRepositoryDocs(root).findings);
    assert(unordered.some((message) => message.includes("canonical reading order") && message.includes("AGENTS.md")));
  });
});

test("validateAdrIndex requires every tracked ADR to have an allowed status and Alpha applicability", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/ADR-002-missing.md", "# ADR-002: Missing index entry\n");
    const missing = messages(validateAdrIndex({ root }));
    assert(missing.some((message) => message.includes("ADR-002-missing.md") && message.includes("missing from docs/architecture/README.md")));

    writeFixture(root, "docs/architecture/README.md", [
      "# Architecture Decisions",
      "",
      "| ADR | Decision status | Alpha applicability | Superseded by | Owner | Notes |",
      "| --- | --- | --- | --- | --- | --- |",
      "| [ADR-001: Fixture decision](ADR-001-fixture.md) | Proposed | Applies | - | Core architecture | Accepted historically |",
      "| [ADR-002: Missing index entry](ADR-002-missing.md) | Accepted | | - | Core architecture | Historical |",
    ].join("\n"));
    const metadata = messages(validateAdrIndex({ root }));
    assert(metadata.some((message) => message.includes("ADR-001-fixture.md") && message.includes("decision status")));
    assert(metadata.some((message) => message.includes("ADR-002-missing.md") && message.includes("Alpha applicability")));
  });
});

test("validateAdrIndex accepts optional outer pipes and escaped cells but requires the exact ADR filename", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/README.md", [
      "# Architecture Decisions",
      "",
      "ADR | Decision status | Alpha applicability | Superseded by | Owner",
      "--- | --- | --- | --- | ---",
      "[ADR-001: Fixture\\| decision](ADR-001-other.md) | Accepted | Applies | - | Core architecture",
    ].join("\n"));
    const mismatched = messages(validateAdrIndex({ root }));
    assert(mismatched.some((message) => message.includes("ADR-001-fixture.md") && message.includes("missing from")));

    writeFixture(root, "docs/architecture/README.md", [
      "# Architecture Decisions",
      "",
      "ADR | Decision status | Alpha applicability | Superseded by | Owner",
      "--- | --- | --- | --- | ---",
      "[ADR-001: Fixture\\| decision](ADR-001-fixture.md) | Accepted | Applies | - | Core architecture",
    ].join("\n"));
    assert.deepEqual(validateAdrIndex({ root }), []);
  });
});

test("validateAdrIndex handles short rows with findings instead of throwing", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/README.md", [
      "# Architecture Decisions",
      "",
      "| ADR | Decision status | Alpha applicability | Superseded by | Owner |",
      "| --- | --- | --- | --- | --- |",
      "| [ADR-001: Fixture decision](ADR-001-fixture.md) |",
    ].join("\n"));
    assert.doesNotThrow(() => validateAdrIndex({ root }));
    const output = messages(validateAdrIndex({ root }));
    assert(output.some((message) => message.includes("ADR-001-fixture.md") && message.includes("decision status")));
    assert(output.some((message) => message.includes("ADR-001-fixture.md") && message.includes("Alpha applicability")));
  });
});

test("validateAdrIndex resolves reference links to exact ADR filenames", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/README.md", [
      "# Architecture Decisions",
      "",
      "| ADR | Decision status | Alpha applicability | Superseded by | Owner |",
      "| --- | --- | --- | --- | --- |",
      "| [ADR-001: Fixture decision][fixture-adr] | Accepted | Applies | - | Core architecture |",
      "",
      "[fixture-adr]: ADR-001-fixture.md",
      "[fixture-adr]: ADR-001-wrong.md",
    ].join("\n"));
    assert.deepEqual(validateAdrIndex({ root }), []);
  });
});

test("validateAdrIndex accepts case-insensitive metadata labels and normalized matching values", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/README.md", [
      "# Architecture Decisions",
      "",
      "| ADR | Decision status | Alpha applicability | Superseded by | Owner |",
      "| --- | --- | --- | --- | --- |",
      "| [ADR-001: Fixture decision](ADR-001-fixture.md) | Accepted | Applies | - | Core architecture |",
    ].join("\n"));
    writeFixture(root, "docs/architecture/ADR-001-fixture.md", [
      "# ADR-001: Fixture decision",
      "",
      "## Decision Metadata",
      "",
      "- decision STATUS: **Accepted**",
      "- ALPHA applicability: Applies",
      "- superseded BY: None",
      "- OWNER: Core",
      "  architecture",
      "",
      "## Decision",
      "The fixture uses the supported runtime.",
    ].join("\n"));

    assert.deepEqual(validateAdrIndex({ root }), []);
  });
});

test("validateAdrIndex reports every ADR metadata value that differs from its index row", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/ADR-001-fixture.md", [
      "# ADR-001: Fixture decision",
      "",
      "## Decision Metadata",
      "",
      "- Decision status: Deferred",
      "- Alpha applicability: Partial",
      "- Superseded by: ADR-002",
      "- Owner: Product architecture",
      "",
      "## Decision",
      "The fixture uses the supported runtime.",
    ].join("\n"));

    const output = messages(validateAdrIndex({ root }));
    for (const label of ["Decision status", "Alpha applicability", "Superseded by", "Owner"]) {
      assert(output.some((message) => message.includes("ADR-001-fixture.md") && message.includes(label) && message.includes("does not match")));
    }
  });
});

test("validateAdrIndex reports missing, duplicate, and malformed header metadata", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/ADR-001-fixture.md", [
      "# ADR-001: Fixture decision",
      "",
      "## Decision Metadata",
      "",
      "- Decision status: Accepted",
      "- Decision STATUS: Accepted",
      "- Alpha applicability Applies",
      "- Superseded by: None",
      "",
      "## Decision",
      "The fixture uses the supported runtime.",
    ].join("\n"));

    const output = messages(validateAdrIndex({ root }));
    assert(output.some((message) => message.includes("duplicate Decision status")));
    assert(output.some((message) => message.includes("malformed Alpha applicability")));
    assert(output.some((message) => message.includes("missing Alpha applicability")));
    assert(output.some((message) => message.includes("missing Owner")));
  });
});

test("validateAdrIndex rejects unsupported status and Alpha applicability values", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/README.md", [
      "# Architecture Decisions",
      "",
      "| ADR | Decision status | Alpha applicability | Superseded by | Owner |",
      "| --- | --- | --- | --- | --- |",
      "| [ADR-001: Fixture decision](ADR-001-fixture.md) | Proposed | Experimental | - | Core architecture |",
    ].join("\n"));
    writeFixture(root, "docs/architecture/ADR-001-fixture.md", [
      "# ADR-001: Fixture decision",
      "",
      "## Decision Metadata",
      "",
      "- Decision status: Proposed",
      "- Alpha applicability: Experimental",
      "- Superseded by: None",
      "- Owner: Core architecture",
      "",
      "## Decision",
      "The fixture uses the supported runtime.",
    ].join("\n"));

    const output = messages(validateAdrIndex({ root }));
    assert(output.some((message) => message.includes("allowed decision status")));
    assert(output.some((message) => message.includes("allowed Alpha applicability")));
  });
});

test("validateAdrIndex requires the metadata block at the top and rejects body-level duplicates", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/ADR-001-fixture.md", [
      "# ADR-001: Fixture decision",
      "",
      "## Decision",
      "The fixture uses the supported runtime.",
      "",
      "- Owner: Product architecture",
      "",
      "## Decision Metadata",
      "",
      "- Decision status: Accepted",
      "- Alpha applicability: Applies",
      "- Superseded by: None",
      "- Owner: Core architecture",
    ].join("\n"));

    const output = messages(validateAdrIndex({ root }));
    assert(output.some((message) => message.includes("top ## Decision Metadata block")));
    assert(output.some((message) => message.includes("body-level Owner metadata")));
    assert(output.some((message) => message.includes("body-level Decision Metadata block")));
  });
});

test("validateAdrIndex ignores bare metadata field names in ADR body schemas", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/ADR-001-fixture.md", [
      "# ADR-001: Fixture decision",
      "",
      "## Decision Metadata",
      "",
      "- Decision status: Accepted",
      "- Alpha applicability: Applies",
      "- Superseded by: None",
      "- Owner: Core architecture",
      "",
      "## Decision",
      "",
      "Required fields:",
      "",
      "- `owner`",
      "- `status`",
    ].join("\n"));

    assert.deepEqual(validateAdrIndex({ root }), []);
  });
});

test("validateAdrIndex reports duplicate and malformed index rows", () => {
  withRepository((root) => {
    writeFixture(root, "docs/architecture/README.md", [
      "# Architecture Decisions",
      "",
      "| ADR | Decision status | Alpha applicability | Superseded by | Owner |",
      "| --- | --- | --- | --- | --- |",
      "| [ADR-001: Fixture decision](ADR-001-fixture.md) | Accepted | Applies | - | Core architecture |",
      "| [ADR-001: Fixture duplicate](ADR-001-fixture.md) | Accepted | Applies | - | Core architecture |",
    ].join("\n"));
    const duplicate = messages(validateAdrIndex({ root }));
    assert(duplicate.some((message) => message.includes("duplicate ADR index rows")));

    writeFixture(root, "docs/architecture/README.md", [
      "# Architecture Decisions",
      "",
      "| ADR | Decision status | Alpha applicability | Superseded by | Owner |",
      "| --- | --- | --- | --- | --- |",
      "| [ADR-001: Fixture decision](ADR-001-fixture.md) | Accepted |",
    ].join("\n"));
    const malformed = messages(validateAdrIndex({ root }));
    assert(malformed.some((message) => message.includes("malformed ADR index row")));
  });
});

test("ADR discovery falls back silently when fixture roots are not Git worktrees", () => {
  withRepository((root) => {
    const probe = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { validateRepositoryDocs } from ${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)}; validateRepositoryDocs(${JSON.stringify(root)});`,
    ], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(probe.status, 0);
    assert.equal(probe.stderr, "");
  });
});

test("validateAdrIndex only requires tracked ADRs", () => {
  withRepository((root) => {
    const runGit = (args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    runGit(["init"]);
    runGit(["add", "docs/architecture/README.md", "docs/architecture/ADR-001-fixture.md"]);

    writeFixture(root, "docs/architecture/ADR-002-untracked.md", "# ADR-002\n");
    assert(!messages(validateAdrIndex({ root })).some((message) => message.includes("ADR-002-untracked.md")));

    runGit(["add", "docs/architecture/ADR-002-untracked.md"]);
    assert(messages(validateAdrIndex({ root })).some((message) => message.includes("ADR-002-untracked.md") && message.includes("missing from")));
  });
});

test("validateRepositoryDocs requires Node declarations to agree and satisfy dependency engines", () => {
  withRepository((root) => {
    assert.deepEqual(validateRepositoryDocs(root).findings, []);

    writeFixture(root, ".nvmrc", "22.12.0\n");
    writeFixture(root, ".github/workflows/checks.yml", [
      "jobs:",
      "  checks:",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 20",
    ].join("\n"));
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes(".nvmrc") && message.includes("package.json engines.node")));
    assert(output.some((message) => message.includes("jsdom") && message.includes("engine")));
    assert(output.some((message) => message.includes("checks.yml") && message.includes("node-version-file") && message.includes(".nvmrc")));
  });
});

test("validateRepositoryDocs validates addon package and lockfile Node surfaces", () => {
  withRepository((root) => {
    writeFixture(root, "addons/resonant-browser-host/package.json", JSON.stringify({
      name: "@fixture/browser-host",
      private: true,
      engines: { node: ">=22.12.0" },
    }, null, 2));
    writeFixture(root, "addons/resonant-browser-host/package-lock.json", JSON.stringify({
      name: "@fixture/browser-host",
      lockfileVersion: 3,
      packages: {
        "": { engines: { node: ">=22.12.0" } },
        "node_modules/browser-host-dependency": {
          version: "1.0.0",
          engines: { node: "^22.14.0 || >=24.0.0" },
        },
      },
    }, null, 2));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("addons/resonant-browser-host/package.json") && message.includes("engines.node")));
    assert(output.some((message) => message.includes("addons/resonant-browser-host/package-lock.json") && message.includes("engines.node")));
    assert(output.some((message) => message.includes("browser-host-dependency") && message.includes("engine")));
  });
});

test("validateRepositoryDocs reports malformed package-lock metadata without throwing", () => {
  withRepository((root) => {
    writeFixture(root, "package-lock.json", JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { engines: { node: ">=22.13.0" } },
        "node_modules/malformed": null,
      },
    }, null, 2));
    assert.doesNotThrow(() => validateRepositoryDocs(root));
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("node_modules/malformed") && message.includes("malformed package metadata")));
  });
});

test("validateRepositoryDocs uses semver for hyphen ranges and caret zero ranges", () => {
  withRepository((root) => {
    writeFixture(root, ".nvmrc", "0.0.4\n");
    writeFixture(root, "package.json", JSON.stringify({
      name: "docs-fixture",
      type: "module",
      engines: { node: ">=0.0.4" },
      scripts: {
        check: "node --check scripts/validate-docs.mjs",
        "docs:check": "node scripts/validate-docs.mjs",
        "test:docs": "node --test scripts/validate-docs.test.mjs",
      },
    }, null, 2));
    writeFixture(root, "package-lock.json", JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { engines: { node: ">=0.0.4" } },
        "node_modules/hyphen-range": { engines: { node: "0.0.3 - 0.0.4" } },
        "node_modules/caret-zero": { engines: { node: "^0.0.3" } },
      },
    }, null, 2));
    writeFixture(root, "addons/resonant-browser-host/package.json", JSON.stringify({
      name: "@fixture/browser-host",
      engines: { node: ">=0.0.4" },
    }, null, 2));
    writeFixture(root, "addons/resonant-browser-host/package-lock.json", JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { engines: { node: ">=0.0.4" } } },
    }, null, 2));
    writeFixture(root, ".github/workflows/checks.yml", "jobs:\n  checks:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n");

    const output = messages(validateRepositoryDocs(root).findings);
    assert(!output.some((message) => message.includes("hyphen-range")));
    assert(output.some((message) => message.includes("caret-zero") && message.includes("engine")));
  });
});

test("validateRepositoryDocs parses YAML version files and reports real workflow line numbers", () => {
  withRepository((root) => {
    writeFixture(root, ".github/workflows/checks.yml", [
      "jobs:",
      "  checks:",
    "    steps:",
    "      - run: \"echo 'node-version: 20'\"",
    "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version-file: .nvmrc",
    ].join("\n"));
    assert.deepEqual(messages(validateRepositoryDocs(root).findings).filter((message) => message.includes("checks.yml")), []);

    writeFixture(root, ".github/workflows/checks.yml", [
      "jobs:",
      "  checks:",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 20",
    ].join("\n"));
    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("checks.yml:6") && message.includes("node-version-file") && message.includes(".nvmrc")));
  });
});

test("validateRepositoryDocs rejects broad setup-node selectors in favor of .nvmrc", () => {
  withRepository((root) => {
    for (const selector of ["22", "22.13.x"]) {
      writeFixture(root, ".github/workflows/checks.yml", [
        "jobs:",
        "  checks:",
        "    steps:",
        "      - uses: actions/setup-node@v4",
        "        with:",
        `          node-version: ${selector}`,
      ].join("\n"));
      assert(messages(validateRepositoryDocs(root).findings).some((message) => message.includes("checks.yml") && message.includes("node-version-file") && message.includes(".nvmrc")), selector);
    }
  });
});

test("validateRepositoryDocs rejects unpinned and aliased setup-node steps", () => {
  withRepository((root) => {
    writeFixture(root, ".github/workflows/checks.yml", [
      "node-step: &node-step",
      "  uses: actions/setup-node@v4",
      "  with:",
      "    node-version: 22",
      "node-with: &node-with",
      "  node-version: 22",
      "jobs:",
      "  checks:",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version-file: .nvmrc",
      "      - uses: actions/setup-node@v4",
      "      - *node-step",
      "      - uses: actions/setup-node@v4",
      "        with: *node-with",
      "      - <<: *node-step",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    const workflowFindings = output.filter((message) => message.includes("checks.yml"));
    assert(workflowFindings.some((message) => message.includes("node-version-file") && message.includes(".nvmrc")));
  });
});

test("validateRepositoryDocs rejects aliased step sequences and job merges", () => {
  withRepository((root) => {
    const workflows = [
      [
        "node-steps: &node-steps",
        "  - uses: actions/setup-node@v4",
        "    with:",
        "      node-version: 20",
        "jobs:",
        "  checks:",
        "    steps: *node-steps",
      ],
      [
        "node-job: &node-job",
        "  steps:",
        "    - uses: actions/setup-node@v4",
        "      with:",
        "        node-version: 20",
        "jobs:",
        "  checks:",
        "    <<: *node-job",
      ],
    ];

    for (const [index, workflow] of workflows.entries()) {
      writeFixture(root, ".github/workflows/checks.yml", workflow.join("\n"));
      const output = messages(validateRepositoryDocs(root).findings);
      assert(output.some((message) => message.includes("checks.yml") && message.includes("node-version-file") && message.includes(".nvmrc")), `variant ${index + 1}`);
    }
  });
});

test("validateRepositoryDocs expands merged jobs maps before checking setup-node", () => {
  withRepository((root) => {
    writeFixture(root, ".github/workflows/checks.yml", [
      "shared-jobs: &shared-jobs",
      "  unpinned:",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 20",
      "jobs:",
      "  <<: *shared-jobs",
      "  pinned:",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version-file: .nvmrc",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("checks.yml") && message.includes("node-version-file") && message.includes(".nvmrc")));
  });
});

test("validateRepositoryDocs allows unrelated workflow aliases when setup-node stays pinned", () => {
  withRepository((root) => {
    const workflow = [
      "shared-env: &shared-env",
      "  FOO: bar",
      "jobs:",
      "  checks:",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version-file: .nvmrc",
    ];
    for (let index = 0; index < 101; index += 1) {
      workflow.push(`      - run: echo ${index}`, "        env: *shared-env");
    }
    writeFixture(root, ".github/workflows/checks.yml", workflow.join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(!output.some((message) => message.includes("checks.yml")));
  });
});

test("validateRepositoryDocs rejects malformed workflow step containers", () => {
  withRepository((root) => {
    writeFixture(root, ".github/workflows/checks.yml", [
      "jobs:",
      "  checks:",
      "    steps:",
      "      uses: actions/setup-node@v4",
      "      with:",
      "        node-version: 22",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("checks.yml") && message.includes("steps") && message.includes("sequence")));
  });
});

test("validateRepositoryDocs fails safely on cyclic workflow merges", () => {
  withRepository((root) => {
    writeFixture(root, ".github/workflows/checks.yml", [
      "loop: &loop",
      "  <<: *loop",
      "jobs:",
      "  checks:",
      "    <<: *loop",
    ].join("\n"));

    const output = messages(validateRepositoryDocs(root).findings);
    assert(output.some((message) => message.includes("checks.yml") && message.includes("could not be resolved safely")));
  });
});

test("validateRepositoryDocs rejects required-file symlinks that escape the repository", () => {
  withRepository((root) => {
    const outside = mkdtempSync(join(tmpdir(), "validate-docs-outside-"));
    try {
      writeFileSync(join(outside, "INSTALL.md"), "# Outside\n");
      rmSync(join(root, "INSTALL.md"));
      symlinkSync(join(outside, "INSTALL.md"), join(root, "INSTALL.md"));
      const output = messages(validateRepositoryDocs(root).findings);
      assert(output.some((message) => message.includes("INSTALL.md") && message.includes("symlink")));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("CLI scans cwd, prints actionable findings, and exits nonzero", () => {
  withRepository((root) => {
    writeFixture(root, "README.md", "# Fixture\n\nRun npm run missing-command.\n\n[Install](INSTALL.md)\n");
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /README\.md:3/);
    assert.match(result.stderr, /npm run missing-command/);
  });
});
