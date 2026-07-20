#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { parseFragment } from "parse5";
import { DecodingMode, EntityDecoder, htmlDecodeTree } from "entities/decode";
import semver from "semver";
import { isAlias, isMap, isSeq, parseDocument } from "yaml";

const CANONICAL_ENTRYPOINTS = [
  "AGENTS.md",
  "README.md",
  "INSTALL.md",
  "CONTRIBUTING.md",
  "docs/README.md",
];
const IMPLICIT_DOCUMENT_CONSUMERS = new Set([
  ".github/pull_request_template.md",
  "index.html",
  "browser-first/resonantos-side-panel-extension/src/main-workspace.html",
  "browser-first/resonantos-side-panel-extension/src/side-panel.html",
]);
const DOCUMENTATION_PATH = /\.(?:md|markdown|mdx|txt|html|pdf|docx)$/i;

const NORMATIVE_DOCUMENTS = new Set([
  "AGENTS.md",
  "README.md",
  "INSTALL.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/README.md",
  "docs/STATUS.md",
  "docs/ROADMAP.md",
  "docs/PROJECT_GOVERNANCE.md",
  "docs/architecture/README.md",
  "docs/architecture/ALPHA_RUNTIME_BOUNDARY.md",
  "docs/architecture/MODULE_MAP.md",
  "docs/architecture/MODULE-OWNERSHIP.md",
  "docs/product/PRODUCT_GUIDE.md",
  "docs/release/ALPHA_DISTRIBUTION.md",
  "docs/reference/CAPABILITY_MATRIX.md",
  "docs/reference/COMMANDS.md",
  "browser-first/README.md",
  "browser-first/host/README.md",
]);

const COMPONENT_COMMAND_READMES = [
  "browser-first/README.md",
  "browser-first/host/README.md",
  "addons/resonant-browser-host/README.md",
];

const CURRENT_COMMAND_DOCUMENTS = new Set([
  ...NORMATIVE_DOCUMENTS,
  ...COMPONENT_COMMAND_READMES,
]);

