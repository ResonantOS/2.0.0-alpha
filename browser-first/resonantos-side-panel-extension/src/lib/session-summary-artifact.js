// Restart-safe session summary artifact for the Augmentor (#222).
//
// A bounded, reviewable, deletable artifact that preserves train-of-thought
// across an extension reload WITHOUT persisting raw page content. The artifact
// stores only tab provenance (title/url), skip reasons, and a redacted summary;
// raw page text, form fields, and controls are never stored. Secrets are
// redacted by the shared strict trace redactor before persistence.
import { redactTraceText } from "./trace-redaction.js";

// Field-bound for per-tab title/url/reason. A page-controlled `document.title`
// can be arbitrarily long, so we cap each piece of provenance at 300 chars
// with an ellipsis to prevent an artifact-bombing tab from filling storage.
const MAX_FIELD_LENGTH = 300;

const boundField = (value) => {
  const text = String(value ?? "");
  return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}…` : text;
};

// Summary artifacts retain their established lowercase sentinel style.
export const redactSecrets = (text) => redactTraceText(text, {
  replacement: "[redacted]",
  tokenReplacement: "[redacted]"
});

// Build a reviewable session-summary artifact. `included` and `skipped` carry
// tab provenance only (title/url/reason), with secrets redacted AND
// per-field-bounded before persistence so query-string secrets AND
// page-controlled long titles never reach chrome.storage.local. The summary is
// also redacted and length-bounded. No raw text, fields, or controls are stored.
export function buildSessionSummaryArtifact({
  included = [],
  skipped = [],
  summary = "",
  trigger = "explicit-command",
  generatedAt = new Date().toISOString()
} = {}) {
  const cleanIncluded = (Array.isArray(included) ? included : []).map((tab) => ({
    title: boundField(redactSecrets(String(tab?.title ?? ""))),
    url: boundField(redactSecrets(String(tab?.url ?? "")))
  }));
  const cleanSkipped = (Array.isArray(skipped) ? skipped : []).map((entry) => ({
    title: boundField(redactSecrets(String(entry?.title ?? ""))),
    url: boundField(redactSecrets(String(entry?.url ?? ""))),
    reason: boundField(redactSecrets(String(entry?.reason ?? "")))
  }));
  return Object.freeze({
    kind: "session-summary",
    trigger,
    generatedAt,
    included: cleanIncluded,
    skipped: cleanSkipped,
    summary: redactSecrets(summary).slice(0, 4000)
  });
}

// A short, reviewable context line restored from a persisted artifact on reload,
// so the user sees prior session context was preserved (and can review/delete it).
// Returns null when there is no valid artifact, so the caller can no-op cleanly.
export function sessionSummaryRestoreLine(artifact) {
  if (!artifact || artifact.kind !== "session-summary") return null;
  const included = Array.isArray(artifact.included) ? artifact.included : [];
  const skipped = Array.isArray(artifact.skipped) ? artifact.skipped : [];
  const when = artifact.generatedAt || "unknown time";
  const skippedNote = skipped.length ? `; ${skipped.length} skipped` : "";
  return `Restored session context from ${when}: ${included.length} tab(s) included${skippedNote}. Review or delete it via /session clear.`;
}
