import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

function clampHistoryLimit(limit) {
  return Math.max(1, Math.min(50, Number(limit) || 10));
}

function isSameOrInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function redactText(value) {
  return String(value ?? "")
    .replace(/sk-[a-z0-9_-]+/gi, "[redacted-key]")
    .replace(/Bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted-token]")
    .replace(/api[_-]?key['":=\s]+[a-z0-9._-]+/gi, "api_key=[redacted]")
    .slice(0, 2_000);
}

export function memorySourceSyncHistoryPath(memoryRoot) {
  return path.join(memoryRoot, "CONFIG", "source-sync-history.json");
}

export function memorySourceRepairHistoryPath(memoryRoot) {
  return path.join(memoryRoot, "CONFIG", "source-version-repairs.json");
}

export function memorySourceMoveHistoryPath(memoryRoot) {
  return path.join(memoryRoot, "CONFIG", "source-move-history.json");
}

export function redactSourcePathForMemoryHistory(filePath, { userRoot = os.homedir() } = {}) {
  const raw = String(filePath ?? "").trim();
  if (!raw) {
    return "";
  }
  const basename = path.basename(raw.replace(/[/\\]+$/, "")) || "source";
  // History is a diagnostic surface. Keep only a non-sensitive label even
  // when the source lives below the operating-system home directory; a `~/`
  // prefix still reveals where a user keeps private material and makes
  // history output inconsistent across callers.
  void userRoot;
  return `[path]/${basename}`;
}

export function managedMemoryPathForHistory(filePath, { memoryRoot, userRoot = os.homedir() } = {}) {
  const raw = String(filePath ?? "").trim();
  if (!raw) {
    return "";
  }
  const resolved = path.resolve(raw);
  if (memoryRoot && isSameOrInside(resolved, memoryRoot)) {
    return path.relative(memoryRoot, resolved).replace(/\\/g, "/");
  }
  return redactSourcePathForMemoryHistory(raw, { userRoot });
}

async function readHistoryFile(filePath, limit) {
  if (!existsSync(filePath)) {
    return [];
  }
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return entries.slice(0, clampHistoryLimit(limit));
}

async function writeHistoryEntry(filePath, safeEntry, current) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ entries: [safeEntry, ...current].slice(0, 50) }, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
  return safeEntry;
}

export async function readMemorySourceSyncHistory({ memoryRoot, limit = 10 }) {
  return readHistoryFile(memorySourceSyncHistoryPath(memoryRoot), limit);
}

export async function appendMemorySourceSyncHistory({ memoryRoot, userRoot, entry, redactDiagnosticText = redactText }) {
  const filePath = memorySourceSyncHistoryPath(memoryRoot);
  const current = await readMemorySourceSyncHistory({ memoryRoot, limit: 49 }).catch(() => []);
  const safeEntry = {
    id: entry.id,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    status: entry.status,
    mode: entry.mode,
    autoSync: entry.autoSync === true,
    autoIntake: entry.autoIntake === true,
    reviewedSources: Number(entry.reviewedSources ?? 0),
    eligibleFiles: Number(entry.eligibleFiles ?? 0),
    createdArtifacts: Number(entry.createdArtifacts ?? 0),
    reviewRequests: Number(entry.reviewRequests ?? 0),
    rejectedFiles: Number(entry.rejectedFiles ?? 0),
    skippedSources: Array.isArray(entry.skippedSources)
      ? entry.skippedSources.map((source) => ({
          sourceId: String(source.sourceId ?? "").slice(0, 160),
          path: redactSourcePathForMemoryHistory(source.path ?? "", { userRoot }),
          reason: redactDiagnosticText(source.reason ?? ""),
        })).slice(0, 20)
      : [],
    sources: Array.isArray(entry.sources)
      ? entry.sources.map((source) => ({
          sourceId: String(source.sourceId ?? "").slice(0, 160),
          path: redactSourcePathForMemoryHistory(source.path ?? "", { userRoot }),
          candidates: Number(source.candidates ?? 0),
          eligibleFiles: Number(source.eligibleFiles ?? 0),
          createdArtifacts: Number(source.createdArtifacts ?? 0),
          reviewRequests: Number(source.reviewRequests ?? 0),
          rejectedFiles: Number(source.rejectedFiles ?? 0),
          status: String(source.status ?? "unknown").slice(0, 80),
          eligibleFileSamples: Array.isArray(source.eligibleFileSamples)
            ? source.eligibleFileSamples.map((file) => String(file ?? "").slice(0, 240)).slice(0, 10)
            : [],
          createdArtifactSamples: Array.isArray(source.createdArtifactSamples)
            ? source.createdArtifactSamples.map((artifact) => ({
                sourceFile: String(artifact.sourceFile ?? "").slice(0, 240),
                path: String(artifact.path ?? "").slice(0, 240),
              })).slice(0, 10)
            : [],
          rejectedFileSamples: Array.isArray(source.rejectedFileSamples)
            ? source.rejectedFileSamples.map((rejected) => ({
                sourceFile: String(rejected.sourceFile ?? "").slice(0, 240),
                reason: redactDiagnosticText(rejected.reason ?? "").slice(0, 240),
              })).slice(0, 10)
            : [],
        })).slice(0, 50)
      : [],
  };
  return writeHistoryEntry(filePath, safeEntry, current);
}

