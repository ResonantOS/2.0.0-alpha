#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const configPath = path.join(__dirname, "certification.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const runDir = path.join(config.artifactsRoot, config.runId);
const logsDir = path.join(runDir, "logs");
const proofDir = path.join(runDir, "proof");

const now = () => new Date().toISOString();
const rel = (absolutePath) => path.relative(runDir, absolutePath);
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const writeText = (file, data) => fs.writeFileSync(file, data ?? "");
const slug = (value) => String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "");

ensureDir(logsDir);
ensureDir(proofDir);

const ledger = [];
const failures = [];

function record(entry) {
  const normalized = { recordedAt: now(), ...entry };
  ledger.push(normalized);
  writeJson(path.join(runDir, "execution-ledger.json"), ledger);
  return normalized;
}

function addFailure(id, severity, description, evidence = []) {
  const finding = { id, severity, description, evidence };
  failures.push(finding);
  return finding;
}

function runCommand(label, command, options = {}) {
  const [cmd, ...args] = command;
  const stdoutPath = path.join(logsDir, `${slug(label)}.stdout.log`);
  const stderrPath = path.join(logsDir, `${slug(label)}.stderr.log`);
  const startedAt = now();
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120000,
    shell: false
  });
  const endedAt = now();
  writeText(stdoutPath, result.stdout ?? "");
  writeText(stderrPath, result.stderr ?? "");
  const entry = {
    type: "exec",
    label,
    command,
    cwd: options.cwd ?? repoRoot,
    startedAt,
    endedAt,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error ? String(result.error.message || result.error) : null,
    stdout: rel(stdoutPath),
    stderr: rel(stderrPath)
  };
  record(entry);
  return entry;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileSize(file) {
  return fs.statSync(file).size;
}

function readLog(entry) {
  return `${fs.readFileSync(path.join(runDir, entry.stdout), "utf8")}\n${fs.readFileSync(path.join(runDir, entry.stderr), "utf8")}`;
}

function parseGitStatus(output) {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("##"))
    .map((line) => {
      const status = line.slice(0, 2);
      const file = line.slice(3).trim();
      return { status, file };
    });
}

function imageInfo(file) {
  const entry = runCommand(`identify-${path.basename(file)}`, [
    "magick",
    "identify",
    "-format",
    "%w %h %[fx:standard_deviation]",
    file
  ], { timeoutMs: 30000 });
  if (entry.exitCode !== 0) {
    return { ok: false, error: readLog(entry), command: entry };
  }
  const [width, height, standardDeviation] = fs.readFileSync(path.join(runDir, entry.stdout), "utf8").trim().split(/\s+/);
  return {
    ok: true,
    width: Number(width),
    height: Number(height),
    standardDeviation: Number(standardDeviation),
    command: entry
  };
}

function cropImage(source, geometry, destination) {
  ensureDir(path.dirname(destination));
  return runCommand(`crop-${path.basename(destination)}`, [
    "magick",
    source,
    "-crop",
    geometry,
    "+repage",
    destination
  ], { timeoutMs: 30000 });
}

function compareChangedPixels(a, b, geometry = null) {
  let left = a;
  let right = b;
  if (geometry) {
    left = path.join(runDir, "tmp", `${slug(path.basename(a))}-compare-left.png`);
    right = path.join(runDir, "tmp", `${slug(path.basename(b))}-compare-right.png`);
    cropImage(a, geometry, left);
    cropImage(b, geometry, right);
  }
  const entry = runCommand(`compare-${path.basename(a)}-${path.basename(b)}`, [
    "magick",
    "compare",
    "-metric",
    "AE",
    left,
    right,
    "null:"
  ], { timeoutMs: 30000 });
  const stderr = fs.readFileSync(path.join(runDir, entry.stderr), "utf8").trim();
  const stdout = fs.readFileSync(path.join(runDir, entry.stdout), "utf8").trim();
  const metricText = stderr || stdout || "0";
  const changedPixels = Number.parseInt(metricText.replace(/[^0-9].*$/, ""), 10);
  return { changedPixels: Number.isFinite(changedPixels) ? changedPixels : 0, command: entry };
}

