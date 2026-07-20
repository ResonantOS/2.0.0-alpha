#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "disciplines", "DISCIPLINES.md");
const validStatuses = new Set(["candidate", "active-pattern", "implemented", "canonical", "deprecated"]);
const requiredSections = ["## Purpose", "## Boundary", "## Evidence", "## Validation", "## Quality Bar", "## Promotion Guardrail"];

function fail(message) {
  failures.push(message);
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function extractLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
}

function resolveLocalLink(fromFile, link) {
  const target = link.split("#", 1)[0];
  return path.resolve(path.dirname(fromFile), target);
}

const failures = [];

if (!existsSync(catalogPath)) {
  fail("missing disciplines/DISCIPLINES.md");
} else {
  const catalog = readFileSync(catalogPath, "utf8");
  const lines = catalog.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("| ID | Discipline |"));

  if (headerIndex === -1) {
    fail("catalog table header not found");
  } else {
    const header = splitRow(lines[headerIndex]);
    const expected = ["ID", "Discipline", "Status", "Steward", "Evidence", "Next hardening move"];
    if (header.join("\0") !== expected.join("\0")) {
      fail(`catalog columns must be: ${expected.join(", ")}`);
    }

    const seenIds = new Set();
    for (const line of lines.slice(headerIndex + 2)) {
      if (!line.startsWith("|")) break;
      const cells = splitRow(line);
      if (cells.length !== expected.length) {
        fail(`row has wrong column count: ${line}`);
        continue;
      }

      const id = cells[0].replace(/`/g, "");
      const status = cells[2];
      const evidence = cells[4];

      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        fail(`invalid discipline id: ${id}`);
      }
      if (seenIds.has(id)) {
        fail(`duplicate discipline id: ${id}`);
      }
      seenIds.add(id);
      if (!validStatuses.has(status)) {
        fail(`${id}: invalid status: ${status}`);
      }

      const links = extractLinks(evidence);
      if (links.length === 0) {
        fail(`${id}: evidence cell must include a local Markdown link`);
      }
      for (const link of links) {
        if (/^[a-z]+:\/\//i.test(link)) {
          fail(`${id}: evidence link must be local: ${link}`);
          continue;
        }
        const target = resolveLocalLink(catalogPath, link);
        if (!existsSync(target)) {
          fail(`${id}: missing evidence target: ${link}`);
          continue;
        }

        const card = readFileSync(target, "utf8");
        for (const section of requiredSections) {
          if (!card.includes(section)) {
            fail(`${id}: card missing ${section}`);
          }
        }
      }
    }

    if (seenIds.size === 0) {
      fail("catalog table has no rows");
    }
  }
}

if (failures.length > 0) {
  console.error("Discipline catalog validation failed");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Discipline catalog validation passed");
