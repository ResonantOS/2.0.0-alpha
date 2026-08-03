import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";

const DEFAULT_SCOPE = [
  "browser-first/host",
  "browser-first/resonantos-side-panel-extension/src",
  "addons/resonant-browser-host/src",
  "src/core",
  "src/modules",
];

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const PROCESS_NAMES = new Set(["spawn", "spawnSync", "exec", "execFile", "execFileSync", "fork", "spawnProcess", "runOpenSsl"]);
const NETWORK_NAMES = new Set(["fetch", "request", "requestAsync", "createConnection", "connect"]);
const FILESYSTEM_NAMES = new Set([
  "writeFile", "writeFileSync", "appendFile", "appendFileSync", "readFile", "readFileSync",
  "mkdir", "mkdirSync", "rm", "rmSync", "rename", "renameSync", "copyFile", "copyFileSync",
  "unlink", "unlinkSync", "open", "openSync",
]);
const CREDENTIAL_NAMES = new Set([
  "readProviderSecrets", "saveProviderSecret", "loadProviderCredentialStatuses", "providerSecretsPath",
  "readSecret", "writeSecret", "credentialStoreStatus", "rememberProviderSecret",
]);

function walk(node, visitor) {
  visitor(node);
  node.forEachChild((child) => walk(child, visitor));
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return "";
}

function sinkKind(name) {
  if (PROCESS_NAMES.has(name)) return "process";
  if (NETWORK_NAMES.has(name)) return "network";
  if (FILESYSTEM_NAMES.has(name)) return "filesystem";
  if (CREDENTIAL_NAMES.has(name)) return "credential";
  return null;
}

function normalizeSnippet(source, node) {
  return source
    .slice(node.getStart(), node.getEnd())
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function fingerprint(entry) {
  return crypto.createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

async function sourceFiles(root, relativeScope) {
  const absolute = path.resolve(root, relativeScope);
  const entries = [];
  const { readdir } = await import("node:fs/promises");
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !/(?:\.test|\.spec)\.[^.]+$/.test(entry.name)) {
        entries.push(fullPath);
      }
    }
  }
  await visit(absolute);
  return entries;
}

export async function scanPrivilegedSinks({ repoRoot = process.cwd(), scope = DEFAULT_SCOPE } = {}) {
  const files = (await Promise.all(scope.map((entry) => sourceFiles(repoRoot, entry)))).flat().sort();
  const byFile = new Map();
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : filePath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
    const entries = [];
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = calleeName(node.expression);
      const kind = sinkKind(name);
      if (!kind) return;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      entries.push({
        kind,
        name,
        line,
        snippet: normalizeSnippet(source, node),
      });
    });
    if (!entries.length) continue;
    const relative = path.relative(repoRoot, filePath).split(path.sep).join("/");
    const sorted = entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    byFile.set(relative, {
      count: sorted.length,
      categories: [...new Set(sorted.map((entry) => entry.kind))].sort(),
      digest: fingerprint(sorted),
    });
  }
  return Object.fromEntries([...byFile.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function comparePrivilegedSinkBaseline(current, baseline) {
  const currentPaths = Object.keys(current).sort();
  const baselinePaths = Object.keys(baseline ?? {}).sort();
  const missingBaseline = currentPaths.filter((entry) => !baselinePaths.includes(entry));
  const staleBaseline = baselinePaths.filter((entry) => !currentPaths.includes(entry));
  const changed = currentPaths
    .filter((entry) => baseline?.[entry] && JSON.stringify(current[entry]) !== JSON.stringify(baseline[entry]))
    .map((entry) => ({ path: entry, expected: baseline[entry], actual: current[entry] }));
  return { ok: !missingBaseline.length && !staleBaseline.length && !changed.length, missingBaseline, staleBaseline, changed };
}

export async function run({ check, repoRoot = process.cwd() }) {
  const baselinePath = path.resolve(repoRoot, check.baseline ?? "scripts/security-pipeline/privileged-sink-baseline.json");
  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  } catch (error) {
    return { status: "fail", summary: `Privileged sink baseline could not be loaded: ${error.message}`, evidence: [] };
  }
  const current = await scanPrivilegedSinks({ repoRoot, scope: check.scope ?? DEFAULT_SCOPE });
  const comparison = comparePrivilegedSinkBaseline(current, baseline);
  if (!comparison.ok) {
    return {
      status: "fail",
      summary: "Privileged sink coverage changed without an updated security baseline.",
      evidence: [{ baselinePath: path.relative(repoRoot, baselinePath), ...comparison }],
    };
  }
  return {
    status: "pass",
    summary: `Privileged sink AST coverage matches the reviewed baseline across ${Object.keys(current).length} source files.`,
    evidence: [{ baselinePath: path.relative(repoRoot, baselinePath), files: Object.keys(current).length, sinks: Object.values(current).reduce((sum, entry) => sum + entry.count, 0) }],
  };
}

export { DEFAULT_SCOPE };
