#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROADMAP_SCOPE_HEADINGS = new Map([
  ["Alpha MVP", "Alpha MVP"],
  ["Community Test", "Community Test"],
  ["Deferred", "Deferred / Waived"],
  ["Experimental", "Experimental"],
  ["Native Future", "Native Future"],
  ["Legacy", "Legacy"],
]);
const LABEL_SCOPES = new Map([
  ["scope:alpha-mvp", "Alpha MVP"],
  ["scope:community-test", "Community Test"],
  ["scope:deferred", "Deferred / Waived"],
  ["scope:experimental", "Experimental"],
  ["scope:native-future", "Native Future"],
  ["scope:legacy", "Legacy"],
]);

function roadmapScopes(markdown) {
  const scopes = new Map();
  let scope = null;
  for (const line of String(markdown).split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      scope = ROADMAP_SCOPE_HEADINGS.get(heading[1]) ?? null;
      continue;
    }
    if (!scope) continue;
    for (const issue of line.matchAll(/\/issues\/(\d+)(?:[)#/?]|$)/g)) {
      scopes.set(Number(issue[1]), scope);
    }
  }
  return scopes;
}

function projectScope(item) {
  const field = item?.["release Scope"]
    ?? item?.["release scope"]
    ?? item?.releaseScope
    ?? item?.release_scope;
  if (field) return field;
  const inferred = [...new Set((item?.labels ?? []).map((label) => LABEL_SCOPES.get(label)).filter(Boolean))];
  return inferred.length === 1 ? inferred[0] : null;
}

export function findRoadmapProjectMismatches(markdown, projectItems) {
  const projectByIssue = new Map(
    (projectItems ?? [])
      .filter((item) => Number.isInteger(item?.content?.number))
      .map((item) => [item.content.number, item]),
  );
  const mismatches = [];

  for (const [issue, roadmapScope] of roadmapScopes(markdown)) {
    const item = projectByIssue.get(issue);
    if (["CLOSED", "MERGED"].includes(String(item?.content?.state ?? "").toUpperCase())) continue;
    const projectScopeValue = projectScope(item);
    if (projectScopeValue === roadmapScope) continue;
    mismatches.push({
      issue,
      projectScope: projectScopeValue ?? "Unresolved",
      roadmapScope,
    });
  }
  return mismatches;
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected --name value, got ${key}`);
    }
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const projectJsonPath = args.get("project-json");
  if (!projectJsonPath) throw new Error("--project-json is required");
  const roadmapPath = args.get("roadmap") ?? "docs/ROADMAP.md";
  const project = JSON.parse(readFileSync(resolve(projectJsonPath), "utf8"));
  const markdown = readFileSync(resolve(roadmapPath), "utf8");
  const mismatches = findRoadmapProjectMismatches(markdown, project.items ?? project);

  if (mismatches.length) {
    for (const mismatch of mismatches) {
      console.error(
        `#${mismatch.issue}: roadmap=${mismatch.roadmapScope}; Project=${mismatch.projectScope}`,
      );
    }
    process.exitCode = 1;
    return mismatches;
  }
  console.log("Roadmap and Project 2 scope classifications agree.");
  return [];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