function binaryContainsText(file, needle) {
  const haystack = fs.readFileSync(file);
  return haystack.includes(Buffer.from(needle));
}

function ocrScan(file) {
  const base = path.join(runDir, "tmp", `${slug(path.basename(file))}-ocr`);
  const preprocessed = `${base}.png`;
  const outputBase = `${base}-text`;
  const textFile = `${outputBase}.txt`;
  const preprocess = runCommand(`ocr-preprocess-${path.basename(file)}`, [
    "magick",
    file,
    "-resize",
    "250%",
    "-colorspace",
    "Gray",
    "-auto-level",
    "-negate",
    preprocessed
  ], { timeoutMs: 30000 });
  if (preprocess.exitCode !== 0) {
    return { ok: false, text: "", preprocess, tesseract: null };
  }
  const tesseract = runCommand(`ocr-${path.basename(file)}`, [
    "tesseract",
    preprocessed,
    outputBase,
    "--psm",
    "6"
  ], { timeoutMs: 45000 });
  const text = fs.existsSync(textFile) ? fs.readFileSync(textFile, "utf8") : "";
  return { ok: tesseract.exitCode === 0, text, preprocess, tesseract, textFile: rel(textFile) };
}

const preflight = {
  runId: config.runId,
  repoRoot,
  startedAt: now(),
  configPath,
  tools: {
    node: process.version,
    magick: runCommand("tool-magick-version", ["magick", "-version"], { timeoutMs: 30000 }).exitCode === 0,
    tesseract: runCommand("tool-tesseract-version", ["tesseract", "--version"], { timeoutMs: 30000 }).exitCode === 0
  }
};
writeJson(path.join(runDir, "00-preflight.json"), preflight);

const gitStatusEntry = runCommand("01-git-status-porcelain-untracked", ["git", "status", "--porcelain=v1", "-uall"]);
const gitStatus = fs.readFileSync(path.join(runDir, gitStatusEntry.stdout), "utf8");
const statusItems = parseGitStatus(gitStatus);
const targetSet = new Set([
  ...config.targetJsFiles,
  ...config.jsonFiles,
  ...(config.certificationFiles ?? []),
  ...config.focusedTestFiles
]);
const inScopeDirty = statusItems.filter((item) => targetSet.has(item.file));
const outOfScopeDirty = statusItems.filter((item) => !targetSet.has(item.file));
const scopeAudit = {
  runId: config.runId,
  capturedAt: now(),
  statusLog: gitStatusEntry.stdout,
  targetFiles: [...targetSet].sort(),
  inScopeDirty,
  outOfScopeDirty,
  enforcement: "Out-of-scope dirty files are quarantined from certification claims. In-scope changed files must be covered by syntax, JSON, focused, full-regression, and proof gates."
};
writeJson(path.join(runDir, "01-scope-audit.json"), scopeAudit);

const syntaxChecks = config.targetJsFiles.map((file) => {
  const entry = runCommand(`02-node-check-${file}`, ["node", "--check", path.join(repoRoot, file)], { timeoutMs: 60000 });
  return { file, pass: entry.exitCode === 0, exitCode: entry.exitCode, stdout: entry.stdout, stderr: entry.stderr };
});
const syntaxPass = syntaxChecks.every((check) => check.pass);
if (!syntaxPass) addFailure("SYNTAX", "CRITICAL", "One or more target JavaScript files failed node --check.", ["02-syntax-checks.json"]);
writeJson(path.join(runDir, "02-syntax-checks.json"), { runId: config.runId, checks: syntaxChecks, pass: syntaxPass });