const REQUIRED_DOCS_SCRIPTS = ["docs:check", "test:docs"];
const OBSOLETE_RUNTIME = /\b(?:tauri|electron|cef|rust|cargo|src-tauri|native packaging)\b/gi;
const EXECUTABLE_FENCE_LANGUAGES = new Set([
  "bash",
  "bash-session",
  "bat",
  "batch",
  "cmd",
  "cmd-session",
  "console",
  "console-session",
  "dosbatch",
  "fish",
  "fish-session",
  "powershell",
  "powershell-session",
  "ps1",
  "pwsh",
  "sh",
  "sh-session",
  "shell",
  "shell-session",
  "shellscript",
  "terminal",
  "terminal-session",
  "windows",
  "zsh",
  "zsh-session",
]);
const ALLOWED_ADR_STATUSES = new Set(["Accepted", "Deferred", "Superseded", "Historical"]);
const ALLOWED_ALPHA_APPLICABILITY = new Set([
  "Applies",
  "Partial",
  "Deferred",
  "Not applicable",
  "Development only",
]);
const ADR_METADATA_FIELDS = [
  { key: "decision status", label: "Decision status", column: "status" },
  { key: "alpha applicability", label: "Alpha applicability", column: "alphaApplicability" },
  { key: "superseded by", label: "Superseded by", column: "supersededBy" },
  { key: "owner", label: "Owner", column: "owner" },
];
const ADR_METADATA_BY_KEY = new Map(ADR_METADATA_FIELDS.map((field) => [field.key, field]));
const NEGATIVE_RUNTIME_LIST_HEADINGS = new Set([
  "not included",
  "out of scope",
  "excluded",
  "historical components",
]);
const NPM_RUN_COMMAND = /\bnpm\s+run\s+([^\s`"'\\;&|()<>]+)/g;
const markdownParser = unified().use(remarkParse).use(remarkGfm);

function createFinding(path, line, message) {
  return { path, line, message };
}

function toRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function lineNumber(markdown, offset) {
  const end = Math.min(Math.max(offset, 0), markdown.length);
  let line = 1;
  for (let index = 0; index < end; index += 1) {
    if (markdown[index] === "\r") {
      line += 1;
      if (index + 1 < end && markdown[index + 1] === "\n") index += 1;
    } else if (markdown[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

function walkFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, path, files);
    else if (entry.isFile()) files.push(toRelative(root, path));
  }
  return files;
}

function readDocuments(root, files = walkFiles(root)) {
  return files
    .filter((path) => /\.md(?:own)?$/i.test(path))
    .sort()
    .map((path) => ({
      path,
      content: readFileSync(resolve(root, path), "utf8"),
    }));
}

function isPathInside(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

function safeRequiredPath(root, path, findings) {
  const repositoryRoot = realpathSync(root);
  const absolute = resolve(root, path);
  if (!isPathInside(resolve(root), absolute)) {
    findings.push(createFinding(path, 1, "required file path escapes the repository"));
    return null;
  }

  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    findings.push(createFinding(path, 1, "required file is missing"));
    return null;
  }
  if (stat.isSymbolicLink()) {
    findings.push(createFinding(path, 1, "required file must not be a symlink"));
    return null;
  }

  try {
    const canonicalPath = realpathSync(absolute);
    if (!isPathInside(repositoryRoot, canonicalPath)) {
      findings.push(createFinding(path, 1, "required file resolves outside the repository"));
      return null;
    }
    return canonicalPath;
  } catch {
    findings.push(createFinding(path, 1, "required file cannot be resolved safely"));
    return null;
  }
}

function walkMarkdown(node, callback) {
  if (!node) return;
  callback(node);
  for (const child of node.children ?? []) walkMarkdown(child, callback);
}

function markdownText(node) {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(markdownText).join("");
}

function decodeHtmlCharacterReferences(value) {
  const text = [];
  const offsets = [];
  const expression = /&(?:#(\d+);?|#x([\da-f]+);?|(?:nbsp|Tab|NewLine|amp|lt|gt|quot|apos);)/gi;
  const named = {
    amp: "&", apos: "'", gt: ">", lt: "<", newline: "\n", nbsp: " ", quot: '"', tab: "\t",
  };
  let cursor = 0;

  for (const match of value.matchAll(expression)) {
    for (let index = cursor; index < match.index; index += 1) {
      text.push(value[index]);
      offsets.push(index);
    }

    let replacement;
    if (match[1] || match[2]) {
      const codePoint = Number.parseInt(match[1] ?? match[2], match[1] ? 10 : 16);
      replacement = codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : "\uFFFD";
    } else {
      replacement = named[match[0].slice(1, -1).toLowerCase()] ?? match[0];
    }
    for (let index = 0; index < replacement.length; index += 1) {
      text.push(replacement[index]);
      offsets.push(match.index);
    }
    cursor = match.index + match[0].length;
  }

  for (let index = cursor; index < value.length; index += 1) {
    text.push(value[index]);
    offsets.push(index);
  }
  return { text: text.join(""), offsets };
}

function preprocessHtmlInput(value) {
  const text = [];
  const offsets = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === "\r") {
      text.push("\n");
      offsets.push(index);
      index += index + 1 < value.length && value[index + 1] === "\n" ? 2 : 1;
    } else if (value[index] === "\0") {
      text.push("\uFFFD");
      offsets.push(index);
      index += 1;
    } else {
      text.push(value[index]);
      offsets.push(index);
      index += 1;
    }
  }
  return { text: text.join(""), offsets };
}

export function decodeHtmlAttributeWithOffsets(value) {
  const input = preprocessHtmlInput(value);
  const text = [];
  const offsets = [];
  let entityOffset = 0;
  const decoder = new EntityDecoder(htmlDecodeTree, (codePoint) => {
    const decoded = String.fromCodePoint(codePoint);
    for (let index = 0; index < decoded.length; index += 1) {
      text.push(decoded[index]);
      offsets.push(entityOffset);
    }
  });

  let cursor = 0;
  while (cursor < input.text.length) {
    if (input.text[cursor] !== "&") {
      text.push(input.text[cursor]);
      offsets.push(input.offsets[cursor]);
      cursor += 1;
      continue;
    }

    entityOffset = input.offsets[cursor];
    decoder.startEntity(DecodingMode.Attribute);
    const length = decoder.write(input.text, cursor + 1);
    const consumed = length < 0 ? decoder.end() : length;
    if (consumed > 0) {
      cursor += consumed;
    } else {
      text.push("&");
      offsets.push(entityOffset);
      cursor += 1;
    }
  }
  return { text: text.join(""), offsets };
}

function isHtmlAsciiWhitespace(character) {
  return character === "\t"
    || character === "\n"
    || character === "\f"
    || character === "\r"
    || character === " ";
}

export function htmlAttributeValueSpan(source, location) {
  const attributeStart = location?.startOffset;
  if (!Number.isInteger(attributeStart) || attributeStart < 0 || attributeStart > source.length) {
    throw new Error("HTML attribute span invariant failed: invalid-start-offset");
  }

  let cursor = attributeStart;
  while (
    cursor < source.length
    && !isHtmlAsciiWhitespace(source[cursor])
    && source[cursor] !== "/"
    && source[cursor] !== ">"
    && source[cursor] !== "="
  ) cursor += 1;
  const nameEnd = cursor;

  while (cursor < source.length && isHtmlAsciiWhitespace(source[cursor])) cursor += 1;
  if (source[cursor] !== "=") return { start: nameEnd, end: nameEnd, hasValue: false };

  cursor += 1;
  while (cursor < source.length && isHtmlAsciiWhitespace(source[cursor])) cursor += 1;
  if (cursor >= source.length || source[cursor] === ">") {
    return { start: cursor, end: cursor, hasValue: true };
  }

  const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor] : null;
  if (quote) {
    const start = cursor + 1;
    cursor = start;
    while (cursor < source.length && source[cursor] !== quote) cursor += 1;
    return { start, end: cursor, hasValue: true };
  }

  const start = cursor;
  while (
    cursor < source.length
    && !isHtmlAsciiWhitespace(source[cursor])
    && source[cursor] !== ">"
  ) cursor += 1;
  return { start, end: cursor, hasValue: true };
}

function removeTemplateContents(value) {
  const preserveLines = (text) => text.replace(/[^\r\n]/g, "");
  const templateTag = /<template(?=[\s/>])(?:(?:"[^"]*"|'[^']*'|[^'">])*)>|<\/template(?=[\s/>])(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let output = "";
  let cursor = 0;
  let depth = 0;

  for (const tag of value.matchAll(templateTag)) {
    output += depth > 0
      ? preserveLines(value.slice(cursor, tag.index))
      : value.slice(cursor, tag.index);

    const closing = /^<\//.test(tag[0]);
    if (closing && depth === 0) {
      output += tag[0];
    } else {
      output += preserveLines(tag[0]);
      depth += closing ? -1 : 1;
    }
    cursor = tag.index + tag[0].length;
  }

  output += depth > 0 ? preserveLines(value.slice(cursor)) : value.slice(cursor);
  return output;
}

const VALID_SRCSET_FLOAT = /^-?(?:(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[0-9]+\.[eE][+-]?[0-9]+)$/;
const BLINK_DECIMAL_PRECISION = 18;
const BLINK_DOUBLE_SERIALIZATION_DIGITS = 15;
const BLINK_DECIMAL_MIN_EXPONENT = -1023n;
const DOUBLE_MAX_ADJUSTED_EXPONENT = 308n;
const DOUBLE_MAX_SIGNIFICAND = "17976931348623157";
const MAX_CHROME_SRCSET_INTEGER = "2147483647";

function parseBlinkDecimal(value) {
  if (!VALID_SRCSET_FLOAT.test(value)) return null;

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const exponentMarker = unsigned.search(/[eE]/);
  const mantissa = exponentMarker < 0 ? unsigned : unsigned.slice(0, exponentMarker);
  const exponentText = exponentMarker < 0 ? "0" : unsigned.slice(exponentMarker + 1);
  const explicitExponent = BigInt(exponentText);
  const [integer, fraction = ""] = mantissa.split(".");

  let coefficientText = "";
  let integerStarted = false;
  let extraIntegerDigits = 0n;
  for (const digit of integer) {
    if (!integerStarted && digit === "0") continue;
    integerStarted = true;
    if (coefficientText.length < BLINK_DECIMAL_PRECISION) coefficientText += digit;
    else extraIntegerDigits += 1n;
  }

  let digitsAfterDot = 0n;
  for (const digit of fraction) {
    if (coefficientText.length >= BLINK_DECIMAL_PRECISION) break;
    coefficientText += digit;
    digitsAfterDot += 1n;
  }

  const coefficient = BigInt(coefficientText || "0");
  if (coefficient === 0n) return { negative: false, coefficient: 0n, exponent: 0n };

  const exponent = explicitExponent - digitsAfterDot + extraIntegerDigits;
  if (exponent < BLINK_DECIMAL_MIN_EXPONENT) {
    return { negative: false, coefficient: 0n, exponent: 0n };
  }
  return { negative, coefficient, exponent };
}

function isWithinDoubleMax(decimal) {
  const digits = decimal.coefficient.toString();
  const adjustedExponent = decimal.exponent + BigInt(digits.length - 1);
  if (adjustedExponent !== DOUBLE_MAX_ADJUSTED_EXPONENT) {
    return adjustedExponent < DOUBLE_MAX_ADJUSTED_EXPONENT;
  }

  const width = Math.max(digits.length, DOUBLE_MAX_SIGNIFICAND.length);
  return digits.padEnd(width, "0") <= DOUBLE_MAX_SIGNIFICAND.padEnd(width, "0");
}

function blinkDecimalDoubleText(decimal) {
  let { coefficient, exponent } = decimal;
  if (exponent < 0n) {
    const digits = coefficient.toString();
    if (digits.length > BLINK_DOUBLE_SERIALIZATION_DIGITS) {
      const droppedDigits = digits.length - BLINK_DOUBLE_SERIALIZATION_DIGITS;
      coefficient = BigInt(digits.slice(0, BLINK_DOUBLE_SERIALIZATION_DIGITS));
      if (digits.charCodeAt(BLINK_DOUBLE_SERIALIZATION_DIGITS) >= 0x35) coefficient += 1n;
      exponent += BigInt(droppedDigits);
    }
    while (exponent < 0n && coefficient % 10n === 0n) {
      coefficient /= 10n;
      exponent += 1n;
    }
  }
  return `${decimal.negative ? "-" : ""}${coefficient}e${exponent}`;
}

function isChromeCompatibleSrcsetDensity(value) {
  const decimal = parseBlinkDecimal(value);
  if (!decimal || !isWithinDoubleMax(decimal)) return false;
  if (decimal.coefficient === 0n) return true;

  const binary64 = Number(blinkDecimalDoubleText(decimal));
  if (!Number.isFinite(binary64)) return false;
  return !(Math.fround(binary64) < 0);
}

function isValidChromeSrcsetInteger(value) {
  const significant = value.replace(/^0+/, "");
  return significant.length > 0
    && (
      significant.length < MAX_CHROME_SRCSET_INTEGER.length
      || (
        significant.length === MAX_CHROME_SRCSET_INTEGER.length
        && significant <= MAX_CHROME_SRCSET_INTEGER
      )
    );
}

function hasValidSrcsetDescriptors(descriptors) {
  let width = false;
  let density = false;
  let futureCompatHeight = false;
  let error = false;

  for (const descriptor of descriptors) {
    const number = descriptor.slice(0, -1);
    const suffix = descriptor.at(-1);
    if (suffix === "w" && /^[0-9]+$/.test(number)) {
      if (width || density) error = true;
      if (!isValidChromeSrcsetInteger(number)) error = true;
      else width = true;
    } else if (suffix === "x") {
      if (width || density || futureCompatHeight) error = true;
      if (!isChromeCompatibleSrcsetDensity(number)) error = true;
      else density = true;
    } else if (suffix === "h" && /^[0-9]+$/.test(number)) {
      if (futureCompatHeight || density) error = true;
      if (!isValidChromeSrcsetInteger(number)) error = true;
      else futureCompatHeight = true;
    } else {
      error = true;
    }
  }

  if (futureCompatHeight && !width) error = true;
  return !error;
}

function srcsetCandidates(value) {
  const candidates = [];
  let cursor = 0;

  while (cursor < value.length) {
    while (
      cursor < value.length
      && (isHtmlAsciiWhitespace(value[cursor]) || value[cursor] === ",")
    ) cursor += 1;
    if (cursor >= value.length) break;

    const start = cursor;
    while (cursor < value.length && !isHtmlAsciiWhitespace(value[cursor])) cursor += 1;
    let target = value.slice(start, cursor);

    if (target.endsWith(",")) {
      while (target.endsWith(",")) target = target.slice(0, -1);
      if (target) candidates.push({ target, offset: start, descriptors: [] });
      continue;
    }

    const descriptors = [];
    let currentDescriptor = "";
    let state = "descriptor";
    let complete = false;
    while (!complete) {
      const character = cursor < value.length ? value[cursor] : null;
      if (state === "descriptor") {
        if (character === null) {
          if (currentDescriptor) descriptors.push(currentDescriptor);
          complete = true;
        } else if (isHtmlAsciiWhitespace(character)) {
          if (currentDescriptor) descriptors.push(currentDescriptor);
          currentDescriptor = "";
          state = "after-descriptor";
          cursor += 1;
        } else if (character === ",") {
          if (currentDescriptor) descriptors.push(currentDescriptor);
          cursor += 1;
          complete = true;
        } else {
          currentDescriptor += character;
          if (character === "(") state = "in-parens";
          cursor += 1;
        }
      } else if (state === "in-parens") {
        if (character === null) {
          if (currentDescriptor) descriptors.push(currentDescriptor);
          complete = true;
        } else {
          currentDescriptor += character;
          if (character === ")") state = "descriptor";
          cursor += 1;
        }
      } else if (character === null) {
        complete = true;
      } else if (isHtmlAsciiWhitespace(character)) {
        cursor += 1;
      } else {
        state = "descriptor";
      }
    }

    if (target && hasValidSrcsetDescriptors(descriptors)) {
      candidates.push({ target, offset: start, descriptors });
    }
  }
  return candidates;
}

function srcsetInvariant(condition, code) {
  if (!condition) throw new Error(`srcset provenance invariant failed: ${code}`);
}

function mappedSrcsetResourceTargets(parsedValue, rawValue, valueOffset) {
  const decoded = decodeHtmlAttributeWithOffsets(rawValue);
  srcsetInvariant(decoded.text === parsedValue, "decoded-value-parity");
  srcsetInvariant(decoded.offsets.length === decoded.text.length, "map-length");

  let previousOrigin = -1;
  for (const origin of decoded.offsets) {
    srcsetInvariant(Number.isInteger(origin), "non-integer-origin");
    srcsetInvariant(origin >= 0 && origin < rawValue.length, "origin-out-of-range");
    srcsetInvariant(origin >= previousOrigin, "origin-order");
    previousOrigin = origin;
  }

  const targets = [];
  let previousCandidateOffset = -1;
  let previousCandidateOrigin = -1;
  for (const candidate of srcsetCandidates(decoded.text)) {
    srcsetInvariant(
      Number.isInteger(candidate.offset)
        && candidate.offset >= 0
        && candidate.offset < decoded.text.length,
      "candidate-decoded-origin",
    );
    srcsetInvariant(candidate.offset > previousCandidateOffset, "candidate-decoded-order");
    srcsetInvariant(decoded.text.startsWith(candidate.target, candidate.offset), "candidate-target-parity");
    const origin = decoded.offsets[candidate.offset];
    srcsetInvariant(origin > previousCandidateOrigin, "candidate-raw-order");
    previousCandidateOffset = candidate.offset;
    previousCandidateOrigin = origin;
    if (!candidate.target.toLowerCase().startsWith("data:")) {
      targets.push({ target: candidate.target, offset: valueOffset + origin });
    }
  }
  return targets;
}

function markdownHtmlProjection(markdown, tree) {
  const ranges = [];
  walkMarkdown(tree, (node) => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (node.type === "html" && Number.isInteger(start) && Number.isInteger(end)) {
      ranges.push({ start, end });
    }
  });
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);

  const mask = (value) => value.replace(/[^\t\n\f\r ]/g, "x");
  const projection = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    const start = Math.max(cursor, range.start);
    projection.push(mask(markdown.slice(cursor, start)));
    projection.push(markdown.slice(start, range.end));
    cursor = range.end;
  }
  projection.push(mask(markdown.slice(cursor)));
  return projection.join("");
}

function parseMarkdownModel(markdown) {
  const tree = markdownParser.parse(markdown);
  const projection = markdownHtmlProjection(markdown, tree);
  const html = parseFragment(projection, { sourceCodeLocationInfo: true });
  return { tree, html };
}

function forEachHtmlElement(root, callback, { includeTemplateContent = false } = {}) {
  const visit = (node) => {
    if (node.tagName) callback(node);
    const children = includeTemplateContent && node.content
      ? node.content.childNodes
      : node.childNodes;
    for (const child of children ?? []) visit(child);
  };
  visit(root);
}

function htmlResourceTargets(markdown, html) {
  const targets = [];
  const allowedAttributes = new Map([
    ["a", new Set(["href", "xlink:href"])],
    ["audio", new Set(["src"])],
    ["embed", new Set(["src"])],
    ["feimage", new Set(["href", "xlink:href"])],
    ["iframe", new Set(["src"])],
    ["image", new Set(["href", "xlink:href"])],
    ["img", new Set(["src", "srcset"])],
    ["input", new Set(["src"])],
    ["link", new Set(["href", "imagesrcset"])],
    ["mpath", new Set(["href", "xlink:href"])],
    ["object", new Set(["data"])],
    ["script", new Set(["src", "href", "xlink:href"])],
    ["source", new Set(["src", "srcset"])],
    ["track", new Set(["src"])],
    ["use", new Set(["href", "xlink:href"])],
    ["video", new Set(["poster", "src"])],
  ]);

  forEachHtmlElement(html, (node) => {
    const tagName = node.tagName?.toLowerCase();
    const allowed = tagName ? allowedAttributes.get(tagName) : null;
    if (allowed && node.sourceCodeLocation?.attrs) {
      for (const attribute of node.attrs ?? []) {
        const attributeName = `${attribute.prefix ? `${attribute.prefix}:` : ""}${attribute.name}`.toLowerCase();
        if (!allowed.has(attributeName)) continue;
        const location = node.sourceCodeLocation.attrs[attributeName];
        if (!location) continue;
        const span = htmlAttributeValueSpan(markdown, location);
        if (!span.hasValue) continue;
        const rawValue = markdown.slice(span.start, span.end);
        const valueOffset = span.start;
        if (attributeName !== "srcset" && attributeName !== "imagesrcset") {
          if (!rawValue && !attribute.value) continue;
          targets.push({ target: attribute.value, offset: valueOffset });
          continue;
        }
        targets.push(...mappedSrcsetResourceTargets(attribute.value, rawValue, valueOffset));
      }
    }
  }, { includeTemplateContent: true });
  return targets;
}

function parsedMarkdownLinks(markdown) {
  const { tree, html } = parseMarkdownModel(markdown);
  const definitions = new Map();
  walkMarkdown(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });

  const links = [];
  walkMarkdown(tree, (node) => {
    const line = node.position?.start?.line ?? 1;
    const index = node.position?.start?.offset ?? 0;
    if (node.type === "link") {
      links.push({ label: markdownText(node), target: node.url, line, index });
    } else if (node.type === "image") {
      links.push({ label: node.alt ?? "", target: node.url, line, index });
    } else if (node.type === "linkReference") {
      const target = definitions.get(node.identifier);
      if (target) links.push({ label: markdownText(node), target, line, index });
    } else if (node.type === "imageReference") {
      const target = definitions.get(node.identifier);
      if (target) links.push({ label: node.alt ?? "", target, line, index });
    }
  });
  for (const resource of htmlResourceTargets(markdown, html)) {
    links.push({
      label: "",
      target: resource.target,
      line: lineNumber(markdown, resource.offset),
      index: resource.offset,
    });
  }
  return links.sort((left, right) => left.index - right.index || left.target.localeCompare(right.target));
}

export function extractMarkdownLinks(markdown) {
  return parsedMarkdownLinks(markdown).map(({ label, target }) => ({ label, target }));
}

function normalizeNpmScriptToken(token, literal) {
  return literal ? token : token.replace(/[.,:]+$/, "");
}

function npmScriptLine(markdown, node, offset) {
  let line = node.position?.start?.line ?? 1;
  if (node.type === "code") {
    const start = node.position?.start?.offset ?? 0;
    const lineEnd = markdown.indexOf("\n", start);
    const sourceLine = markdown.slice(start, lineEnd === -1 ? undefined : lineEnd);
    if (/^[ \t]{0,3}(?:`{3,}|~{3,})/.test(sourceLine)) line += 1;
  }
  return line + lineNumber(node.value, offset) - 1;
}

