// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-013-living-archive-memory-domains.md

import type { ArchiveLibraryPreflightResult } from "../../core/contracts";

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
};

const listLabels = (labels: string[]): string => (labels.length ? labels.join(", ") : "none");

const formatCounts = (counts: ArchiveLibraryPreflightResult["supportedByTopFolder"]): string =>
  counts
    .slice(0, 8)
    .map((item) => `- ${item.label}: ${item.count} file(s), ${formatBytes(item.sizeBytes)}`)
    .join("\n") || "- none";

const formatSamples = (samples: ArchiveLibraryPreflightResult["samples"]): string =>
  samples
    .slice(0, 8)
    .map((sample) => `- ${sample.reason}: ${sample.path}`)
    .join("\n") || "- none";

export const buildArchivePreflightAugmentorPrompt = (report: ArchiveLibraryPreflightResult): string =>
  [
    "Help me understand this Living Archive import preflight and the recommended import plan.",
    "",
    "Use the supplied facts and ResonantOS architecture memory. Explain what is happening in plain language, why files were skipped, whether the recommended plan is safe, and what I should do next. Keep the answer practical.",
    "",
    "Important boundaries:",
    "- The Living Archive keeps Human Knowledge, External Knowledge, and AI Memory separate.",
    "- Copy-on-import preserves the original source and makes the managed ResonantOS copy canonical.",
    "- Obvious technical/generated folders can be excluded automatically.",
    "- Ambiguous folders should be explained, not silently reorganised.",
    "- Specialist media extraction belongs to reviewed add-ons and should not be treated as core Living Archive functionality unless such an add-on is installed.",
    "",
    "Preflight facts:",
    `- Source path: ${report.sourcePath}`,
    `- Source exists: ${report.exists ? "yes" : "no"}`,
    `- Directory: ${report.isDirectory ? "yes" : "no"}`,
    `- Obsidian vault detected: ${report.obsidianVaultDetected ? "yes" : "no"}`,
    `- Supported files: ${report.supportedFiles}`,
    `- Skipped files: ${report.skippedFiles}`,
    `- Estimated source size: ${formatBytes(report.estimatedImportBytes)}`,
    `- Estimated managed storage: ${formatBytes(report.estimatedManagedStorageBytes)}`,
    "",
    "Recommended plan:",
    `- Summary: ${report.recommendedPlan.summary}`,
    `- Action: ${report.recommendedPlan.recommendedAction}`,
    `- Included top folders: ${listLabels(report.recommendedPlan.includedTopFolders)}`,
    `- Auto-excluded technical folders: ${listLabels(report.recommendedPlan.autoExcludedTopFolders)}`,
    `- Ambiguous folders: ${listLabels(report.recommendedPlan.ambiguousTopFolders)}`,
    `- Approval note: ${report.recommendedPlan.approvalNote}`,
    "",
    "Supported files by top folder:",
    formatCounts(report.supportedByTopFolder),
    "",
    "Skipped files by top folder:",
    formatCounts(report.skippedByTopFolder),
    "",
    "Skipped examples:",
    formatSamples(report.samples),
    "",
    "Answer as Augmentor. Start with the user-facing meaning of the result, then give the recommended next action. If there is a risk or uncertainty, state it clearly.",
  ].join("\n");