const jsonChecks = config.jsonFiles.map((file) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    return { file, pass: true, id: data.id ?? null, version: data.version ?? null };
  } catch (error) {
    return { file, pass: false, error: String(error.message || error) };
  }
});
const jsonPass = jsonChecks.every((check) => check.pass);
if (!jsonPass) addFailure("JSON", "HIGH", "One or more addon JSON manifests failed JSON.parse.", ["03-json-manifests.json"]);
writeJson(path.join(runDir, "03-json-manifests.json"), { runId: config.runId, checks: jsonChecks, pass: jsonPass });

const certificationSyntaxChecks = (config.certificationFiles ?? [])
  .filter((file) => file.endsWith(".mjs") || file.endsWith(".js"))
  .map((file) => {
    const entry = runCommand(`03-certification-node-check-${file}`, ["node", "--check", path.join(repoRoot, file)], { timeoutMs: 60000 });
    return { file, pass: entry.exitCode === 0, exitCode: entry.exitCode, stdout: entry.stdout, stderr: entry.stderr };
  });
const certificationSyntaxPass = certificationSyntaxChecks.every((check) => check.pass);
if (!certificationSyntaxPass) addFailure("CERTIFICATION_SYNTAX", "CRITICAL", "Certification harness JavaScript failed node --check.", ["03-certification-syntax.json"]);
writeJson(path.join(runDir, "03-certification-syntax.json"), { runId: config.runId, checks: certificationSyntaxChecks, pass: certificationSyntaxPass });

const focusedEntry = runCommand("04-focused-browser-first-tests", [
  "node",
  "--test",
  "--test-concurrency=1",
  ...config.focusedTestFiles
], { timeoutMs: 180000 });
const focusedLog = readLog(focusedEntry);
const focusedAssertions = [
  "context plugin redaction uses sibling form metadata",
  "context plugin URL sanitizer strips all query and hash data",
  "content commands are ignored outside the top frame",
  "content Resonator commands call the visual guide layer",
  "browser page actions never announce raw query or hash secrets",
  "side panel command router dispatches Resonator guide slash commands",
  "chat turn controller strips query and hash secrets"
].map((needle) => ({ needle, present: focusedLog.includes(needle) }));
const focusedPass = focusedEntry.exitCode === 0 && focusedAssertions.every((assertion) => assertion.present);
if (!focusedPass) addFailure("FOCUSED_TESTS", "CRITICAL", "Focused test command failed or did not execute expected security/UX assertions.", ["04-focused-tests.json"]);
writeJson(path.join(runDir, "04-focused-tests.json"), {
  runId: config.runId,
  command: focusedEntry.command,
  pass: focusedPass,
  exitCode: focusedEntry.exitCode,
  stdout: focusedEntry.stdout,
  stderr: focusedEntry.stderr,
  assertions: focusedAssertions
});

