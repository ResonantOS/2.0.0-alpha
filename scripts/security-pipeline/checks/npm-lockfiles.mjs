import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function run({ check, repoRoot }) {
  const surfaces = Array.isArray(check.surfaces) ? check.surfaces : [];
  const lockfiles = Array.isArray(check.lockfiles) && check.lockfiles.length > 0
    ? check.lockfiles
    : ["package-lock.json", "npm-shrinkwrap.json"];
  const evidence = [];
  const failures = [];

  for (const surface of surfaces) {
    const surfaceRoot = path.resolve(repoRoot, surface);
    const packagePath = path.join(surfaceRoot, "package.json");
    if (!existsSync(packagePath)) {
      failures.push(`${surface}: package.json not found`);
      evidence.push({ surface, status: "fail", reason: "package.json not found" });
      continue;
    }

    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    const dependencyCount = countDependencies(pkg);
    const presentLockfiles = lockfiles.filter((lockfile) => existsSync(path.join(surfaceRoot, lockfile)));

    if (dependencyCount === 0) {
      evidence.push({
        surface,
        status: "pass",
        dependencyCount,
        lockfiles: presentLockfiles,
        reason: "No dependencies declared; lockfile not required."
      });
      continue;
    }

    if (presentLockfiles.length === 0) {
      failures.push(`${surface}: ${dependencyCount} dependencies but no supported lockfile`);
      evidence.push({
        surface,
        status: "fail",
        dependencyCount,
        lockfiles: [],
        reason: "Dependency-bearing package surface lacks a supported lockfile."
      });
      continue;
    }

    evidence.push({
      surface,
      status: "pass",
      dependencyCount,
      lockfiles: presentLockfiles,
      reason: "Dependency-bearing package surface has a supported lockfile."
    });
  }

  return {
    status: failures.length > 0 ? "fail" : "pass",
    summary: failures.length > 0
      ? `Missing lockfiles: ${failures.join("; ")}`
      : `${surfaces.length} npm surfaces checked for lockfile coverage.`,
    evidence
  };
}

function countDependencies(pkg) {
  return Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
}