function parsedNpmScripts(markdown) {
  const scripts = [];
  const tree = markdownParser.parse(markdown);
  walkMarkdown(tree, (node) => {
    const literal = node.type === "inlineCode" || node.type === "code";
    if (!literal && node.type !== "text") return;

    for (const match of node.value.matchAll(NPM_RUN_COMMAND)) {
      const name = normalizeNpmScriptToken(match[1], literal);
      if (!name) continue;
      scripts.push({
        name,
        line: npmScriptLine(markdown, node, match.index),
        index: (node.position?.start?.offset ?? 0) + match.index,
      });
    }
  });
  return scripts.sort((left, right) => left.index - right.index || left.name.localeCompare(right.name));
}

export function extractNpmScripts(markdown) {
  const names = new Set();
  for (const script of parsedNpmScripts(markdown)) names.add(script.name);
  return [...names].sort();
}

function slugifyHeading(heading) {
  return heading
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\\`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function markdownAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  const { tree, html } = parseMarkdownModel(markdown);
  walkMarkdown(tree, (node) => {
    if (node.type === "heading") {
      const base = slugifyHeading(markdownText(node));
      if (base) {
        const count = counts.get(base) ?? 0;
        counts.set(base, count + 1);
        anchors.add(count === 0 ? base : `${base}-${count}`);
      }
    }
  });
  forEachHtmlElement(html, (element) => {
    for (const attribute of element.attrs ?? []) {
      if (attribute.name === "id" || attribute.name === "name") anchors.add(attribute.value);
    }
  });
  return anchors;
}

function isExternalTarget(target) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
}

function splitTarget(target) {
  const hash = target.indexOf("#");
  const beforeHash = hash === -1 ? target : target.slice(0, hash);
  const query = beforeHash.indexOf("?");
  return {
    file: query === -1 ? beforeHash : beforeHash.slice(0, query),
    anchor: hash === -1 ? "" : target.slice(hash + 1),
  };
}

function resolveLocalDocument(root, sourcePath, target) {
  const { file, anchor } = splitTarget(target);

  let decoded;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    return { error: `local Markdown target \"${file}\" has invalid URL encoding` };
  }
  if (isExternalTarget(decoded)) return null;

  const absolute = decoded
    ? resolve(root, dirname(sourcePath), decoded)
    : resolve(root, sourcePath);
  const resolved = toRelative(root, absolute);
  if (resolved === ".." || resolved.startsWith("../")) {
    return { error: `local Markdown target \"${file}\" escapes the repository` };
  }
  try {
    return { path: resolved, anchor: decodeURIComponent(anchor) };
  } catch {
    return { error: `heading anchor \"${anchor}\" has invalid URL encoding` };
  }
}

