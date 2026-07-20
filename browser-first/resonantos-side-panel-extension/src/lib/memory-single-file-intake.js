// Intent citation: docs/architecture/ADR-027-living-archive-llm-wiki-compliance.md

const SINGLE_FILE_INTAKE_LIMIT_BYTES = 1_000_000;
const SINGLE_FILE_INTAKE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv", ".json"]);

export function isSupportedSingleFileIntake(file) {
  const name = String(file?.name ?? "").toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const type = String(file?.type ?? "").toLowerCase();
  return SINGLE_FILE_INTAKE_EXTENSIONS.has(extension) ||
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/csv";
}

export async function singleFileIntakeContent(file) {
  if (!file) {
    return null;
  }
  if (!isSupportedSingleFileIntake(file)) {
    return [
      `# ${file.name || "Unsupported attachment"}`,
      "",
      "## Boundary",
      "This is a metadata-only attachment stub. ResonantOS did not read or copy the binary file content, and this stub is not trusted AI Memory until review, draft, verification, and promotion complete.",
      "",
      "## File Metadata",
      `- name: ${file.name || "unknown"}`,
      `- type: ${file.type || "unknown"}`,
      `- bytes: ${Number(file.size ?? 0)}`,
      "- contentStatus: metadata-only",
      "",
      "## Required Add-on",
      "Install or enable a specialist attachment add-on before extracting content from this file type. Examples include PDF, DOCX, image, audio, or video processors.",
      "",
    ].join("\n");
  }
  if (Number(file.size ?? 0) > SINGLE_FILE_INTAKE_LIMIT_BYTES) {
    throw new Error("Single-file intake is capped at 1 MB. Use folder import for larger source sets.");
  }
  const text = await file.text();
  if (!String(text ?? "").trim()) {
    throw new Error("Selected file is empty.");
  }
  return [
    `# ${file.name || "Uploaded source file"}`,
    "",
    "## Boundary",
    "This is a single-file governed intake copy. It is raw source evidence and is not trusted AI Memory until review, draft, verification, and promotion complete.",
    "",
    "## File Metadata",
    `- name: ${file.name || "unknown"}`,
    `- type: ${file.type || "unknown"}`,
    `- bytes: ${Number(file.size ?? 0)}`,
    "",
    "## Content",
    String(text).trim(),
    "",
  ].join("\n");
}