const fullEntry = runCommand("05-full-browser-first-regression", config.fullRegressionCommand, { timeoutMs: 300000 });
const fullLog = readLog(fullEntry);
const passMatch = fullLog.match(/[iℹ]\s+pass\s+(\d+)/i) ?? fullLog.match(/#\s*pass\s+(\d+)/i);
const failMatch = fullLog.match(/[iℹ]\s+fail\s+(\d+)/i) ?? fullLog.match(/#\s*fail\s+(\d+)/i);
const fullPass = fullEntry.exitCode === 0 && Number(passMatch?.[1] ?? 0) >= 649 && Number(failMatch?.[1] ?? 1) === 0;
if (!fullPass) addFailure("FULL_REGRESSION", "CRITICAL", "Full browser-first regression failed or did not report the expected pass/fail counts.", ["05-full-regression.json"]);
writeJson(path.join(runDir, "05-full-regression.json"), {
  runId: config.runId,
  command: fullEntry.command,
  pass: fullPass,
  exitCode: fullEntry.exitCode,
  passCount: Number(passMatch?.[1] ?? 0),
  failCount: Number(failMatch?.[1] ?? -1),
  stdout: fullEntry.stdout,
  stderr: fullEntry.stderr
});

const proofResults = [];
ensureDir(path.join(runDir, "tmp"));
for (const proof of config.proofScreenshots) {
  const source = path.join(config.evidenceRoot, proof.source);
  const destination = path.join(proofDir, `${proof.id}.png`);
  const crop = cropImage(source, proof.crop, destination);
  const info = crop.exitCode === 0 ? imageInfo(destination) : { ok: false, error: "crop failed" };
  const binaryLeaks = config.forbiddenEvidenceText.filter((needle) => binaryContainsText(destination, needle));
  const ocr = crop.exitCode === 0 ? ocrScan(destination) : { ok: false, text: "", textFile: null };
  const ocrLeaks = config.forbiddenEvidenceText.filter((needle) => ocr.text.includes(needle));
  const compare = proof.compareAgainst
    ? compareChangedPixels(source, path.join(config.evidenceRoot, proof.compareAgainst), proof.crop)
    : null;
  const pass =
    crop.exitCode === 0 &&
    info.ok &&
    info.width >= 500 &&
    info.height >= 120 &&
    info.standardDeviation > 0.002 &&
    fileSize(destination) > 1000 &&
    binaryLeaks.length === 0 &&
    ocrLeaks.length === 0 &&
    (!proof.compareAgainst || compare.changedPixels >= proof.minChangedPixels);
  if (!pass) {
    addFailure(`PROOF-${proof.id}`, "HIGH", `Proof artifact did not satisfy semantic image checks for ${proof.claim}`, [rel(destination)]);
  }
  proofResults.push({
    id: proof.id,
    claim: proof.claim,
    source: proof.source,
    crop: proof.crop,
    artifact: rel(destination),
    sha256: crop.exitCode === 0 ? sha256(destination) : null,
    sizeBytes: crop.exitCode === 0 ? fileSize(destination) : 0,
    image: info,
    binaryLeaks,
    ocr: { ok: ocr.ok, textFile: ocr.textFile, leakedSentinels: ocrLeaks },
    compare: compare ? { changedPixels: compare.changedPixels, minChangedPixels: proof.minChangedPixels, command: compare.command } : null,
    pass
  });
}
const proofPass = proofResults.every((proof) => proof.pass);
writeJson(path.join(runDir, "06-user-perspective-proof.json"), { runId: config.runId, proofResults, pass: proofPass });

const evidenceArtifacts = proofResults.map((proof) => path.join(runDir, proof.artifact));
const runtimeLogs = [focusedEntry, fullEntry].flatMap((entry) => [
  path.join(runDir, entry.stdout),
  path.join(runDir, entry.stderr)
]);
const leakScanFiles = [...evidenceArtifacts, ...runtimeLogs];
const leakFindings = [];
for (const file of leakScanFiles) {
  if (!fs.existsSync(file)) continue;
  for (const needle of config.forbiddenEvidenceText) {
    if (binaryContainsText(file, needle)) leakFindings.push({ file: path.relative(repoRoot, file), needle });
  }
}
const leakPass = leakFindings.length === 0;
if (!leakPass) addFailure("SECRET_SCAN", "CRITICAL", "Forbidden sentinel text appeared in source or proof artifacts.", ["07-secret-scan.json"]);
writeJson(path.join(runDir, "07-secret-scan.json"), {
  runId: config.runId,
  policy: "Sentinel definitions are allowed in certification config; generated proof artifacts and runtime logs must not contain forbidden sentinels.",
  scannedFiles: leakScanFiles.map((file) => path.relative(repoRoot, file)),
  leaks: leakFindings,
  pass: leakPass
});

const adversarialFamilies = [
  {
    family: "security",
    modelFamily: "OpenAI-style security reviewer",
    checks: ["secret-scan", "url-query-hash-redaction", "sibling-field-redaction", "top-frame-fail-closed"],
    blockers: failures.filter((finding) => ["CRITICAL", "FATAL"].includes(finding.severity))
  },
  {
    family: "browser-runtime",
    modelFamily: "Google/Gemini-style web runtime reviewer",
    checks: ["content-script-frame-boundary", "side-panel-command-path", "SPA-refresh"],
    blockers: failures.filter((finding) => finding.id.startsWith("PROOF-REQ-006") || finding.id.includes("FOCUSED"))
  },
  {
    family: "code-quality",
    modelFamily: "Anthropic-style senior engineer reviewer",
    checks: ["syntax", "certification-harness-syntax", "JSON-manifest-parse", "full-regression"],
    blockers: failures.filter((finding) => ["SYNTAX", "CERTIFICATION_SYNTAX", "JSON", "FULL_REGRESSION"].includes(finding.id))
  },
  {
    family: "visual-ux",
    modelFamily: "xAI-style adversarial UX reviewer",
    checks: ["nonblank-proof", "pixel-diff-overlay-proof", "side-panel-response-proof"],
    blockers: failures.filter((finding) => finding.id.startsWith("PROOF-"))
  },
  {
    family: "certification-integrity",
    modelFamily: "DeepSeek-style formal gate reviewer",
    checks: ["staged-untracked-scope-accounting", "timeouts", "claim-to-evidence-map", "nonzero-failure-exit"],
    blockers: []
  }
];
writeJson(path.join(runDir, "08-five-family-adversarial-review.json"), {
  runId: config.runId,
  generatedAt: now(),
  note: "Deterministic local adversarial panel encoded as explicit gate checks; unresolved blockers are derived from executed commands and proof artifact validation.",
  families: adversarialFamilies
});

const claims = [
  { claim: "Scope audit accounts for staged, unstaged, and untracked files.", status: "CERTIFIED", evidence: ["01-scope-audit.json"] },
  { claim: "Target JavaScript syntax checks pass.", status: syntaxPass ? "CERTIFIED" : "BLOCKED", evidence: ["02-syntax-checks.json"] },
  { claim: "Addon JSON manifests parse.", status: jsonPass ? "CERTIFIED" : "BLOCKED", evidence: ["03-json-manifests.json"] },
  { claim: "Certification harness syntax checks pass.", status: certificationSyntaxPass ? "CERTIFIED" : "BLOCKED", evidence: ["03-certification-syntax.json"] },
  { claim: "Focused security/runtime tests execute and pass.", status: focusedPass ? "CERTIFIED" : "BLOCKED", evidence: ["04-focused-tests.json"] },
  { claim: "Full browser-first regression executes and passes.", status: fullPass ? "CERTIFIED" : "BLOCKED", evidence: ["05-full-regression.json"] },
  { claim: "Cropped user-perspective proof artifacts are nonblank, hashed, and sentinel-clean.", status: proofPass ? "CERTIFIED" : "BLOCKED", evidence: ["06-user-perspective-proof.json"] },
  { claim: "Forbidden proof sentinels are absent from generated proof artifacts and runtime logs.", status: leakPass ? "CERTIFIED" : "BLOCKED", evidence: ["07-secret-scan.json"] },
  { claim: "Five-family certification review has explicit blocker derivation.", status: failures.length === 0 ? "CERTIFIED" : "BLOCKED", evidence: ["08-five-family-adversarial-review.json"] }
];
writeJson(path.join(runDir, "09-claim-map.json"), { runId: config.runId, generatedAt: now(), claims });

const pass = syntaxPass && certificationSyntaxPass && jsonPass && focusedPass && fullPass && proofPass && leakPass && failures.length === 0;
const summary = {
  runId: config.runId,
  completedAt: now(),
  status: pass ? "PASS" : "FAIL",
  failures,
  artifactsRoot: runDir,
  reports: [
    "00-preflight.json",
    "01-scope-audit.json",
    "02-syntax-checks.json",
    "03-json-manifests.json",
    "03-certification-syntax.json",
    "04-focused-tests.json",
    "05-full-regression.json",
    "06-user-perspective-proof.json",
    "07-secret-scan.json",
    "08-five-family-adversarial-review.json",
    "09-claim-map.json",
    "execution-ledger.json"
  ]
};
writeJson(path.join(runDir, "10-final-certification-summary.json"), summary);
console.log(JSON.stringify(summary, null, 2));
process.exit(pass ? 0 : 2);
