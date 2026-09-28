// Restart-safe persistence for the Augmentor session-summary artifact (#222).
//
// Uses chrome.storage.local so the artifact survives an extension reload; the
// storage is the source of truth, so deletion is honored on restart. The
// production caller already redacts and bounds artifacts with
// session-summary-artifact.js. Redact a detached copy here as defense in depth
// for direct callers, preserving the caller's object and lowercase sentinels.
import { redactTraceValue } from "./trace-redaction.js";

export const SESSION_SUMMARY_ARTIFACT_KEY = "augmentorSessionSummaryArtifact";

export async function saveSessionSummaryArtifact(chrome, artifact) {
  if (!chrome?.storage?.local?.set) return false;
  const redactedArtifact = redactTraceValue(artifact, {
    replacement: "[redacted]",
    tokenReplacement: "[redacted]"
  });
  await chrome.storage.local.set({ [SESSION_SUMMARY_ARTIFACT_KEY]: redactedArtifact });
  return true;
}

export async function loadSessionSummaryArtifact(chrome) {
  if (!chrome?.storage?.local?.get) return null;
  const result = await chrome.storage.local.get(SESSION_SUMMARY_ARTIFACT_KEY);
  const artifact = result?.[SESSION_SUMMARY_ARTIFACT_KEY];
  return artifact && artifact.kind === "session-summary" ? artifact : null;
}

export async function deleteSessionSummaryArtifact(chrome) {
  if (!chrome?.storage?.local?.remove) return false;
  await chrome.storage.local.remove(SESSION_SUMMARY_ARTIFACT_KEY);
  return true;
}
