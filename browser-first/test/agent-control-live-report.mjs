import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const VALID_SCENARIO_STATUSES = new Set(["passed", "failed", "gated", "excluded"]);

export function sanitizeEvidenceText(value, { roots = [] } = {}) {
  let text = String(value ?? "");
  for (const root of [...roots].filter(Boolean).sort((left, right) => right.length - left.length)) {
    text = text.split(root).join("[redacted-path]");
  }
  return text
    .replace(/(?:\/home|\/Users)\/[^/\s]+(?:\/[^\s"'`]+)*/g, "[redacted-path]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s"'`]+)*/g, "[redacted-path]")
    .replace(/((?:bridge|capability|bootstrap)(?:[-_ ]?token)?\s*[:=]\s*)[^\s,;"']+/gi, "$1[redacted-token]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, "$1[redacted-token]");
}

export function decideUnavailableCertification({ ci, reason }) {
  return {
    status: "not-certified",
    exitCode: ci ? 78 : 0,
    reason,
  };
}

export function decidePublicSubmitScenario({ mode = "auto", humanHandoff }) {
  if (humanHandoff) {
    return {
      status: "passed",
      reason: "#240 human-only public-submit handoff is active and no executable approval is exposed.",
    };
  }
  if (mode === "required") {
    return {
      status: "failed",
      reason: "#240 human-only public-submit handoff was required but the legacy approval path remained.",
    };
  }
  return {
    status: "gated",
    reason: "#240 human-only public-submit handoff is not present in this revision.",
  };
}

export function createLiveCertificationReport({
  artifactDir,
  profile,
  roots = [],
  runId = "local",
  runAttempt = "1",
}) {
  const scenarios = [];
  let assertionNumber = 0;

  function record(id, status, detail = "") {
    if (!VALID_SCENARIO_STATUSES.has(status)) {
      throw new Error(`Unsupported live-certification scenario status: ${status}`);
    }
    scenarios.push({
      id: String(id),
      status,
      detail: sanitizeEvidenceText(detail, { roots }),
    });
  }

  function recordAssertion(condition, message) {
    assertionNumber += 1;
    const id = `assertion-${String(assertionNumber).padStart(3, "0")}`;
    record(id, condition ? "passed" : "failed", message);
    if (!condition) throw new Error(message);
  }

  async function write({ status, screenshots = [], error = null, metadata = {} }) {
    await mkdir(artifactDir, { recursive: true });
    const safeScreenshots = screenshots.map((screenshot) => ({
      ok: Boolean(screenshot?.ok),
      path: screenshot?.path ? path.basename(screenshot.path) : null,
      fallback: screenshot?.fallback ?? null,
      error: screenshot?.error ? sanitizeEvidenceText(screenshot.error, { roots }) : null,
    }));
    const counts = Object.fromEntries(
      ["passed", "failed", "gated", "excluded"].map((scenarioStatus) => [
        scenarioStatus,
        scenarios.filter((scenario) => scenario.status === scenarioStatus).length,
      ]),
    );
    const payload = {
      schemaVersion: 1,
      certification: "resonantos-agent-control-live",
      status,
      profile,
      run: { id: String(runId), attempt: String(runAttempt) },
      generatedAt: new Date().toISOString(),
      counts,
      scenarios,
      screenshots: safeScreenshots,
      error: error ? sanitizeEvidenceText(error instanceof Error ? error.stack ?? error.message : error, { roots }) : null,
      metadata: Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => [key, sanitizeEvidenceText(value, { roots })]),
      ),
    };
    const jsonPath = path.join(artifactDir, "scenario-matrix.json");
    const markdownPath = path.join(artifactDir, "scenario-matrix.md");
    const markdownRows = scenarios.map((scenario) => {
      const detail = scenario.detail.replaceAll("|", "\\|").replaceAll("\n", " ");
      return `| ${scenario.id} | ${scenario.status} | ${detail} |`;
    });
    const markdown = [
      "# ResonantOS Agent Control Live Certification",
      "",
      `- Status: ${status}`,
      `- Profile: ${profile}`,
      `- Run: ${runId}/${runAttempt}`,
      `- Counts: ${JSON.stringify(counts)}`,
      "",
      "| Scenario | Status | Detail |",
      "| --- | --- | --- |",
      ...markdownRows,
      "",
      "## Screenshots",
      "",
      ...(safeScreenshots.length
        ? safeScreenshots.map((screenshot) => `- ${screenshot.path ?? "unavailable"}: ${screenshot.ok ? "captured" : "failed"}${screenshot.fallback ? ` (${screenshot.fallback})` : ""}`)
        : ["- none"]),
      "",
      "## Error",
      "",
      payload.error ? `\`\`\`text\n${payload.error}\n\`\`\`` : "none",
      "",
    ].join("\n");
    await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, markdown, "utf8");
    return { jsonPath, markdownPath, payload };
  }

  return {
    assert: recordAssertion,
    record,
    scenarios,
    write,
  };
}