function validateMarkdownLinks(context) {
  const findings = [];
  const documentByPath = new Map(context.documents.map((document) => [document.path, document]));
  for (const document of context.documents) {
    for (const link of parsedMarkdownLinks(document.content)) {
      const destination = resolveLocalDocument(context.root, document.path, link.target);
      if (!destination) continue;
      const line = link.line;
      if (destination.error) {
        findings.push(createFinding(document.path, line, destination.error));
        continue;
      }
      const targetDocument = documentByPath.get(destination.path);
      let targetExists = Boolean(targetDocument);
      if (!targetExists) {
        try {
          const absoluteTarget = resolve(context.root, destination.path);
          lstatSync(absoluteTarget);
          const realTarget = toRelative(context.root, realpathSync(absoluteTarget));
          targetExists = realTarget !== ".." && !realTarget.startsWith("../");
        } catch {
          targetExists = false;
        }
      }
      if (!targetExists) {
        const target = splitTarget(link.target).file;
        const label = /\.md(?:own)?$/i.test(target) ? "local Markdown target" : "local target";
        findings.push(createFinding(document.path, line, `${label} \"${target}\" does not exist`));
        continue;
      }
      if (!destination.anchor) continue;
      if (!targetDocument) continue;
      if (!markdownAnchors(targetDocument.content).has(destination.anchor)) {
        findings.push(createFinding(
          document.path,
          line,
          `heading anchor \"${destination.anchor}\" does not exist in ${destination.path}`,
        ));
      }
    }
  }
  return findings;
}

function documentedNpmScripts(context) {
  const scripts = [];
  for (const document of context.documents) {
    if (!CURRENT_COMMAND_DOCUMENTS.has(document.path)) continue;
    for (const script of parsedNpmScripts(document.content)) {
      scripts.push({
        path: document.path,
        line: script.line,
        name: script.name,
      });
    }
  }
  return scripts;
}

function readJson(root, path, findings) {
  const absolute = safeRequiredPath(root, path, findings);
  if (!absolute) return null;
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    findings.push(createFinding(path, 1, `invalid JSON: ${error.message}`));
    return null;
  }
}

function validateNpmScripts(context) {
  const findings = [];
  const packageJson = readJson(context.root, "package.json", findings);
  if (!packageJson) return findings;
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    findings.push(createFinding("package.json", 1, "package.json scripts must be an object"));
    return findings;
  }
  for (const name of REQUIRED_DOCS_SCRIPTS) {
    if (!Object.hasOwn(scripts, name)) {
      findings.push(createFinding("package.json", 1, `package.json must define required documentation script ${name}`));
    }
  }
  for (const documented of documentedNpmScripts(context)) {
    if (!Object.hasOwn(scripts, documented.name)) {
      findings.push(createFinding(
        documented.path,
        documented.line,
        `documented npm run ${documented.name} is absent from package.json scripts`,
      ));
    }
  }
  return findings;
}

