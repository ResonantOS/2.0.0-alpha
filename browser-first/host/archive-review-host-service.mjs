import path from "node:path";
import { createArchiveReviewService } from "./archive-review-service.mjs";

export function safeMemoryRelativePathForRoot(memoryRoot, relativePath, requiredPrefix = "INTAKE") {
  const normalized = String(relativePath ?? "").replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0") || path.isAbsolute(normalized)) {
    throw new Error("Archive path must be a relative memory path.");
  }
  const prefix = `${requiredPrefix}/`;
  if (normalized !== requiredPrefix && !normalized.startsWith(prefix)) {
    throw new Error(`Archive path must stay inside ${requiredPrefix}.`);
  }
  const root = path.resolve(memoryRoot);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Archive path escapes the memory root.");
  }
  return resolved;
}

export function frontmatterValue(content, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(content);
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1].replace(/^["']|["']$/g, "");
  }
}

export function writeFrontmatterValue(content, key, value) {
  const serialized = `${key}: ${JSON.stringify(value)}`;
  const linePattern = new RegExp(`^${key}:\\s*.+$`, "m");
  if (linePattern.test(content)) {
    return content.replace(linePattern, serialized);
  }
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      return `${content.slice(0, end)}\n${serialized}${content.slice(end)}`;
    }
  }
  return ["---", serialized, "---", "", content].join("\n");
}

export function markdownTitle(content, fallback) {
  return frontmatterValue(content, "title") ||
    /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ||
    fallback;
}

export function artifactKind(content, filePath) {
  if (content.includes("# Browser Job Report")) return "browser-job-report";
  if (content.includes("# Browser Agent Control Report")) return "browser-control-report";
  const portablePath = String(filePath ?? "").replace(/\\/g, "/");
  if (portablePath.includes("/browser/")) return "browser-intake";
  return "intake";
}

export function markdownBody(content) {
  return content.replace(/^---[\s\S]*?---\s*/m, "").trim();
}

export function compactExcerpt(content, limit = 1_800) {
  return markdownBody(content)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function artifactInsights(content) {
  const value = String(content ?? "");
  const lineValue = (label) => {
    const match = new RegExp(`^-\\s*${label}:\\s*(.+)$`, "mi").exec(value);
    return match?.[1]?.trim() ?? "";
  };
  return {
    nextHumanAction: /^ {0,5}-\s*next human action:\s*(.+)$/gmi.exec(value)?.[1]?.trim() ?? "",
    percentComplete: lineValue("percentComplete"),
    phase: lineValue("phase"),
    status: lineValue("status"),
    summary: lineValue("summary"),
    targetReason: lineValue("targetReason"),
    targetSite: lineValue("targetSite"),
  };
}

export function markdownSection(content, heading) {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|\\s*$)`, "m");
  return pattern.exec(content)?.[1]?.trim() ?? "";
}

export function createArchiveReviewHostService({
  memoryRoot,
  userRoot,
  listFilesRecursive,
  safeFileSlug,
  runArchiveIngestWriter,
  runArchiveSemanticVerifier,
} = {}) {
  const safeMemoryRelativePath = (relativePath, requiredPrefix = "INTAKE") =>
    safeMemoryRelativePathForRoot(memoryRoot(), relativePath, requiredPrefix);

  return createArchiveReviewService({
    memoryRoot,
    userRoot,
    listFilesRecursive,
    safeFileSlug,
    safeMemoryRelativePath,
    frontmatterValue,
    writeFrontmatterValue,
    markdownTitle,
    artifactKind,
    artifactInsights,
    markdownSection,
    compactExcerpt,
    runArchiveIngestWriter,
    runArchiveSemanticVerifier,
  });
}
