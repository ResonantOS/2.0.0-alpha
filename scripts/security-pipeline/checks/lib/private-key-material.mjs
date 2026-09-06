import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const PRIVATE_KEY_FILENAME_PATTERN =
  /(^|[/\\])(?:[^/\\]*(?:\.|-)signer\.json|[^/\\]*-private[^/\\]*\.json|[^/\\]*\.(?:pem|key|p12|pfx|keystore|jwk)|id_(?:rsa|ed25519|ecdsa|dsa))$/iu;

const BINARY_CONTENT_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|gz|tgz|pdf|mp4|mov)$/iu;
const JWK_PRIVATE_KTY = new Set(["OKP", "EC", "RSA"]);
// The body is everything base64-ish after the header: base64 characters, whitespace, and the
// literal two-character escapes \n / \r as they appear inside JSON strings. Deliberately NOT anchored
// on an -----END----- footer: a truncated block with a full body is still usable key material.
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?<body>(?:[A-Za-z0-9+/=]|\s|\\[rn])+)/gu;
const JWK_FALLBACK_PATTERN =
  /(?:"kty"\s*:\s*"(?:[Oo][Kk][Pp]|[Ee][Cc]|[Rr][Ss][Aa])"[\s\S]{0,800}?"d"\s*:\s*"([A-Za-z0-9_\-+/=]{16,})"|"d"\s*:\s*"([A-Za-z0-9_\-+/=]{16,})"[\s\S]{0,800}?"kty"\s*:\s*"(?:[Oo][Kk][Pp]|[Ee][Cc]|[Rr][Ss][Aa])")/gu;

export function scanText({ path: filePath, text }) {
  const findings = [];
  findings.push(...scanPemPrivateKeys({ path: filePath, text }));
  if (/\.json$/iu.test(filePath)) {
    findings.push(...scanJwkPrivateComponents({ path: filePath, text }));
  } else {
    findings.push(...scanJwkFallback({ path: filePath, text }));
  }
  return findings;
}

export function listCandidateFiles(repoRoot) {
  if (existsSync(path.join(repoRoot, ".git"))) {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return output.split("\0").filter(Boolean).map(toPosixPath).sort();
  }

  const files = [];
  walkFiles(repoRoot, repoRoot, files);
  return files.sort();
}

export function isBinaryContentPath(filePath) {
  return BINARY_CONTENT_EXTENSION_PATTERN.test(filePath);
}

export function fingerprintMaterial(material) {
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

function scanPemPrivateKeys({ path: filePath, text }) {
  const findings = [];
  for (const match of text.matchAll(PEM_PRIVATE_KEY_PATTERN)) {
    const normalizedBody = normalizePemBody(match.groups?.body ?? "");
    if (normalizedBody.length < 40 || !/^[A-Za-z0-9+/=]+$/u.test(normalizedBody)) {
      continue;
    }
    findings.push({
      kind: "pem-private-key",
      path: filePath,
      line: lineForIndex(text, match.index ?? 0),
      fingerprint: fingerprintMaterial(normalizedBody),
    });
  }
  return findings;
}

function scanJwkPrivateComponents({ path: filePath, text }) {
  const findings = [];
  try {
    const parsed = JSON.parse(text);
    walkJsonForJwk(parsed, ({ d }) => {
      findings.push({
        kind: "jwk-private-component",
        path: filePath,
        line: lineForJsonDKey(text, d),
        fingerprint: fingerprintMaterial(d),
      });
    });
    return findings;
  } catch {
    return scanJwkFallback({ path: filePath, text });
  }
}

function scanJwkFallback({ path: filePath, text }) {
  const findings = [];
  for (const match of text.matchAll(JWK_FALLBACK_PATTERN)) {
    const dValue = match[1] ?? match[2];
    findings.push({
      kind: "jwk-private-component",
      path: filePath,
      line: lineForIndex(text, match.index ?? 0),
      fingerprint: fingerprintMaterial(dValue),
    });
  }
  return findings;
}

function walkJsonForJwk(value, onFinding) {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkJsonForJwk(item, onFinding);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  if (
    JWK_PRIVATE_KTY.has(String(value.kty ?? "").toUpperCase()) &&
    typeof value.d === "string" &&
    value.d.length >= 16
  ) {
    onFinding({ d: value.d });
  }

  for (const child of Object.values(value)) {
    walkJsonForJwk(child, onFinding);
  }
}

function lineForJsonDKey(text, dValue) {
  const escaped = escapeRegExp(JSON.stringify(dValue).slice(1, -1));
  const pattern = new RegExp(`"d"\\s*:\\s*"${escaped}"`, "u");
  const match = pattern.exec(text);
  return match ? lineForIndex(text, match.index) : 1;
}

function normalizePemBody(body) {
  return body.replace(/\\[rn]/gu, "").replace(/\s+/gu, "");
}

function lineForIndex(text, index) {
  return text.slice(0, index).split("\n").length;
}

function walkFiles(root, directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, absolutePath, files);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(toPosixPath(path.relative(root, absolutePath)));
    }
  }
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