function runtimeClause(line, index) {
  const sentenceStart = Math.max(
    line.lastIndexOf(".", index - 1),
    line.lastIndexOf("!", index - 1),
    line.lastIndexOf("?", index - 1),
  ) + 1;
  const sentenceEndMatch = /[.!?]/.exec(line.slice(index));
  const sentenceEnd = sentenceEndMatch ? index + sentenceEndMatch.index : line.length;
  const sentence = line.slice(sentenceStart, sentenceEnd);
  const matchOffset = index - sentenceStart;
  const separators = /:|;|,\s+(?:but|however|yet|while)\s+/gi;
  let start = 0;
  let separator;
  while ((separator = separators.exec(sentence))) {
    if (matchOffset < separator.index) return sentence.slice(start, separator.index);
    start = separator.index + separator[0].length;
  }
  return sentence.slice(start);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasPositiveRuntimeRequirement(clause, term) {
  const escapedTerm = escapeRegExp(term);
  const termIsRequired = new RegExp(
    `\\b${escapedTerm}\\b(?:\\s+(?:is|are|must be|should be|remains?))*\\s+(?:required|needed|mandatory|supported|enabled|included)\\b`,
    "i",
  );
  const actionRequiresTerm = new RegExp(
    `\\b(?:must|should|need to|use|install|run|build with|depend on)\\b[^.;]{0,64}\\b${escapedTerm}\\b`,
    "i",
  );
  return termIsRequired.test(clause) || actionRequiresTerm.test(clause);
}

function isNegativeOrOutOfScope(text, match, structuralNegative = false) {
  const clause = runtimeClause(text, match.index);
  const negative = /\b(?:not|no|never|without|removed|retired|historical|superseded|legacy|excluded?|out[- ]of[- ]scope|do not|does not|cannot|must not)\b/i.test(clause);
  return (structuralNegative || negative) && !hasPositiveRuntimeRequirement(clause, match[0]);
}

function appendRuntimeClaimBlock(blocks, node, structuralNegative = false) {
  const text = markdownText(node).replace(/\s+/g, " ").trim();
  if (text) blocks.push({
    text,
    line: node.position?.start?.line ?? 1,
    structuralNegative,
  });
}

function collectRuntimeClaimBlocks(node, blocks, structuralNegative = false) {
  if (node.type === "paragraph") {
    appendRuntimeClaimBlock(blocks, node, structuralNegative);
  } else if (node.type === "list") {
    for (const item of node.children) appendRuntimeClaimBlock(blocks, item, structuralNegative);
  } else if (node.type === "table") {
    for (const row of node.children) {
      for (const cell of row.children) appendRuntimeClaimBlock(blocks, cell, false);
    }
  } else if (node.type === "blockquote") {
    for (const child of node.children) collectRuntimeClaimBlocks(child, blocks, false);
  }
}

function appendExecutableRuntimeBlocks(markdown, blocks) {
  const tree = markdownParser.parse(markdown);
  walkMarkdown(tree, (node) => {
    if (node.type === "code" && (
      node.lang == null
      || EXECUTABLE_FENCE_LANGUAGES.has(String(node.lang).toLowerCase())
    )) {
      const firstContentLine = (node.position?.start?.line ?? 1) + 1;
      for (const [offset, text] of node.value.split("\n").entries()) {
        if (text.trim()) blocks.push({
          text,
          line: firstContentLine + offset,
          structuralNegative: false,
        });
      }
      return;
    }

    if (node.type !== "html") return;
    for (const pre of node.value.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)) {
      for (const code of pre[1].matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) {
        const rawContent = code[1];
        const renderedContent = rawContent
          .replace(/<!--[\s\S]*?-->/g, (value) => value.replace(/[^\r\n]/g, ""))
          .replace(/<br\s*\/?\s*>/gi, "\n");
        const visibleContent = removeTemplateContents(renderedContent).replace(/<[^>]+>/g, "");
        const content = decodeHtmlCharacterReferences(visibleContent).text;
        const contentOffset = pre.index
          + pre[0].indexOf(pre[1])
          + code.index
          + code[0].indexOf(rawContent);
        const firstLine = (node.position?.start?.line ?? 1)
          + lineNumber(node.value, contentOffset)
          - 1;
        for (const [offset, text] of content.split("\n").entries()) {
          if (text.trim()) blocks.push({ text, line: firstLine + offset, structuralNegative: false });
        }
      }
    }
  });
}

function runtimeClaimBlocks(markdown) {
  const blocks = [];
  appendExecutableRuntimeBlocks(markdown, blocks);
  let negativeListHeading = false;
  for (const node of markdownParser.parse(markdown).children) {
    if (node.type === "code" || node.type === "html") {
      negativeListHeading = false;
      continue;
    }
    if (node.type === "heading") {
      const heading = markdownText(node).replace(/\s+/g, " ").trim().toLowerCase();
      negativeListHeading = NEGATIVE_RUNTIME_LIST_HEADINGS.has(heading);
      continue;
    }
    collectRuntimeClaimBlocks(node, blocks, node.type === "list" && negativeListHeading);
    negativeListHeading = false;
  }
  return blocks;
}

function isMainDevelopmentBranch(line) {
  return /\b(?:active\s+)?development\s+branch\s*(?:is|:|=|remains|should be)?\s*[`"']?main\b/i.test(line)
    || /\bmain\b.{0,48}\b(?:active\s+)?development\s+branch\b/i.test(line);
}

function isFixedTestCount(line) {
  return /\b\d+\s+(?:tests?|checks?)\s+(?:are\s+)?(?:pass(?:ed|ing)?|green|successful|complete)\b/i.test(line)
    || /\b(?:pass(?:ed|ing)?|completed?|green|successful)\b[^.\n]{0,40}\ball\s+\d+\s+(?:tests?|checks?)\b/i.test(line);
}

function isDatedVerificationSnapshot(line) {
  return /\b(?:verified snapshot|verification (?:passed|completed|succeeded)(?:\s+on)?)\b[^\n]{0,64}\b\d{4}-\d{2}-\d{2}\b/i.test(line);
}

function isStatusAuthorityClaim(line) {
  const normalized = line.replace(/[`*_]/g, "");
  if (!/\b(?:current|canonical|authoritative)\s+status\s+source\s+of\s+truth\b/i.test(normalized)) return false;
  if (/\bonly\s+docs\/status\.md\s+may\s+claim\b/i.test(normalized)) return false;
  return /\b(?:this|the)\s+(?:document|guide|page|file|status(?:\s+page)?)\s+(?:is|remains|serves as)\b/i.test(normalized)
    || /\bthis\s+is\s+(?:the\s+)?(?:current|canonical|authoritative)\s+status\s+source\s+of\s+truth\b/i.test(normalized)
    || /\b[A-Za-z0-9_./-]+\.md\s+(?:is|remains|serves as)\s+(?:the\s+)?(?:current|canonical|authoritative)\s+status\s+source\s+of\s+truth\b/i.test(normalized);
}

