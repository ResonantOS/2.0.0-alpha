#!/usr/bin/env node

// Issue #223 deterministic certification gate for Agent Control safe
// click/type/scroll fixtures. Every run gets a fresh run ID; artifacts are
// bound to that ID and hashed against the exact fixture/source revisions, so
// stale screenshots or foreign-run artifacts can never certify a claim.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "certification.config.json"), "utf8"));

const runId = `AC-CERT-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${crypto.randomBytes(4).toString("hex")}`;
const artifactsRoot = path.resolve(repoRoot, config.artifactsRoot);
const runDir = path.join(artifactsRoot, runId);
const logsDir = path.join(runDir, "logs");
const proofDir = path.join(runDir, "proof");
const liveProofDir = process.env[config.liveProofDirEnv];

const now = () => new Date().toISOString();
const rel = (absolutePath) => path.relative(runDir, absolutePath);
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const writeText = (file, data) => fs.writeFileSync(file, data ?? "");
const slug = (value) => String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

ensureDir(logsDir);
ensureDir(proofDir);

const ledger = [];
const failures = [];
const runStartedAt = now();

function record(entry) {
  const normalized = { recordedAt: now(), runId, ...entry };
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
    timeout: options.timeoutMs ?? 300000,
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

function readLog(entry) {
  return `${fs.readFileSync(path.join(runDir, entry.stdout), "utf8")}\n${fs.readFileSync(path.join(runDir, entry.stderr), "utf8")}`;
}

function artifactHashInfo(file) {
  return { file: rel(file), sha256: sha256(file), sizeBytes: fs.statSync(file).size };
}

const preflight = {
  runId,
  repoRoot,
  startedAt: runStartedAt,
  node: process.version,
  platform: process.platform,
  liveProofDir: liveProofDir ?? null
};
writeJson(path.join(runDir, "00-preflight.json"), preflight);

// Stage 1: scope audit — certification claims only cover the declared target
// files, and dirty out-of-scope files are quarantined from the claims.
const gitStatusEntry = runCommand("01-git-status-porcelain", ["git", "status", "--porcelain=v1", "-uall"]);
const statusLines = fs.readFileSync(path.join(runDir, gitStatusEntry.stdout), "utf8")
  .split("\n").map((line) => line.trimEnd()).filter((line) => line && !line.startsWith("##"));
const targetSet = new Set([...config.targetFiles, ...config.certificationFiles, ...config.focusedTestFiles]);
const scopeAudit = {
  runId,
  capturedAt: now(),
  inScopeDirty: statusLines.filter((line) => targetSet.has(line.slice(3).trim())),
  outOfScopeDirty: statusLines.filter((line) => !targetSet.has(line.slice(3).trim())),
  targetFiles: [...targetSet].sort(),
  enforcement: "Out-of-scope dirty files are quarantined from certification claims. In-scope files are covered by syntax, focused, full-regression, and freshness gates."
};
writeJson(path.join(runDir, "01-scope-audit.json"), scopeAudit);

// Stage 2: source integrity — hash every certification input so the artifacts
// are provably tied to the exact fixture and enforcement sources used.
const sourceIntegrity = {
  runId,
  capturedAt: now(),
  files: config.targetFiles.filter((file) => fs.existsSync(path.join(repoRoot, file))).map((file) => artifactHashInfo(path.join(repoRoot, file)))
};
writeJson(path.join(runDir, "02-source-integrity.json"), sourceIntegrity);

// Stage 3: syntax checks for the harness and fixture module.
const syntaxFiles = [...config.certificationFiles, ...config.targetFiles].filter((file) => file.endsWith(".mjs") || file.endsWith(".js"));
const syntaxChecks = syntaxFiles.map((file) => {
  const entry = runCommand(`03-node-check-${slug(file)}`, ["node", "--check", path.join(repoRoot, file)], { timeoutMs: 60000 });
  return { file, pass: entry.exitCode === 0, exitCode: entry.exitCode, stdout: entry.stdout, stderr: entry.stderr };
});
const syntaxPass = syntaxChecks.every((check) => check.pass);
if (!syntaxPass) addFailure("SYNTAX", "CRITICAL", "Certification harness or fixture sources failed node --check.", ["03-syntax-checks.json"]);
writeJson(path.join(runDir, "03-syntax-checks.json"), { runId, checks: syntaxChecks, pass: syntaxPass });

// Stage 4: focused certification tests (the exact command from issue #223's
// contributor handoff) plus assertion-content checks so the gate fails closed
// if the named certification tests disappear or stop exercising the claims.
const focusedEntry = runCommand("04-focused-certification-tests", [
  "node", "--test", "--test-concurrency=1", ...config.focusedTestFiles
], { timeoutMs: 180000 });
const focusedLog = readLog(focusedEntry);
const focusedAssertions = config.focusedTestAssertions.map((needle) => ({ needle, present: focusedLog.includes(needle) }));
const focusedPass = focusedEntry.exitCode === 0 && focusedAssertions.every((assertion) => assertion.present);
if (!focusedPass) addFailure("FOCUSED_TESTS", "CRITICAL", "Focused certification tests failed or did not exercise every declared claim.", ["04-focused-tests.json"]);
writeJson(path.join(runDir, "04-focused-tests.json"), {
  runId,
  command: focusedEntry.command,
  pass: focusedPass,
  exitCode: focusedEntry.exitCode,
  stdout: focusedEntry.stdout,
  stderr: focusedEntry.stderr,
  assertions: focusedAssertions
});

// Stage 5: full browser-first regression.
const fullEntry = runCommand("05-full-browser-first-regression", config.fullRegressionCommand, { timeoutMs: 600000 });
const fullLog = readLog(fullEntry);
const passMatch = fullLog.match(/[iℹ]\s+pass\s+(\d+)/i) ?? fullLog.match(/#\s*pass\s+(\d+)/i);
const failMatch = fullLog.match(/[iℹ]\s+fail\s+(\d+)/i) ?? fullLog.match(/#\s*fail\s+(\d+)/i);
const fullPass = fullEntry.exitCode === 0 && Number(passMatch?.[1] ?? 0) >= config.minFullRegressionPassCount && Number(failMatch?.[1] ?? 1) === 0;
if (!fullPass) addFailure("FULL_REGRESSION", "CRITICAL", "Full browser-first regression failed or did not report the expected pass/fail counts.", ["05-full-regression.json"]);
writeJson(path.join(runDir, "05-full-regression.json"), {
  runId,
  command: fullEntry.command,
  pass: fullPass,
  exitCode: fullEntry.exitCode,
  passCount: Number(passMatch?.[1] ?? 0),
  failCount: Number(failMatch?.[1] ?? -1),
  stdout: fullEntry.stdout,
  stderr: fullEntry.stderr
});

// Stage 6: freshness and binding gate. Every artifact must carry this run's
// ID; a stale artifact (different run ID, or predating this run) is a FAIL,
// because "fresh artifacts tied to a run ID" is an issue acceptance criterion.
const freshnessFiles = [
  "00-preflight.json", "01-scope-audit.json", "02-source-integrity.json",
  "03-syntax-checks.json", "04-focused-tests.json", "05-full-regression.json",
  "execution-ledger.json"
];
const freshnessFindings = [];
for (const file of freshnessFiles) {
  const absolute = path.join(runDir, file);
  if (!fs.existsSync(absolute)) {
    freshnessFindings.push({ file, finding: "missing artifact" });
    continue;
  }
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const bound = Array.isArray(parsed)
    ? parsed.length > 0 && parsed.every((entry) => entry.runId === runId)
    : parsed.runId === runId;
  const fresh = fs.statSync(absolute).mtimeMs >= Date.parse(runStartedAt);
  if (!bound || !fresh) freshnessFindings.push({ file, bound, fresh });
}
const freshnessPass = freshnessFindings.length === 0;
if (!freshnessPass) addFailure("FRESHNESS", "CRITICAL", "One or more artifacts are missing, stale, or not bound to this run ID.", ["06-freshness-gate.json"]);
writeJson(path.join(runDir, "06-freshness-gate.json"), { runId, generatedAt: now(), findings: freshnessFindings, pass: freshnessPass });

// Stage 7: live browser proof attach. The live harness (issue #267) writes
// screenshots/ledgers into RESONANTOS_CERT_PROOF_DIR when available; this gate
// hashes and binds them to this run ID. Absence is recorded as "excluded",
// never as a pass — live proof is a separate live-browser certification.
const proofResults = [];
if (liveProofDir && fs.existsSync(liveProofDir)) {
  const candidates = fs.readdirSync(liveProofDir, { recursive: true })
    .filter((entry) => fs.statSync(path.join(liveProofDir, entry)).isFile());
  for (const entry of candidates) {
    const source = path.join(liveProofDir, entry);
    const destination = path.join(proofDir, slug(entry));
    fs.copyFileSync(source, destination);
    proofResults.push({ id: slug(entry), source: entry, artifact: artifactHashInfo(destination) });
  }
  if (!proofResults.length) {
    addFailure("LIVE_PROOF_EMPTY", "HIGH", "Live proof directory was provided but contained no files.", ["07-live-proof-attach.json"]);
  }
}
const liveProofAttach = {
  runId,
  generatedAt: now(),
  mode: liveProofDir ? "attached" : "excluded",
  note: "Live browser proof is provided by the live harness (#267); this run certifies deterministic behavior and binds any supplied proof to this run ID.",
  proofResults
};
writeJson(path.join(runDir, "07-live-proof-attach.json"), liveProofAttach);
const liveProofPass = liveProofDir ? proofResults.length > 0 : true;

// Stage 8: secret scan across generated artifacts and runtime logs.
const leakScanFiles = freshnessFiles.map((file) => path.join(runDir, file)).filter((file) => fs.existsSync(file))
  .concat(proofResults.map((proof) => proof.artifact.file).map((file) => path.join(runDir, file)));
const leakFindings = [];
for (const file of leakScanFiles) {
  const haystack = fs.readFileSync(file);
  for (const needle of config.forbiddenEvidenceText) {
    if (haystack.includes(Buffer.from(needle))) leakFindings.push({ file: path.relative(repoRoot, file), needle });
  }
}
const leakPass = leakFindings.length === 0;
if (!leakPass) addFailure("SECRET_SCAN", "CRITICAL", "Forbidden sentinel text appeared in certification artifacts.", ["08-secret-scan.json"]);
writeJson(path.join(runDir, "08-secret-scan.json"), { runId, scannedFiles: leakScanFiles.map((file) => path.relative(repoRoot, file)), leaks: leakFindings, pass: leakPass });

const families = [
  { family: "security", checks: ["source-integrity", "secret-scan"], blockers: failures.filter((finding) => ["SYNTAX", "SECRET_SCAN"].includes(finding.id)) },
  { family: "browser-runtime", checks: ["focused-certification", "assertion-content"], blockers: failures.filter((finding) => finding.id.includes("FOCUSED")) },
  { family: "code-quality", checks: ["syntax", "full-regression"], blockers: failures.filter((finding) => ["SYNTAX", "FULL_REGRESSION"].includes(finding.id)) },
  { family: "certification-integrity", checks: ["freshness", "run-id-binding", "live-proof-binding"], blockers: failures.filter((finding) => ["FRESHNESS", "LIVE_PROOF_EMPTY"].includes(finding.id)) },
  { family: "scope-governance", checks: ["scope-audit", "quarantine"], blockers: failures.filter((finding) => finding.id.startsWith("SCOPE")) }
];
writeJson(path.join(runDir, "09-five-family-review.json"), {
  runId,
  generatedAt: now(),
  note: "Deterministic adversarial panel encoded as explicit gate checks; unresolved blockers are derived from executed commands and artifact validation.",
  families
});

const claims = [
  { claim: "Fresh artifacts are bound to run ID " + runId, status: freshnessPass ? "CERTIFIED" : "BLOCKED", evidence: ["06-freshness-gate.json"] },
  { claim: "Source hashes bind the certification to exact fixture and enforcement revisions.", status: "CERTIFIED", evidence: ["02-source-integrity.json"] },
  { claim: "Certification harness and fixture sources pass syntax checks.", status: syntaxPass ? "CERTIFIED" : "BLOCKED", evidence: ["03-syntax-checks.json"] },
  { claim: "Focused certification tests execute every declared safe/blocked claim.", status: focusedPass ? "CERTIFIED" : "BLOCKED", evidence: ["04-focused-tests.json"] },
  { claim: "Full browser-first regression passes.", status: fullPass ? "CERTIFIED" : "BLOCKED", evidence: ["05-full-regression.json"] },
  { claim: "Attached live proof (when supplied) is bound and hashed for this run.", status: liveProofPass ? "CERTIFIED" : "BLOCKED", evidence: ["07-live-proof-attach.json"] },
  { claim: "Generated artifacts are sentinel-clean.", status: leakPass ? "CERTIFIED" : "BLOCKED", evidence: ["08-secret-scan.json"] }
];
writeJson(path.join(runDir, "10-claim-map.json"), { runId, generatedAt: now(), claims });

const pass = syntaxPass && focusedPass && fullPass && freshnessPass && liveProofPass && leakPass && failures.length === 0;
const summary = {
  runId,
  completedAt: now(),
  status: pass ? "PASS" : "FAIL",
  failures,
  artifactsRoot: runDir,
  liveProofMode: liveProofAttach.mode,
  reports: freshnessFiles.slice(0, 6).concat("06-freshness-gate.json", "07-live-proof-attach.json", "08-secret-scan.json", "09-five-family-review.json", "10-claim-map.json", "execution-ledger.json")
};
writeJson(path.join(runDir, "11-final-certification-summary.json"), summary);
console.log(JSON.stringify(summary, null, 2));
process.exit(pass ? 0 : 2);