export async function readMemorySourceRepairHistory({ memoryRoot, limit = 10 }) {
  return readHistoryFile(memorySourceRepairHistoryPath(memoryRoot), limit);
}

export async function appendMemorySourceRepairHistory({ memoryRoot, userRoot, entry, redactDiagnosticText = redactText }) {
  const filePath = memorySourceRepairHistoryPath(memoryRoot);
  const current = await readMemorySourceRepairHistory({ memoryRoot, limit: 49 }).catch(() => []);
  const safeEntry = {
    id: String(entry.id ?? `repair-${randomUUID()}`).slice(0, 120),
    sourceId: String(entry.sourceId ?? "").slice(0, 160),
    sourcePath: redactSourcePathForMemoryHistory(entry.sourcePath ?? "", { userRoot }),
    status: String(entry.status ?? "unknown").slice(0, 80),
    repairedAt: String(entry.repairedAt ?? new Date().toISOString()).slice(0, 80),
    backupPath: String(entry.backupPath ?? "").slice(0, 260),
    reason: redactDiagnosticText(entry.reason ?? "").slice(0, 260),
    message: redactDiagnosticText(entry.message ?? "").slice(0, 260),
  };
  return writeHistoryEntry(filePath, safeEntry, current);
}

export async function readMemorySourceMoveHistory({ memoryRoot, limit = 10 }) {
  return readHistoryFile(memorySourceMoveHistoryPath(memoryRoot), limit);
}

export async function appendMemorySourceMoveHistory({ memoryRoot, userRoot, entry, redactDiagnosticText = redactText }) {
  const filePath = memorySourceMoveHistoryPath(memoryRoot);
  const current = await readMemorySourceMoveHistory({ memoryRoot, limit: 49 }).catch(() => []);
  const safeEntry = {
    id: String(entry.id ?? `move-${randomUUID()}`).slice(0, 120),
    action: String(entry.action ?? "move").slice(0, 80),
    sourceId: String(entry.sourceId ?? "").slice(0, 160),
    moveId: String(entry.moveId ?? "").slice(0, 160),
    status: String(entry.status ?? "unknown").slice(0, 80),
    at: String(entry.at ?? new Date().toISOString()).slice(0, 80),
    originalPath: redactSourcePathForMemoryHistory(entry.originalPath ?? "", { userRoot }),
    managedPath: managedMemoryPathForHistory(entry.managedPath ?? "", { memoryRoot, userRoot }),
    ledgerPath: managedMemoryPathForHistory(entry.ledgerPath ?? "", { memoryRoot, userRoot }),
    manifestPath: managedMemoryPathForHistory(entry.manifestPath ?? "", { memoryRoot, userRoot }),
    movedCount: Number(entry.movedCount ?? 0),
    restoredCount: Number(entry.restoredCount ?? 0),
    skippedCount: Number(entry.skippedCount ?? 0),
    message: redactDiagnosticText(entry.message ?? "").slice(0, 260),
  };
  return writeHistoryEntry(filePath, safeEntry, current);
}