export function validateCanonicalClaims(context) {
  const resolvedContext = buildContext(context.root, context);
  const findings = [];

  for (const document of resolvedContext.documents) {
    const lines = document.content.split("\n");

    if (NORMATIVE_DOCUMENTS.has(document.path)) {
      for (const block of runtimeClaimBlocks(document.content)) {
        const matches = [...block.text.matchAll(OBSOLETE_RUNTIME)];
        for (const match of matches) {
          if (!isNegativeOrOutOfScope(block.text, match, block.structuralNegative)) {
            findings.push(createFinding(
              document.path,
              block.line,
              `current normative documentation positively prescribes obsolete runtime \"${match[0]}\"; state that it is historical or out of scope instead`,
            ));
          }
        }
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      if (NORMATIVE_DOCUMENTS.has(document.path)) {
        if (/\bbrowser-first-preview\b/i.test(line)) {
          findings.push(createFinding(document.path, index + 1, "browser-first-preview must not be presented as the current runtime"));
        }
        if (isMainDevelopmentBranch(line)) {
          findings.push(createFinding(document.path, index + 1, "main must not be presented as the development branch; use dev"));
        }
        if (isFixedTestCount(line)) {
          findings.push(createFinding(document.path, index + 1, "fixed test count must not be presented as current truth"));
        }
        if (document.path === "docs/STATUS.md" && isDatedVerificationSnapshot(line)) {
          findings.push(createFinding(document.path, index + 1, "dated verification snapshot is not freshness evidence; describe the executable verification contract instead"));
        }
        if (/\/Users\/dr\.tom(?:\/|$)/.test(line)) {
          findings.push(createFinding(document.path, index + 1, "founder-specific absolute path is not portable"));
        }
      }

      if (
        document.path !== "docs/STATUS.md"
        && isStatusAuthorityClaim(line)
      ) {
        findings.push(createFinding(
          document.path,
          index + 1,
          "only docs/STATUS.md may claim to be the current status source of truth",
        ));
      }
    }
  }

  return findings;
}

function relativeLinkTarget(root, sourcePath, target) {
  const destination = resolveLocalDocument(root, sourcePath, target);
  return destination?.path ?? null;
}

function entrypointLinks(context, sourcePath) {
  const document = context.documents.find((candidate) => candidate.path === sourcePath);
  if (!document) return [];
  return parsedMarkdownLinks(document.content).map((link) => ({
    ...link,
    path: relativeLinkTarget(context.root, sourcePath, link.target),
  }));
}

function validateEntrypoints(context) {
  const findings = [];
  const documentPaths = new Set(context.documents.map((document) => document.path));
  for (const path of CANONICAL_ENTRYPOINTS) {
    safeRequiredPath(context.root, path, findings);
    if (!documentPaths.has(path)) findings.push(createFinding(path, 1, `Missing canonical entrypoint ${path}`));
  }
  if (findings.length > 0) return findings;

  const orderedLinks = entrypointLinks(context, "AGENTS.md");
  const positions = CANONICAL_ENTRYPOINTS.map((path) => orderedLinks.find((link) => link.path === path)?.index ?? -1);
  if (positions.some((position) => position === -1) || positions.some((position, index) => index > 0 && position < positions[index - 1])) {
    findings.push(createFinding(
      "AGENTS.md",
      1,
      "AGENTS.md must link to AGENTS.md, README.md, INSTALL.md, CONTRIBUTING.md, and docs/README.md in canonical reading order",
    ));
  }

  for (const [source, destination] of [
    ["README.md", "INSTALL.md"],
    ["INSTALL.md", "CONTRIBUTING.md"],
    ["CONTRIBUTING.md", "docs/README.md"],
  ]) {
    if (!entrypointLinks(context, source).some((link) => link.path === destination)) {
      findings.push(createFinding(source, 1, `${source} must link to ${destination} in the canonical reading order`));
    }
  }
  return findings;
}

function trackedFiles(root, fallback) {
  try {
    return execFileSync("git", ["-C", root, "ls-files"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return fallback;
  }
}

function reachableDocumentTarget(context, tracked, sourcePath, target) {
  const { file } = splitTarget(target);
  if (!file || isExternalTarget(file)) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    return null;
  }

  const destination = toRelative(context.root, resolve(context.root, dirname(sourcePath), decoded));
  if (destination === ".." || destination.startsWith("../")) return null;
  if (tracked.has(destination)) return destination;
  const readme = `${destination.replace(/\/$/, "")}/README.md`;
  return tracked.has(readme) ? readme : null;
}

export function validateDocumentationReachability(context) {
  const resolvedContext = buildContext(context.root, context);
  const tracked = new Set(
    (context.trackedFiles ?? trackedFiles(resolvedContext.root, resolvedContext.files))
      .filter((path) => DOCUMENTATION_PATH.test(path) || path.startsWith("docs/")),
  );
  const documents = new Map(resolvedContext.documents.map((document) => [document.path, document]));
  const reached = new Set(
    [...CANONICAL_ENTRYPOINTS, ...IMPLICIT_DOCUMENT_CONSUMERS]
      .filter((path) => tracked.has(path)),
  );
  const queue = CANONICAL_ENTRYPOINTS.filter((path) => tracked.has(path));

  while (queue.length > 0) {
    const source = queue.shift();
    const document = documents.get(source);
    if (!document) continue;
    for (const link of parsedMarkdownLinks(document.content)) {
      const destination = reachableDocumentTarget(resolvedContext, tracked, source, link.target);
      if (!destination || reached.has(destination)) continue;
      reached.add(destination);
      if (documents.has(destination)) queue.push(destination);
    }
  }

  return [...tracked]
    .filter((path) => !reached.has(path))
    .sort()
    .map((path) => createFinding(
      path,
      1,
      "tracked documentation is not reachable from a canonical entrypoint or an explicit runtime/GitHub consumer",
    ));
}

function normalizeTableCell(cell) {
  return markdownText(cell).replace(/[\`*_]/g, "").trim();
}

function normalizeMetadataValue(value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized === "-" ? "None" : normalized;
}

function allowedValue(values, value) {
  return [...values].some((candidate) => candidate.toLowerCase() === value.toLowerCase());
}

function parseAdrIndexTable(markdown) {
  const tree = markdownParser.parse(markdown);
  const definitions = new Map();
  walkMarkdown(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });

  let result = null;
  walkMarkdown(tree, (node) => {
    if (result || node.type !== "table" || node.children.length < 2) return;
    const headers = node.children[0].children;
    const normalizedHeaders = headers.map((header) => normalizeTableCell(header).toLowerCase());
    const adr = normalizedHeaders.indexOf("adr");
    const status = normalizedHeaders.indexOf("decision status");
    const alphaApplicability = normalizedHeaders.indexOf("alpha applicability");
    const supersededBy = normalizedHeaders.indexOf("superseded by");
    const owner = normalizedHeaders.indexOf("owner");
    if ([adr, status, alphaApplicability, supersededBy, owner].includes(-1)) return;
    result = {
      adr,
      status,
      alphaApplicability,
      supersededBy,
      owner,
      definitions,
      rows: node.children.slice(1).map((row) => ({
        line: row.position?.start?.line ?? 1,
        cells: row.children,
      })),
    };
  });
  return result;
}

function adrCellMatches(cell, id, filename, definitions) {
  let matches = false;
  walkMarkdown(cell, (node) => {
    const target = node.type === "link"
      ? node.url
      : node.type === "linkReference"
        ? definitions.get(node.identifier)
        : null;
    if (!target) return;
    const { file } = splitTarget(target);
    try {
      const normalizedFile = decodeURIComponent(file).replace(/^\.\//, "");
      if (normalizedFile === filename && markdownText(node).includes(id)) matches = true;
    } catch {
      // Invalid targets cannot be exact ADR filename matches.
    }
  });
  return matches;
}

function parseMetadataListItem(node) {
  const text = markdownText(node).replace(/\s+/g, " ").trim();
  const separator = text.indexOf(":");
  if (separator !== -1) {
    const key = text.slice(0, separator).replace(/\s+/g, " ").trim().toLowerCase();
    const field = ADR_METADATA_BY_KEY.get(key);
    if (field) {
      return {
        field,
        line: node.position?.start?.line ?? 1,
        value: normalizeMetadataValue(text.slice(separator + 1)),
        malformed: false,
      };
    }
  }

  const normalized = text.toLowerCase();
  const field = ADR_METADATA_FIELDS.find(({ key }) => normalized === key || normalized.startsWith(`${key} `));
  if (!field) return null;
  return {
    field,
    line: node.position?.start?.line ?? 1,
    value: "",
    malformed: true,
  };
}

function metadataListItems(nodes) {
  const items = [];
  for (const node of nodes) {
    walkMarkdown(node, (candidate) => {
      if (candidate.type !== "listItem") return;
      const entry = parseMetadataListItem(candidate);
      if (entry) items.push(entry);
    });
  }
  return items;
}

function parseAdrMetadata(document, findings) {
  const tree = markdownParser.parse(document.content);
  const sections = tree.children;
  const firstH2 = sections.findIndex((node) => node.type === "heading" && node.depth === 2);
  const metadataHeadings = sections
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type === "heading" && node.depth === 2 && markdownText(node).trim() === "Decision Metadata");
  const topMetadata = firstH2 !== -1 && metadataHeadings.some(({ index }) => index === firstH2);

  if (!topMetadata) {
    const line = metadataHeadings[0]?.node.position?.start?.line ?? 1;
    findings.push(createFinding(document.path, line, `${document.path} must have a top ## Decision Metadata block`));
  }

  const metadataStart = topMetadata ? firstH2 : -1;
  let metadataEnd = metadataStart === -1 ? -1 : sections.length;
  if (metadataStart !== -1) {
    const nextSection = sections.findIndex((node, index) => {
      return index > metadataStart && node.type === "heading" && node.depth <= 2;
    });
    if (nextSection !== -1) metadataEnd = nextSection;
  }

  const entries = new Map();
  if (metadataStart !== -1) {
    for (const entry of metadataListItems(sections.slice(metadataStart + 1, metadataEnd))) {
      if (entry.malformed || !entry.value) {
        findings.push(createFinding(
          document.path,
          entry.line,
          `${document.path} has malformed ${entry.field.label} metadata; expected "- ${entry.field.label}: value"`,
        ));
        continue;
      }
      if (entries.has(entry.field.key)) {
        findings.push(createFinding(document.path, entry.line, `${document.path} has duplicate ${entry.field.label} metadata`));
        continue;
      }
      entries.set(entry.field.key, entry);
    }
  }

  for (const field of ADR_METADATA_FIELDS) {
    if (!entries.has(field.key)) {
      findings.push(createFinding(document.path, metadataStart === -1 ? 1 : sections[metadataStart].position?.start?.line ?? 1, `${document.path} is missing ${field.label} metadata`));
    }
  }

  for (const { node, index } of metadataHeadings) {
    if (index === metadataStart) continue;
    findings.push(createFinding(document.path, node.position?.start?.line ?? 1, `${document.path} has a body-level Decision Metadata block`));
  }

  const bodyNodes = sections.filter((node, index) => {
    return metadataStart === -1 || index < metadataStart || index >= metadataEnd;
  });
  for (const entry of metadataListItems(bodyNodes)) {
    if (entry.malformed || !entry.value) continue;
    findings.push(createFinding(document.path, entry.line, `${document.path} has body-level ${entry.field.label} metadata outside the top metadata block`));
  }

  return entries;
}

export function validateAdrIndex(context) {
  const resolvedContext = buildContext(context.root, context);
  const findings = [];
  const index = resolvedContext.documents.find((document) => document.path === "docs/architecture/README.md");
  const discovered = resolvedContext.documents.map((document) => document.path);
  const tracked = context.trackedFiles ?? trackedFiles(resolvedContext.root, discovered);
  const adrs = tracked
    .filter((path) => /^docs\/architecture\/ADR-\d+.*\.md$/i.test(path))
    .sort();

  const safeIndexPath = safeRequiredPath(resolvedContext.root, "docs/architecture/README.md", findings);
  if (!index || !safeIndexPath) {
    if (adrs.length > 0) findings.push(createFinding("docs/architecture/README.md", 1, "ADR index is required for tracked ADR files"));
    return findings;
  }

  const table = parseAdrIndexTable(index.content);
  if (!table) {
    findings.push(createFinding(
      "docs/architecture/README.md",
      1,
      "ADR index must contain a Markdown table with ADR, Decision status, Alpha applicability, Superseded by, and Owner columns",
    ));
    return findings;
  }

  const documentByPath = new Map(resolvedContext.documents.map((document) => [document.path, document]));
  for (const adr of adrs) {
    const id = adr.match(/ADR-\d+/i)[0];
    const rows = table.rows.filter(({ cells }) => {
      return adrCellMatches(cells[table.adr], id, adr.split("/").pop(), table.definitions);
    });
    const row = rows[0];
    if (!row) {
      findings.push(createFinding(adr, 1, `${adr} is missing from docs/architecture/README.md`));
      continue;
    }
    if (rows.length > 1) {
      findings.push(createFinding(
        "docs/architecture/README.md",
        rows[1].line,
        `${adr} has duplicate ADR index rows`,
      ));
    }

    const rowValues = new Map();
    let malformed = false;
    for (const field of ADR_METADATA_FIELDS) {
      const value = normalizeMetadataValue(normalizeTableCell(row.cells[table[field.column]]));
      rowValues.set(field.key, value);
      if (!value) malformed = true;
    }
    if (malformed) {
      findings.push(createFinding(
        "docs/architecture/README.md",
        row.line,
        `${adr} has a malformed ADR index row; all metadata columns require values`,
      ));
    }

    const status = rowValues.get("decision status");
    if (!allowedValue(ALLOWED_ADR_STATUSES, status)) {
      findings.push(createFinding(adr, 1, `${adr} must declare an allowed decision status: Accepted, Deferred, Superseded, or Historical`));
    }

    const alphaApplicability = rowValues.get("alpha applicability");
    if (!alphaApplicability) {
      findings.push(createFinding(adr, 1, `${adr} must declare Alpha applicability in docs/architecture/README.md`));
    } else if (!allowedValue(ALLOWED_ALPHA_APPLICABILITY, alphaApplicability)) {
      findings.push(createFinding(
        adr,
        1,
        `${adr} must declare an allowed Alpha applicability: Applies, Partial, Deferred, Not applicable, or Development only`,
      ));
    }

    const adrDocument = documentByPath.get(adr);
    if (!adrDocument) {
      findings.push(createFinding(adr, 1, `${adr} is tracked but could not be read as Markdown`));
      continue;
    }
    const metadata = parseAdrMetadata(adrDocument, findings);
    const adrStatus = metadata.get("decision status");
    if (adrStatus && !allowedValue(ALLOWED_ADR_STATUSES, adrStatus.value)) {
      findings.push(createFinding(
        adr,
        adrStatus.line,
        `${adr} must declare an allowed decision status: Accepted, Deferred, Superseded, or Historical`,
      ));
    }
    const adrApplicability = metadata.get("alpha applicability");
    if (adrApplicability && !allowedValue(ALLOWED_ALPHA_APPLICABILITY, adrApplicability.value)) {
      findings.push(createFinding(
        adr,
        adrApplicability.line,
        `${adr} must declare an allowed Alpha applicability: Applies, Partial, Deferred, Not applicable, or Development only`,
      ));
    }

    for (const field of ADR_METADATA_FIELDS) {
      const entry = metadata.get(field.key);
      const indexValue = rowValues.get(field.key);
      if (!entry || !indexValue || entry.value === indexValue) continue;
      findings.push(createFinding(
        adr,
        entry.line,
        `${field.label} metadata "${entry.value}" does not match ADR index value "${indexValue}"`,
      ));
    }
  }

  return findings;
}

function yamlString(node) {
  return node?.value === undefined || node?.value === null ? "" : String(node.value);
}

function resolveYamlNode(document, node, seen = new Set()) {
  if (!isAlias(node)) return node;
  if (seen.has(node)) {
    throw new Error("cyclic YAML alias");
  }
  const nextSeen = new Set(seen);
  nextSeen.add(node);
  return resolveYamlNode(document, node.resolve(document), nextSeen);
}

function isYamlMergePair(pair) {
  const key = yamlString(pair.key);
  return key === "<<" || key === "Symbol(<<)";
}

function yamlMapValueResolved(document, node, key, seen = new Set()) {
  const map = resolveYamlNode(document, node, seen);
  if (!isMap(map)) return undefined;
  const direct = map.items.find((pair) => yamlString(pair.key) === key);
  if (direct) {
    return resolveYamlNode(document, direct.value, seen);
  }
  if (seen.has(map)) {
    throw new Error("cyclic YAML merge");
  }
  const nextSeen = new Set(seen);
  nextSeen.add(map);

  for (const pair of map.items.filter(isYamlMergePair)) {
    const merged = resolveYamlNode(document, pair.value, nextSeen);
    const sources = isSeq(merged) ? merged.items : [merged];
    for (const source of sources) {
      const value = yamlMapValueResolved(document, source, key, nextSeen);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function yamlMapEntriesResolved(document, node, seen = new Set()) {
  const map = resolveYamlNode(document, node, seen);
  if (!isMap(map)) return [];
  if (seen.has(map)) {
    throw new Error("cyclic YAML merge");
  }
  const nextSeen = new Set(seen);
  nextSeen.add(map);

  const entries = [];
  const keys = new Set();
  for (const pair of map.items.filter((item) => !isYamlMergePair(item))) {
    const key = yamlString(pair.key);
    keys.add(key);
    entries.push(pair);
  }

  for (const pair of map.items.filter(isYamlMergePair)) {
    const merged = resolveYamlNode(document, pair.value, nextSeen);
    const sources = isSeq(merged) ? merged.items : [merged];
    for (const source of sources) {
      for (const inherited of yamlMapEntriesResolved(document, source, nextSeen)) {
        const key = yamlString(inherited.key);
        if (keys.has(key)) continue;
        keys.add(key);
        entries.push(inherited);
      }
    }
  }
  return entries;
}

function yamlLine(content, node) {
  return typeof node?.range?.[0] === "number" ? lineNumber(content, node.range[0]) : 1;
}

function workflowNodeVersions(context, findings) {
  const versions = [];
  for (const path of context.files.filter((file) => /^\.github\/workflows\/.*\.ya?ml$/i.test(file))) {
    const content = readFileSync(resolve(context.root, path), "utf8");
    const document = parseDocument(content, { merge: true });
    if (document.errors.length > 0) {
      const error = document.errors[0];
      const line = error.linePos?.[0]?.line ?? 1;
      findings.push(createFinding(path, line, `invalid workflow YAML: ${error.message}`));
      continue;
    }

    try {
      const jobs = yamlMapValueResolved(document, document.contents, "jobs");
      if (jobs !== undefined && !isMap(jobs)) {
        findings.push(createFinding(path, yamlLine(content, jobs), "workflow jobs must be a mapping"));
        continue;
      }
      for (const jobPair of yamlMapEntriesResolved(document, jobs)) {
        const job = resolveYamlNode(document, jobPair.value);
        if (!isMap(job)) {
          findings.push(createFinding(path, yamlLine(content, jobPair.value), "workflow job must be a mapping"));
          continue;
        }
        const steps = yamlMapValueResolved(document, job, "steps");
        if (steps === undefined) continue;
        if (!isSeq(steps)) {
          findings.push(createFinding(path, yamlLine(content, steps), "workflow job steps must be a sequence"));
          continue;
        }
        for (const rawStep of steps.items) {
          const step = resolveYamlNode(document, rawStep);
          if (!isMap(step)) {
            findings.push(createFinding(path, yamlLine(content, rawStep), "workflow step must be a mapping"));
            continue;
          }
          const uses = yamlMapValueResolved(document, step, "uses");
          if (!/^actions\/setup-node@/i.test(yamlString(uses))) continue;
          const withValues = yamlMapValueResolved(document, step, "with");
          const nodeVersion = yamlMapValueResolved(document, withValues, "node-version");
          if (nodeVersion !== undefined) {
            findings.push(createFinding(
              path,
              yamlLine(content, nodeVersion),
              "actions/setup-node must use node-version-file: .nvmrc instead of node-version",
            ));
          }

          const nodeVersionFile = yamlMapValueResolved(document, withValues, "node-version-file");
          if (nodeVersionFile === undefined) {
            findings.push(createFinding(
              path,
              yamlLine(content, rawStep),
              "actions/setup-node must use node-version-file: .nvmrc",
            ));
          } else {
            const versionFilePath = yamlString(nodeVersionFile);
            if (versionFilePath !== ".nvmrc") {
              findings.push(createFinding(
                path,
                yamlLine(content, nodeVersionFile),
                `actions/setup-node node-version-file must be .nvmrc, got ${versionFilePath}`,
              ));
            } else {
              const safePath = safeRequiredPath(context.root, versionFilePath, findings);
              if (safePath) {
                versions.push({
                  path,
                  line: yamlLine(content, nodeVersionFile),
                  value: readFileSync(safePath, "utf8").trim(),
                });
              }
            }
          }
        }
      }
    } catch {
      findings.push(createFinding(path, 1, "workflow aliases or merge keys could not be resolved safely"));
    }
  }
  return versions;
}

function workflowVersionAgrees(version, nvmVersion) {
  const normalized = version.replace(/^v/i, "");
  const range = semver.validRange(normalized);
  return Boolean(range) && semver.satisfies(nvmVersion, range);
}

function trackedPackageSurfacePaths(context, filename) {
  const tracked = context.trackedFiles ?? trackedFiles(context.root, context.files);
  const paths = tracked.filter((path) => path === filename || path.endsWith(`/${filename}`));
  if (filename === "package.json" && !paths.includes("package.json")) paths.unshift("package.json");
  return [...new Set(paths)].sort();
}

function validateEngineFloor(metadata, path, nvmVersion, findings) {
  const range = metadata?.engines?.node;
  const normalizedRange = typeof range === "string" ? semver.validRange(range) : null;
  const floor = normalizedRange ? semver.minVersion(normalizedRange) : null;
  if (!floor) {
    findings.push(createFinding(path, 1, `${path} must declare engines.node with a >= Node version floor`));
  } else if (!semver.eq(nvmVersion, floor.version)) {
    findings.push(createFinding(
      path,
      1,
      `${path} engines.node ${range} does not agree with .nvmrc ${nvmVersion}`,
    ));
  }
}

function validateNodeVersions(context) {
  const findings = [];
  const nvmPath = safeRequiredPath(context.root, ".nvmrc", findings);
  if (!nvmPath) return findings;
  const nvmVersion = semver.valid(readFileSync(nvmPath, "utf8").trim());
  if (!nvmVersion) {
    findings.push(createFinding(".nvmrc", 1, "must contain an exact Node version"));
    return findings;
  }

  const versions = workflowNodeVersions(context, findings);
  if (versions.length === 0) {
    findings.push(createFinding(".github/workflows", 1, "no workflow declares a Node version"));
  }
  for (const workflow of versions) {
    if (!workflowVersionAgrees(workflow.value, nvmVersion)) {
      findings.push(createFinding(
        workflow.path,
        workflow.line,
        `workflow Node version ${workflow.value} does not agree with .nvmrc ${nvmVersion}`,
      ));
    }
  }

  for (const path of trackedPackageSurfacePaths(context, "package.json")) {
    const packageJson = readJson(context.root, path, findings);
    if (packageJson) validateEngineFloor(packageJson, path, nvmVersion, findings);
  }

  for (const lockPath of trackedPackageSurfacePaths(context, "package-lock.json")) {
    const lockfile = readJson(context.root, lockPath, findings);
    if (!lockfile?.packages) {
      if (lockfile) findings.push(createFinding(lockPath, 1, `${lockPath} must expose a packages map`));
      continue;
    }

    const rootPackage = lockfile.packages[""];
    if (!rootPackage || typeof rootPackage !== "object" || Array.isArray(rootPackage)) {
      findings.push(createFinding(lockPath, 1, `${lockPath} has malformed root package metadata`));
    } else {
      validateEngineFloor(rootPackage, lockPath, nvmVersion, findings);
    }

    for (const [dependencyPath, metadata] of Object.entries(lockfile.packages)) {
      if (!dependencyPath) continue;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        findings.push(createFinding(lockPath, 1, `${dependencyPath} has malformed package metadata`));
        continue;
      }
      if (!metadata.engines?.node) continue;
      const range = semver.validRange(metadata.engines.node);
      if (!range) {
        findings.push(createFinding(lockPath, 1, `${dependencyPath} (${metadata.version ?? "unknown"}) has invalid Node engine ${metadata.engines.node}`));
      } else if (!semver.satisfies(nvmVersion, range)) {
        findings.push(createFinding(
          lockPath,
          1,
          `${dependencyPath} (${metadata.version ?? "unknown"}) declares Node engine ${metadata.engines.node}, which .nvmrc ${nvmVersion} does not satisfy`,
        ));
      }
    }
  }
  return findings;
}

function buildContext(root, options = {}) {
  const resolvedRoot = resolve(root);
  const files = options.files ?? walkFiles(resolvedRoot);
  return {
    root: resolvedRoot,
    files,
    trackedFiles: options.trackedFiles,
    documents: options.documents ?? readDocuments(resolvedRoot, files),
  };
}

export function validateRepositoryDocs(root, options = {}) {
  const context = buildContext(root, options);
  const findings = [
    ...validateMarkdownLinks(context),
    ...validateNpmScripts(context),
    ...validateCanonicalClaims(context),
    ...validateEntrypoints(context),
    ...validateDocumentationReachability(context),
    ...validateAdrIndex({ ...context, ...options }),
    ...validateNodeVersions(context),
  ].sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.line - right.line
    || left.message.localeCompare(right.message)
  ));
  return { findings };
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const { findings } = validateRepositoryDocs(process.cwd());
  if (findings.length === 0) {
    console.log("Documentation contract validation passed.");
  } else {
    console.error(`Documentation contract validation found ${findings.length} issue(s):`);
    for (const finding of findings) console.error(`${finding.path}:${finding.line}: ${finding.message}`);
    process.exitCode = 1;
  }
}
